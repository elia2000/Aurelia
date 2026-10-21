import { describe, test, expect } from "vitest";
import request from "supertest";
import {
  ALICE_ID,
  BOB_ID,
  CAROL_ID,
  CHAT_ID,
  MSG_ID,
  MSG_ID_2,
  flush,
  makeGifApp,
} from "../helpers/savedGifFixture.js";
import { buildGif, buildPng } from "../helpers/imageBytes.js";

const UNKNOWN_ID = "99999999-9999-4999-8999-999999999999";

async function setup(options = {}) {
  const ctx = makeGifApp(options);
  const cookies = {
    alice: await ctx.login("alice"),
    bob: await ctx.login("bob"),
    carol: await ctx.login("carol"),
  };
  const as = (who) => ({
    get: (url) => request(ctx.app).get(url).set("Cookie", cookies[who]),
    post: (url) => request(ctx.app).post(url).set("Cookie", cookies[who]),
    delete: (url) => request(ctx.app).delete(url).set("Cookie", cookies[who]),
  });
  // Alice has one saved GIF.
  const bytes = buildGif({ frames: 4, width: 48, height: 36 });
  const file = ctx.addFile(MSG_ID, bytes);
  const saved = (await as("alice").post("/api/gifs").send({ messageId: MSG_ID, fileId: file.id })).body.gif;
  ctx.userEvents.length = 0;
  const send = (who, body) =>
    as(who)
      .post("/api/messages")
      .send({ chatId: CHAT_ID, username: who, savedGifId: saved.id, ...body });
  return { ...ctx, cookies, as, bytes, saved, send };
}

describe("POST /api/messages with savedGifId", () => {
  test("creates a normal message whose attachment is a copy of the GIF, flagged as a GIF", async () => {
    const { send, created, storage, bytes, saved, gifStore } = await setup();
    const res = await send("alice", {});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: expect.any(String),
      deduped: false,
      expiresAt: null,
      files: [
        {
          id: expect.anything(),
          kind: "media",
          name: "animation.gif",
          mimeType: "image/gif",
          processing: false,
          sizeBytes: bytes.length,
          width: 48,
          height: 36,
          durationSeconds: null,
          expiresAt: null,
          expires_at: null,
          thumbStorageKey: null,
          thumbUrl: null,
          url: expect.stringMatching(/^\/api\/uploads\/messages\/copy-[0-9a-f]{8}\.gif$/),
          isAnimated: true,
          gif: true,
        },
      ],
    });

    expect(created.messages).toHaveLength(1);
    expect(created.messages[0]).toMatchObject({ chatId: CHAT_ID, userId: ALICE_ID, body: "Sent a media file", replyTo: null, expiresAt: null });

    // The attachment is a copy, written like an upload: its own name, its own bytes.
    expect(storage.calls.writeMessageCopy).toEqual([{ mime: "image/gif", type: "gif", size: bytes.length }]);
    const [copy] = [...storage.messageCopies.values()];
    expect(copy.bytes.equals(bytes)).toBe(true);
    expect(copy.storedName).not.toContain(saved.id);
    expect(created.files).toHaveLength(1);
    expect(created.files[0].input).toMatchObject({
      kind: "media",
      originalName: "animation.gif",
      storedName: copy.storedName,
      mimeType: "image/gif",
      sizeBytes: bytes.length,
      widthPx: 48,
      heightPx: 36,
      isAnimated: true,
      processingStatus: "ready",
    });
    // The saved GIF is untouched.
    expect(gifStore.rows).toHaveLength(1);
    expect(storage.gifs.size).toBe(1);
  });

  test("everybody in the chat gets one ordinary chat_message event, with the GIF flagged and no trace of the saved one", async () => {
    const { send, events, saved, gifStore } = await setup();
    const res = await send("alice", { caption: "ignored" });
    expect(res.status).toBe(200);
    await flush();

    expect(events).toHaveLength(1);
    expect(events[0].chatId).toBe(CHAT_ID);
    expect(events[0].payload).toMatchObject({
      type: "chat_message",
      chatId: CHAT_ID,
      messageId: res.body.id,
      username: "alice",
      userId: ALICE_ID,
      // The generic body clients already hide; the preview comes from summaryText.
      body: "Sent a media file",
      summaryText: "Sent a GIF",
      replyToMessageId: null,
      files: [{ mimeType: "image/gif", isAnimated: true, gif: true, name: "animation.gif" }],
    });

    const wire = JSON.stringify([events, res.body]);
    expect(wire).not.toContain(saved.id);
    expect(wire).not.toContain("savedGifId");
    expect(wire).not.toContain(gifStore.rows[0].storage_key);
    expect(wire).not.toContain(`gifs/${ALICE_ID}`);
    expect(wire).not.toContain(gifStore.rows[0].sha256);
  });

  test("a caption becomes the message text", async () => {
    const { send, created, events } = await setup();
    const res = await send("alice", { body: "  look at this one  " });
    expect(res.status).toBe(200);
    expect(created.messages[0].body).toBe("look at this one");
    expect(events[0].payload.body).toBe("look at this one");
    expect(events[0].payload.summaryText).toBe("Sent a GIF");
  });

  test("the caption obeys the usual rules", async () => {
    const { send, created } = await setup();
    expect((await send("alice", { body: "[[system:member_joined]]" })).status).toBe(400);
    expect((await send("alice", { body: "x".repeat(4001) })).status).toBe(400);
    expect((await send("alice", { body: "[object Object]" })).status).toBe(400);
    expect(created.messages).toEqual([]);
  });

  test("works as a reply", async () => {
    const { send, created, events } = await setup();
    const res = await send("alice", { replyToMessageId: MSG_ID_2 });
    expect(res.status).toBe(200);
    expect(created.messages[0].replyTo).toBe(MSG_ID_2);
    expect(events[0].payload.replyToMessageId).toBe(MSG_ID_2);
  });

  test("a reply target outside the chat is refused and nothing is copied", async () => {
    const { send, storage, created } = await setup();
    const res = await send("alice", { replyToMessageId: UNKNOWN_ID });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reply target/i);
    expect(storage.calls.writeMessageCopy).toEqual([]);
    expect(created.messages).toEqual([]);
  });

  test("the attachment expires like any upload; the saved GIF never does", async () => {
    const { send, created, gifStore } = await setup({ settings: { MESSAGE_FILE_RETENTION: 7 } });
    const before = Date.now();
    const res = await send("alice", {});
    expect(res.status).toBe(200);
    const expires = Date.parse(res.body.expiresAt);
    expect(expires).toBeGreaterThan(before + 6.9 * 86_400_000);
    expect(expires).toBeLessThan(before + 7.1 * 86_400_000);
    expect(res.body.files[0].expiresAt).toBe(res.body.expiresAt);
    expect(created.files[0].input.expiresAt).toBe(res.body.expiresAt);
    expect(created.messages[0].expiresAt).toBeNull();
    // Nothing about the saved GIF is time-limited.
    expect(Object.keys(gifStore.rows[0]).some((k) => /expire/i.test(k))).toBe(false);
  });

  test("the copy and the saved GIF are independent: either can go without the other", async () => {
    const { send, as, saved, storage, created } = await setup();
    const res = await send("alice", {});
    expect(res.status).toBe(200);
    const [copy] = [...storage.messageCopies.values()];

    // Deleting the saved GIF leaves the message and its file alone...
    expect((await as("alice").delete(`/api/gifs/${saved.id}`)).status).toBe(200);
    expect(storage.messageCopies.has(copy.storedName)).toBe(true);
    expect(created.files[0].row.stored_name).toBe(copy.storedName);
  });

  test("a message file that retention removed does not take the saved GIF with it", async () => {
    const { send, as, saved, storage, bytes } = await setup();
    await send("alice", {});
    storage.messageCopies.clear(); // what the retention clean-up does to the message's file
    const file = await as("alice").get(`/api/gifs/${saved.id}/file`).buffer(true).parse((r, cb) => {
      const chunks = [];
      r.on("data", (c) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(file.status).toBe(200);
    expect(file.body.equals(bytes)).toBe(true);
  });

  describe("who may send what", () => {
    test("somebody else's saved GIF id is not found, and nothing is copied or created", async () => {
      const { as, saved, storage, created, events } = await setup();
      const res = await as("bob")
        .post("/api/messages")
        .send({ chatId: CHAT_ID, username: "bob", savedGifId: saved.id });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "GIF not found." });
      expect(storage.calls.writeMessageCopy).toEqual([]);
      expect(created.messages).toEqual([]);
      expect(events).toEqual([]);
    });

    test("an id that does not exist gives exactly the same answer", async () => {
      const { as } = await setup();
      const res = await as("bob")
        .post("/api/messages")
        .send({ chatId: CHAT_ID, username: "bob", savedGifId: UNKNOWN_ID });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "GIF not found." });
    });

    test("somebody outside the chat cannot send into it, even with their own GIF", async () => {
      const { as, storage, created } = await setup();
      const f = (await as("carol").get("/api/gifs")).body;
      expect(f.count).toBe(0);
      const res = await as("carol")
        .post("/api/messages")
        .send({ chatId: CHAT_ID, username: "carol", savedGifId: UNKNOWN_ID });
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "Not a member of this chat." });
      expect(storage.calls.writeMessageCopy).toEqual([]);
      expect(created.messages).toEqual([]);
      expect(CAROL_ID).toBeTruthy();
    });

    test("only the owner of a channel can post a GIF there", async () => {
      const { as, saved } = await setup({ chat: { type: "channel", name: "News" } });
      const res = await as("bob")
        .post("/api/messages")
        .send({ chatId: CHAT_ID, username: "bob", savedGifId: saved.id });
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "Only channel owner can send messages." });
      const ok = await as("alice")
        .post("/api/messages")
        .send({ chatId: CHAT_ID, username: "alice", savedGifId: saved.id });
      expect(ok.status).toBe(200);
    });

    test("the username must be the signed-in person's", async () => {
      const { as, saved, created } = await setup();
      const res = await as("alice")
        .post("/api/messages")
        .send({ chatId: CHAT_ID, username: "bob", savedGifId: saved.id });
      expect(res.status).toBe(403);
      expect(created.messages).toEqual([]);
    });

    test("needs a session", async () => {
      const { app, saved } = await setup();
      const res = await request(app).post("/api/messages").send({ chatId: CHAT_ID, username: "alice", savedGifId: saved.id });
      expect(res.status).toBe(401);
    });
  });

  describe("the existing upload rules still apply", () => {
    test("refused while file uploads are switched off", async () => {
      const off = await setup({ settings: { FILE_UPLOAD: false } });
      // With uploads off the GIF could not even have been saved, so put it in directly.
      const gifId = "d3d3d3d3-e1e1-4f2f-b040-171717171717";
      off.gifStore.rows.push({
        id: gifId,
        user_id: ALICE_ID,
        storage_key: `gifs/${ALICE_ID}/${gifId}.gif`,
        storage_driver: "local",
        mime: "image/gif",
        width: 4,
        height: 4,
        frames: 2,
        size_bytes: 10,
        sha256: "00".repeat(32),
        created_at: new Date().toISOString(),
        source_message_id: null,
        source_file_id: null,
      });
      const res = await off
        .as("alice")
        .post("/api/messages")
        .send({ chatId: CHAT_ID, username: "alice", savedGifId: gifId });
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: "File uploads are disabled on this server." });
      expect(off.created.messages).toEqual([]);
    });

    test("a GIF larger than the per-file limit of the server is refused (the limit was lowered after it was saved)", async () => {
      const { send, created, storage, deps } = await setup();
      deps.MESSAGE_FILE_LIMITS = { maxFiles: 10, maxFileSizeBytes: 100, maxTotalBytes: 1000 };
      const res = await send("alice", {});
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/at most/i);
      expect(res.body.code).toBe("gif_too_large");
      expect(storage.calls.writeMessageCopy).toEqual([]);
      expect(created.messages).toEqual([]);
    });

    test("not enough free space on the server", async () => {
      // (saving the GIF in the first place is held to the same check, so the space runs out afterwards)
      const { send, created, storage, deps } = await setup();
      deps.hasEnoughFreeDiskSpace = () => false;
      const res = await send("alice", {});
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "Not enough free storage space on server." });
      expect(storage.calls.writeMessageCopy).toEqual([]);
      expect(created.messages).toEqual([]);
    });
  });

  describe("retries and failures", () => {
    test("the same client request id is answered from the message it already made, with no second copy", async () => {
      const { send, created, storage } = await setup();
      const first = await send("alice", { clientRequestId: "req-1" });
      const again = await send("alice", { clientRequestId: "req-1" });
      expect(first.body.deduped).toBe(false);
      expect(again.status).toBe(200);
      expect(again.body).toEqual({ id: first.body.id, deduped: true });
      expect(created.messages).toHaveLength(1);
      expect(storage.calls.writeMessageCopy).toHaveLength(1);
    });

    test("a request that loses a race on the client request id removes its own copy", async () => {
      const { send, created, storage, deps } = await setup();
      const first = await send("alice", { clientRequestId: "req-2" });
      // The pre-check misses (the other request had not committed yet)...
      const lookup = deps.findMessageIdByClientRequestId;
      deps.findMessageIdByClientRequestId = () => null;
      const again = await send("alice", { clientRequestId: "req-2" });
      deps.findMessageIdByClientRequestId = lookup;
      // ...but creating the message finds it.
      expect(again.body).toEqual({ id: first.body.id, deduped: true });
      expect(created.messages).toHaveLength(1);
      expect(storage.messageCopies.size).toBe(1);
    });

    test("a GIF whose bytes are gone is not found, and no message is made", async () => {
      const { send, storage, created } = await setup();
      storage.gifs.clear();
      const res = await send("alice", {});
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "GIF file not found." });
      expect(created.messages).toEqual([]);
    });

    test("a failing copy makes no message", async () => {
      const { send, storage, created } = await setup();
      storage.state.failCopy = true;
      const res = await send("alice", {});
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "Unable to send the GIF." });
      expect(created.messages).toEqual([]);
    });

    test("if the file cannot be attached, the message is taken back and the copy removed", async () => {
      const { send, storage, created, flags, events } = await setup();
      flags.failFiles = true;
      const res = await send("alice", {});
      expect(res.status).toBe(500);
      expect(created.hidden).toEqual([created.messages[0].id]);
      expect(storage.messageCopies.size).toBe(0);
      expect(events).toEqual([]);
    });
  });

  describe("storage on a bucket", () => {
    test("the file is a bucket object under uploads/messages and its url is the bucket's", async () => {
      const provider = {
        type: "s3",
        getDownloadUrl: async (key) => `https://bucket.test/${key}?sig=1`,
      };
      const ctx = await setup({ deps: { storageProvider: provider } });
      ctx.storage.state.remote = true;
      const res = await ctx.send("alice", {});
      expect(res.status).toBe(200);
      const [copy] = [...ctx.storage.messageCopies.values()];
      expect(copy.storageDriver).toBe("s3");
      expect(copy.storageKey).toBe(`uploads/messages/${copy.storedName}`);
      expect(res.body.files[0].url).toBe(`https://bucket.test/${copy.storageKey}?sig=1`);
      expect(ctx.created.files[0].input).toMatchObject({ storageDriver: "s3", storageKey: copy.storageKey });
    });
  });

  describe("notifications", () => {
    test("people who are not looking at the app get a push; the sender, the muted and the connected do not", async () => {
      const ctx = await setup();
      const res = await ctx.send("alice", { body: "wow" });
      expect(res.status).toBe(200);
      await flush();
      expect(ctx.pushes).toHaveLength(1);
      expect(ctx.pushes[0].userIds).toEqual([BOB_ID]);
      expect(ctx.pushes[0].payload).toMatchObject({ title: "Friends", body: "wow", data: { url: "/", chatId: CHAT_ID } });

      const plain = await setup();
      await plain.send("alice", {});
      await flush();
      expect(plain.pushes[0].payload.body).toBe("Sent a GIF");

      const muted = await setup();
      muted.mute(BOB_ID);
      await muted.send("alice", {});
      await flush();
      expect(muted.pushes).toEqual([]);

      const online = await setup();
      online.setConnected("bob");
      await online.send("alice", {});
      await flush();
      expect(online.pushes).toEqual([]);
    });
  });

  describe("validation", () => {
    test.each([
      ["a saved GIF id that is not a UUID", "nope"],
      ["a saved GIF id that is an array", ["x"]],
      ["a saved GIF id that is an object", { id: 1 }],
      ["a saved GIF id with spaces around it", " d3d3d3d3-e1e1-4f2f-b040-171717171717 "],
    ])("is refused with %s", async (_label, savedGifId) => {
      const { as, created } = await setup();
      const res = await as("alice").post("/api/messages").send({ chatId: CHAT_ID, username: "alice", savedGifId });
      expect(res.status).toBe(400);
      expect(created.messages).toEqual([]);
    });

    test("a message without text and without a saved GIF is still refused", async () => {
      const { as } = await setup();
      const res = await as("alice").post("/api/messages").send({ chatId: CHAT_ID, username: "alice" });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "Chat, username, and message body are required." });
    });

    test("an ordinary text message is unchanged", async () => {
      const { as, created } = await setup();
      const res = await as("alice").post("/api/messages").send({ chatId: CHAT_ID, username: "alice", body: "hello" });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: expect.any(String), deduped: false });
      expect(created.messages).toHaveLength(1);
      expect(created.messages[0]).toMatchObject({ body: "hello", userId: ALICE_ID });
      expect(created.files).toEqual([]);
    });
  });

  test("is rate limited per person", async () => {
    const { send } = await setup();
    let last;
    for (let i = 0; i < 31; i += 1) last = await send("alice", {});
    expect(last.status).toBe(429);
    expect(last.body.error).toMatch(/too many/i);
  });

  test("an animated PNG sent from the collection keeps its type", async () => {
    const ctx = await setup();
    const png = ctx.addFile(MSG_ID, buildPng({ animated: true, frames: 3 }), { mime_type: "image/png", original_name: "a.png" });
    const saved = (await ctx.as("alice").post("/api/gifs").send({ messageId: MSG_ID, fileId: png.id })).body.gif;
    const res = await ctx.as("alice").post("/api/messages").send({ chatId: CHAT_ID, username: "alice", savedGifId: saved.id });
    expect(res.status).toBe(200);
    expect(res.body.files[0]).toMatchObject({ mimeType: "image/png", name: "animation.png", isAnimated: true });
  });
});
