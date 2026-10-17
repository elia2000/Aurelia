import { describe, test, expect, vi } from "vitest";
import request from "supertest";
import { THUMBS } from "../helpers/reactionFixture.js";
import {
  ALICE_ID,
  BOB_ID,
  CHAT_ID,
  MSG_ID,
  makePinApp,
} from "../helpers/pinFixture.js";

const CALL_MSG_ID = "ca11ca11-0000-4000-8000-000000000001";
const CALL_MSG_ID_2 = "ca11ca11-0000-4000-8000-000000000002";
const CALL_ID = "ca11ca11-1111-4111-8111-111111111111";
const NOW = "2025-01-01 10:00:00";

// What db.js getMessages hands the route for an ordinary message.
function rawMessage(id, overrides = {}) {
  return {
    id,
    chat_id: CHAT_ID,
    user_id: BOB_ID,
    username: "bob",
    nickname: "Bob",
    avatar_url: null,
    color: "#10b981",
    body: `body of ${id}`,
    created_at: NOW,
    edited: 0,
    read_at: null,
    read_by_user_id: null,
    expires_at: null,
    client_request_id: null,
    reply_to_message_id: null,
    reply_id: null,
    hidden_everyone_at: null,
    ...overrides,
  };
}

// ... and for a call entry: written by the caller, empty body, call columns.
function rawCallMessage(id, overrides = {}) {
  return rawMessage(id, {
    user_id: ALICE_ID,
    username: "alice",
    nickname: "Alice",
    body: "",
    call_id: CALL_ID,
    call_kind: "audio",
    call_outcome: "completed",
    call_duration_sec: 83,
    ...overrides,
  });
}

// An ordinary DM between alice and bob that holds one call entry.
function makeDmApp({ messages = [], deps = {}, ...options } = {}) {
  const ctx = makePinApp({
    ...options,
    chat: { type: "dm", name: "alice & bob" },
    deps: {
      getMessages: () => ({ messages, hasMore: false }),
      getMessageReadByUser: () => [],
      getMessageReadCounts: () => [],
      listMessageFilesByMessageIds: () => [],
      hydrateMissingVideoMetadata: async (files) => files,
      ...deps,
    },
  });
  // The row findMessageById answers with: the call columns are part of it.
  ctx.messages.set(CALL_MSG_ID, {
    id: CALL_MSG_ID,
    chat_id: CHAT_ID,
    user_id: ALICE_ID,
    body: "",
    hidden_everyone_at: null,
    call_id: CALL_ID,
    call_kind: "audio",
    call_outcome: "completed",
    call_duration_sec: 83,
  });
  return ctx;
}

const list = async (ctx, username = "alice") => {
  const cookie = await ctx.login(username);
  return request(ctx.app)
    .get("/api/messages")
    .set("Cookie", cookie)
    .query({ chatId: CHAT_ID, username });
};

const post = async (ctx, username, url, body) => {
  const cookie = await ctx.login(username);
  return request(ctx.app).post(url).set("Cookie", cookie).send(body);
};

describe("GET /api/messages: call entries", () => {
  test("a call entry says what it is and carries the structured call", async () => {
    const ctx = makeDmApp({ messages: [rawCallMessage(CALL_MSG_ID)] });
    const res = await list(ctx, "bob");
    expect(res.status).toBe(200);
    const [entry] = res.body.messages;
    expect(entry).toMatchObject({
      id: CALL_MSG_ID,
      type: "call",
      messageType: "call",
      body: "",
      user_id: ALICE_ID,
      username: "alice",
      call: { callId: CALL_ID, kind: "audio", outcome: "completed", durationSec: 83 },
      reactions: [],
      pinned: false,
    });
  });

  test("the call object has exactly the four documented fields", async () => {
    const ctx = makeDmApp({ messages: [rawCallMessage(CALL_MSG_ID)] });
    const res = await list(ctx, "bob");
    expect(Object.keys(res.body.messages[0].call).sort()).toEqual([
      "callId",
      "durationSec",
      "kind",
      "outcome",
    ]);
  });

  test("the raw database columns are not repeated next to it", async () => {
    const ctx = makeDmApp({ messages: [rawCallMessage(CALL_MSG_ID)] });
    const res = await list(ctx, "bob");
    for (const column of ["call_id", "call_kind", "call_outcome", "call_duration_sec"]) {
      expect(res.body.messages[0]).not.toHaveProperty(column);
    }
  });

  test("ordinary messages have no call and say they are text", async () => {
    const ctx = makeDmApp({ messages: [rawMessage(MSG_ID)] });
    const res = await list(ctx, "alice");
    const [entry] = res.body.messages;
    expect(entry.call).toBeNull();
    expect(entry.messageType).toBe("text");
    expect(entry).not.toHaveProperty("type");
  });

  test("every outcome comes out as stored, with a duration only when there is one", async () => {
    const outcomes = ["completed", "missed", "declined", "cancelled", "busy", "failed"];
    const rows = outcomes.map((outcome, i) =>
      rawCallMessage(`ca11ca11-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`, {
        call_id: `ca11ca11-1111-4111-8111-1111111112${String(i).padStart(2, "0")}`,
        call_outcome: outcome,
        call_kind: i % 2 ? "video" : "audio",
        call_duration_sec: outcome === "completed" ? 5 : null,
      }),
    );
    const ctx = makeDmApp({ messages: rows });
    const res = await list(ctx, "bob");
    expect(res.body.messages.map((m) => m.call.outcome)).toEqual(outcomes);
    expect(res.body.messages.map((m) => m.call.kind)).toEqual([
      "audio",
      "video",
      "audio",
      "video",
      "audio",
      "video",
    ]);
    expect(res.body.messages.map((m) => m.call.durationSec)).toEqual([5, null, null, null, null, null]);
  });

  test("calls and text appear in the order the database gave them", async () => {
    const ctx = makeDmApp({
      messages: [
        rawMessage(MSG_ID, { created_at: "2025-01-01 09:00:00" }),
        rawCallMessage(CALL_MSG_ID, { created_at: "2025-01-01 09:30:00" }),
        rawMessage("ca11ca11-0000-4000-8000-0000000000aa", { created_at: "2025-01-01 10:00:00" }),
      ],
    });
    const res = await list(ctx, "alice");
    expect(res.body.messages.map((m) => m.id)).toEqual([
      MSG_ID,
      CALL_MSG_ID,
      "ca11ca11-0000-4000-8000-0000000000aa",
    ]);
  });

  test("the caller's own entry is read; a missed one stays unread for the callee until read", async () => {
    const missed = rawCallMessage(CALL_MSG_ID, { call_outcome: "missed", call_duration_sec: null });
    const unreadForBob = makeDmApp({ messages: [missed] });
    const asCaller = await list(unreadForBob, "alice");
    expect(asCaller.body.messages[0].read_by_me).toBe(true);
    const asCallee = await list(unreadForBob, "bob");
    expect(asCallee.body.messages[0].read_by_me).toBe(false);

    const readByBob = makeDmApp({
      messages: [missed],
      deps: { getMessageReadByUser: () => [{ message_id: CALL_MSG_ID }] },
    });
    expect((await list(readByBob, "bob")).body.messages[0].read_by_me).toBe(true);
  });

  test("a page of many entries costs no extra queries per entry", async () => {
    const rows = Array.from({ length: 50 }, (_, i) =>
      rawCallMessage(`ca11ca11-0000-4000-8000-${String(i + 1000).padStart(12, "0")}`, {
        call_id: `ca11ca11-1111-4111-8111-${String(i + 1000).padStart(12, "0")}`,
      }),
    );
    const getMessages = vi.fn(() => ({ messages: rows, hasMore: false }));
    const findMessageById = vi.fn(() => null);
    const getMessageReadByUser = vi.fn(() => []);
    const ctx = makeDmApp({
      messages: rows,
      deps: { getMessages, findMessageById, getMessageReadByUser },
    });
    const res = await list(ctx, "bob");
    expect(res.body.messages).toHaveLength(50);
    expect(getMessages).toHaveBeenCalledTimes(1);
    expect(getMessageReadByUser).toHaveBeenCalledTimes(1);
    expect(findMessageById).not.toHaveBeenCalled();
  });

  test("a stored value that is not a known outcome cannot break the list", async () => {
    const ctx = makeDmApp({
      messages: [rawCallMessage(CALL_MSG_ID, { call_outcome: "weird", call_kind: "hologram" })],
    });
    const res = await list(ctx, "alice");
    expect(res.status).toBe(200);
    expect(res.body.messages[0].call).toMatchObject({ outcome: "failed", kind: "audio" });
  });
});

describe("call entries cannot be treated like text", () => {
  test("cannot be edited by their author", async () => {
    const editMessage = vi.fn();
    const ctx = makeDmApp({ deps: { editMessage } });
    const res = await post(ctx, "alice", "/api/messages/edit", {
      chatId: CHAT_ID,
      username: "alice",
      messageId: CALL_MSG_ID,
      body: "I never called",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot be edited/i);
    expect(editMessage).not.toHaveBeenCalled();
  });

  test("cannot be edited by attaching files to them either", async () => {
    const createMessageFiles = vi.fn();
    const editMessage = vi.fn();
    const ctx = makeDmApp({ deps: { createMessageFiles, editMessage } });
    const res = await post(ctx, "alice", "/api/messages/upload", {
      chatId: CHAT_ID,
      username: "alice",
      body: "hello",
      editMessageId: CALL_MSG_ID,
      storageKeys: ["uploads/doc.pdf"],
      fileMeta: JSON.stringify([{ originalName: "doc.pdf", mimeType: "application/pdf", sizeBytes: 10 }]),
    });
    expect(res.status).toBe(400);
    expect(createMessageFiles).not.toHaveBeenCalled();
    expect(editMessage).not.toHaveBeenCalled();
  });

  test("cannot be forwarded", async () => {
    const createMessage = vi.fn();
    const ctx = makeDmApp({ deps: { createMessage } });
    const res = await post(ctx, "bob", "/api/messages/forward", {
      username: "bob",
      sourceMessageId: CALL_MSG_ID,
      targetChatIds: [CHAT_ID],
      body: "call",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot be forwarded/i);
    expect(createMessage).not.toHaveBeenCalled();
  });

  test("cannot be reacted to", async () => {
    const ctx = makeDmApp();
    const res = await post(ctx, "bob", "/api/messages/react", {
      chatId: CHAT_ID,
      username: "bob",
      messageId: CALL_MSG_ID,
      emoji: THUMBS,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not available/i);
    expect(ctx.store.rows).toHaveLength(0);
    expect(ctx.store.calls.toggle).toHaveLength(0);
  });

  test("reactions to it cannot be listed either; there are none", async () => {
    const ctx = makeDmApp();
    const cookie = await ctx.login("bob");
    const res = await request(ctx.app)
      .get("/api/messages/reactions")
      .set("Cookie", cookie)
      .query({ chatId: CHAT_ID, username: "bob", messageId: CALL_MSG_ID });
    expect(res.status).toBe(200);
    expect(res.body.reactions).toEqual([]);
  });

  test("cannot be pinned", async () => {
    const ctx = makeDmApp();
    const cookie = await ctx.login("alice");
    const res = await request(ctx.app)
      .post(`/api/chats/${CHAT_ID}/pins`)
      .set("Cookie", cookie)
      .send({ messageId: CALL_MSG_ID });
    expect(res.status).toBe(400);
    expect(ctx.pins.rows).toHaveLength(0);
  });

  test("cannot be replied to", async () => {
    const createOrReuseMessage = vi.fn(() => ({ id: MSG_ID }));
    const ctx = makeDmApp({ deps: { createOrReuseMessage } });
    const res = await post(ctx, "bob", "/api/messages", {
      chatId: CHAT_ID,
      username: "bob",
      body: "sorry I missed it",
      replyToMessageId: CALL_MSG_ID,
    });
    expect(res.status).toBe(400);
    expect(createOrReuseMessage).not.toHaveBeenCalled();
  });

  test("cannot be replied to with an upload either", async () => {
    const createOrReuseMessage = vi.fn(() => ({ id: MSG_ID }));
    const ctx = makeDmApp({ deps: { createOrReuseMessage } });
    const res = await post(ctx, "bob", "/api/messages/upload", {
      chatId: CHAT_ID,
      username: "bob",
      body: "photo",
      replyToMessageId: CALL_MSG_ID,
      storageKeys: ["uploads/photo.png"],
      fileMeta: JSON.stringify([{ originalName: "photo.png", mimeType: "image/png", sizeBytes: 10 }]),
    });
    expect(res.status).toBe(400);
    expect(createOrReuseMessage).not.toHaveBeenCalled();
  });

  test("cannot be deleted for everyone, not even by the person who made the call", async () => {
    const hideMessageForEveryone = vi.fn();
    const ctx = makeDmApp({ deps: { hideMessageForEveryone } });
    const res = await post(ctx, "alice", "/api/messages/delete", {
      chatId: CHAT_ID,
      username: "alice",
      messageId: CALL_MSG_ID,
      scope: "everyone",
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("call_message_self_only");
    expect(hideMessageForEveryone).not.toHaveBeenCalled();
  });

  test.each(["alice", "bob"])("can be hidden for yourself by %s", async (who) => {
    const hideMessageForUser = vi.fn();
    const ctx = makeDmApp({ deps: { hideMessageForUser } });
    const res = await post(ctx, who, "/api/messages/delete", {
      chatId: CHAT_ID,
      username: who,
      messageId: CALL_MSG_ID,
      scope: "self",
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, scope: "self", id: CALL_MSG_ID });
    expect(hideMessageForUser).toHaveBeenCalledWith(CALL_MSG_ID, who === "alice" ? ALICE_ID : BOB_ID);
  });

  test("hiding it without a scope defaults to yourself", async () => {
    const hideMessageForUser = vi.fn();
    const ctx = makeDmApp({ deps: { hideMessageForUser } });
    const res = await post(ctx, "bob", "/api/messages/delete", {
      chatId: CHAT_ID,
      username: "bob",
      messageId: CALL_MSG_ID,
    });
    expect(res.status).toBe(200);
    expect(hideMessageForUser).toHaveBeenCalledTimes(1);
  });

  test("an outsider cannot hide it", async () => {
    const ctx = makeDmApp();
    const res = await post(ctx, "carol", "/api/messages/delete", {
      chatId: CHAT_ID,
      username: "carol",
      messageId: CALL_MSG_ID,
      scope: "self",
    });
    expect(res.status).toBe(403);
  });

  test("ordinary messages are still editable, forwardable and reactable", async () => {
    const editMessage = vi.fn();
    const ctx = makeDmApp({ deps: { editMessage } });
    const edited = await post(ctx, "bob", "/api/messages/edit", {
      chatId: CHAT_ID,
      username: "bob",
      messageId: MSG_ID,
      body: "better words",
    });
    expect(edited.status).toBe(200);
    const reacted = await post(ctx, "alice", "/api/messages/react", {
      chatId: CHAT_ID,
      username: "alice",
      messageId: MSG_ID,
      emoji: THUMBS,
    });
    expect(reacted.status).toBe(200);
  });
});

describe("GET /api/chats: the last message is a call", () => {
  const callRow = (overrides = {}) => ({
    id: CHAT_ID,
    name: "alice & bob",
    type: "dm",
    last_message_id: CALL_MSG_ID,
    last_message: "",
    last_time: NOW,
    last_sender_id: ALICE_ID,
    last_sender_username: "alice",
    last_sender_nickname: "Alice",
    last_call_id: CALL_ID,
    last_call_kind: "audio",
    last_call_outcome: "completed",
    last_call_duration_sec: 83,
    unread_count: 0,
    pin_position: null,
    ...overrides,
  });

  const chatsFor = async (row, username) => {
    const ctx = makeDmApp({
      deps: {
        listChatsForUser: () => [row],
        listChatMembersForChats: () => new Map(),
      },
    });
    const cookie = await ctx.login(username);
    const res = await request(ctx.app).get("/api/chats").set("Cookie", cookie).query({ username });
    expect(res.status).toBe(200);
    return res.body.chats[0];
  };

  test("the caller reads an outgoing call, the callee an incoming one", async () => {
    const asCaller = await chatsFor(callRow(), "alice");
    const asCallee = await chatsFor(callRow(), "bob");
    expect(asCaller.last_message).toBe("Outgoing call");
    expect(asCallee.last_message).toBe("Incoming call");
  });

  test.each([
    ["audio", "completed", "alice", "Outgoing call"],
    ["audio", "completed", "bob", "Incoming call"],
    ["video", "completed", "alice", "Outgoing video call"],
    ["video", "completed", "bob", "Incoming video call"],
    ["audio", "missed", "bob", "Missed call"],
    ["video", "missed", "bob", "Missed video call"],
    ["audio", "missed", "alice", "No answer"],
    ["audio", "declined", "alice", "Declined call"],
    ["audio", "declined", "bob", "Declined call"],
    ["video", "declined", "bob", "Declined video call"],
    ["audio", "cancelled", "alice", "Cancelled call"],
    ["audio", "cancelled", "bob", "Cancelled call"],
    ["audio", "busy", "alice", "Busy"],
    ["audio", "failed", "alice", "Call failed"],
    ["video", "failed", "bob", "Video call failed"],
  ])("a %s call that was %s reads right for %s: %s", async (kind, outcome, who, text) => {
    const chat = await chatsFor(
      callRow({
        last_call_kind: kind,
        last_call_outcome: outcome,
        last_call_duration_sec: outcome === "completed" ? 9 : null,
      }),
      who,
    );
    expect(chat.last_message).toBe(text);
  });

  test("the structured call is sent too, so the client can say it in its own language", async () => {
    const chat = await chatsFor(callRow({ last_call_kind: "video" }), "bob");
    expect(chat.last_message_type).toBe("call");
    expect(chat.last_call).toEqual({
      callId: CALL_ID,
      kind: "video",
      outcome: "completed",
      durationSec: 83,
    });
    expect(chat.last_sender_id).toBe(ALICE_ID);
  });

  test("the raw database columns are not repeated", async () => {
    const chat = await chatsFor(callRow(), "bob");
    for (const column of ["last_call_id", "last_call_kind", "last_call_outcome", "last_call_duration_sec"]) {
      expect(chat).not.toHaveProperty(column);
    }
  });

  test("a chat whose last message is text is unchanged and has no call", async () => {
    const chat = await chatsFor(
      callRow({
        last_message: "see you",
        last_call_id: null,
        last_call_kind: null,
        last_call_outcome: null,
        last_call_duration_sec: null,
      }),
      "bob",
    );
    expect(chat.last_message).toBe("see you");
    expect(chat.last_message_type).toBe("message");
    expect(chat.last_call).toBeNull();
  });

  test("a chat with no messages at all has no call either", async () => {
    const chat = await chatsFor(
      callRow({
        last_message_id: null,
        last_message: null,
        last_call_id: null,
        last_call_kind: null,
        last_call_outcome: null,
        last_call_duration_sec: null,
      }),
      "bob",
    );
    expect(chat.last_call).toBeNull();
    expect(chat.last_message_type).toBe("message");
  });
});
