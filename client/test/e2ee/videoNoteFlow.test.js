import { describe, test, expect, beforeEach, vi } from "vitest";
import { friendlyVideoNoteError, NoRecipientsError, prepareVideoNoteUpload } from "../../src/videoNote/send.js";
import {
  ciphertextUrl,
  friendlyDecryptError,
  loadVideoNote,
  loadVideoNotePoster,
  videoNoteKey,
} from "../../src/videoNote/receive.js";
import {
  clearRememberedVideoNotes,
  getRememberedVideoNote,
  rememberVideoNote,
} from "../../src/videoNote/localCache.js";
import {
  formatDurationMs,
  normalizeContainer,
  pickRecorderFormat,
  VIDEO_BITS_PER_SECOND,
} from "../../src/videoNote/config.js";
import { KeyMismatchError } from "../../src/e2ee/directory.js";
import { bytesEqual, randomBytes } from "../../src/e2ee/encoding.js";
import { makeIdentity } from "./helpers.js";

const blobBytes = async (url) => new Uint8Array(await (await fetch(url)).arrayBuffer());

describe("pickRecorderFormat", () => {
  test("prefers hardware H.264 MP4, then VP8, then VP9, then anything", () => {
    const only = (...supported) => (m) => supported.includes(m);
    expect(pickRecorderFormat(() => true).mimeType).toContain("avc1.42E01E");
    expect(pickRecorderFormat(only("video/webm;codecs=vp8,opus", "video/webm;codecs=vp9,opus")).mimeType).toBe(
      "video/webm;codecs=vp8,opus",
    );
    expect(pickRecorderFormat(only("video/webm;codecs=vp9,opus")).mimeType).toBe("video/webm;codecs=vp9,opus");
    expect(pickRecorderFormat(only("video/webm")).container).toBe("video/webm");
    expect(pickRecorderFormat(() => false)).toBeNull();
  });
  test("uses a small bitrate and survives a throwing isTypeSupported", () => {
    const format = pickRecorderFormat((m) => {
      if (m.startsWith("video/mp4")) throw new Error("boom");
      return true;
    });
    expect(format.container).toBe("video/webm");
    expect(format.videoBitsPerSecond).toBe(VIDEO_BITS_PER_SECOND);
    expect(format.videoBitsPerSecond).toBeLessThanOrEqual(400_000);
  });
  test("normalizeContainer / formatDurationMs", () => {
    expect(normalizeContainer("video/mp4;codecs=avc1")).toBe("video/mp4");
    expect(normalizeContainer("application/x-evil")).toBe("video/webm");
    expect(formatDurationMs(0)).toBe("0:00");
    expect(formatDurationMs(61_400)).toBe("1:01");
  });
});

describe("localCache", () => {
  beforeEach(() => clearRememberedVideoNotes());

  test("keeps a bounded number of entries and revokes evicted blob URLs", () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    for (let i = 0; i < 9; i += 1) rememberVideoNote(`k${i}`, { url: `blob:${i}`, posterUrl: `blob:p${i}` });
    expect(getRememberedVideoNote("k0")).toBeNull();
    expect(getRememberedVideoNote("k8")).toBeTruthy();
    expect(revoke).toHaveBeenCalledWith("blob:0");
    expect(revoke).toHaveBeenCalledWith("blob:p0");
    revoke.mockRestore();
  });

  test("reading refreshes recency", () => {
    for (let i = 0; i < 6; i += 1) rememberVideoNote(`k${i}`, { url: `blob:${i}` });
    getRememberedVideoNote("k0");
    rememberVideoNote("k6", { url: "blob:6" });
    expect(getRememberedVideoNote("k0")).toBeTruthy();
    expect(getRememberedVideoNote("k1")).toBeNull();
  });
});

describe("encrypted video message round trip", () => {
  let alice;
  let bob;
  let carol;
  let devices;
  let aliceServices;
  let bobServices;
  let note;
  let membersWithoutDevice;

  const servicesFor = (who) => ({
    getIdentity: async () => who.identity,
    directory: {
      getChatDevices: vi.fn(async () => ({ devices, membersWithoutDevice })),
      findDevice: vi.fn(async (userId, deviceId) => devices.find((d) => d.userId === userId && d.id === deviceId) || null),
    },
  });

  beforeEach(async () => {
    clearRememberedVideoNotes();
    alice = await makeIdentity("alice");
    bob = await makeIdentity("bob");
    carol = await makeIdentity("carol");
    devices = [alice.record, bob.record];
    membersWithoutDevice = [];
    aliceServices = servicesFor(alice);
    bobServices = servicesFor(bob);
    note = {
      blob: new Blob([randomBytes(50_000)], { type: "video/mp4" }),
      mime: "video/mp4;codecs=avc1",
      durationMs: 7300,
      posterBlob: new Blob([randomBytes(700)], { type: "image/jpeg" }),
    };
  });

  const asMessage = (prepared, extra = {}) => ({
    id: "m1",
    clientRequestId: "client-1",
    user_id: "alice",
    e2ee: prepared.envelope,
    files: [{ url: "/api/uploads/messages/x.bin" }],
    ...extra,
  });

  test("bob decrypts what alice sent, and the server-visible file is opaque", async () => {
    const prepared = await prepareVideoNoteUpload({
      chatId: "chat", user: { id: "alice" }, note, services: aliceServices,
    });
    expect(prepared.ciphertext.type).toBe("application/octet-stream");
    expect(prepared.envelope.mime).toBe("video/mp4");
    const cipherBytes = new Uint8Array(await prepared.ciphertext.arrayBuffer());
    expect(cipherBytes.length).toBe(50_000 + 16);

    const fetchCiphertext = vi.fn(async () => cipherBytes);
    const loaded = await loadVideoNote({
      msg: asMessage(prepared), user: { id: "bob" }, services: bobServices, fetchCiphertext,
    });
    expect(loaded.durationMs).toBe(7300);
    expect(loaded.posterUrl).toMatch(/^blob:/);
    expect(bytesEqual(await blobBytes(loaded.url), new Uint8Array(await note.blob.arrayBuffer()))).toBe(true);
  });

  test("the second view reuses the decrypted copy without downloading again", async () => {
    const prepared = await prepareVideoNoteUpload({ chatId: "c", user: { id: "alice" }, note, services: aliceServices });
    const cipherBytes = new Uint8Array(await prepared.ciphertext.arrayBuffer());
    const fetchCiphertext = vi.fn(async () => cipherBytes);
    const args = { msg: asMessage(prepared), user: { id: "bob" }, services: bobServices, fetchCiphertext };
    const first = await loadVideoNote(args);
    const second = await loadVideoNote(args);
    expect(second.url).toBe(first.url);
    expect(fetchCiphertext).toHaveBeenCalledTimes(1);
  });

  test("the poster is available without downloading the video", async () => {
    const prepared = await prepareVideoNoteUpload({ chatId: "c", user: { id: "alice" }, note, services: aliceServices });
    const url = await loadVideoNotePoster({ msg: asMessage(prepared), user: { id: "bob" }, services: bobServices });
    expect(url).toMatch(/^blob:/);
    expect(bytesEqual(await blobBytes(url), new Uint8Array(await note.posterBlob.arrayBuffer()))).toBe(true);
  });

  test("a device added after sending cannot open it, and says why", async () => {
    const prepared = await prepareVideoNoteUpload({ chatId: "c", user: { id: "alice" }, note, services: aliceServices });
    const cipherBytes = new Uint8Array(await prepared.ciphertext.arrayBuffer());
    const bobLaptop = await makeIdentity("bob");
    devices.push(bobLaptop.record);
    await expect(
      loadVideoNote({
        msg: asMessage(prepared), user: { id: "bob" }, services: servicesFor(bobLaptop),
        fetchCiphertext: async () => cipherBytes,
      }),
    ).rejects.toMatchObject({ code: "no_key" });
    expect(friendlyDecryptError({ code: "no_key" })).toMatch(/before this device/);
  });

  test("a server that serves different bytes is detected", async () => {
    const prepared = await prepareVideoNoteUpload({ chatId: "c", user: { id: "alice" }, note, services: aliceServices });
    const cipherBytes = new Uint8Array(await prepared.ciphertext.arrayBuffer());
    cipherBytes[10] ^= 1;
    await expect(
      loadVideoNote({
        msg: asMessage(prepared), user: { id: "bob" }, services: bobServices, fetchCiphertext: async () => cipherBytes,
      }),
    ).rejects.toMatchObject({ code: "bad_signature" });
  });

  test("a message attributed to a different author is rejected", async () => {
    const prepared = await prepareVideoNoteUpload({ chatId: "c", user: { id: "alice" }, note, services: aliceServices });
    const cipherBytes = new Uint8Array(await prepared.ciphertext.arrayBuffer());
    // Server claims carol sent it; carol has no such device.
    await expect(
      loadVideoNote({
        msg: asMessage(prepared, { user_id: "carol" }), user: { id: "bob" }, services: bobServices,
        fetchCiphertext: async () => cipherBytes,
      }),
    ).rejects.toMatchObject({ code: "unknown_sender" });
  });

  test("the sender's own copy plays from the local cache with no download", async () => {
    rememberVideoNote("client-1", { url: "blob:local", posterUrl: null, durationMs: 1 });
    const fetchCiphertext = vi.fn();
    const out = await loadVideoNote({
      msg: { clientRequestId: "client-1", files: [{ url: "/x" }] }, user: { id: "alice" }, services: aliceServices, fetchCiphertext,
    });
    expect(out.url).toBe("blob:local");
    expect(fetchCiphertext).not.toHaveBeenCalled();
  });

  test("a DM with a contact who has no device is refused with a helpful message", async () => {
    devices = [alice.record];
    membersWithoutDevice = [{ userId: "bob", username: "bob" }];
    const error = await prepareVideoNoteUpload({
      chatId: "c", user: { id: "alice" }, note, services: servicesFor(alice),
    }).catch((e) => e);
    expect(error).toBeInstanceOf(NoRecipientsError);
    expect(friendlyVideoNoteError(error)).toContain("bob");
  });

  test("saved messages (only yourself) work without another recipient", async () => {
    devices = [alice.record];
    const prepared = await prepareVideoNoteUpload({
      chatId: "saved", user: { id: "alice" }, note, services: servicesFor(alice), isSavedChat: true,
    });
    expect(prepared.envelope.keys).toHaveLength(1);
  });

  test("groups warn about members who cannot watch yet but still send", async () => {
    devices = [alice.record, bob.record];
    membersWithoutDevice = [{ userId: "carol", username: "carol" }];
    const prepared = await prepareVideoNoteUpload({
      chatId: "g", user: { id: "alice" }, note, services: servicesFor(alice),
    });
    expect(prepared.warnings).toHaveLength(1);
    expect(prepared.warnings[0]).toContain("carol");
    void carol;
  });

  test("every device of every member gets a wrapped key, including the sender's other devices", async () => {
    const aliceTablet = await makeIdentity("alice");
    const bobTablet = await makeIdentity("bob");
    devices = [alice.record, aliceTablet.record, bob.record, bobTablet.record];
    const prepared = await prepareVideoNoteUpload({ chatId: "c", user: { id: "alice" }, note, services: aliceServices });
    expect(prepared.envelope.keys.map((k) => k.deviceId).sort()).toEqual(devices.map((d) => d.id).sort());
  });

  test("key mismatches from the directory abort sending with a clear message", async () => {
    const services = {
      getIdentity: async () => alice.identity,
      directory: { getChatDevices: async () => { throw new KeyMismatchError("bob", ["d"]); } },
    };
    const error = await prepareVideoNoteUpload({ chatId: "c", user: { id: "alice" }, note, services }).catch((e) => e);
    expect(friendlyVideoNoteError(error)).toMatch(/security keys changed/);
  });
});

describe("receive helpers", () => {
  test("videoNoteKey prefers the client request id so local and server copies match", () => {
    expect(videoNoteKey({ clientRequestId: "c1", id: "s1" })).toBe("c1");
    expect(videoNoteKey({ id: "s1" })).toBe("s1");
  });
  test("ciphertextUrl reads the first file", () => {
    expect(ciphertextUrl({ files: [{ url: "/a" }] })).toBe("/a");
    expect(ciphertextUrl({ files: [] })).toBeNull();
  });
  test("friendlyDecryptError never exposes internals and is silent on abort", () => {
    expect(friendlyDecryptError({ code: "bad_signature" })).toMatch(/tampered/);
    expect(friendlyDecryptError({ name: "AbortError" })).toBe("");
    expect(friendlyDecryptError(new Error("x"))).toMatch(/Could not load/);
  });
});
