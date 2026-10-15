import { describe, test, expect } from "vitest";
import { computeSafetyNumber, deviceFingerprint } from "../../src/e2ee/safetyNumber.js";
import { sasEmoji } from "../../src/e2ee/sas.js";
import { SAS_EMOJI } from "../../src/e2ee/sasEmoji.js";
import { makeIdentity } from "./helpers.js";

describe("computeSafetyNumber", () => {
  test("both people compute the identical 60-digit number", async () => {
    const alice = await makeIdentity("user-alice");
    const bob = await makeIdentity("user-bob");
    const a = await computeSafetyNumber({
      selfUserId: "user-alice", selfDevices: [alice.record],
      peerUserId: "user-bob", peerDevices: [bob.record],
    });
    const b = await computeSafetyNumber({
      selfUserId: "user-bob", selfDevices: [bob.record],
      peerUserId: "user-alice", peerDevices: [alice.record],
    });
    expect(a.digits).toBe(b.digits);
    expect(a.digits).toMatch(/^\d{60}$/);
    expect(a.groups).toHaveLength(12);
  });

  test("does not depend on device order", async () => {
    const alice1 = await makeIdentity("user-alice");
    const alice2 = await makeIdentity("user-alice");
    const bob = await makeIdentity("user-bob");
    const args = { selfUserId: "user-bob", selfDevices: [bob.record], peerUserId: "user-alice" };
    const a = await computeSafetyNumber({ ...args, peerDevices: [alice1.record, alice2.record] });
    const b = await computeSafetyNumber({ ...args, peerDevices: [alice2.record, alice1.record] });
    expect(a.digits).toBe(b.digits);
  });

  test("changes when a device is added (resets verification)", async () => {
    const alice = await makeIdentity("user-alice");
    const alice2 = await makeIdentity("user-alice");
    const bob = await makeIdentity("user-bob");
    const base = { selfUserId: "user-bob", selfDevices: [bob.record], peerUserId: "user-alice" };
    const before = await computeSafetyNumber({ ...base, peerDevices: [alice.record] });
    const after = await computeSafetyNumber({ ...base, peerDevices: [alice.record, alice2.record] });
    expect(after.digits).not.toBe(before.digits);
  });

  test("changes when a key is swapped for another person", async () => {
    const alice = await makeIdentity("user-alice");
    const mallory = await makeIdentity("user-alice");
    const bob = await makeIdentity("user-bob");
    const base = { selfUserId: "user-bob", selfDevices: [bob.record], peerUserId: "user-alice" };
    const real = await computeSafetyNumber({ ...base, peerDevices: [alice.record] });
    const forged = await computeSafetyNumber({ ...base, peerDevices: [mallory.record] });
    expect(forged.digits).not.toBe(real.digits);
  });

  test("needs devices on both sides", async () => {
    const bob = await makeIdentity("user-bob");
    await expect(
      computeSafetyNumber({ selfUserId: "b", selfDevices: [bob.record], peerUserId: "a", peerDevices: [] }),
    ).rejects.toThrow();
  });
});

describe("deviceFingerprint", () => {
  test("is stable and depends on both keys", async () => {
    const a = await makeIdentity();
    const fp = await deviceFingerprint(a.record);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(await deviceFingerprint(a.record)).toBe(fp);
    const swapped = { ...a.record, ecdsaPublic: (await makeIdentity()).record.ecdsaPublic };
    expect(await deviceFingerprint(swapped)).not.toBe(fp);
  });
});

describe("SAS emoji", () => {
  test("table has 256 distinct single-symbol entries", () => {
    expect(SAS_EMOJI).toHaveLength(256);
    expect(new Set(SAS_EMOJI).size).toBe(256);
    SAS_EMOJI.forEach((e) => expect([...e]).toHaveLength(1));
  });

  test("maps bytes to emoji deterministically", () => {
    const out = sasEmoji(new Uint8Array([0, 1, 254, 255]));
    expect(out).toEqual([SAS_EMOJI[0], SAS_EMOJI[1], SAS_EMOJI[254], SAS_EMOJI[255]]);
  });

  test("needs enough material", () => {
    expect(() => sasEmoji(new Uint8Array(2))).toThrow();
  });
});
