import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import {
  ALICE_ID,
  BOB_ID,
  CALL_MSG,
  CAROL_MSG,
  DELETED_MSG,
  DM,
  DM_MSG,
  GROUP,
  M1,
  M2,
  M3,
  M4,
  M5,
  MISSING_MSG,
  MY_CHANNEL,
  SERVICE_MSG,
  makeBatchApp,
  uid,
} from "../helpers/batchMessageFixture.js";

const del = (ctx, chatId, body, { token = "tok-alice", username = "alice" } = {}) =>
  request(ctx.app)
    .post("/api/messages/delete")
    .set("Cookie", `sid=${token}`)
    .send({ chatId, username, ...body });

const asBob = { token: "tok-bob", username: "bob" };
const resultOf = (res, messageId) => res.body.results.find((r) => r.messageId === messageId);

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/messages/delete: the single-message request keeps its answers", () => {
  test("for me only (the default): { ok, scope: self, id }, nothing is told to the chat", async () => {
    const ctx = makeBatchApp();
    const res = await del(ctx, GROUP, { messageId: M1 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, scope: "self", id: M1 });
    expect(ctx.calls.hideSelf).toEqual([{ id: M1, userId: ALICE_ID }]);
    expect(ctx.calls.hideEveryone).toEqual([]);
    expect(ctx.events).toEqual([]);
  });

  test("an unknown scope means for me only", async () => {
    const ctx = makeBatchApp();
    const res = await del(ctx, GROUP, { messageId: M1, scope: "bananas" });
    expect(res.body.scope).toBe("self");
  });

  test("for everyone, by the author: { ok, scope: everyone, id } and one chat_message_deleted", async () => {
    const ctx = makeBatchApp();
    const res = await del(ctx, GROUP, { messageId: M1, scope: "everyone" }, asBob);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, scope: "everyone", id: M1 });
    expect(ctx.calls.hideEveryone).toEqual([M1]);
    expect(ctx.events).toEqual([
      { chatId: GROUP, payload: { type: "chat_message_deleted", chatId: GROUP, messageIds: [M1] } },
    ]);
  });

  test("the owner of a group can delete anybody's message for everyone", async () => {
    const ctx = makeBatchApp();
    const res = await del(ctx, GROUP, { messageId: M1, scope: "everyone" });
    expect(res.status).toBe(200);
    expect(ctx.calls.hideEveryone).toEqual([M1]);
  });

  test("a member cannot delete somebody else's message for everyone", async () => {
    const ctx = makeBatchApp();
    const res = await del(ctx, GROUP, { messageId: M2, scope: "everyone" }, asBob);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "You cannot delete this message for everyone." });
    expect(ctx.calls.hideEveryone).toEqual([]);
    expect(ctx.events).toEqual([]);
  });

  test("a message that was pinned is unpinned with it, and the chat is told", async () => {
    const ctx = makeBatchApp();
    ctx.pin(GROUP, M1);
    const res = await del(ctx, GROUP, { messageId: M1, scope: "everyone" });
    expect(res.status).toBe(200);
    expect(ctx.isPinned(GROUP, M1)).toBe(false);
    expect(ctx.events.map((e) => e.payload)).toEqual([
      { type: "chat_message_deleted", chatId: GROUP, messageIds: [M1] },
      { type: "message_unpinned", chatId: GROUP, messageId: M1 },
    ]);
  });

  test("a message that was not pinned sends no unpin event", async () => {
    const ctx = makeBatchApp();
    await del(ctx, GROUP, { messageId: M1, scope: "everyone" });
    expect(ctx.eventsOfType("message_unpinned")).toHaveLength(0);
  });

  test("a call entry can be deleted for me, never for everyone (and says why with a code)", async () => {
    const ctx = makeBatchApp();
    const self = await del(ctx, DM, { messageId: CALL_MSG });
    expect(self.status).toBe(200);
    expect(self.body).toEqual({ ok: true, scope: "self", id: CALL_MSG });

    const everyone = await del(ctx, DM, { messageId: CALL_MSG, scope: "everyone" });
    expect(everyone.status).toBe(400);
    expect(everyone.body).toEqual({
      error: "Call entries can only be deleted for yourself.",
      code: "call_message_self_only",
    });
    expect(ctx.calls.hideEveryone).toEqual([]);
  });

  test.each([
    ["a message that does not exist", { messageId: MISSING_MSG }, GROUP, 404, "Message not found."],
    ["a message of another chat", { messageId: DM_MSG }, GROUP, 404, "Message not found."],
    ["a message of a chat I am not in", { messageId: CAROL_MSG }, GROUP, 404, "Message not found."],
    ["the same, for everyone", { messageId: DM_MSG, scope: "everyone" }, GROUP, 404, "Message not found."],
  ])("%s", async (_name, body, chatId, status, error) => {
    const ctx = makeBatchApp();
    const res = await del(ctx, chatId, body);
    expect(res.status).toBe(status);
    expect(res.body).toEqual({ error });
  });

  test("somebody outside the chat is turned away", async () => {
    const ctx = makeBatchApp();
    const res = await del(ctx, GROUP, { messageId: M1 }, { token: "tok-carol", username: "carol" });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Not a member of this chat." });
    expect(ctx.calls.hideSelf).toEqual([]);
  });

  test("a chat that does not exist (for everyone)", async () => {
    const ctx = makeBatchApp({ deps: { findChatById: () => null } });
    const res = await del(ctx, GROUP, { messageId: M1, scope: "everyone" });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Chat not found." });
  });

  test("in a channel only the owner can delete for everyone", async () => {
    const ctx = makeBatchApp();
    const post = uid(0x2020);
    ctx.messages.set(post, { ...ctx.messages.get(M1), id: post, chat_id: MY_CHANNEL, user_id: ALICE_ID });
    const subscriber = await del(ctx, MY_CHANNEL, { messageId: post, scope: "everyone" }, asBob);
    expect(subscriber.status).toBe(403);
    const owner = await del(ctx, MY_CHANNEL, { messageId: post, scope: "everyone" });
    expect(owner.status).toBe(200);
  });

  test("the required fields", async () => {
    const ctx = makeBatchApp();
    const noMessage = await del(ctx, GROUP, {});
    expect(noMessage.status).toBe(400);
    expect(noMessage.body).toEqual({ error: "Field 'messageId' is required." });
    expect((await del(ctx, GROUP, { messageId: "nope" })).status).toBe(400);
    expect((await del(ctx, "nope", { messageId: M1 })).status).toBe(400);
    expect((await del(ctx, GROUP, { messageId: M1, username: "" })).status).toBe(400);
    expect(ctx.calls.hideSelf).toEqual([]);
  });

  test("somebody else's session cannot delete in my name", async () => {
    const ctx = makeBatchApp();
    const res = await del(ctx, GROUP, { messageId: M1 }, { token: "tok-bob", username: "alice" });
    expect(res.status).toBe(403);
    expect(ctx.calls.hideSelf).toEqual([]);
  });

  test("a request without a session", async () => {
    const ctx = makeBatchApp();
    const res = await request(ctx.app).post("/api/messages/delete").send({ chatId: GROUP, username: "alice", messageId: M1 });
    expect(res.status).toBe(401);
  });

  test("a failing database is a 500 with an error body, not a crash", async () => {
    const ctx = makeBatchApp({
      deps: {
        hideMessageForUser: () => {
          throw new Error("disk");
        },
      },
    });
    const res = await del(ctx, GROUP, { messageId: M1 });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Unable to delete message." });
  });
});

describe("POST /api/messages/delete: several messages", () => {
  test("for me only: one result per message, in the order asked", async () => {
    const ctx = makeBatchApp();
    const res = await del(ctx, GROUP, { messageIds: [M3, M1, M2] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      results: [
        { messageId: M3, ok: true },
        { messageId: M1, ok: true },
        { messageId: M2, ok: true },
      ],
    });
    expect(ctx.calls.hideSelf).toEqual([
      { id: M3, userId: ALICE_ID },
      { id: M1, userId: ALICE_ID },
      { id: M2, userId: ALICE_ID },
    ]);
    // Nobody else is told about something only I stopped seeing.
    expect(ctx.events).toEqual([]);
  });

  test("a member may remove any message of the chat from their own view", async () => {
    const ctx = makeBatchApp();
    const res = await del(ctx, GROUP, { messageIds: [M2, M4] }, asBob);
    expect(res.body.results.every((r) => r.ok)).toBe(true);
  });

  test("for everyone, as the owner: all of them go and the chat hears about it once", async () => {
    const ctx = makeBatchApp();
    const res = await del(ctx, GROUP, { messageIds: [M5, M1, M3], scope: "everyone" });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([
      { messageId: M5, ok: true },
      { messageId: M1, ok: true },
      { messageId: M3, ok: true },
    ]);
    expect(ctx.calls.hideEveryone).toEqual([M5, M1, M3]);
    expect(ctx.events).toEqual([
      { chatId: GROUP, payload: { type: "chat_message_deleted", chatId: GROUP, messageIds: [M5, M1, M3] } },
    ]);
  });

  test("for everyone, as a member: only their own go, the others say why", async () => {
    const ctx = makeBatchApp();
    // M1, M3, M5 are bob's; M2, M4 are alice's.
    const res = await del(ctx, GROUP, { messageIds: [M1, M2, M3, M4, M5], scope: "everyone" }, asBob);
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([
      { messageId: M1, ok: true },
      { messageId: M2, ok: false, code: "forbidden", error: "You cannot delete this message for everyone." },
      { messageId: M3, ok: true },
      { messageId: M4, ok: false, code: "forbidden", error: "You cannot delete this message for everyone." },
      { messageId: M5, ok: true },
    ]);
    expect(ctx.calls.hideEveryone).toEqual([M1, M3, M5]);
    // One event, naming only what was really deleted.
    expect(ctx.eventsOfType("chat_message_deleted").map((e) => e.payload.messageIds)).toEqual([[M1, M3, M5]]);
    expect(ctx.events).toHaveLength(1);
  });

  test("pins go with their messages, one unpin event each, and only for deleted messages", async () => {
    const ctx = makeBatchApp();
    ctx.pin(GROUP, M1);
    ctx.pin(GROUP, M3);
    ctx.pin(GROUP, M2);
    const res = await del(ctx, GROUP, { messageIds: [M1, M2, M3], scope: "everyone" }, asBob);
    expect(res.status).toBe(200);
    expect(ctx.isPinned(GROUP, M1)).toBe(false);
    expect(ctx.isPinned(GROUP, M3)).toBe(false);
    // M2 is alice's: bob could not delete it, so it is still pinned.
    expect(ctx.isPinned(GROUP, M2)).toBe(true);
    expect(ctx.events.map((e) => e.payload)).toEqual([
      { type: "chat_message_deleted", chatId: GROUP, messageIds: [M1, M3] },
      { type: "message_unpinned", chatId: GROUP, messageId: M1 },
      { type: "message_unpinned", chatId: GROUP, messageId: M3 },
    ]);
  });

  test("deleting for me does not touch pins", async () => {
    const ctx = makeBatchApp();
    ctx.pin(GROUP, M1);
    await del(ctx, GROUP, { messageIds: [M1, M2] });
    expect(ctx.isPinned(GROUP, M1)).toBe(true);
    expect(ctx.calls.unpin).toEqual([]);
  });

  test("a failed unpin does not undo the deletion", async () => {
    const ctx = makeBatchApp({
      deps: {
        unpinMessage: () => {
          throw new Error("pins down");
        },
      },
    });
    const res = await del(ctx, GROUP, { messageIds: [M1, M3], scope: "everyone" });
    expect(res.status).toBe(200);
    expect(res.body.results.every((r) => r.ok)).toBe(true);
    expect(ctx.eventsOfType("chat_message_deleted")[0].payload.messageIds).toEqual([M1, M3]);
  });

  test("a call entry among them: only for me", async () => {
    const ctx = makeBatchApp();
    // bob wrote DM_MSG; alice's call entry is in the same chat.
    const res = await del(ctx, DM, { messageIds: [DM_MSG, CALL_MSG], scope: "everyone" }, asBob);
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([
      { messageId: DM_MSG, ok: true },
      { messageId: CALL_MSG, ok: false, code: "call_message_self_only", error: "Call entries can only be deleted for yourself." },
    ]);
    const forMe = await del(ctx, DM, { messageIds: [CALL_MSG] }, asBob);
    expect(forMe.body).toEqual({ results: [{ messageId: CALL_MSG, ok: true }] });
  });

  test("a service entry is deleted like any other message", async () => {
    const ctx = makeBatchApp();
    const res = await del(ctx, GROUP, { messageIds: [SERVICE_MSG], scope: "everyone" });
    expect(res.body.results).toEqual([{ messageId: SERVICE_MSG, ok: true }]);
  });

  test("messages that are not in this chat are 'not found', exactly like ones that never existed", async () => {
    const ctx = makeBatchApp();
    const res = await del(ctx, GROUP, { messageIds: [M1, MISSING_MSG, DM_MSG, CAROL_MSG] });
    expect(res.status).toBe(200);
    const notFound = { ok: false, code: "not_found", error: "Message not found." };
    expect(res.body.results).toEqual([
      { messageId: M1, ok: true },
      { messageId: MISSING_MSG, ...notFound },
      { messageId: DM_MSG, ...notFound },
      { messageId: CAROL_MSG, ...notFound },
    ]);
    // Nothing of the other chats was touched.
    expect(ctx.calls.hideSelf).toEqual([{ id: M1, userId: ALICE_ID }]);
  });

  test("a message that is already gone for everyone: nothing to do, nothing new to tell", async () => {
    const ctx = makeBatchApp();
    const res = await del(ctx, GROUP, { messageIds: [DELETED_MSG, M1], scope: "everyone" });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([
      { messageId: DELETED_MSG, ok: true },
      { messageId: M1, ok: true },
    ]);
    expect(ctx.calls.hideEveryone).toEqual([M1]);
    expect(ctx.eventsOfType("chat_message_deleted")[0].payload.messageIds).toEqual([M1]);
  });

  test("a message that fails is reported and the rest go on", async () => {
    const hideMessageForEveryone = vi.fn((id) => {
      if (id === M3) throw new Error("locked");
    });
    const ctx = makeBatchApp({ deps: { hideMessageForEveryone } });
    const res = await del(ctx, GROUP, { messageIds: [M1, M3, M5], scope: "everyone" });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([
      { messageId: M1, ok: true },
      { messageId: M3, ok: false, code: "delete_failed", error: "Unable to delete message." },
      { messageId: M5, ok: true },
    ]);
    expect(ctx.eventsOfType("chat_message_deleted")[0].payload.messageIds).toEqual([M1, M5]);
  });

  test("a realtime hub that breaks does not turn deletions into errors", async () => {
    const ctx = makeBatchApp({
      deps: {
        emitChatEvent: () => {
          throw new Error("hub down");
        },
      },
    });
    const res = await del(ctx, GROUP, { messageIds: [M1, M3], scope: "everyone" });
    expect(res.status).toBe(200);
    expect(res.body.results.every((r) => r.ok)).toBe(true);
    expect(ctx.calls.hideEveryone).toEqual([M1, M3]);
  });

  test("an id named twice is handled once", async () => {
    const ctx = makeBatchApp();
    const res = await del(ctx, GROUP, { messageIds: [M1, M1, M2] });
    expect(res.body.results.map((r) => r.messageId)).toEqual([M1, M2]);
    expect(ctx.calls.hideSelf).toHaveLength(2);
  });

  test("nothing could be deleted: an error status that carries the results", async () => {
    const ctx = makeBatchApp();
    const forbidden = await del(ctx, GROUP, { messageIds: [M2, M4], scope: "everyone" }, asBob);
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error).toBe("You cannot delete this message for everyone.");
    expect(forbidden.body.results).toEqual([
      { messageId: M2, ok: false, code: "forbidden", error: "You cannot delete this message for everyone." },
      { messageId: M4, ok: false, code: "forbidden", error: "You cannot delete this message for everyone." },
    ]);

    const missing = await del(ctx, GROUP, { messageIds: [MISSING_MSG, DM_MSG] });
    expect(missing.status).toBe(404);
    expect(missing.body.results).toHaveLength(2);

    const mixed = await del(ctx, GROUP, { messageIds: [MISSING_MSG, M2], scope: "everyone" }, asBob);
    expect(mixed.status).toBe(400);
    expect(mixed.body.results.map((r) => r.code)).toEqual(["not_found", "forbidden"]);
    expect(ctx.events).toEqual([]);
  });

  test("somebody who is not in the chat gets one refusal, not a list of results", async () => {
    const ctx = makeBatchApp();
    const res = await del(ctx, GROUP, { messageIds: [M1, M2] }, { token: "tok-carol", username: "carol" });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Not a member of this chat." });
    expect(ctx.calls.hideSelf).toEqual([]);
  });

  test("a person who left the chat cannot delete in it any more", async () => {
    const ctx = makeBatchApp();
    delete ctx.chats.get(GROUP).members[BOB_ID];
    const res = await del(ctx, GROUP, { messageIds: [M1], scope: "everyone" }, asBob);
    expect(res.status).toBe(403);
    expect(ctx.calls.hideEveryone).toEqual([]);
  });

  test("in a channel only the owner can delete for everyone, the others get a refusal per message", async () => {
    const ctx = makeBatchApp();
    const a = uid(0x2021);
    const b = uid(0x2022);
    for (const id of [a, b]) {
      ctx.messages.set(id, { ...ctx.messages.get(M1), id, chat_id: MY_CHANNEL, user_id: ALICE_ID });
    }
    const subscriber = await del(ctx, MY_CHANNEL, { messageIds: [a, b], scope: "everyone" }, asBob);
    expect(subscriber.status).toBe(403);
    const owner = await del(ctx, MY_CHANNEL, { messageIds: [a, b], scope: "everyone" });
    expect(owner.status).toBe(200);
    expect(owner.body.results.every((r) => r.ok)).toBe(true);
    // A subscriber can still tidy their own view.
    const forMe = await del(ctx, MY_CHANNEL, { messageIds: [a, b] }, asBob);
    expect(forMe.body.results.every((r) => r.ok)).toBe(true);
  });

  test("works with a database that answers with promises", async () => {
    const ctx = makeBatchApp({ asyncDb: true });
    ctx.pin(GROUP, M1);
    const res = await del(ctx, GROUP, { messageIds: [M1, M3], scope: "everyone" });
    expect(res.body.results.every((r) => r.ok)).toBe(true);
    expect(ctx.eventsOfType("message_unpinned")).toHaveLength(1);
  });

  test("works with a database layer that has no bulk lookup", async () => {
    const ctx = makeBatchApp({ bulk: false });
    const res = await del(ctx, GROUP, { messageIds: [M1, M3], scope: "everyone" });
    expect(res.body.results.every((r) => r.ok)).toBe(true);
  });
});

describe("POST /api/messages/delete: accounts", () => {
  test("a banned account whose session is still around is refused, for one message and for many", async () => {
    const ctx = makeBatchApp();
    ctx.userStore.users.get("alice").banned = 1;
    const single = await del(ctx, GROUP, { messageId: M1 });
    expect(single.status).toBe(403);
    expect(single.body).toEqual({ error: "Account is banned." });
    const many = await del(ctx, GROUP, { messageIds: [M1, M2], scope: "everyone" });
    expect(many.status).toBe(403);
    expect(many.body).toEqual({ error: "Account is banned." });
    expect(ctx.calls.hideSelf).toEqual([]);
    expect(ctx.calls.hideEveryone).toEqual([]);
  });

  test("an account that was deleted has no session and no user", async () => {
    const ctx = makeBatchApp();
    ctx.userStore.users.delete("alice");
    const res = await del(ctx, GROUP, { messageIds: [M1] });
    expect([401, 404]).toContain(res.status);
    expect(ctx.calls.hideSelf).toEqual([]);
  });
});

describe("POST /api/messages/delete: limits and lookups", () => {
  test("1 to 100 messages", async () => {
    const ctx = makeBatchApp();
    const none = await del(ctx, GROUP, { messageIds: [] });
    expect(none.status).toBe(400);
    expect(none.body.error).toMatch(/at least one/);
    const tooMany = await del(ctx, GROUP, { messageIds: Array.from({ length: 101 }, (_, i) => uid(0x7000 + i)) });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error).toMatch(/at most 100/);
    expect(ctx.calls.hideSelf).toEqual([]);
    expect(ctx.calls.isMember).toEqual([]);
  });

  test("the limit counts what was sent, not the distinct ids", async () => {
    const ctx = makeBatchApp();
    const res = await del(ctx, GROUP, { messageIds: Array.from({ length: 101 }, () => M1) });
    expect(res.status).toBe(400);
  });

  test("exactly 100 are accepted, looked up with one query", async () => {
    const ctx = makeBatchApp();
    const ids = ctx.addFillers(100);
    const res = await del(ctx, GROUP, { messageIds: ids, scope: "everyone" });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(100);
    expect(res.body.results.every((r) => r.ok)).toBe(true);
    expect(ctx.calls.findMessagesByIds).toHaveLength(1);
    expect(ctx.calls.findMessageById).toBe(0);
    // One membership check, one chat lookup and one role lookup for the whole request.
    expect(ctx.calls.isMember).toEqual([GROUP]);
    expect(ctx.calls.findChatById).toEqual([GROUP]);
    expect(ctx.calls.getChatMemberRole).toEqual([GROUP]);
    // One event for all of them.
    expect(ctx.eventsOfType("chat_message_deleted")).toHaveLength(1);
    expect(ctx.eventsOfType("chat_message_deleted")[0].payload.messageIds).toEqual(ids);
  });

  test("for me only needs neither the chat nor the role", async () => {
    const ctx = makeBatchApp();
    await del(ctx, GROUP, { messageIds: [M1, M2, M3] });
    expect(ctx.calls.findChatById).toEqual([]);
    expect(ctx.calls.getChatMemberRole).toEqual([]);
  });

  test.each([
    ["a string", "abc"],
    ["an object", { a: 1 }],
    ["a number", 3],
    ["a list with a non-uuid", [M1, "nope"]],
    ["a list with null", [M1, null]],
    ["a list with a number", [M1, 5]],
  ])("messageIds as %s is refused", async (_name, value) => {
    const ctx = makeBatchApp();
    const res = await del(ctx, GROUP, { messageIds: value });
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe("string");
    expect(ctx.calls.hideSelf).toEqual([]);
  });

  test("messageId and messageIds together are ambiguous", async () => {
    const ctx = makeBatchApp();
    const res = await del(ctx, GROUP, { messageId: M1, messageIds: [M2] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/either/);
    expect(ctx.calls.hideSelf).toEqual([]);
  });

  test("an invalid chat id is refused for a multi-select request too", async () => {
    const ctx = makeBatchApp();
    const res = await del(ctx, "nope", { messageIds: [M1] });
    expect(res.status).toBe(400);
  });

  test("one rate-limit token per request, however many messages it names", async () => {
    const ctx = makeBatchApp();
    const ids = ctx.addFillers(100);
    for (let i = 0; i < 120; i += 1) {
      const res = await del(ctx, GROUP, { messageIds: ids });
      expect(res.status, `request ${i + 1}`).toBe(200);
    }
    const limited = await del(ctx, GROUP, { messageIds: [M1] });
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: "Too many delete requests. Please slow down." });
    // Per person.
    const bob = await del(ctx, GROUP, { messageIds: [M1] }, asBob);
    expect(bob.status).toBe(200);
  }, 60_000);

  test("a refused request does not use up a token", async () => {
    const ctx = makeBatchApp();
    for (let i = 0; i < 150; i += 1) {
      expect((await del(ctx, GROUP, { messageIds: [] })).status).toBe(400);
    }
    expect((await del(ctx, GROUP, { messageIds: [M1] })).status).toBe(200);
  }, 60_000);
});
