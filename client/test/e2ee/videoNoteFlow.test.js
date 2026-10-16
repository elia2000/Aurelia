import { describe, test, expect, beforeEach, vi } from "vitest";
import {
  DevicesChangedError,
  friendlyVideoNoteError,
  MAX_RECIPIENT_DEVICES,
  NoRecipientsError,
  prepareVideoNoteUpload,
  TooManyRecipientsError,
} from "../../src/videoNote/send.js";
import {
  ciphertextUrl,
  clearVideoNoteCaches,
  friendlyDecryptError,
  loadVideoNote,
  loadVideoNotePoster,
  videoNoteContext,
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
import { createDirectory, KeyMismatchError } from "../../src/e2ee/directory.js";
import { createKeyStore, createMemoryAdapter } from "../../src/e2ee/keyStore.js";
import { createTrustTracker } from "../../src/e2ee/trust.js";
import { ApiError } from "../../src/api/e2eeApi.js";
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
  let devices; // every registered device, as the server lists them (may carry revokedAt)
  let membership; // chatId -> userIds
  let dmPairs; // pairs with a direct chat
  let membersWithoutDevice;
  let note;

  /**
   * A person's view of the world: the REAL directory and trust tracker over a
   * fake server that applies the same access rule as the real one (a peer's
   * keys need a direct chat, or a shared chat that is named in the request).
   */
  const servicesFor = (who, selfId) => {
    const trust = createTrustTracker(createKeyStore(createMemoryAdapter()));
    const active = () => devices.filter((d) => !d.revokedAt);
    const allowed = (userId, chatId) =>
      userId === selfId ||
      dmPairs.some((pair) => pair.includes(selfId) && pair.includes(userId)) ||
      Boolean(chatId && membership[chatId]?.includes(selfId) && membership[chatId]?.includes(userId));
    const api = {
      fetchChatDevices: vi.fn(async (chatId) => {
        if (!membership[chatId]?.includes(selfId)) throw new ApiError("Not a member", { status: 403 });
        return {
          devices: active().filter((d) => membership[chatId].includes(d.userId)).map((d) => ({ ...d, username: d.userId })),
          membersWithoutDevice,
        };
      }),
      fetchUserDevices: vi.fn(async (userId, { chatId, deviceId } = {}) => {
        if (!allowed(userId, chatId)) throw new ApiError("No shared chat with this user.", { status: 403 });
        return {
          devices: devices.filter((d) => d.userId === userId && (!d.revokedAt || d.id === deviceId)),
        };
      }),
    };
    return {
      getIdentity: async () => who.identity,
      directory: createDirectory({ api, trust, ttlMs: 0 }),
      trust,
      api,
    };
  };

  let aliceServices;
  let bobServices;

  beforeEach(async () => {
    clearVideoNoteCaches();
    alice = await makeIdentity("alice");
    bob = await makeIdentity("bob");
    carol = await makeIdentity("carol");
    devices = [alice.record, bob.record];
    membership = { chat: ["alice", "bob"], group: ["alice", "bob", "carol"], saved: ["alice"] };
    dmPairs = [["alice", "bob"]];
    membersWithoutDevice = [];
    aliceServices = servicesFor(alice, "alice");
    bobServices = servicesFor(bob, "bob");
    note = {
      blob: new Blob([randomBytes(50_000)], { type: "video/mp4" }),
      mime: "video/mp4;codecs=avc1",
      durationMs: 7300,
      posterBlob: new Blob([randomBytes(700)], { type: "image/jpeg" }),
    };
  });

  const prepare = (services = aliceServices, extra = {}) =>
    prepareVideoNoteUpload({
      chatId: "chat", clientRequestId: "client-1", user: { id: "alice" }, note, services, ...extra,
    });

  const asMessage = (prepared, extra = {}) => ({
    id: "m1",
    chat_id: "chat",
    client_request_id: "client-1",
    user_id: "alice",
    e2ee: prepared.envelope,
    files: [{ url: "/api/uploads/messages/x.bin" }],
    ...extra,
  });
  const cipherOf = async (prepared) => new Uint8Array(await prepared.ciphertext.arrayBuffer());

  test("bob decrypts what alice sent, and the server-visible file is opaque", async () => {
    const prepared = await prepare();
    expect(prepared.ciphertext.type).toBe("application/octet-stream");
    expect(prepared.envelope.mime).toBe("video/mp4");
    const cipherBytes = await cipherOf(prepared);
    expect(cipherBytes.length).toBe(50_000 + 16);

    const loaded = await loadVideoNote({
      msg: asMessage(prepared), user: { id: "bob" }, services: bobServices, fetchCiphertext: vi.fn(async () => cipherBytes),
    });
    expect(loaded.durationMs).toBe(7300);
    expect(loaded.posterUrl).toMatch(/^blob:/);
    expect(bytesEqual(await blobBytes(loaded.url), new Uint8Array(await note.blob.arrayBuffer()))).toBe(true);
  });

  test("a group member who has no direct chat with the sender can open the message", async () => {
    const prepared = await prepare(aliceServices, { chatId: "group" });
    expect(prepared.envelope.keys).toHaveLength(2); // carol has no device yet
    devices.push(carol.record);
    const prepared2 = await prepare(aliceServices, { chatId: "group", clientRequestId: "client-2" });
    const carolServices = servicesFor(carol, "carol"); // no DM with anyone
    const loaded = await loadVideoNote({
      msg: asMessage(prepared2, { chat_id: "group", client_request_id: "client-2" }),
      user: { id: "carol" },
      services: carolServices,
      fetchCiphertext: async () => cipherOf(prepared2),
    });
    expect(bytesEqual(await blobBytes(loaded.url), new Uint8Array(await note.blob.arrayBuffer()))).toBe(true);
    // The lookup named the chat; without it the server would have said no.
    expect(carolServices.api.fetchUserDevices).toHaveBeenCalledWith("alice", expect.objectContaining({ chatId: "group" }));
    await expect(carolServices.api.fetchUserDevices("alice", {})).rejects.toMatchObject({ status: 403 });
  });

  test("the second view reuses the decrypted copy without downloading again", async () => {
    const prepared = await prepare();
    const fetchCiphertext = vi.fn(async () => cipherOf(prepared));
    const args = { msg: asMessage(prepared), user: { id: "bob" }, services: bobServices, fetchCiphertext };
    const first = await loadVideoNote(args);
    const second = await loadVideoNote(args);
    expect(second.url).toBe(first.url);
    expect(fetchCiphertext).toHaveBeenCalledTimes(1);
  });

  test("the poster is available without downloading the video", async () => {
    const prepared = await prepare();
    const url = await loadVideoNotePoster({ msg: asMessage(prepared), user: { id: "bob" }, services: bobServices });
    expect(url).toMatch(/^blob:/);
    expect(bytesEqual(await blobBytes(url), new Uint8Array(await note.posterBlob.arrayBuffer()))).toBe(true);
  });

  test("a device added after sending cannot open it, and says why", async () => {
    const prepared = await prepare();
    const bobLaptop = await makeIdentity("bob");
    devices.push(bobLaptop.record);
    await expect(
      loadVideoNote({
        msg: asMessage(prepared), user: { id: "bob" }, services: servicesFor(bobLaptop, "bob"),
        fetchCiphertext: async () => cipherOf(prepared),
      }),
    ).rejects.toMatchObject({ code: "no_key" });
    expect(friendlyDecryptError({ code: "no_key" })).toMatch(/before this device/);
  });

  test("a server that serves different bytes is detected", async () => {
    const prepared = await prepare();
    const cipherBytes = await cipherOf(prepared);
    cipherBytes[10] ^= 1;
    await expect(
      loadVideoNote({ msg: asMessage(prepared), user: { id: "bob" }, services: bobServices, fetchCiphertext: async () => cipherBytes }),
    ).rejects.toMatchObject({ code: "bad_signature" });
  });

  test("a message attributed to a different author is rejected", async () => {
    const prepared = await prepare();
    // The server claims carol sent it; carol has no such device.
    await expect(
      loadVideoNote({
        msg: asMessage(prepared, { user_id: "carol" }), user: { id: "bob" }, services: servicesFor(bob, "bob"),
        fetchCiphertext: async () => cipherOf(prepared),
      }),
    ).rejects.toMatchObject({ code: "unknown_sender" });
  });

  test("a stored message cannot be replayed into another chat or as another message", async () => {
    const prepared = await prepare();
    const fetchCiphertext = async () => cipherOf(prepared);
    for (const patch of [{ chat_id: "elsewhere" }, { client_request_id: "client-9" }]) {
      await expect(
        loadVideoNote({ msg: asMessage(prepared, patch), user: { id: "bob" }, services: servicesFor(bob, "bob"), fetchCiphertext }),
      ).rejects.toMatchObject({ code: "bad_signature" });
    }
  });

  test("a member cannot make their video appear in place of someone else's by reusing a request id", async () => {
    // Mallory (a group member) reuses the client request id of Alice's message.
    const mallory = await makeIdentity("mallory");
    devices.push(mallory.record);
    membership.group.push("mallory");
    dmPairs.push(["mallory", "bob"]);
    const malloryServices = servicesFor(mallory, "mallory");
    const aliceNote = await prepare(aliceServices, { chatId: "group", clientRequestId: "same-id" });
    const mallNote = {
      ...note,
      blob: new Blob([randomBytes(50_000)], { type: "video/mp4" }),
    };
    const malloryNote = await prepareVideoNoteUpload({
      chatId: "group", clientRequestId: "same-id", user: { id: "mallory" }, note: mallNote, services: malloryServices,
    });

    const bobSees = (prepared, who) =>
      loadVideoNote({
        msg: asMessage(prepared, { chat_id: "group", client_request_id: "same-id", user_id: who }),
        user: { id: "bob" },
        services: bobServices,
        fetchCiphertext: async () => cipherOf(prepared),
      });
    const fromMallory = await bobSees(malloryNote, "mallory");
    const fromAlice = await bobSees(aliceNote, "alice");
    expect(fromAlice.url).not.toBe(fromMallory.url);
    expect(bytesEqual(await blobBytes(fromAlice.url), new Uint8Array(await note.blob.arrayBuffer()))).toBe(true);
    expect(bytesEqual(await blobBytes(fromMallory.url), new Uint8Array(await mallNote.blob.arrayBuffer()))).toBe(true);
    // The previews do not collide either.
    const posterAlice = await loadVideoNotePoster({ msg: asMessage(aliceNote, { chat_id: "group", client_request_id: "same-id" }), user: { id: "bob" }, services: bobServices });
    const posterMallory = await loadVideoNotePoster({ msg: asMessage(malloryNote, { chat_id: "group", client_request_id: "same-id", user_id: "mallory" }), user: { id: "bob" }, services: bobServices });
    expect(posterAlice).not.toBe(posterMallory);
  });

  test("the sender's own copy plays from the local cache with no download", async () => {
    const prepared = await prepare();
    rememberVideoNote(videoNoteKey(asMessage(prepared)), {
      url: "blob:local", posterUrl: null, durationMs: 1,
    });
    const fetchCiphertext = vi.fn();
    const out = await loadVideoNote({
      msg: asMessage(prepared), user: { id: "alice" }, services: aliceServices, fetchCiphertext,
    });
    expect(out.url).toBe("blob:local");
    expect(fetchCiphertext).not.toHaveBeenCalled();
  });

  test("a message that was already opened is not shown again from the cache when replayed into another chat", async () => {
    const prepared = await prepare();
    const first = await loadVideoNote({
      msg: asMessage(prepared), user: { id: "bob" }, services: bobServices, fetchCiphertext: async () => cipherOf(prepared),
    });
    expect(first.url).toMatch(/^blob:/);

    // A malicious server re-posts the same envelope and file into a chat the
    // sender never wrote it in. The cache must not answer for it.
    const replay = asMessage(prepared, { chat_id: "other-chat" });
    await expect(
      loadVideoNote({ msg: replay, user: { id: "bob" }, services: bobServices, fetchCiphertext: async () => cipherOf(prepared) }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/bad_signature|corrupt/) });
    const again = asMessage(prepared, { client_request_id: "client-2" });
    await expect(
      loadVideoNote({ msg: again, user: { id: "bob" }, services: bobServices, fetchCiphertext: async () => cipherOf(prepared) }),
    ).rejects.toMatchObject({ code: "bad_signature" });
  });

  test("a DM with a contact who has no device is refused with a helpful message", async () => {
    devices = [alice.record];
    membersWithoutDevice = [{ userId: "bob", username: "bob" }];
    const error = await prepare(servicesFor(alice, "alice")).catch((e) => e);
    expect(error).toBeInstanceOf(NoRecipientsError);
    expect(friendlyVideoNoteError(error)).toContain("bob");
  });

  test("saved messages (only yourself) work without another recipient", async () => {
    devices = [alice.record];
    const prepared = await prepare(servicesFor(alice, "alice"), { chatId: "saved", isSavedChat: true });
    expect(prepared.envelope.keys).toHaveLength(1);
  });

  test("groups warn about members who cannot watch yet but still send", async () => {
    membersWithoutDevice = [{ userId: "carol", username: "carol" }];
    const prepared = await prepare(aliceServices, { chatId: "group" });
    expect(prepared.warnings).toHaveLength(1);
    expect(prepared.warnings[0]).toContain("carol");
  });

  test("every device of every member gets a wrapped key, including the sender's other devices", async () => {
    const aliceTablet = await makeIdentity("alice");
    const bobTablet = await makeIdentity("bob");
    devices = [alice.record, aliceTablet.record, bob.record, bobTablet.record];
    // Everything is new on first contact, so the first look pins it all.
    const prepared = await prepare();
    expect(prepared.envelope.keys.map((k) => k.deviceId).sort()).toEqual(devices.map((d) => d.id).sort());
  });

  test("key mismatches from the directory abort sending with a clear message", async () => {
    const services = {
      getIdentity: async () => alice.identity,
      directory: { getChatDevices: async () => { throw new KeyMismatchError("bob", ["d"]); } },
    };
    const error = await prepare(services).catch((e) => e);
    expect(friendlyVideoNoteError(error)).toMatch(/security keys changed/);
  });

  describe("devices this device has not seen before", () => {
    test("a new device of an unverified contact asks first, and sending anyway accepts it", async () => {
      await prepare(); // first contact: Bob's device is pinned
      const bobTablet = await makeIdentity("bob");
      devices.push(bobTablet.record);

      const error = await prepare().catch((e) => e);
      expect(error).toBeInstanceOf(DevicesChangedError);
      expect(error.requiresVerification).toBe(false);
      expect(error.changes).toEqual([
        { userId: "bob", username: "bob", added: [bobTablet.record.id], verified: false },
      ]);
      // Still asking: looking at it does not make it trusted.
      expect(await prepare().catch((e) => e)).toBeInstanceOf(DevicesChangedError);

      const sent = await prepare(aliceServices, { acknowledgeChanges: true });
      expect(sent.envelope.keys.map((k) => k.deviceId)).toContain(bobTablet.record.id);
      // Accepted once; no more questions.
      expect((await prepare()).envelope.keys).toHaveLength(3);
    });

    test("a contact you verified can never be sent to silently, not even with 'send anyway'", async () => {
      await prepare();
      await aliceServices.trust.setVerified("bob", "999", true, [bob.record]);
      const intruder = await makeIdentity("bob");
      devices.push(intruder.record);

      const refused = await prepare(aliceServices, { acknowledgeChanges: true }).catch((e) => e);
      expect(refused).toBeInstanceOf(DevicesChangedError);
      expect(refused.requiresVerification).toBe(true);
      expect(friendlyVideoNoteError(refused)).toMatch(/verified contact/);

      // Re-verifying the new number accepts the new device.
      await aliceServices.trust.setVerified("bob", "1000", true, [bob.record, intruder.record]);
      aliceServices.directory.invalidate("bob");
      const sent = await prepare();
      expect(sent.envelope.keys.map((k) => k.deviceId)).toContain(intruder.record.id);
    });

    test("a new device on your own account is also asked about, but this device never is", async () => {
      await prepare();
      const otherBrowser = await makeIdentity("alice");
      devices.push(otherBrowser.record);
      const error = await prepare().catch((e) => e);
      expect(error).toBeInstanceOf(DevicesChangedError);
      expect(error.changes.map((c) => c.userId)).toEqual(["alice"]);
      expect(error.changes[0].added).toEqual([otherBrowser.record.id]);
    });

    test("this device's own registration after its pin was made is not a question", async () => {
      // e.g. the browser lost its storage and re-registered: the old device is
      // gone and the new one is this one.
      await prepare();
      const reborn = await makeIdentity("alice");
      devices = [reborn.record, bob.record];
      const services = { ...aliceServices, getIdentity: async () => reborn.identity };
      const prepared = await prepare(services);
      expect(prepared.envelope.senderDeviceId).toBe(reborn.record.id);
    });

    test("receiving from a new device of an unverified sender works but is flagged", async () => {
      await prepare(); // establishes the pin for Alice on Bob's side later
      await bobServices.directory.getUserDevices("alice", { chatId: "chat" }); // Bob pins Alice's device
      const aliceNew = await makeIdentity("alice");
      devices.push(aliceNew.record);
      const fromNew = await prepareVideoNoteUpload({
        chatId: "chat", clientRequestId: "n-1", user: { id: "alice" }, note,
        services: { ...aliceServices, getIdentity: async () => aliceNew.identity },
        acknowledgeChanges: true,
      });
      const loaded = await loadVideoNote({
        msg: asMessage(fromNew, { client_request_id: "n-1" }), user: { id: "bob" }, services: bobServices,
        fetchCiphertext: async () => cipherOf(fromNew),
      });
      expect(loaded.senderPending).toBe(true);
    });

    test("receiving from a new device of a sender you verified is refused", async () => {
      await bobServices.directory.getUserDevices("alice", { chatId: "chat" });
      await bobServices.trust.setVerified("alice", "777", true, [alice.record]);
      const aliceNew = await makeIdentity("alice");
      devices.push(aliceNew.record);
      const fromNew = await prepareVideoNoteUpload({
        chatId: "chat", clientRequestId: "n-2", user: { id: "alice" }, note,
        services: { ...servicesFor(aliceNew, "alice"), getIdentity: async () => aliceNew.identity },
        acknowledgeChanges: true,
      });
      await expect(
        loadVideoNote({
          msg: asMessage(fromNew, { client_request_id: "n-2" }), user: { id: "bob" }, services: bobServices,
          fetchCiphertext: async () => cipherOf(fromNew),
        }),
      ).rejects.toMatchObject({ code: "sender_changed" });
      expect(friendlyDecryptError({ code: "sender_changed" })).toMatch(/safety number/);
    });
  });

  test("a sender device revoked after sending still verifies its old messages", async () => {
    const prepared = await prepare();
    // Bob knew the device while it was active.
    await bobServices.directory.getUserDevices("alice", { chatId: "chat" });
    const other = await makeIdentity("alice");
    devices.push(other.record);
    alice.record.revokedAt = "2024-01-01";
    await bobServices.directory.getUserDevices("alice", { chatId: "chat", force: true });
    const loaded = await loadVideoNote({
      msg: asMessage(prepared), user: { id: "bob" }, services: bobServices, fetchCiphertext: async () => cipherOf(prepared),
    });
    expect(loaded.url).toMatch(/^blob:/);
    expect(loaded.senderPending).toBe(false);
    delete alice.record.revokedAt;
  });

  test("a revoked sender device Bob never knew cannot vouch for a verified contact", async () => {
    await bobServices.directory.getUserDevices("alice", { chatId: "chat" });
    await bobServices.trust.setVerified("alice", "777", true, [alice.record]);
    const ghost = await makeIdentity("alice");
    ghost.record.revokedAt = "2024-01-01"; // the server claims it was revoked, but Bob never saw it
    devices.push(ghost.record);
    const fromGhost = await prepareVideoNoteUpload({
      chatId: "chat", clientRequestId: "g-1", user: { id: "alice" }, note,
      services: { ...servicesFor(ghost, "alice"), getIdentity: async () => ghost.identity },
      acknowledgeChanges: true,
    });
    await expect(
      loadVideoNote({
        msg: asMessage(fromGhost, { client_request_id: "g-1" }), user: { id: "bob" }, services: bobServices,
        fetchCiphertext: async () => cipherOf(fromGhost),
      }),
    ).rejects.toMatchObject({ code: "sender_changed" });
  });

  test("more recipient devices than the server accepts is stopped before anything is encrypted or uploaded", async () => {
    const many = [];
    for (let i = 0; i < MAX_RECIPIENT_DEVICES; i += 1) many.push((await makeIdentity("bob")).record);
    devices = [alice.record, ...many];
    const error = await prepare().catch((e) => e);
    expect(error).toBeInstanceOf(TooManyRecipientsError);
    expect(friendlyVideoNoteError(error)).toMatch(/too many/i);
  });
});

describe("receive helpers", () => {
  test("the cache key names the sender, the chat, the request and the signature", () => {
    const msg = { client_request_id: "c1", chat_id: "g", id: "s1", user_id: "u", e2ee: { sig: "SIG" } };
    expect(videoNoteKey(msg)).toBe("u:g:c1:SIG");
    expect(videoNoteKey({ client_request_id: "c1", chat_id: "g", user_id: "u" })).toBe("");
    expect(videoNoteKey({ ...msg, chat_id: "" })).toBe("");
    expect(videoNoteKey({ ...msg, client_request_id: "" })).toBe("");
    expect(videoNoteKey({ ...msg, user_id: "v" })).not.toBe(videoNoteKey(msg));
    expect(videoNoteKey({ ...msg, e2ee: { sig: "OTHER" } })).not.toBe(videoNoteKey(msg));
    // The server's own message id plays no part.
    expect(videoNoteKey({ ...msg, id: "s2" })).toBe(videoNoteKey(msg));
  });
  test("the context is read from the message", () => {
    expect(videoNoteContext({ chat_id: "c", client_request_id: "r", user_id: "u" })).toEqual({
      chatId: "c", clientRequestId: "r", senderUserId: "u",
    });
    expect(videoNoteContext({ chatId: "c", clientRequestId: "r", userId: "u" })).toEqual({
      chatId: "c", clientRequestId: "r", senderUserId: "u",
    });
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
  test("clearing the session forgets decrypted videos", () => {
    rememberVideoNote("k", { url: "blob:x" });
    clearVideoNoteCaches();
    expect(getRememberedVideoNote("k")).toBeNull();
  });
});
