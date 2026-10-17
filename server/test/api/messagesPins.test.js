import { describe, test, expect, vi } from "vitest";
import request from "supertest";
import {
  ALICE_ID,
  BOB_ID,
  CHAT_ID,
  MSG_ID,
  MSG_ID_2,
  SYSTEM_MSG_ID,
  flush,
  makePinApp,
  pinAs,
} from "../helpers/pinFixture.js";

const NOW = "2025-01-01 10:00:00";

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

function makeListApp(rawMessages, { deps = {}, ...options } = {}) {
  return makePinApp({
    ...options,
    deps: {
      getMessages: () => ({ messages: rawMessages, hasMore: false }),
      getMessageReadByUser: () => [],
      getMessageReadCounts: () => [],
      listMessageFilesByMessageIds: () => [],
      hydrateMissingVideoMetadata: async (files) => files,
      ...deps,
    },
  });
}

const list = async (ctx, username = "alice") => {
  const cookie = await ctx.login(username);
  return request(ctx.app)
    .get("/api/messages")
    .set("Cookie", cookie)
    .query({ chatId: CHAT_ID, username });
};

const eventsOfType = (ctx, type) =>
  ctx.events.filter((e) => e.payload.type === type).map((e) => e.payload);

describe("GET /api/messages pinned flag", () => {
  test("every message says whether it is pinned", async () => {
    const ctx = makeListApp([rawMessage(MSG_ID), rawMessage(MSG_ID_2)]);
    await pinAs(ctx, "alice", MSG_ID_2);
    const res = await list(ctx, "bob");
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.messages.map((m) => [m.id, m.pinned]));
    expect(byId).toEqual({ [MSG_ID]: false, [MSG_ID_2]: true });
    for (const message of res.body.messages) expect(typeof message.pinned).toBe("boolean");
  });

  test("a whole page needs exactly one pin query, with every id and the chat", async () => {
    const ids = Array.from(
      { length: 40 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    const ctx = makeListApp(ids.map((id) => rawMessage(id)));
    const res = await list(ctx);
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(40);
    expect(ctx.pins.calls.ids).toHaveLength(1);
    expect(ctx.pins.calls.ids[0].chatId).toBe(CHAT_ID);
    expect(ctx.pins.calls.ids[0].messageIds.sort()).toEqual([...ids].sort());
  });

  test("an empty page makes no pin query", async () => {
    const ctx = makeListApp([]);
    const res = await list(ctx);
    expect(res.status).toBe(200);
    expect(ctx.pins.calls.ids).toEqual([]);
  });

  test("works with a database that answers with promises", async () => {
    const ctx = makeListApp([rawMessage(MSG_ID)], { asyncDb: true });
    await pinAs(ctx, "alice", MSG_ID);
    const res = await list(ctx);
    expect(res.body.messages[0].pinned).toBe(true);
  });

  test("a server without the pin function still lists messages", async () => {
    const ctx = makeListApp([rawMessage(MSG_ID)], { deps: { listPinnedMessageIds: undefined } });
    const res = await list(ctx);
    expect(res.status).toBe(200);
    expect(res.body.messages[0].pinned).toBe(false);
  });

  test("a failing pin query does not take the message list down", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = makeListApp([rawMessage(MSG_ID)], {
      deps: {
        listPinnedMessageIds: () => {
          throw new Error("boom");
        },
      },
    });
    const res = await list(ctx);
    expect(res.status).toBe(200);
    expect(res.body.messages[0].pinned).toBe(false);
    spy.mockRestore();
  });

  test("nobody outside the chat reads anything", async () => {
    const ctx = makeListApp([rawMessage(MSG_ID)]);
    await pinAs(ctx, "alice", MSG_ID);
    ctx.pins.calls.ids.length = 0;
    const res = await list(ctx, "carol");
    expect(res.status).toBe(403);
    expect(ctx.pins.calls.ids).toEqual([]);
  });
});

describe("GET /api/messages service entries", () => {
  const pinEntry = (id, target, userId = ALICE_ID) =>
    rawMessage(id, {
      user_id: userId,
      username: "alice",
      nickname: "Alice",
      body: `[[system:pinned:${target}]]`,
    });

  test("an \"X pinned a message\" entry carries its structured form", async () => {
    const entryId = "9a9a9a9a-b2b2-4c3c-8d4d-e5e5e5e5e5e5";
    const ctx = makeListApp([rawMessage(MSG_ID), pinEntry(entryId, MSG_ID)]);
    const res = await list(ctx, "bob");
    const byId = Object.fromEntries(res.body.messages.map((m) => [m.id, m]));
    expect(byId[entryId].service).toEqual({ action: "pin", messageId: MSG_ID, actorId: ALICE_ID });
    expect(byId[entryId].body).toBe(`[[system:pinned:${MSG_ID}]]`);
    expect(byId[entryId].pinned).toBe(false);
  });

  test("ordinary messages and other service entries have no structured form", async () => {
    const ctx = makeListApp([
      rawMessage(MSG_ID),
      rawMessage(SYSTEM_MSG_ID, { body: "[[system:joined:Bob]]" }),
    ]);
    const res = await list(ctx);
    expect(res.body.messages.map((m) => m.service)).toEqual([null, null]);
  });

  test("an entry that only looks like one is not parsed", async () => {
    const ctx = makeListApp([rawMessage(MSG_ID, { body: "[[system:pinned:not-an-id]]" })]);
    const res = await list(ctx);
    expect(res.body.messages[0].service).toBeNull();
  });
});

describe("POST /api/messages/delete and pins", () => {
  const deleteAs = async (ctx, username, messageId, scope) => {
    const cookie = await ctx.login(username);
    return request(ctx.app)
      .post("/api/messages/delete")
      .set("Cookie", cookie)
      .send({ chatId: CHAT_ID, username, messageId, scope });
  };

  const makeDeleteApp = (options = {}) =>
    makePinApp({
      ...options,
      deps: {
        hideMessageForEveryone: () => {},
        hideMessageForUser: () => {},
        ...options.deps,
      },
    });

  test("deleting a pinned message for everyone unpins it and tells the chat", async () => {
    const ctx = makeDeleteApp();
    await pinAs(ctx, "alice", MSG_ID);
    ctx.events.length = 0;

    const res = await deleteAs(ctx, "alice", MSG_ID, "everyone");
    expect(res.status).toBe(200);
    expect(ctx.pins.rows).toHaveLength(0);
    expect(eventsOfType(ctx, "message_unpinned")).toEqual([
      { type: "message_unpinned", chatId: CHAT_ID, messageId: MSG_ID },
    ]);
    // The deletion itself is announced first.
    const order = ctx.events.map((e) => e.payload.type);
    expect(order).toEqual(["chat_message_deleted", "message_unpinned"]);
  });

  test("a message that was not pinned produces no unpin event", async () => {
    const ctx = makeDeleteApp();
    await pinAs(ctx, "alice", MSG_ID);
    ctx.events.length = 0;
    const res = await deleteAs(ctx, "alice", MSG_ID_2, "everyone");
    expect(res.status).toBe(200);
    expect(eventsOfType(ctx, "message_unpinned")).toEqual([]);
    expect(ctx.pins.rows).toHaveLength(1);
  });

  test("deleting only for yourself leaves the pin for everybody", async () => {
    const ctx = makeDeleteApp();
    await pinAs(ctx, "alice", MSG_ID);
    ctx.events.length = 0;
    const res = await deleteAs(ctx, "bob", MSG_ID, "self");
    expect(res.status).toBe(200);
    expect(ctx.pins.rows).toHaveLength(1);
    expect(ctx.events).toEqual([]);
  });

  test("somebody who may not delete for everyone cannot remove a pin that way", async () => {
    const ctx = makeDeleteApp();
    await pinAs(ctx, "alice", MSG_ID_2); // alice's own message
    const res = await deleteAs(ctx, "bob", MSG_ID_2, "everyone");
    expect(res.status).toBe(403);
    expect(ctx.pins.rows).toHaveLength(1);
  });

  test("works with a database that answers with promises", async () => {
    const ctx = makeDeleteApp({ asyncDb: true });
    await pinAs(ctx, "alice", MSG_ID);
    const res = await deleteAs(ctx, "alice", MSG_ID, "everyone");
    expect(res.status).toBe(200);
    expect(ctx.pins.rows).toHaveLength(0);
    expect(eventsOfType(ctx, "message_unpinned")).toHaveLength(1);
  });

  test("a failure while unpinning does not undo the deletion", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = makeDeleteApp({
      deps: {
        unpinMessage: () => {
          throw new Error("boom");
        },
      },
    });
    const res = await deleteAs(ctx, "alice", MSG_ID, "everyone");
    expect(res.status).toBe(200);
    expect(eventsOfType(ctx, "chat_message_deleted")).toHaveLength(1);
    spy.mockRestore();
  });
});

describe("service entries cannot be faked, forwarded or edited", () => {
  const post = async (ctx, username, path, body) => {
    const cookie = await ctx.login(username);
    return request(ctx.app).post(path).set("Cookie", cookie).send({ username, ...body });
  };

  test.each([
    ["a pin entry", `[[system:pinned:${MSG_ID}]]`],
    ["a joined entry", "[[system:joined:Mallory]]"],
    ["an entry with leading spaces", `   [[system:pinned:${MSG_ID}]]`],
    ["an entry after a newline", `\n[[system:left:Bob]]`],
  ])("a person cannot send %s as a message", async (_label, body) => {
    const createOrReuseMessage = vi.fn(() => ({ id: MSG_ID_2, deduped: false }));
    const ctx = makePinApp({ deps: { createOrReuseMessage } });
    const res = await post(ctx, "bob", "/api/messages", { chatId: CHAT_ID, body });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid message body/i);
    expect(createOrReuseMessage).not.toHaveBeenCalled();
  });

  test("an ordinary message that mentions the syntax in the middle is fine", async () => {
    const ctx = makePinApp({
      deps: {
        createOrReuseMessage: () => ({ id: MSG_ID_2, deduped: false }),
        markMessageRead: () => {},
        listMutedUserIdsForChat: () => [],
        computeExpiryIso: () => null,
      },
    });
    const res = await post(ctx, "bob", "/api/messages", {
      chatId: CHAT_ID,
      body: "typing [[system:joined:x]] in the middle",
    });
    expect(res.status).toBe(200);
  });

  test("an \"X pinned a message\" entry cannot be reacted to", async () => {
    const ctx = makePinApp();
    ctx.addMessage({ id: "9a9a9a9a-b2b2-4c3c-8d4d-e5e5e5e5e5e5", user_id: ALICE_ID, body: `[[system:pinned:${MSG_ID}]]` });
    const res = await post(ctx, "bob", "/api/messages/react", {
      chatId: CHAT_ID,
      messageId: "9a9a9a9a-b2b2-4c3c-8d4d-e5e5e5e5e5e5",
      emoji: "\u{1F44D}",
    });
    expect(res.status).toBe(400);
    expect(ctx.store.rows).toHaveLength(0);
  });

  test("a caption cannot be a service entry either", async () => {
    const createMessageFiles = vi.fn();
    const removeUploadedFiles = vi.fn();
    const ctx = makePinApp({
      deps: {
        createMessageFiles,
        removeUploadedFiles,
        // The real middleware parses multipart; the route only needs the fields.
        uploadFiles: { array: () => (req, _res, next) => { req.files = []; next(); } },
      },
    });
    const res = await post(ctx, "bob", "/api/messages/upload", {
      chatId: CHAT_ID,
      uploadType: "media",
      body: `[[system:pinned:${MSG_ID}]]`,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid message body/i);
    expect(createMessageFiles).not.toHaveBeenCalled();
    expect(removeUploadedFiles).toHaveBeenCalled();
  });

  test("a message cannot be edited into a service entry", async () => {
    const editMessage = vi.fn();
    const ctx = makePinApp({ deps: { editMessage } });
    const res = await post(ctx, "bob", "/api/messages/edit", {
      chatId: CHAT_ID,
      messageId: MSG_ID,
      body: `[[system:pinned:${MSG_ID_2}]]`,
    });
    expect(res.status).toBe(400);
    expect(editMessage).not.toHaveBeenCalled();
  });

  test("a service entry cannot be edited", async () => {
    const editMessage = vi.fn();
    const ctx = makePinApp({ deps: { editMessage } });
    // The entry was written by alice (see the fixture's service message).
    const res = await post(ctx, "alice", "/api/messages/edit", {
      chatId: CHAT_ID,
      messageId: SYSTEM_MSG_ID,
      body: "now it says something else",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot be edited/i);
    expect(editMessage).not.toHaveBeenCalled();
  });

  test("a service entry cannot be forwarded", async () => {
    const createMessage = vi.fn();
    const ctx = makePinApp({ deps: { createMessage } });
    const res = await post(ctx, "alice", "/api/messages/forward", {
      sourceMessageId: SYSTEM_MSG_ID,
      targetChatIds: [CHAT_ID],
      body: "forwarded",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot be forwarded/i);
    expect(createMessage).not.toHaveBeenCalled();
  });

  test("somebody outside the chat cannot learn that a message is a service entry", async () => {
    const ctx = makePinApp();
    const res = await post(ctx, "carol", "/api/messages/forward", {
      sourceMessageId: SYSTEM_MSG_ID,
      targetChatIds: [CHAT_ID],
      body: "forwarded",
    });
    expect(res.status).toBe(403);
  });

  test("a forwarded body cannot be a service entry either", async () => {
    const createMessage = vi.fn();
    const ctx = makePinApp({ deps: { createMessage } });
    const res = await post(ctx, "alice", "/api/messages/forward", {
      sourceMessageId: MSG_ID,
      targetChatIds: [CHAT_ID],
      body: "[[system:joined:Mallory]]",
    });
    expect(res.status).toBe(400);
    expect(createMessage).not.toHaveBeenCalled();
  });

  test("an ordinary message is still forwarded", async () => {
    const forwarded = [];
    const ctx = makePinApp({
      deps: {
        createMessage: (...args) => {
          forwarded.push(args);
          return MSG_ID_2;
        },
        setMessageForwardOrigin: async () => {},
        listMessageFilesByMessageIds: () => [],
        markMessageRead: () => {},
        unhideChat: () => {},
      },
    });
    const res = await post(ctx, "alice", "/api/messages/forward", {
      sourceMessageId: MSG_ID,
      targetChatIds: [CHAT_ID],
      body: "hello from bob",
    });
    expect(res.status).toBe(200);
    expect(forwarded).toHaveLength(1);
  });
});

describe("messages that disappear because their file is gone", () => {
  const missingFileCleanup = () => ({
    changed: true,
    deletedMessageIds: [MSG_ID],
    deletedByChat: new Map([[CHAT_ID, [MSG_ID]]]),
    unpinned: [{ chat_id: CHAT_ID, message_id: MSG_ID }],
  });

  test("reading the messages tells the chat that the pin is gone too", async () => {
    const ctx = makeListApp([rawMessage(MSG_ID)], {
      deps: { cleanupMissingMessageFiles: missingFileCleanup },
    });
    await list(ctx);
    await flush();
    await flush();
    expect(ctx.events.map((e) => e.payload.type)).toEqual(["chat_message_deleted", "message_unpinned"]);
    expect(eventsOfType(ctx, "message_unpinned")).toEqual([
      { type: "message_unpinned", chatId: CHAT_ID, messageId: MSG_ID },
    ]);
  });

  test("reading the chat list does the same", async () => {
    const ctx = makePinApp({
      deps: {
        listChatsForUser: () => [{ id: CHAT_ID, type: "group", last_message_id: MSG_ID }],
        listChatMembersForChats: () => new Map(),
        listMessageFilesByMessageIds: () => [],
        hydrateMissingVideoMetadata: async (files) => files,
        cleanupMissingMessageFiles: missingFileCleanup,
      },
    });
    const cookie = await ctx.login("alice");
    const res = await request(ctx.app).get("/api/chats").set("Cookie", cookie).query({ username: "alice" });
    expect(res.status).toBe(200);
    await flush();
    await flush();
    expect(eventsOfType(ctx, "message_unpinned")).toHaveLength(1);
  });

  test("a cleanup that removed nothing says nothing", async () => {
    const ctx = makeListApp([rawMessage(MSG_ID)], {
      deps: { cleanupMissingMessageFiles: () => ({ changed: false, deletedByChat: new Map(), unpinned: [] }) },
    });
    await list(ctx);
    await flush();
    expect(ctx.events).toEqual([]);
  });
});
