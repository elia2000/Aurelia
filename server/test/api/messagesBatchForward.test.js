import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import {
  ALICE_ID,
  BOB_ID,
  BOBS_CHANNEL,
  CALL_MSG,
  CAROLS_GROUP,
  CAROL_MSG,
  CHANNEL_POST,
  CREATED_PREFIX,
  DELETED_MSG,
  DM,
  DM_MSG,
  E2EE_MSG,
  GROUP,
  HIDDEN_MSG,
  M1,
  M2,
  M3,
  M4,
  M5,
  MISSING_CHAT,
  MISSING_MSG,
  MY_CHANNEL,
  SAVED,
  SERVICE_MSG,
  TARGET_GROUP,
  makeBatchApp,
  uid,
} from "../helpers/batchMessageFixture.js";

const forward = (ctx, body, { token = "tok-alice", username = "alice" } = {}) =>
  request(ctx.app)
    .post("/api/messages/forward")
    .set("Cookie", `sid=${token}`)
    .send({ username, ...body });

const batch = (ctx, sourceMessageIds, extra = {}) =>
  forward(ctx, { sourceMessageIds, targetChatIds: [TARGET_GROUP], ...extra });

const createdBodies = (ctx) => ctx.created.map((c) => c.body);
const codes = (res) => res.body.failed.map((f) => [f.sourceMessageId, f.code]);

describe("POST /api/messages/forward: the single-message request keeps working", () => {
  test("answers { ok, ids } and writes the text the client sent, exactly as before", async () => {
    const ctx = makeBatchApp();
    const res = await forward(ctx, { sourceMessageId: M1, targetChatIds: [TARGET_GROUP], body: "first" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, ids: [`${CREATED_PREFIX}000000000001`] });
    expect(ctx.created).toHaveLength(1);
    // createMessage was called with the five arguments it always got: no id is
    // forced on a single message.
    expect(ctx.created[0]).toMatchObject({
      chatId: TARGET_GROUP,
      userId: ALICE_ID,
      body: "first",
      replyTo: null,
      expiresAt: null,
    });
    expect(ctx.created[0].clientRequestId).toBeUndefined();
    expect(ctx.created[0].options).toBeUndefined();
    expect(ctx.origins).toEqual([
      expect.objectContaining({
        id: `${CREATED_PREFIX}000000000001`,
        sourceUserId: BOB_ID,
        sourceUsername: "bob",
        label: "Bob",
        sourceChatId: null,
      }),
    ]);
    expect(ctx.eventsOfType("chat_message")).toHaveLength(1);
  });

  test("the client's text is used, not the stored one", async () => {
    const ctx = makeBatchApp();
    await forward(ctx, { sourceMessageId: M1, targetChatIds: [TARGET_GROUP], body: "what the client showed" });
    expect(createdBodies(ctx)).toEqual(["what the client showed"]);
  });

  test.each([
    ["a missing source", { sourceMessageId: MISSING_MSG }, 404, /Source message not found/],
    ["a deleted source", { sourceMessageId: DELETED_MSG }, 410, /no longer available/],
    ["a source removed from my own view", { sourceMessageId: HIDDEN_MSG }, 410, /no longer available/],
    ["an encrypted source", { sourceMessageId: E2EE_MSG }, 400, /End-to-end encrypted/],
    ["a service entry", { sourceMessageId: SERVICE_MSG }, 400, /cannot be forwarded/],
    ["a call entry", { sourceMessageId: CALL_MSG }, 400, /cannot be forwarded/],
    ["a chat I am not in", { sourceMessageId: CAROL_MSG }, 403, /cannot forward from this chat/],
    ["an empty text", { sourceMessageId: M1, body: "  " }, 400, /body is required/],
    ["a service text", { sourceMessageId: M1, body: "[[system:member_joined]]" }, 400, /Invalid message body/],
  ])("%s keeps its status and message", async (_name, extra, status, pattern) => {
    const ctx = makeBatchApp();
    const res = await forward(ctx, { targetChatIds: [TARGET_GROUP], body: "text", ...extra });
    expect(res.status).toBe(status);
    expect(res.body.error).toMatch(pattern);
    expect(Object.keys(res.body)).toEqual(["error"]);
    expect(ctx.created).toHaveLength(0);
    expect(ctx.events).toHaveLength(0);
  });

  test("a target that does not accept the sender fails the request before anything is written", async () => {
    const ctx = makeBatchApp();
    const res = await forward(ctx, {
      sourceMessageId: M1,
      targetChatIds: [TARGET_GROUP, CAROLS_GROUP],
      body: "first",
    });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Cannot send to one or more selected chats." });
    expect(ctx.created).toHaveLength(0);
  });

  test("a channel is only a target for its owner", async () => {
    const ctx = makeBatchApp();
    const refused = await forward(ctx, { sourceMessageId: M1, targetChatIds: [BOBS_CHANNEL], body: "x" });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/channels you own/);
    const allowed = await forward(ctx, { sourceMessageId: M1, targetChatIds: [MY_CHANNEL], body: "x" });
    expect(allowed.status).toBe(200);
  });

  test("a target chat that does not exist", async () => {
    const ctx = makeBatchApp({ deps: { isMember: () => true } });
    const res = await forward(ctx, { sourceMessageId: M1, targetChatIds: [MISSING_CHAT], body: "x" });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/);
  });

  test("the required fields", async () => {
    const ctx = makeBatchApp();
    expect((await forward(ctx, { targetChatIds: [TARGET_GROUP], body: "x" })).status).toBe(400);
    expect((await forward(ctx, { sourceMessageId: "nope", targetChatIds: [TARGET_GROUP], body: "x" })).status).toBe(400);
    expect((await forward(ctx, { sourceMessageId: M1, body: "x" })).status).toBe(400);
    expect((await forward(ctx, { sourceMessageId: M1, targetChatIds: [], body: "x" })).status).toBe(400);
    expect((await forward(ctx, { sourceMessageId: M1, targetChatIds: ["not-a-uuid"], body: "x" })).status).toBe(400);
    expect(ctx.created).toHaveLength(0);
  });

  test("a text longer than a message may be is refused, unless the source itself is that long", async () => {
    const ctx = makeBatchApp({ settings: { MESSAGE_MAX_CHARS: 10 } });
    const tooLong = await forward(ctx, { sourceMessageId: M1, targetChatIds: [TARGET_GROUP], body: "x".repeat(11) });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error).toMatch(/at most 10 characters/);

    // A post mirrored from a remote channel can be longer than the limit.
    ctx.messages.get(M1).body = "y".repeat(50);
    const mirrored = await forward(ctx, { sourceMessageId: M1, targetChatIds: [TARGET_GROUP], body: "y".repeat(50) });
    expect(mirrored.status).toBe(200);
  });

  test("somebody else's session cannot forward in my name", async () => {
    const ctx = makeBatchApp();
    const res = await forward(ctx, { sourceMessageId: M1, targetChatIds: [TARGET_GROUP], body: "x" }, { token: "tok-bob" });
    expect(res.status).toBe(403);
    expect(ctx.created).toHaveLength(0);
  });

  test("a request without a session is refused", async () => {
    const ctx = makeBatchApp();
    const res = await request(ctx.app)
      .post("/api/messages/forward")
      .send({ username: "alice", sourceMessageId: M1, targetChatIds: [TARGET_GROUP], body: "x" });
    expect(res.status).toBe(401);
  });
});

describe("POST /api/messages/forward: several messages", () => {
  test("they arrive oldest first, whatever order the request names them in", async () => {
    const ctx = makeBatchApp();
    const res = await batch(ctx, [M5, M1, M4, M2, M3]);

    expect(res.status).toBe(200);
    expect(res.body.failed).toEqual([]);
    // M3 and M4 share a second: the chat shows equal times by id, M3 < M4.
    expect(res.body.forwarded.map((m) => m.sourceMessageId)).toEqual([M1, M2, M3, M4, M5]);
    expect(createdBodies(ctx)).toEqual(["first", "second (edited)", "third", "fourth", "fifth"]);
    // The events leave in the same order.
    expect(ctx.eventsOfType("chat_message").map((e) => e.payload.body)).toEqual(createdBodies(ctx));
  });

  test("each message is its own message with the text it has now (an edited one is forwarded as edited)", async () => {
    const ctx = makeBatchApp();
    const res = await batch(ctx, [M2, M1]);
    expect(res.body.forwarded).toHaveLength(2);
    expect(res.body.forwarded[1].body).toBe("second (edited)");
    expect(new Set(res.body.forwarded.map((m) => m.id)).size).toBe(2);
    expect(ctx.created.map((c) => c.chatId)).toEqual([TARGET_GROUP, TARGET_GROUP]);
    expect(ctx.created.every((c) => c.userId === ALICE_ID)).toBe(true);
  });

  test("the answer describes every forwarded message", async () => {
    const ctx = makeBatchApp();
    const res = await batch(ctx, [M1]);
    expect(res.body).toEqual({
      forwarded: [
        {
          id: `${CREATED_PREFIX}000000000001`,
          chatId: TARGET_GROUP,
          sourceMessageId: M1,
          userId: ALICE_ID,
          username: "alice",
          body: "first",
          fileCount: 0,
          forwardedFrom: {
            chatId: null,
            label: "Bob",
            userId: BOB_ID,
            username: "bob",
            avatarUrl: "/api/uploads/avatars/bob.png",
            color: "#10b981",
          },
        },
      ],
      failed: [],
    });
  });

  test("messages written in the same second get ascending ids, so every client shows them in order", async () => {
    const ctx = makeBatchApp();
    await batch(ctx, [M4, M3, M2, M1, M5]);
    const ids = ctx.created.map((c) => c.id);
    expect(ids).toEqual([...ids].sort());
    expect(ctx.created.every((c) => c.options?.id === c.id)).toBe(true);
  });

  test("the forward origin is kept per message: the author, or the channel for a channel post", async () => {
    const ctx = makeBatchApp();
    const res = await forward(ctx, {
      sourceMessageIds: [CHANNEL_POST, M2],
      targetChatIds: [TARGET_GROUP],
    });
    expect(res.status).toBe(200);
    // CHANNEL_POST (08:30) is older than M2 (10:00:01).
    expect(ctx.origins.map((o) => o.label)).toEqual(["Bob's news", "Alice"]);
    expect(ctx.origins[0]).toMatchObject({ sourceChatId: BOBS_CHANNEL, sourceUserId: null, sourceUsername: null });
    expect(ctx.origins[1]).toMatchObject({ sourceChatId: null, sourceUserId: ALICE_ID, sourceUsername: "alice" });
    expect(res.body.forwarded[0].forwardedFrom).toMatchObject({ chatId: BOBS_CHANNEL, label: "Bob's news" });
  });

  test("messages of different source chats can be forwarded together", async () => {
    const ctx = makeBatchApp();
    const res = await batch(ctx, [M1, DM_MSG]);
    expect(res.status).toBe(200);
    expect(res.body.forwarded.map((m) => m.sourceMessageId)).toEqual([DM_MSG, M1]);
  });

  test("to several chats: every chat gets all messages, oldest first", async () => {
    const ctx = makeBatchApp();
    const res = await forward(ctx, {
      sourceMessageIds: [M3, M1],
      targetChatIds: [TARGET_GROUP, DM, SAVED],
    });
    expect(res.status).toBe(200);
    expect(ctx.created.map((c) => [c.chatId, c.body])).toEqual([
      [TARGET_GROUP, "first"],
      [TARGET_GROUP, "third"],
      [DM, "first"],
      [DM, "third"],
      [SAVED, "first"],
      [SAVED, "third"],
    ]);
    expect(res.body.forwarded).toHaveLength(6);
    expect(ctx.eventsOfType("chat_message").map((e) => e.chatId)).toEqual([
      TARGET_GROUP,
      TARGET_GROUP,
      DM,
      DM,
      SAVED,
      SAVED,
    ]);
  });

  test("an id or a chat named twice counts once", async () => {
    const ctx = makeBatchApp();
    const res = await forward(ctx, {
      sourceMessageIds: [M1, M1, M2],
      targetChatIds: [TARGET_GROUP, TARGET_GROUP],
    });
    expect(res.body.forwarded).toHaveLength(2);
  });

  test("a message with a file gets a copy of the file, kept as long as the file; text expires like text", async () => {
    const ctx = makeBatchApp({ settings: { MESSAGE_TEXT_RETENTION: 3 } });
    const res = await batch(ctx, [M5, M1]);
    expect(res.status).toBe(200);
    const [text, withFile] = ctx.created;
    expect(text.body).toBe("first");
    expect(typeof text.expiresAt).toBe("string");
    expect(withFile.body).toBe("fifth");
    expect(withFile.expiresAt).toBeNull();
    expect(ctx.createdFiles).toHaveLength(1);
    expect(ctx.createdFiles[0].id).toBe(res.body.forwarded[1].id);
    expect(ctx.createdFiles[0].files).toEqual([
      expect.objectContaining({ storedName: "stored-photo.png", originalName: "photo.png", mimeType: "image/png", sizeBytes: 1234 }),
    ]);
    expect(res.body.forwarded[1].fileCount).toBe(1);
  });

  test("a file that is gone from the disk is not copied", async () => {
    const ctx = makeBatchApp({ deps: { fs: { existsSync: () => false } } });
    const res = await batch(ctx, [M5, M1]);
    expect(res.status).toBe(200);
    expect(ctx.createdFiles).toHaveLength(0);
    expect(res.body.forwarded[1].fileCount).toBe(0);
  });

  test("a Saved Messages target is read and shown again, like a single forward", async () => {
    const ctx = makeBatchApp();
    const res = await forward(ctx, { sourceMessageIds: [M1, M2], targetChatIds: [SAVED] });
    expect(res.status).toBe(200);
    expect(ctx.calls.markRead).toHaveLength(2);
    expect(ctx.calls.unhide).toEqual([
      { userId: ALICE_ID, chatId: SAVED },
      { userId: ALICE_ID, chatId: SAVED },
    ]);
    for (const event of ctx.eventsOfType("chat_message")) {
      expect(event.payload).toMatchObject({ read_by_user_id: ALICE_ID });
      expect(event.payload.read_at).toBeTruthy();
    }
  });

  test("works the same with a database that answers with promises", async () => {
    const ctx = makeBatchApp({ asyncDb: true });
    const res = await batch(ctx, [M3, M1]);
    expect(res.status).toBe(200);
    expect(res.body.forwarded.map((m) => m.body)).toEqual(["first", "third"]);
    expect(res.body.forwarded[0].id).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("works with a database layer that has no bulk lookups (falls back to one lookup each)", async () => {
    const ctx = makeBatchApp({ bulk: false });
    const res = await batch(ctx, [M3, M1]);
    expect(res.status).toBe(200);
    expect(res.body.forwarded.map((m) => m.body)).toEqual(["first", "third"]);
  });
});

describe("POST /api/messages/forward: some messages cannot be forwarded", () => {
  // The failures below are logged on purpose; keep the test output readable.
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("the others still are, and the answer names each failure with a code", async () => {
    const ctx = makeBatchApp();
    const res = await batch(ctx, [
      M1,
      MISSING_MSG,
      CAROL_MSG,
      DELETED_MSG,
      HIDDEN_MSG,
      E2EE_MSG,
      SERVICE_MSG,
      CALL_MSG,
      M2,
    ]);

    expect(res.status).toBe(200);
    expect(res.body.forwarded.map((m) => m.sourceMessageId)).toEqual([M1, M2]);
    expect(codes(res)).toEqual([
      [MISSING_MSG, "not_found"],
      [CAROL_MSG, "forbidden"],
      [DELETED_MSG, "gone"],
      [HIDDEN_MSG, "gone"],
      [E2EE_MSG, "encrypted"],
      [SERVICE_MSG, "not_forwardable"],
      [CALL_MSG, "not_forwardable"],
    ]);
    for (const failure of res.body.failed) {
      expect(Object.keys(failure).sort()).toEqual(["code", "error", "sourceMessageId"]);
      expect(typeof failure.error).toBe("string");
    }
    expect(createdBodies(ctx)).toEqual(["first", "second (edited)"]);
    // Events only for what was written.
    expect(ctx.eventsOfType("chat_message")).toHaveLength(2);
  });

  test("a message from a chat the caller is not in says nothing about the message itself", async () => {
    const ctx = makeBatchApp();
    const answers = [];
    // An ordinary message, a deleted one, an encrypted one, a service entry:
    // the same answer for all of them.
    for (const change of [
      () => {},
      () => (ctx.messages.get(CAROL_MSG).hidden_everyone_at = "2025-01-01 00:00:00"),
      () => (ctx.messages.get(CAROL_MSG).e2ee_envelope = "{}"),
      () => (ctx.messages.get(CAROL_MSG).body = "[[system:member_joined]]"),
    ]) {
      change();
      const res = await batch(ctx, [CAROL_MSG]);
      answers.push([res.status, res.body.failed[0].code, res.body.failed[0].error]);
    }
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    expect(answers[0][1]).toBe("forbidden");
    expect(ctx.created).toHaveLength(0);
  });

  test("failures come back in the order they were asked for", async () => {
    const ctx = makeBatchApp();
    const res = await batch(ctx, [SERVICE_MSG, M1, MISSING_MSG, CALL_MSG]);
    expect(res.body.failed.map((f) => f.sourceMessageId)).toEqual([SERVICE_MSG, MISSING_MSG, CALL_MSG]);
  });

  test("nothing could be forwarded: an error status, with the reasons", async () => {
    const ctx = makeBatchApp();
    const gone = await batch(ctx, [DELETED_MSG, HIDDEN_MSG]);
    expect(gone.status).toBe(410);
    expect(gone.body.forwarded).toEqual([]);
    expect(codes(gone)).toEqual([[DELETED_MSG, "gone"], [HIDDEN_MSG, "gone"]]);
    expect(gone.body.error).toMatch(/no longer available/);

    const mixed = await batch(ctx, [DELETED_MSG, MISSING_MSG]);
    expect(mixed.status).toBe(400);
    expect(mixed.body.failed).toHaveLength(2);
    expect(ctx.created).toHaveLength(0);
  });

  test("a message that cannot be created is reported, the rest go on", async () => {
    // The first createMessage call throws.
    const ctx = makeBatchApp({ failCreateFor: [1] });
    const res = await batch(ctx, [M1, M2, M3]);
    expect(res.status).toBe(200);
    expect(res.body.forwarded.map((m) => m.sourceMessageId)).toEqual([M2, M3]);
    expect(res.body.failed).toEqual([
      { sourceMessageId: M1, targetChatId: TARGET_GROUP, code: "create_failed", error: "Unable to forward message." },
    ]);
    expect(ctx.eventsOfType("chat_message")).toHaveLength(2);
  });

  test("a message that was created but could not be finished is taken back", async () => {
    const setMessageForwardOrigin = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValue(undefined);
    const ctx = makeBatchApp({ deps: { setMessageForwardOrigin } });
    const res = await batch(ctx, [M1, M2]);
    expect(res.status).toBe(200);
    expect(res.body.forwarded.map((m) => m.sourceMessageId)).toEqual([M2]);
    expect(res.body.failed).toEqual([expect.objectContaining({ sourceMessageId: M1, code: "create_failed" })]);
    // The half-made copy is deleted for everyone, so nobody sees it.
    expect(ctx.calls.hideEveryone).toEqual([ctx.created[0].id]);
    expect(ctx.eventsOfType("chat_message")).toHaveLength(1);
  });

  test("a realtime hub that breaks does not undo stored messages", async () => {
    const emitChatEvent = vi.fn(() => {
      throw new Error("hub down");
    });
    const ctx = makeBatchApp({ deps: { emitChatEvent } });
    const res = await batch(ctx, [M1, M2]);
    expect(res.status).toBe(200);
    expect(res.body.forwarded).toHaveLength(2);
    expect(res.body.failed).toEqual([]);
  });

  test("a target that refuses the sender fails the whole request before anything is written", async () => {
    const ctx = makeBatchApp();
    const res = await forward(ctx, { sourceMessageIds: [M1, M2], targetChatIds: [TARGET_GROUP, CAROLS_GROUP] });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Cannot send to one or more selected chats." });
    expect(ctx.created).toHaveLength(0);
    expect(ctx.events).toHaveLength(0);
  });

  test("a channel the caller does not own refuses the whole request", async () => {
    const ctx = makeBatchApp();
    const res = await forward(ctx, { sourceMessageIds: [M1, M2], targetChatIds: [BOBS_CHANNEL] });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/channels you own/);
    expect(ctx.created).toHaveLength(0);
  });

  test("a person who left the target chat (no longer a member) cannot forward into it", async () => {
    const ctx = makeBatchApp();
    delete ctx.chats.get(TARGET_GROUP).members[ALICE_ID];
    const res = await batch(ctx, [M1]);
    expect(res.status).toBe(403);
    expect(ctx.created).toHaveLength(0);
  });

  test("a person who left the source chat cannot forward from it any more", async () => {
    const ctx = makeBatchApp();
    delete ctx.chats.get(GROUP).members[ALICE_ID];
    const res = await batch(ctx, [M1, M2]);
    expect(res.status).toBe(403);
    expect(res.body.failed.map((f) => f.code)).toEqual(["forbidden", "forbidden"]);
    expect(ctx.created).toHaveLength(0);
  });

  test("nobody is forwarded to when every message fails, whatever the targets say", async () => {
    const ctx = makeBatchApp();
    const res = await forward(ctx, { sourceMessageIds: [MISSING_MSG], targetChatIds: [CAROLS_GROUP] });
    expect(res.status).toBe(404);
    expect(res.body.failed[0].code).toBe("not_found");
  });
});

describe("POST /api/messages/forward: limits and validation", () => {
  const manyIds = (n) => Array.from({ length: n }, (_, i) => uid(0x7000 + i));

  test("1 to 100 messages", async () => {
    const ctx = makeBatchApp();
    const none = await batch(ctx, []);
    expect(none.status).toBe(400);
    expect(none.body.error).toMatch(/at least one/);

    const tooMany = await batch(ctx, manyIds(101));
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error).toMatch(/at most 100/);
    expect(ctx.created).toHaveLength(0);
    // Refused before anything is looked up.
    expect(ctx.calls.findMessagesByIds).toHaveLength(0);
  });

  test("exactly 100 are accepted", async () => {
    const ctx = makeBatchApp();
    const ids = ctx.addFillers(100);
    const res = await batch(ctx, ids);
    expect(res.status).toBe(200);
    expect(res.body.forwarded).toHaveLength(100);
    expect(ctx.eventsOfType("chat_message")).toHaveLength(100);
    // One lookup for all of them, not one per message.
    expect(ctx.calls.findMessagesByIds).toHaveLength(1);
    expect(ctx.calls.findMessagesByIds[0]).toHaveLength(100);
    expect(ctx.calls.findMessageById).toBe(0);
  });

  test("the limit counts what was sent, not the distinct ids", async () => {
    const ctx = makeBatchApp();
    const res = await batch(ctx, Array.from({ length: 101 }, () => M1));
    expect(res.status).toBe(400);
  });

  test.each([
    ["a string", "abc"],
    ["an object", { a: 1 }],
    ["a number", 5],
    ["a list with a non-uuid", [M1, "nope"]],
    ["a list with a number", [M1, 7]],
    ["a list with null", [M1, null]],
    ["a list with a nested list", [[M1]]],
  ])("sourceMessageIds as %s is refused", async (_name, value) => {
    const ctx = makeBatchApp();
    const res = await forward(ctx, { sourceMessageIds: value, targetChatIds: [TARGET_GROUP] });
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe("string");
    expect(ctx.created).toHaveLength(0);
  });

  test("sourceMessageId and sourceMessageIds together are ambiguous", async () => {
    const ctx = makeBatchApp();
    const res = await forward(ctx, { sourceMessageId: M1, sourceMessageIds: [M2], targetChatIds: [TARGET_GROUP] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/either/);
  });

  test("a multi-select request needs target chats", async () => {
    const ctx = makeBatchApp();
    expect((await forward(ctx, { sourceMessageIds: [M1] })).status).toBe(400);
    expect((await forward(ctx, { sourceMessageIds: [M1], targetChatIds: [] })).status).toBe(400);
    expect((await forward(ctx, { sourceMessageIds: [M1], targetChatIds: [7] })).status).toBe(400);
  });

  test("at most 20 target chats", async () => {
    const ctx = makeBatchApp();
    const targets = Array.from({ length: 21 }, (_, i) => uid(0x9000 + i));
    const res = await forward(ctx, { sourceMessageIds: [M1], targetChatIds: targets });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at most 20 chats/);
  });

  test("a request cannot create more than 500 messages (messages x chats)", async () => {
    const ctx = makeBatchApp();
    const targets = Array.from({ length: 6 }, (_, i) => uid(0x9000 + i));
    const res = await forward(ctx, { sourceMessageIds: manyIds(100), targetChatIds: targets });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at most 500/);
    expect(ctx.created).toHaveLength(0);
    expect(ctx.calls.findMessagesByIds).toHaveLength(0);
  });

  test("the sender's own text is not accepted on a multi-select request: each message keeps its own", async () => {
    const ctx = makeBatchApp();
    await batch(ctx, [M1, M2], { body: "I am impersonating Bob" });
    expect(createdBodies(ctx)).toEqual(["first", "second (edited)"]);
  });
});

describe("POST /api/messages/forward: accounts", () => {
  test("a banned account whose session is still around is refused, for one message and for many", async () => {
    const ctx = makeBatchApp();
    ctx.userStore.users.get("alice").banned = 1;
    const single = await forward(ctx, { sourceMessageId: M1, targetChatIds: [TARGET_GROUP], body: "x" });
    expect(single.status).toBe(403);
    expect(single.body).toEqual({ error: "Account is banned." });
    const many = await batch(ctx, [M1, M2]);
    expect(many.status).toBe(403);
    expect(many.body).toEqual({ error: "Account is banned." });
    expect(ctx.created).toHaveLength(0);
  });

  test("an account that was deleted has no session and no user", async () => {
    const ctx = makeBatchApp();
    ctx.userStore.users.delete("alice");
    const res = await batch(ctx, [M1]);
    expect([401, 404]).toContain(res.status);
    expect(ctx.created).toHaveLength(0);
  });

  test("a message by a deleted account can still be forwarded: the origin says 'Deleted user'", async () => {
    const ctx = makeBatchApp();
    ctx.userStore.users.delete("bob");
    const res = await forward(ctx, { sourceMessageIds: [M1], targetChatIds: [TARGET_GROUP] });
    expect(res.status).toBe(200);
    expect(ctx.origins[0]).toMatchObject({ label: "Deleted user", sourceUsername: null, sourceAvatarUrl: null });
  });
});

describe("POST /api/messages/forward: lookups and rate limit", () => {
  test("no query per message: one lookup per kind for the whole request", async () => {
    const ctx = makeBatchApp();
    const res = await forward(ctx, {
      sourceMessageIds: [M1, M2, M3, M4, M5],
      targetChatIds: [TARGET_GROUP],
    });
    expect(res.status).toBe(200);
    expect(ctx.calls.findMessagesByIds).toHaveLength(1);
    expect(ctx.calls.findMessageById).toBe(0);
    expect(ctx.calls.listHidden).toHaveLength(1);
    expect(ctx.calls.listFiles).toHaveLength(1);
    // One chat, one membership check for the source and one for the target.
    expect(ctx.calls.isMember.filter((id) => id === GROUP)).toHaveLength(1);
    expect(ctx.calls.findChatById.filter((id) => id === GROUP)).toHaveLength(1);
    // Two authors, looked up once each.
    expect(ctx.calls.findUserById.slice().sort()).toEqual([ALICE_ID, BOB_ID].sort());
  });

  test("one rate-limit token per request, however many messages it names", async () => {
    const ctx = makeBatchApp();
    const ids = ctx.addFillers(100);
    for (let i = 0; i < 30; i += 1) {
      const res = await batch(ctx, ids);
      expect(res.status, `request ${i + 1}`).toBe(200);
    }
    const limited = await batch(ctx, [M1]);
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: "Too many forward requests. Please slow down." });
  }, 60_000);

  test("the limit is per person", async () => {
    const ctx = makeBatchApp();
    for (let i = 0; i < 30; i += 1) {
      expect((await batch(ctx, [M1])).status).toBe(200);
    }
    expect((await batch(ctx, [M1])).status).toBe(429);
    // Bob is in the same chats and is not affected.
    const bob = await forward(
      ctx,
      { sourceMessageIds: [M1], targetChatIds: [TARGET_GROUP], username: "bob" },
      { token: "tok-bob", username: "bob" },
    );
    expect(bob.status).toBe(200);
  }, 60_000);

  test("a refused request does not use up a token", async () => {
    const ctx = makeBatchApp();
    for (let i = 0; i < 40; i += 1) {
      expect((await batch(ctx, [])).status).toBe(400);
    }
    expect((await batch(ctx, [M1])).status).toBe(200);
  });
});
