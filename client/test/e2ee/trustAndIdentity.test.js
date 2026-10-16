import { describe, test, expect, beforeEach, vi } from "vitest";
import { createKeyStore, createMemoryAdapter } from "../../src/e2ee/keyStore.js";
import { createTrustTracker, TRUST } from "../../src/e2ee/trust.js";
import { createDirectory, KeyMismatchError } from "../../src/e2ee/directory.js";
import { loadOrCreateIdentity } from "../../src/e2ee/identity.js";
import { makeIdentity } from "./helpers.js";

describe("trust-on-first-use", () => {
  let store;
  let trust;
  beforeEach(() => {
    store = createKeyStore(createMemoryAdapter());
    trust = createTrustTracker(store);
  });

  test("first sight is NEW, then OK", async () => {
    const bob = await makeIdentity("bob");
    expect((await trust.assess("bob", [bob.record])).status).toBe(TRUST.NEW);
    expect((await trust.assess("bob", [bob.record])).status).toBe(TRUST.OK);
  });

  test("a new device is reported on EVERY lookup until the person acknowledges it", async () => {
    const bob1 = await makeIdentity("bob");
    const bob2 = await makeIdentity("bob");
    await trust.assess("bob", [bob1.record]);
    for (let i = 0; i < 3; i += 1) {
      const result = await trust.assess("bob", [bob1.record, bob2.record]);
      expect(result.status).toBe(TRUST.DEVICES_ADDED);
      expect(result.added).toEqual([bob2.record.id]);
    }
    // Looking at it never pins it.
    expect(Object.keys((await store.getPeer("bob")).devices)).toEqual([bob1.record.id]);

    await trust.acknowledge("bob", [bob1.record, bob2.record]);
    expect((await trust.assess("bob", [bob1.record, bob2.record])).status).toBe(TRUST.OK);
  });

  test("the assessment says whether the person had been verified", async () => {
    const bob1 = await makeIdentity("bob");
    const bob2 = await makeIdentity("bob");
    await trust.assess("bob", [bob1.record]);
    await trust.setVerified("bob", "123456", true, [bob1.record]);
    const result = await trust.assess("bob", [bob1.record, bob2.record]);
    expect(result).toMatchObject({ status: TRUST.DEVICES_ADDED, verified: true });
    expect(await trust.wasVerified("bob")).toBe(true);
  });

  test("acknowledging a new device ends the old verification: the number it covered is gone", async () => {
    const bob1 = await makeIdentity("bob");
    const bob2 = await makeIdentity("bob");
    await trust.assess("bob", [bob1.record]);
    await trust.setVerified("bob", "111", true, [bob1.record]);
    await trust.acknowledge("bob", [bob1.record, bob2.record]);
    expect(await trust.wasVerified("bob")).toBe(false);
    expect(await trust.isVerified("bob", "111")).toBe(false);
  });

  test("verifying the new number accepts the devices it was computed from", async () => {
    const bob1 = await makeIdentity("bob");
    const bob2 = await makeIdentity("bob");
    await trust.assess("bob", [bob1.record]);
    await trust.setVerified("bob", "222", true, [bob1.record, bob2.record]);
    const result = await trust.assess("bob", [bob1.record, bob2.record]);
    expect(result).toMatchObject({ status: TRUST.OK, verified: true });
  });

  test("a known device id presenting different keys is a hard mismatch and is not re-pinned", async () => {
    const bob = await makeIdentity("bob");
    await trust.assess("bob", [bob.record]);
    const evil = await makeIdentity("bob", bob.record.id);
    const result = await trust.assess("bob", [evil.record]);
    expect(result.status).toBe(TRUST.KEY_MISMATCH);
    expect(result.mismatched).toEqual([bob.record.id]);
    // The original pin must survive so the mismatch keeps being detected.
    expect((await trust.assess("bob", [bob.record])).status).toBe(TRUST.OK);
    expect((await trust.assess("bob", [evil.record])).status).toBe(TRUST.KEY_MISMATCH);
  });

  test("revoked devices are forgotten without a warning", async () => {
    const bob1 = await makeIdentity("bob");
    const bob2 = await makeIdentity("bob");
    await trust.assess("bob", [bob1.record, bob2.record]);
    expect((await trust.assess("bob", [bob1.record])).status).toBe(TRUST.OK);
    const pin = await store.getPeer("bob");
    expect(Object.keys(pin.devices)).toEqual([bob1.record.id]);
  });

  test("verification is tied to the exact safety number", async () => {
    await trust.setVerified("bob", "111");
    expect(await trust.isVerified("bob", "111")).toBe(true);
    expect(await trust.isVerified("bob", "222")).toBe(false);
    await trust.setVerified("bob", "111", false);
    expect(await trust.isVerified("bob", "111")).toBe(false);
  });

  test("verification survives later assessments", async () => {
    const bob = await makeIdentity("bob");
    await trust.assess("bob", [bob.record]);
    await trust.setVerified("bob", "999");
    await trust.assess("bob", [bob.record]);
    expect(await trust.isVerified("bob", "999")).toBe(true);
  });

  test("a device id that is an Object.prototype name cannot hide as already-known", async () => {
    const bob = await makeIdentity("bob");
    await trust.assess("bob", [bob.record]);
    for (const id of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      const sneaky = { ...(await makeIdentity("bob")).record, id };
      const result = await trust.assess("bob", [bob.record, sneaky]);
      expect(result.status, id).toBe(TRUST.DEVICES_ADDED);
      expect(result.added, id).toEqual([id]);
    }
  });

  test("a device id that is an Object.prototype name is pinned like any other once acknowledged", async () => {
    const bob = await makeIdentity("bob");
    const sneaky = { ...(await makeIdentity("bob")).record, id: "__proto__" };
    await trust.assess("bob", [bob.record]);
    await trust.acknowledge("bob", [bob.record, sneaky]);
    expect((await trust.assess("bob", [bob.record, sneaky])).status).toBe(TRUST.OK);
    const other = { ...(await makeIdentity("bob")).record, id: "__proto__" };
    expect((await trust.assess("bob", [bob.record, other])).status).toBe(TRUST.KEY_MISMATCH);
  });
});

describe("directory", () => {
  test("a device whose id is not a UUID is never offered as a recipient", async () => {
    const trust = createTrustTracker(createKeyStore(createMemoryAdapter()));
    const bob = await makeIdentity("bob");
    const bad = (await makeIdentity("bob")).record;
    const api = {
      fetchUserDevices: vi.fn(async () => ({ devices: [bob.record, { ...bad, id: "__proto__" }] })),
      fetchChatDevices: vi.fn(async () => ({
        devices: [bob.record, { ...bad, id: "constructor" }],
        membersWithoutDevice: [],
      })),
    };
    const dir = createDirectory({ api, trust });
    expect((await dir.getUserDevices("bob")).devices.map((d) => d.id)).toEqual([bob.record.id]);
    expect((await dir.getChatDevices("c1")).devices.map((d) => d.id)).toEqual([bob.record.id]);
  });

  test("blocks with KeyMismatchError and never caches the bad answer", async () => {
    const store = createKeyStore(createMemoryAdapter());
    const trust = createTrustTracker(store);
    const bob = await makeIdentity("bob");
    const evil = await makeIdentity("bob", bob.record.id);
    let current = bob.record;
    const api = { fetchUserDevices: vi.fn(async () => ({ devices: [current] })) };
    const dir = createDirectory({ api, trust, ttlMs: 60_000 });

    await dir.getUserDevices("bob");
    current = evil.record;
    await expect(dir.getUserDevices("bob", { force: true })).rejects.toBeInstanceOf(KeyMismatchError);
    await expect(dir.getUserDevices("bob")).rejects.toBeInstanceOf(KeyMismatchError);
  });

  test("caches within the TTL and refreshes after it", async () => {
    const trust = createTrustTracker(createKeyStore(createMemoryAdapter()));
    const bob = await makeIdentity("bob");
    let t = 0;
    const api = { fetchUserDevices: vi.fn(async () => ({ devices: [bob.record] })) };
    const dir = createDirectory({ api, trust, ttlMs: 1000, now: () => t });
    await dir.getUserDevices("bob");
    await dir.getUserDevices("bob");
    expect(api.fetchUserDevices).toHaveBeenCalledTimes(1);
    t = 2000;
    await dir.getUserDevices("bob");
    expect(api.fetchUserDevices).toHaveBeenCalledTimes(2);
  });

  test("devices of someone with unacknowledged devices are flagged pending, and acknowledging clears it", async () => {
    const trust = createTrustTracker(createKeyStore(createMemoryAdapter()));
    const bob1 = await makeIdentity("bob");
    const bob2 = await makeIdentity("bob");
    let list = [bob1.record];
    const api = { fetchUserDevices: vi.fn(async () => ({ devices: list })) };
    const dir = createDirectory({ api, trust, ttlMs: 60_000 });
    await dir.getUserDevices("bob");
    list = [bob1.record, bob2.record];

    const found = await dir.findDevice("bob", bob2.record.id);
    expect(found.pending).toBe(true);
    expect((await dir.findDevice("bob", bob1.record.id)).pending).toBe(false);
    // The signal is still there on the next lookup.
    expect((await dir.getUserDevices("bob", { force: true })).assessment.status).toBe(TRUST.DEVICES_ADDED);

    await dir.acknowledge("bob", list);
    const after = await dir.getUserDevices("bob", { force: true });
    expect(after.assessment.status).toBe(TRUST.OK);
    expect(after.devices.every((d) => !d.pending)).toBe(true);
  });

  test("chat device lists report who has new devices, including whether they were verified", async () => {
    const store = createKeyStore(createMemoryAdapter());
    const trust = createTrustTracker(store);
    const alice = await makeIdentity("alice");
    const bob1 = await makeIdentity("bob");
    const bob2 = await makeIdentity("bob");
    let devices = [
      { ...alice.record, username: "alice" },
      { ...bob1.record, username: "bob" },
    ];
    const api = { fetchChatDevices: vi.fn(async () => ({ devices, membersWithoutDevice: [] })) };
    const dir = createDirectory({ api, trust });

    const first = await dir.getChatDevices("chat");
    expect(first.changes).toEqual([]);

    await trust.setVerified("bob", "999", true, [bob1.record]);
    devices = [...devices, { ...bob2.record, username: "bob" }];
    for (let i = 0; i < 2; i += 1) {
      // Reported every time, not only on the first fetch.
      const next = await dir.getChatDevices("chat");
      expect(next.changes).toEqual([
        { userId: "bob", username: "bob", added: [bob2.record.id], verified: true },
      ]);
      expect(next.devices.find((d) => d.id === bob2.record.id).pending).toBe(true);
      expect(next.devices.find((d) => d.id === bob1.record.id).pending).toBe(false);
    }
  });

  test("a revoked device is found only when asked for, and is never pinned or listed", async () => {
    const trust = createTrustTracker(createKeyStore(createMemoryAdapter()));
    const bob = await makeIdentity("bob");
    const old = await makeIdentity("bob");
    const api = {
      fetchUserDevices: vi.fn(async (_userId, { deviceId } = {}) => ({
        devices: [bob.record, ...(deviceId === old.record.id ? [{ ...old.record, revokedAt: "2024-01-01" }] : [])],
      })),
    };
    const dir = createDirectory({ api, trust });
    expect(await dir.findDevice("bob", old.record.id)).toBeNull();
    const found = await dir.findDevice("bob", old.record.id, { allowRevoked: true, chatId: "c" });
    expect(found.id).toBe(old.record.id);
    // Never seen while it was active: nothing vouches for these keys.
    expect(found.pending).toBe(true);
    expect(api.fetchUserDevices).toHaveBeenLastCalledWith("bob", { chatId: "c", deviceId: old.record.id });
    expect((await dir.getUserDevices("bob", { force: true })).devices.map((d) => d.id)).toEqual([bob.record.id]);
  });

  test("a device we pinned before it was revoked still counts as known, but only with the keys we pinned", async () => {
    const trust = createTrustTracker(createKeyStore(createMemoryAdapter()));
    const bob = await makeIdentity("bob");
    const old = await makeIdentity("bob");
    const forged = { ...(await makeIdentity("bob")).record, id: old.record.id };
    let listed = [bob.record, old.record];
    let revoked = null;
    const api = {
      fetchUserDevices: vi.fn(async () => ({
        devices: [...listed, ...(revoked ? [{ ...revoked, revokedAt: "2024-01-01" }] : [])],
      })),
    };
    const dir = createDirectory({ api, trust });
    await dir.getUserDevices("bob"); // pins both
    listed = [bob.record]; // `old` is revoked and drops out of the listing
    await dir.getUserDevices("bob", { force: true });

    revoked = old.record;
    expect((await dir.findDevice("bob", old.record.id, { allowRevoked: true })).pending).toBe(false);

    // The server invents a "revoked" device under the same id with other keys.
    revoked = forged;
    expect((await dir.findDevice("bob", old.record.id, { allowRevoked: true })).pending).toBe(true);
  });

  test("findDevice re-fetches once when the device is new", async () => {
    const trust = createTrustTracker(createKeyStore(createMemoryAdapter()));
    const bob1 = await makeIdentity("bob");
    const bob2 = await makeIdentity("bob");
    let list = [bob1.record];
    const api = { fetchUserDevices: vi.fn(async () => ({ devices: list })) };
    const dir = createDirectory({ api, trust });
    await dir.getUserDevices("bob");
    list = [bob1.record, bob2.record];
    expect((await dir.findDevice("bob", bob2.record.id)).id).toBe(bob2.record.id);
    expect(await dir.findDevice("bob", "00000000-0000-4000-8000-000000000000")).toBeNull();
  });
});

describe("loadOrCreateIdentity", () => {
  test("creates keys once, registers them and reuses the same device afterwards", async () => {
    const store = createKeyStore(createMemoryAdapter());
    let n = 0;
    const api = {
      registerDevice: vi.fn(async ({ deviceId }) => ({
        device: { id: deviceId || `00000000-0000-4000-8000-00000000000${++n}` },
      })),
    };
    const first = await loadOrCreateIdentity({ userId: "alice", api, store, label: "Test" });
    const again = await loadOrCreateIdentity({ userId: "alice", api, store, label: "Test" });
    expect(again.deviceId).toBe(first.deviceId);
    expect(again.ecdhPublic).toBe(first.ecdhPublic);
    expect(api.registerDevice.mock.calls[1][0].deviceId).toBe(first.deviceId);
  });

  test("private keys are not extractable", async () => {
    const store = createKeyStore(createMemoryAdapter());
    const api = { registerDevice: async () => ({ device: { id: "00000000-0000-4000-8000-000000000001" } }) };
    const id = await loadOrCreateIdentity({ userId: "alice", api, store });
    expect(id.keys.ecdh.privateKey.extractable).toBe(false);
    expect(id.keys.ecdsa.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("pkcs8", id.keys.ecdsa.privateKey)).rejects.toThrow();
  });

  test("an already registered device keeps working when only the 'last seen' refresh fails", async () => {
    const store = createKeyStore(createMemoryAdapter());
    const api = {
      registerDevice: vi
        .fn()
        .mockResolvedValueOnce({ device: { id: "00000000-0000-4000-8000-000000000001" } })
        .mockRejectedValueOnce(new Error("429")),
    };
    const first = await loadOrCreateIdentity({ userId: "alice", api, store });
    const again = await loadOrCreateIdentity({ userId: "alice", api, store });
    expect(again.deviceId).toBe(first.deviceId);
    expect(again.keys.ecdsa.privateKey).toBe(first.keys.ecdsa.privateKey);
  });

  test("keeps the keys when registration fails, and registers the same keys next time", async () => {
    const store = createKeyStore(createMemoryAdapter());
    const api = { registerDevice: vi.fn().mockRejectedValueOnce(new Error("offline")) };
    await expect(loadOrCreateIdentity({ userId: "alice", api, store })).rejects.toThrow("offline");
    const saved = await store.getIdentity("alice");
    expect(saved.keys).toBeTruthy();
    api.registerDevice.mockResolvedValueOnce({ device: { id: "00000000-0000-4000-8000-000000000002" } });
    const id = await loadOrCreateIdentity({ userId: "alice", api, store });
    expect(id.keys.ecdsa.publicKey).toBe(saved.keys.ecdsa.publicKey);
  });

  test("adopts a new device id when the server no longer knows the old one", async () => {
    const store = createKeyStore(createMemoryAdapter());
    const api = {
      registerDevice: vi
        .fn()
        .mockResolvedValueOnce({ device: { id: "00000000-0000-4000-8000-000000000001" } })
        .mockResolvedValueOnce({ device: { id: "00000000-0000-4000-8000-000000000009" } }),
    };
    await loadOrCreateIdentity({ userId: "alice", api, store });
    const again = await loadOrCreateIdentity({ userId: "alice", api, store });
    expect(again.deviceId).toBe("00000000-0000-4000-8000-000000000009");
    expect((await store.getIdentity("alice")).deviceId).toBe("00000000-0000-4000-8000-000000000009");
  });
});
