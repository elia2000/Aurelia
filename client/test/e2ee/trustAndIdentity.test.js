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

  test("a new device is reported once and then accepted", async () => {
    const bob1 = await makeIdentity("bob");
    const bob2 = await makeIdentity("bob");
    await trust.assess("bob", [bob1.record]);
    const result = await trust.assess("bob", [bob1.record, bob2.record]);
    expect(result.status).toBe(TRUST.DEVICES_ADDED);
    expect(result.added).toEqual([bob2.record.id]);
    expect((await trust.assess("bob", [bob1.record, bob2.record])).status).toBe(TRUST.OK);
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
});

describe("directory", () => {
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
