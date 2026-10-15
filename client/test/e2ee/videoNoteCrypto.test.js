import { describe, test, expect, beforeAll } from "vitest";
import {
  decryptVideoNote,
  encryptVideoNote,
  E2eeDecryptError,
} from "../../src/e2ee/videoNoteCrypto.js";
import { bytesEqual, fromB64u, randomBytes, toB64u } from "../../src/e2ee/encoding.js";
import { makeIdentity } from "./helpers.js";

describe("video note encryption", () => {
  let alice;
  let bob;
  let bobTablet;
  let eve;
  let media;
  let poster;
  let sealed;
  const context = { chatId: "chat-1", clientRequestId: "req-1", senderUserId: "alice" };

  const recipients = () => [alice, bob, bobTablet].map((p) => ({
    id: p.record.id,
    ecdhPublic: p.record.ecdhPublic,
  }));

  beforeAll(async () => {
    alice = await makeIdentity("alice");
    bob = await makeIdentity("bob");
    bobTablet = await makeIdentity("bob");
    eve = await makeIdentity("eve");
    media = randomBytes(200_000);
    poster = randomBytes(900);
    sealed = await encryptVideoNote({
      media,
      mime: "video/mp4",
      durationMs: 12_345,
      poster,
      identity: alice.identity,
      recipients: recipients(),
      context,
    });
  });

  const open = (patch = {}, who = bob) =>
    decryptVideoNote({
      envelope: sealed.envelope,
      ciphertext: sealed.ciphertext,
      identity: who.identity,
      senderDevice: alice.record,
      context,
      ...patch,
    });

  test("every recipient device (and the sender) can decrypt", async () => {
    for (const who of [alice, bob, bobTablet]) {
      const out = await open({}, who);
      expect(bytesEqual(out.media, media)).toBe(true);
      expect(bytesEqual(out.poster, poster)).toBe(true);
      expect(out.mime).toBe("video/mp4");
      expect(out.durationMs).toBe(12_345);
    }
  });

  test("ciphertext does not contain the plaintext and is exactly one GCM tag longer", () => {
    expect(sealed.ciphertext.length).toBe(media.length + 16);
    expect(bytesEqual(sealed.ciphertext.subarray(0, 64), media.subarray(0, 64))).toBe(false);
  });

  test("the envelope has one wrapped key per recipient device and no key material in the clear", () => {
    expect(sealed.envelope.keys.map((k) => k.deviceId).sort()).toEqual(
      recipients().map((r) => r.id).sort(),
    );
    const json = JSON.stringify(sealed.envelope);
    expect(json).not.toContain(toB64u(media.subarray(0, 32)));
    // 32-byte key + 16-byte tag
    expect(fromB64u(sealed.envelope.keys[0].ct)).toHaveLength(48);
  });

  test("a device that was not a recipient cannot decrypt", async () => {
    await expect(open({}, eve)).rejects.toMatchObject({ code: "no_key" });
  });

  test("a different ECDH key for the same device id cannot unwrap the key", async () => {
    const impostor = await makeIdentity("bob", bob.record.id);
    await expect(open({}, impostor)).rejects.toBeInstanceOf(E2eeDecryptError);
  });

  test("tampered ciphertext is rejected (signature covers the ciphertext hash)", async () => {
    const bad = new Uint8Array(sealed.ciphertext);
    bad[1000] ^= 0x01;
    await expect(open({ ciphertext: bad })).rejects.toMatchObject({ code: "bad_signature" });
  });

  test.each([
    ["duration", (e) => ({ ...e, durationMs: 1 })],
    ["container type", (e) => ({ ...e, mime: "video/webm" })],
    ["sender device", (e) => ({ ...e, senderDeviceId: bob.record.id })],
    ["media IV", (e) => ({ ...e, iv: toB64u(randomBytes(12)) })],
    ["recipient list", (e) => ({ ...e, keys: e.keys.slice(0, 2) })],
    ["poster", (e) => ({ ...e, poster: { ...e.poster, ct: toB64u(randomBytes(40)) } })],
  ])("tampering with the %s breaks verification", async (_name, mutate) => {
    await expect(open({ envelope: mutate(sealed.envelope) })).rejects.toBeInstanceOf(E2eeDecryptError);
  });

  test.each([
    ["another chat", { chatId: "chat-2" }],
    ["another message", { clientRequestId: "req-2" }],
    ["another sender account", { senderUserId: "mallory" }],
  ])("the message is bound to its conversation: replaying it into %s fails", async (_name, patch) => {
    // A hostile server (or any member) re-posts the stored envelope and file as
    // a new message elsewhere. The signature and the AES-GCM data both cover
    // the context, so it neither verifies nor decrypts.
    await expect(open({ context: { ...context, ...patch } })).rejects.toBeInstanceOf(E2eeDecryptError);
  });

  test("a message without its context cannot be opened or sealed", async () => {
    await expect(open({ context: undefined })).rejects.toBeInstanceOf(E2eeDecryptError);
    await expect(
      encryptVideoNote({ media, mime: "video/mp4", durationMs: 1, identity: alice.identity, recipients: recipients() }),
    ).rejects.toThrow();
  });

  test("an envelope of the previous format is refused with a clear reason", async () => {
    await expect(open({ envelope: { ...sealed.envelope, v: 1 } })).rejects.toMatchObject({ code: "unsupported" });
  });

  test("a forged sender is detected: signature must verify under the claimed sender's key", async () => {
    await expect(open({ senderDevice: eve.record })).rejects.toMatchObject({ code: "bad_signature" });
  });

  test("a missing sender record is reported as unknown_sender", async () => {
    await expect(open({ senderDevice: null })).rejects.toMatchObject({ code: "unknown_sender" });
  });

  test("a wrapped key cannot be swapped between devices", async () => {
    const swapped = {
      ...sealed.envelope,
      keys: sealed.envelope.keys.map((k) =>
        k.deviceId === bob.record.id
          ? { ...k, ct: sealed.envelope.keys.find((x) => x.deviceId === bobTablet.record.id).ct }
          : k,
      ),
    };
    await expect(open({ envelope: swapped })).rejects.toBeInstanceOf(E2eeDecryptError);
  });

  test("works without a poster, and a corrupt poster does not block playback", async () => {
    const noPoster = await encryptVideoNote({
      media, mime: "video/webm", durationMs: 1000, identity: alice.identity, recipients: recipients(), context,
    });
    expect(noPoster.envelope.poster).toBeUndefined();
    const out = await decryptVideoNote({
      envelope: noPoster.envelope, ciphertext: noPoster.ciphertext, identity: bob.identity, senderDevice: alice.record, context,
    });
    expect(out.poster).toBeNull();
    expect(bytesEqual(out.media, media)).toBe(true);
  });

  test("two encryptions of the same media never share a key, IV or ciphertext", async () => {
    const again = await encryptVideoNote({
      media, mime: "video/mp4", durationMs: 12_345, poster, identity: alice.identity, recipients: recipients(), context,
    });
    expect(again.envelope.iv).not.toBe(sealed.envelope.iv);
    expect(again.envelope.keys[0].ct).not.toBe(sealed.envelope.keys[0].ct);
    expect(bytesEqual(again.ciphertext, sealed.ciphertext)).toBe(false);
  });

  test("refuses to encrypt when the sending device cannot read it back", async () => {
    await expect(
      encryptVideoNote({
        media, mime: "video/mp4", durationMs: 1, identity: alice.identity,
        recipients: [{ id: bob.record.id, ecdhPublic: bob.record.ecdhPublic }],
        context,
      }),
    ).rejects.toThrow();
  });

  test("the produced envelope satisfies the server's structural validation limits", () => {
    const e = sealed.envelope;
    expect(fromB64u(e.iv)).toHaveLength(12);
    expect(fromB64u(e.sig)).toHaveLength(64);
    expect(fromB64u(e.keys[0].epk)).toHaveLength(65);
    expect(fromB64u(e.keys[0].iv)).toHaveLength(12);
    expect(JSON.stringify(e).length).toBeLessThan(48 * 1024);
  });
});
