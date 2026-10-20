import { describe, test, expect, vi } from "vitest";
import request from "supertest";
import {
  ALICE_ID,
  BOB_ID,
  CHAT_ID,
  FIRE,
  HEART,
  MSG_ID,
  MSG_ID_2,
  THUMBS,
  makeReactionApp,
} from "../helpers/reactionFixture.js";

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

function makeListApp(rawMessages, deps = {}) {
  return makeReactionApp({
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

describe("GET /api/messages reactions", () => {
  test("every message has a reactions array, empty when nobody reacted", async () => {
    const ctx = makeListApp([rawMessage(MSG_ID), rawMessage(MSG_ID_2)]);
    const res = await list(ctx);
    expect(res.status).toBe(200);
    expect(res.body.messages.map((m) => m.reactions)).toEqual([[], []]);
  });

  test("carries count and the caller's own flag, most used first", async () => {
    const ctx = makeListApp([rawMessage(MSG_ID), rawMessage(MSG_ID_2)]);
    ctx.store.toggleMessageReaction({ messageId: MSG_ID, userId: BOB_ID, emoji: HEART, maxPerUser: 1 });
    ctx.store.toggleMessageReaction({ messageId: MSG_ID, userId: ALICE_ID, emoji: THUMBS, maxPerUser: 1 });
    ctx.store.toggleMessageReaction({ messageId: MSG_ID_2, userId: BOB_ID, emoji: THUMBS, maxPerUser: 1 });
    ctx.store.toggleMessageReaction({ messageId: MSG_ID_2, userId: ALICE_ID, emoji: THUMBS, maxPerUser: 1 });

    const asAlice = await list(ctx, "alice");
    const byId = Object.fromEntries(asAlice.body.messages.map((m) => [m.id, m.reactions]));
    expect(byId[MSG_ID]).toEqual([
      { emoji: HEART, count: 1, reacted: false },
      { emoji: THUMBS, count: 1, reacted: true },
    ]);
    expect(byId[MSG_ID_2]).toEqual([{ emoji: THUMBS, count: 2, reacted: true }]);

    const asBob = await list(ctx, "bob");
    const bobById = Object.fromEntries(asBob.body.messages.map((m) => [m.id, m.reactions]));
    expect(bobById[MSG_ID]).toEqual([
      { emoji: HEART, count: 1, reacted: true },
      { emoji: THUMBS, count: 1, reacted: false },
    ]);
  });

  test("a whole page needs exactly one reactions query, with every id and the viewer", async () => {
    const ids = Array.from(
      { length: 40 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    const ctx = makeListApp(ids.map((id) => rawMessage(id)));
    const res = await list(ctx);
    expect(res.status).toBe(200);
    expect(res.body.messages.length).toBe(40);
    expect(ctx.store.calls.summaries.length).toBe(1);
    expect(ctx.store.calls.summaries[0].messageIds.sort()).toEqual([...ids].sort());
    expect(ctx.store.calls.summaries[0].viewerUserId).toBe(ALICE_ID);
  });

  test("an empty page makes no reactions query that matters", async () => {
    const ctx = makeListApp([]);
    const res = await list(ctx);
    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
  });

  test("works with a database that answers with promises", async () => {
    const ctx = makeReactionApp({
      asyncDb: true,
      deps: {
        getMessages: async () => ({ messages: [rawMessage(MSG_ID)], hasMore: false }),
        getMessageReadByUser: async () => [],
        listMessageFilesByMessageIds: async () => [],
        hydrateMissingVideoMetadata: async (files) => files,
      },
    });
    ctx.store.toggleMessageReaction({ messageId: MSG_ID, userId: ALICE_ID, emoji: FIRE, maxPerUser: 1 });
    const res = await list(ctx);
    expect(res.body.messages[0].reactions).toEqual([{ emoji: FIRE, count: 1, reacted: true }]);
  });

  test("a server without the reaction functions still lists messages", async () => {
    const ctx = makeListApp([rawMessage(MSG_ID)], { listMessageReactionSummaries: undefined });
    const res = await list(ctx);
    expect(res.status).toBe(200);
    expect(res.body.messages[0].reactions).toEqual([]);
  });

  test("a failing reactions query does not take the message list down", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = makeListApp([rawMessage(MSG_ID)], {
      listMessageReactionSummaries: () => {
        throw new Error("boom");
      },
    });
    const res = await list(ctx);
    expect(res.status).toBe(200);
    expect(res.body.messages[0].reactions).toEqual([]);
    spy.mockRestore();
  });

  test("nobody outside the chat can read reactions through the list", async () => {
    const ctx = makeListApp([rawMessage(MSG_ID)], { isMember: () => false });
    ctx.store.toggleMessageReaction({ messageId: MSG_ID, userId: ALICE_ID, emoji: FIRE, maxPerUser: 1 });
    const res = await list(ctx, "carol");
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain(FIRE);
    expect(ctx.store.calls.summaries).toEqual([]);
  });
});
