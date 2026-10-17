import { describe, test, expect, vi, afterEach } from "vitest";
import request from "supertest";
import {
  ALICE_ID,
  BOB_ID,
  CAROL_ID,
  CHAT_ID,
  FIRE,
  FOREIGN_MSG_ID,
  HEART,
  LAUGH,
  MSG_ID,
  MSG_ID_2,
  SYSTEM_MSG_ID,
  THUMBS,
  flush,
  makeReactionApp,
} from "../helpers/reactionFixture.js";

const react = (ctx, cookie, body) =>
  request(ctx.app).post("/api/messages/react").set("Cookie", cookie).send(body);

const reactors = (ctx, cookie, query) =>
  request(ctx.app).get("/api/messages/reactions").set("Cookie", cookie).query(query);

afterEach(() => {
  vi.useRealTimers();
});

describe("POST /api/messages/react", () => {
  test("401 without a session", async () => {
    const ctx = makeReactionApp();
    const res = await request(ctx.app)
      .post("/api/messages/react")
      .send({ chatId: CHAT_ID, messageId: MSG_ID, emoji: THUMBS });
    expect(res.status).toBe(401);
    expect(ctx.store.calls.toggle).toEqual([]);
  });

  describe("validation", () => {
    test.each([
      ["missing chatId", { messageId: MSG_ID, emoji: THUMBS }, /chatId/],
      ["missing messageId", { chatId: CHAT_ID, emoji: THUMBS }, /messageId/],
      ["chatId that is not a UUID", { chatId: "nope", messageId: MSG_ID, emoji: THUMBS }, /chatId/],
      ["messageId that is not a UUID", { chatId: CHAT_ID, messageId: "1", emoji: THUMBS }, /messageId/],
      ["chatId sent as an array", { chatId: [CHAT_ID], messageId: MSG_ID, emoji: THUMBS }, /chatId/],
      ["emoji missing", { chatId: CHAT_ID, messageId: MSG_ID }, /emoji/i],
      ["plain text instead of an emoji", { chatId: CHAT_ID, messageId: MSG_ID, emoji: "like" }, /single emoji/i],
      ["two emoji", { chatId: CHAT_ID, messageId: MSG_ID, emoji: THUMBS + THUMBS }, /single emoji/i],
      ["emoji with text", { chatId: CHAT_ID, messageId: MSG_ID, emoji: `${THUMBS}!` }, /single emoji/i],
      ["a number", { chatId: CHAT_ID, messageId: MSG_ID, emoji: 1 }, /single emoji/i],
      ["an object", { chatId: CHAT_ID, messageId: MSG_ID, emoji: { e: THUMBS } }, /single emoji/i],
      ["a very long string", { chatId: CHAT_ID, messageId: MSG_ID, emoji: THUMBS.repeat(100) }, /single emoji/i],
    ])("400 for %s", async (_label, body, pattern) => {
      const ctx = makeReactionApp();
      const cookie = await ctx.login("alice");
      const res = await react(ctx, cookie, body);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(pattern);
      expect(ctx.store.calls.toggle).toEqual([]);
      expect(ctx.events).toEqual([]);
    });

    test("403 when the supplied username is not the signed-in person", async () => {
      const ctx = makeReactionApp();
      const cookie = await ctx.login("alice");
      const res = await react(ctx, cookie, {
        chatId: CHAT_ID,
        messageId: MSG_ID,
        emoji: THUMBS,
        username: "bob",
      });
      expect(res.status).toBe(403);
      expect(ctx.store.calls.toggle).toEqual([]);
    });

    test("an accepted username is optional and may be sent", async () => {
      const ctx = makeReactionApp();
      const cookie = await ctx.login("alice");
      const res = await react(ctx, cookie, {
        chatId: CHAT_ID,
        messageId: MSG_ID,
        emoji: THUMBS,
        username: "Alice",
      });
      expect(res.status).toBe(200);
    });
  });

  describe("authorization", () => {
    test("403 for somebody who is not in the chat, and nothing is written", async () => {
      const ctx = makeReactionApp();
      const cookie = await ctx.login("carol");
      const res = await react(ctx, cookie, { chatId: CHAT_ID, messageId: MSG_ID, emoji: THUMBS });
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "Not a member of this chat." });
      expect(ctx.store.calls.toggle).toEqual([]);
      expect(ctx.events).toEqual([]);
    });

    test("a non-member learns nothing about whether the message exists", async () => {
      const ctx = makeReactionApp();
      const cookie = await ctx.login("carol");
      const real = await react(ctx, cookie, { chatId: CHAT_ID, messageId: MSG_ID, emoji: THUMBS });
      const fake = await react(ctx, cookie, {
        chatId: CHAT_ID,
        messageId: "99999999-9999-4999-8999-999999999999",
        emoji: THUMBS,
      });
      expect(fake.status).toBe(real.status);
      expect(fake.body).toEqual(real.body);
    });

    test("someone who left or was removed (no longer a member) is refused", async () => {
      const ctx = makeReactionApp();
      const cookie = await ctx.login("bob");
      ctx.chatMembers.splice(
        ctx.chatMembers.findIndex((m) => m.id === BOB_ID),
        1,
      );
      const res = await react(ctx, cookie, { chatId: CHAT_ID, messageId: MSG_ID, emoji: THUMBS });
      expect(res.status).toBe(403);
    });

    test("404 for a message that belongs to another chat", async () => {
      const ctx = makeReactionApp();
      const cookie = await ctx.login("alice");
      const res = await react(ctx, cookie, {
        chatId: CHAT_ID,
        messageId: FOREIGN_MSG_ID,
        emoji: THUMBS,
      });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "Message not found." });
      expect(ctx.store.calls.toggle).toEqual([]);
    });

    test("404 for a message that does not exist", async () => {
      const ctx = makeReactionApp();
      const cookie = await ctx.login("alice");
      const res = await react(ctx, cookie, {
        chatId: CHAT_ID,
        messageId: "99999999-9999-4999-8999-999999999999",
        emoji: THUMBS,
      });
      expect(res.status).toBe(404);
    });

    test("404 for a message deleted for everyone", async () => {
      const ctx = makeReactionApp();
      ctx.messages.get(MSG_ID).hidden_everyone_at = "2025-01-01 00:00:00";
      const cookie = await ctx.login("alice");
      const res = await react(ctx, cookie, { chatId: CHAT_ID, messageId: MSG_ID, emoji: THUMBS });
      expect(res.status).toBe(404);
      expect(ctx.store.calls.toggle).toEqual([]);
    });

    test("404 for a message the caller deleted for themselves, but not for others", async () => {
      const ctx = makeReactionApp();
      ctx.hide(MSG_ID, ALICE_ID);
      const alice = await ctx.login("alice");
      const bob = await ctx.login("bob");
      expect(
        (await react(ctx, alice, { chatId: CHAT_ID, messageId: MSG_ID, emoji: THUMBS })).status,
      ).toBe(404);
      expect(
        (await react(ctx, bob, { chatId: CHAT_ID, messageId: MSG_ID, emoji: THUMBS })).status,
      ).toBe(200);
    });

    test("404 when the chat itself is gone", async () => {
      const ctx = makeReactionApp({ deps: { findChatById: () => null } });
      const cookie = await ctx.login("alice");
      const res = await react(ctx, cookie, { chatId: CHAT_ID, messageId: MSG_ID, emoji: THUMBS });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "Chat not found." });
    });

    test("400 for a service message", async () => {
      const ctx = makeReactionApp();
      const cookie = await ctx.login("alice");
      const res = await react(ctx, cookie, {
        chatId: CHAT_ID,
        messageId: SYSTEM_MSG_ID,
        emoji: THUMBS,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/not available/i);
      expect(ctx.store.calls.toggle).toEqual([]);
    });

    test("members of a channel can react too", async () => {
      const ctx = makeReactionApp({ chat: { type: "channel", name: "News" } });
      const cookie = await ctx.login("bob");
      const res = await react(ctx, cookie, { chatId: CHAT_ID, messageId: MSG_ID, emoji: THUMBS });
      expect(res.status).toBe(200);
    });
  });

  describe("behaviour", () => {
    test("adds a reaction and answers with the summary for the caller", async () => {
      const ctx = makeReactionApp();
      const cookie = await ctx.login("alice");
      const res = await react(ctx, cookie, { chatId: CHAT_ID, messageId: MSG_ID, emoji: THUMBS });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        messageId: MSG_ID,
        reactions: [{ emoji: THUMBS, count: 1, reacted: true }],
      });
      expect(ctx.store.calls.toggle).toEqual([
        { messageId: MSG_ID, userId: ALICE_ID, emoji: THUMBS, maxPerUser: 1 },
      ]);
    });

    test("the same emoji again removes it (toggle)", async () => {
      const ctx = makeReactionApp();
      const cookie = await ctx.login("alice");
      const body = { chatId: CHAT_ID, messageId: MSG_ID, emoji: THUMBS };
      await react(ctx, cookie, body);
      const res = await react(ctx, cookie, body);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ messageId: MSG_ID, reactions: [] });
    });

    test("with the default limit of 1 another emoji replaces the previous one", async () => {
      const ctx = makeReactionApp();
      const cookie = await ctx.login("alice");
      await react(ctx, cookie, { chatId: CHAT_ID, messageId: MSG_ID, emoji: THUMBS });
      const res = await react(ctx, cookie, { chatId: CHAT_ID, messageId: MSG_ID, emoji: HEART });
      expect(res.body.reactions).toEqual([{ emoji: HEART, count: 1, reacted: true }]);
    });

    test("MAX_REACTIONS_PER_USER=2 lets a person keep two and drops the oldest for a third", async () => {
      const ctx = makeReactionApp({ settings: { MAX_REACTIONS_PER_USER: 2 } });
      const cookie = await ctx.login("alice");
      const send = (emoji) => react(ctx, cookie, { chatId: CHAT_ID, messageId: MSG_ID, emoji });
      await send(THUMBS);
      const two = await send(HEART);
      expect(two.body.reactions.map((r) => r.emoji).sort()).toEqual([HEART, THUMBS].sort());
      const three = await send(FIRE);
      expect(three.body.reactions.map((r) => r.emoji).sort()).toEqual([FIRE, HEART].sort());
    });

    test("the setting is clamped to 1-3 whatever the admin stored", async () => {
      const ctx = makeReactionApp({ settings: { MAX_REACTIONS_PER_USER: 50 } });
      const cookie = await ctx.login("alice");
      await react(ctx, cookie, { chatId: CHAT_ID, messageId: MSG_ID, emoji: THUMBS });
      expect(ctx.store.calls.toggle[0].maxPerUser).toBe(3);
    });

    test.each([[null], [""]])("emoji %j removes the caller's reactions", async (value) => {
      const ctx = makeReactionApp({ settings: { MAX_REACTIONS_PER_USER: 3 } });
      const alice = await ctx.login("alice");
      const bob = await ctx.login("bob");
      await react(ctx, alice, { chatId: CHAT_ID, messageId: MSG_ID, emoji: THUMBS });
      await react(ctx, alice, { chatId: CHAT_ID, messageId: MSG_ID, emoji: HEART });
      await react(ctx, bob, { chatId: CHAT_ID, messageId: MSG_ID, emoji: THUMBS });
      const res = await react(ctx, alice, { chatId: CHAT_ID, messageId: MSG_ID, emoji: value });
      expect(res.status).toBe(200);
      expect(res.body.reactions).toEqual([{ emoji: THUMBS, count: 1, reacted: false }]);
    });

    test("removing when there is nothing to remove succeeds quietly and broadcasts nothing", async () => {
      const ctx = makeReactionApp();
      const cookie = await ctx.login("alice");
      const res = await react(ctx, cookie, { chatId: CHAT_ID, messageId: MSG_ID, emoji: null });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ messageId: MSG_ID, reactions: [] });
      expect(ctx.events).toEqual([]);
    });

    test("counts everybody but flags only the caller's own reaction", async () => {
      const ctx = makeReactionApp();
      const alice = await ctx.login("alice");
      const bob = await ctx.login("bob");
      await react(ctx, alice, { chatId: CHAT_ID, messageId: MSG_ID, emoji: THUMBS });
      const res = await react(ctx, bob, { chatId: CHAT_ID, messageId: MSG_ID, emoji: THUMBS });
      expect(res.body.reactions).toEqual([{ emoji: THUMBS, count: 2, reacted: true }]);
      const again = await react(ctx, bob, { chatId: CHAT_ID, messageId: MSG_ID, emoji: HEART });
      expect(again.body.reactions).toEqual([
        { emoji: THUMBS, count: 1, reacted: false },
        { emoji: HEART, count: 1, reacted: true },
      ]);
    });

    test("canonicalises text-style symbols so both spellings are the same reaction", async () => {
      const ctx = makeReactionApp();
      const cookie = await ctx.login("alice");
      await react(ctx, cookie, { chatId: CHAT_ID, messageId: MSG_ID, emoji: "❤" });
      expect(ctx.store.calls.toggle[0].emoji).toBe(HEART);
      const res = await react(ctx, cookie, { chatId: CHAT_ID, messageId: MSG_ID, emoji: HEART });
      expect(res.body.reactions).toEqual([]);
    });

    test("works with a database that answers with promises", async () => {
      const ctx = makeReactionApp({ asyncDb: true });
      const cookie = await ctx.login("alice");
      const res = await react(ctx, cookie, { chatId: CHAT_ID, messageId: MSG_ID, emoji: THUMBS });
      expect(res.status).toBe(200);
      expect(res.body.reactions).toEqual([{ emoji: THUMBS, count: 1, reacted: true }]);
    });

    test("a message deleted between the checks and the write is a 404, not a 500", async () => {
      const fk = Object.assign(new Error("FOREIGN KEY constraint failed"), {
        code: "SQLITE_CONSTRAINT_FOREIGNKEY",
      });
      const ctx = makeReactionApp({
        deps: {
          toggleMessageReaction: () => {
            throw fk;
          },
        },
      });
      const cookie = await ctx.login("alice");
      const res = await react(ctx, cookie, { chatId: CHAT_ID, messageId: MSG_ID, emoji: THUMBS });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "Message not found." });
    });

    test("an unexpected database failure is a 500 with the usual error shape and no details", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const ctx = makeReactionApp({
        deps: {
          toggleMessageReaction: async () => {
            throw new Error("disk exploded at /var/lib/secret");
          },
        },
      });
      const cookie = await ctx.login("alice");
      const res = await react(ctx, cookie, { chatId: CHAT_ID, messageId: MSG_ID, emoji: THUMBS });
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "Unable to update reaction." });
      expect(ctx.events).toEqual([]);
      spy.mockRestore();
    });
  });

  describe("realtime", () => {
    test("broadcasts message_reactions to the chat with counts and the actor", async () => {
      const ctx = makeReactionApp();
      const alice = await ctx.login("alice");
      const bob = await ctx.login("bob");
      await react(ctx, alice, { chatId: CHAT_ID, messageId: MSG_ID, emoji: THUMBS });
      await react(ctx, bob, { chatId: CHAT_ID, messageId: MSG_ID, emoji: THUMBS });
      expect(ctx.events.length).toBe(2);
      expect(ctx.events[1]).toEqual({
        chatId: CHAT_ID,
        payload: {
          type: "message_reactions",
          chatId: CHAT_ID,
          messageId: MSG_ID,
          counts: [{ emoji: THUMBS, count: 2 }],
          actorId: BOB_ID,
          actorEmoji: THUMBS,
          removedEmoji: null,
          removedEmojis: [],
        },
      });
    });

    test("the broadcast carries no per-person reacted flag", async () => {
      const ctx = makeReactionApp();
      const cookie = await ctx.login("alice");
      await react(ctx, cookie, { chatId: CHAT_ID, messageId: MSG_ID, emoji: THUMBS });
      expect(JSON.stringify(ctx.events[0].payload)).not.toContain("reacted");
    });

    test("removing says which emoji went and that nothing was added", async () => {
      const ctx = makeReactionApp();
      const cookie = await ctx.login("alice");
      const body = { chatId: CHAT_ID, messageId: MSG_ID, emoji: THUMBS };
      await react(ctx, cookie, body);
      await react(ctx, cookie, body);
      expect(ctx.events[1].payload).toMatchObject({
        counts: [],
        actorId: ALICE_ID,
        actorEmoji: null,
        removedEmoji: THUMBS,
        removedEmojis: [THUMBS],
      });
    });

    test("replacing says what was added and what was replaced", async () => {
      const ctx = makeReactionApp();
      const cookie = await ctx.login("alice");
      await react(ctx, cookie, { chatId: CHAT_ID, messageId: MSG_ID, emoji: THUMBS });
      await react(ctx, cookie, { chatId: CHAT_ID, messageId: MSG_ID, emoji: HEART });
      expect(ctx.events[1].payload).toMatchObject({
        counts: [{ emoji: HEART, count: 1 }],
        actorEmoji: HEART,
        removedEmoji: THUMBS,
        removedEmojis: [THUMBS],
      });
    });

    test("removing everything lists every emoji that went", async () => {
      const ctx = makeReactionApp({ settings: { MAX_REACTIONS_PER_USER: 3 } });
      const cookie = await ctx.login("alice");
      await react(ctx, cookie, { chatId: CHAT_ID, messageId: MSG_ID, emoji: THUMBS });
      await react(ctx, cookie, { chatId: CHAT_ID, messageId: MSG_ID, emoji: HEART });
      await react(ctx, cookie, { chatId: CHAT_ID, messageId: MSG_ID, emoji: null });
      const last = ctx.events.at(-1).payload;
      expect(last.actorEmoji).toBeNull();
      expect([...last.removedEmojis].sort()).toEqual([HEART, THUMBS].sort());
      expect(last.removedEmoji).toBe(last.removedEmojis[0]);
      expect(last.counts).toEqual([]);
    });

    test("nothing is broadcast when the request is rejected", async () => {
      const ctx = makeReactionApp();
      const cookie = await ctx.login("carol");
      await react(ctx, cookie, { chatId: CHAT_ID, messageId: MSG_ID, emoji: THUMBS });
      const alice = await ctx.login("alice");
      await react(ctx, alice, { chatId: CHAT_ID, messageId: MSG_ID, emoji: "x" });
      await react(ctx, alice, { chatId: CHAT_ID, messageId: SYSTEM_MSG_ID, emoji: THUMBS });
      expect(ctx.events).toEqual([]);
    });
  });

  describe("rate limit", () => {
    test("30 requests a minute per person, then 429 with the usual error shape", async () => {
      const ctx = makeReactionApp();
      const alice = await ctx.login("alice");
      const bob = await ctx.login("bob");
      const body = { chatId: CHAT_ID, messageId: MSG_ID, emoji: THUMBS };
      for (let i = 0; i < 30; i += 1) {
        expect((await react(ctx, alice, body)).status).toBe(200);
      }
      const blocked = await react(ctx, alice, body);
      expect(blocked.status).toBe(429);
      expect(blocked.body).toEqual({ error: expect.stringMatching(/too many/i) });
      // Somebody else is not affected.
      expect((await react(ctx, bob, body)).status).toBe(200);
    });

    test("the window slides: a minute later reactions work again", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const ctx = makeReactionApp();
      const alice = await ctx.login("alice");
      const body = { chatId: CHAT_ID, messageId: MSG_ID, emoji: THUMBS };
      for (let i = 0; i < 30; i += 1) await react(ctx, alice, body);
      expect((await react(ctx, alice, body)).status).toBe(429);
      vi.setSystemTime(Date.now() + 61_000);
      expect((await react(ctx, alice, body)).status).toBe(200);
    });
  });

  describe("push notification to the author", () => {
    test("tells the author who reacted with what, without any message text", async () => {
      const ctx = makeReactionApp();
      const cookie = await ctx.login("alice");
      await react(ctx, cookie, { chatId: CHAT_ID, messageId: MSG_ID, emoji: THUMBS });
      await flush();
      expect(ctx.pushes).toEqual([
        {
          userIds: [BOB_ID],
          payload: {
            title: "Friends",
            body: `Alice reacted ${THUMBS} to your message`,
            redactedBody: "New reaction",
            data: { chatId: CHAT_ID, messageId: MSG_ID, type: "reaction" },
          },
        },
      ]);
      expect(JSON.stringify(ctx.pushes)).not.toContain("hello from bob");
    });

    test("in a one-to-one chat the title is the reactor", async () => {
      const ctx = makeReactionApp({ chat: { type: "dm", name: "dm" } });
      const cookie = await ctx.login("alice");
      await react(ctx, cookie, { chatId: CHAT_ID, messageId: MSG_ID, emoji: THUMBS });
      await flush();
      expect(ctx.pushes[0].payload.title).toBe("Alice");
    });

    test("not for reactions on your own message", async () => {
      const ctx = makeReactionApp();
      const cookie = await ctx.login("alice");
      await react(ctx, cookie, { chatId: CHAT_ID, messageId: MSG_ID_2, emoji: THUMBS });
      await flush();
      expect(ctx.pushes).toEqual([]);
    });

    test("not when a reaction is removed", async () => {
      const ctx = makeReactionApp();
      const cookie = await ctx.login("alice");
      const body = { chatId: CHAT_ID, messageId: MSG_ID, emoji: THUMBS };
      await react(ctx, cookie, body);
      await react(ctx, cookie, body);
      await flush();
      expect(ctx.pushes.length).toBe(1);
    });

    test("not when the author muted the chat", async () => {
      const ctx = makeReactionApp();
      ctx.mute(BOB_ID);
      const cookie = await ctx.login("alice");
      await react(ctx, cookie, { chatId: CHAT_ID, messageId: MSG_ID, emoji: THUMBS });
      await flush();
      expect(ctx.pushes).toEqual([]);
    });

    test("not when the author is online and sees it live", async () => {
      const ctx = makeReactionApp();
      ctx.setConnected("bob");
      const cookie = await ctx.login("alice");
      await react(ctx, cookie, { chatId: CHAT_ID, messageId: MSG_ID, emoji: THUMBS });
      await flush();
      expect(ctx.pushes).toEqual([]);
    });

    test("not for mirrored channel posts, which have no real author", async () => {
      const ctx = makeReactionApp({ chat: { type: "channel", name: "News" } });
      ctx.markRemote(MSG_ID);
      const cookie = await ctx.login("alice");
      await react(ctx, cookie, { chatId: CHAT_ID, messageId: MSG_ID, emoji: THUMBS });
      await flush();
      expect(ctx.pushes).toEqual([]);
    });

    test("not when the author's account is gone", async () => {
      const ctx = makeReactionApp();
      ctx.messages.get(MSG_ID).user_id = "99999999-9999-4999-8999-999999999999";
      const cookie = await ctx.login("alice");
      await react(ctx, cookie, { chatId: CHAT_ID, messageId: MSG_ID, emoji: THUMBS });
      await flush();
      expect(ctx.pushes).toEqual([]);
    });

    test("not when the author has left or was removed from the chat", async () => {
      const ctx = makeReactionApp();
      const cookie = await ctx.login("alice");
      ctx.chatMembers.splice(
        ctx.chatMembers.findIndex((m) => m.id === BOB_ID),
        1,
      );
      await react(ctx, cookie, { chatId: CHAT_ID, messageId: MSG_ID, emoji: THUMBS });
      await flush();
      expect(ctx.pushes).toEqual([]);
    });

    test("not when the author deleted the message for themselves", async () => {
      const ctx = makeReactionApp();
      ctx.hide(MSG_ID, BOB_ID);
      const cookie = await ctx.login("alice");
      await react(ctx, cookie, { chatId: CHAT_ID, messageId: MSG_ID, emoji: THUMBS });
      await flush();
      expect(ctx.pushes).toEqual([]);
    });

    test("at most one push per reactor and message per minute", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const ctx = makeReactionApp({ settings: { MAX_REACTIONS_PER_USER: 3 } });
      const alice = await ctx.login("alice");
      const body = { chatId: CHAT_ID, messageId: MSG_ID };
      await react(ctx, alice, { ...body, emoji: THUMBS });
      await react(ctx, alice, { ...body, emoji: THUMBS });
      await react(ctx, alice, { ...body, emoji: HEART });
      await react(ctx, alice, { ...body, emoji: FIRE });
      await flush();
      expect(ctx.pushes.length).toBe(1);

      vi.setSystemTime(Date.now() + 61_000);
      await react(ctx, alice, { ...body, emoji: LAUGH });
      await flush();
      expect(ctx.pushes.length).toBe(2);
    });

    test("another reactor, or another message, is a separate push", async () => {
      const ctx = makeReactionApp({
        members: [
          { id: ALICE_ID, username: "alice", role: "owner" },
          { id: BOB_ID, username: "bob", role: "member" },
          { id: CAROL_ID, username: "carol", role: "member" },
        ],
      });
      ctx.messages.get(MSG_ID_2).user_id = BOB_ID;
      const alice = await ctx.login("alice");
      const carol = await ctx.login("carol");
      await react(ctx, alice, { chatId: CHAT_ID, messageId: MSG_ID, emoji: THUMBS });
      await react(ctx, carol, { chatId: CHAT_ID, messageId: MSG_ID, emoji: THUMBS });
      await react(ctx, alice, { chatId: CHAT_ID, messageId: MSG_ID_2, emoji: THUMBS });
      await flush();
      expect(ctx.pushes.length).toBe(3);
    });

    test("a muted or connected author does not use up the minute", async () => {
      const ctx = makeReactionApp();
      ctx.setConnected("bob");
      const alice = await ctx.login("alice");
      const body = { chatId: CHAT_ID, messageId: MSG_ID };
      await react(ctx, alice, { ...body, emoji: THUMBS });
      await flush();
      ctx.setConnected("bob", false);
      await react(ctx, alice, { ...body, emoji: HEART });
      await flush();
      expect(ctx.pushes.length).toBe(1);
    });

    test("a failing push never fails the reaction", async () => {
      const ctx = makeReactionApp({
        deps: {
          sendPushNotificationToUsers: async () => {
            throw new Error("push service down");
          },
        },
      });
      const cookie = await ctx.login("alice");
      const res = await react(ctx, cookie, { chatId: CHAT_ID, messageId: MSG_ID, emoji: THUMBS });
      await flush();
      expect(res.status).toBe(200);
    });
  });
});

describe("GET /api/messages/reactions", () => {
  const seed = async (ctx) => {
    const alice = await ctx.login("alice");
    const bob = await ctx.login("bob");
    await react(ctx, alice, { chatId: CHAT_ID, messageId: MSG_ID, emoji: THUMBS });
    await react(ctx, bob, { chatId: CHAT_ID, messageId: MSG_ID, emoji: THUMBS });
    return { alice, bob };
  };

  test("401 without a session", async () => {
    const ctx = makeReactionApp();
    const res = await request(ctx.app)
      .get("/api/messages/reactions")
      .query({ chatId: CHAT_ID, messageId: MSG_ID });
    expect(res.status).toBe(401);
  });

  test.each([
    ["missing chatId", { messageId: MSG_ID }],
    ["missing messageId", { chatId: CHAT_ID }],
    ["chatId that is not a UUID", { chatId: "x", messageId: MSG_ID }],
    ["messageId that is not a UUID", { chatId: CHAT_ID, messageId: "x" }],
    ["repeated chatId", "chatId=" + CHAT_ID + "&chatId=" + CHAT_ID + "&messageId=" + MSG_ID],
    ["emoji that is not an emoji", { chatId: CHAT_ID, messageId: MSG_ID, emoji: "abc" }],
  ])("400 for %s", async (_label, query) => {
    const ctx = makeReactionApp();
    const cookie = await ctx.login("alice");
    const res = await reactors(ctx, cookie, query);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: expect.any(String) });
    expect(ctx.store.calls.users).toEqual([]);
  });

  test("403 for somebody who is not in the chat", async () => {
    const ctx = makeReactionApp();
    await seed(ctx);
    const carol = await ctx.login("carol");
    const res = await reactors(ctx, carol, { chatId: CHAT_ID, messageId: MSG_ID });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Not a member of this chat." });
  });

  test("404 for a message of another chat, a missing one, a deleted one and one hidden from the caller", async () => {
    const ctx = makeReactionApp();
    const alice = await ctx.login("alice");
    const ask = (messageId) => reactors(ctx, alice, { chatId: CHAT_ID, messageId });
    expect((await ask(FOREIGN_MSG_ID)).status).toBe(404);
    expect((await ask("99999999-9999-4999-8999-999999999999")).status).toBe(404);
    ctx.messages.get(MSG_ID).hidden_everyone_at = "2025-01-01 00:00:00";
    expect((await ask(MSG_ID)).status).toBe(404);
    ctx.messages.get(MSG_ID).hidden_everyone_at = null;
    ctx.hide(MSG_ID, ALICE_ID);
    expect((await ask(MSG_ID)).status).toBe(404);
  });

  test("lists the people behind each emoji with the fields a client needs", async () => {
    const ctx = makeReactionApp();
    const { alice } = await seed(ctx);
    await react(ctx, alice, { chatId: CHAT_ID, messageId: MSG_ID, emoji: HEART });
    const res = await reactors(ctx, alice, { chatId: CHAT_ID, messageId: MSG_ID });
    expect(res.status).toBe(200);
    expect(res.body.messageId).toBe(MSG_ID);
    expect(res.body.truncated).toBe(false);
    expect(res.body.reactions).toEqual([
      {
        emoji: THUMBS,
        count: 1,
        users: [
          {
            id: BOB_ID,
            username: "bob",
            nickname: "Bob",
            avatarUrl: "/api/uploads/avatars/bob.png",
            color: "#10b981",
            createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
          },
        ],
      },
      {
        emoji: HEART,
        count: 1,
        users: [expect.objectContaining({ id: ALICE_ID, username: "alice" })],
      },
    ]);
    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toContain("password");
  });

  test("an emoji filter narrows the answer and is canonicalised", async () => {
    const ctx = makeReactionApp({ settings: { MAX_REACTIONS_PER_USER: 3 } });
    const { alice } = await seed(ctx);
    await react(ctx, alice, { chatId: CHAT_ID, messageId: MSG_ID, emoji: "❤" });
    const res = await reactors(ctx, alice, { chatId: CHAT_ID, messageId: MSG_ID, emoji: "❤" });
    expect(res.status).toBe(200);
    expect(res.body.reactions.map((r) => r.emoji)).toEqual([HEART]);
    expect(ctx.store.calls.users.at(-1).emoji).toBe(HEART);
  });

  test("an empty emoji parameter means every emoji", async () => {
    const ctx = makeReactionApp();
    const { alice } = await seed(ctx);
    const res = await reactors(ctx, alice, { chatId: CHAT_ID, messageId: MSG_ID, emoji: "" });
    expect(res.status).toBe(200);
    expect(res.body.reactions.map((r) => r.emoji)).toEqual([THUMBS]);
  });

  test("asks the database for at most 200 people and says when the list was cut", async () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      emoji: THUMBS,
      created_at: new Date(1_700_000_000_000 + i).toISOString(),
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      username: `user${i}`,
      nickname: `User ${i}`,
      avatar_url: null,
      color: "#10b981",
    }));
    const ctx = makeReactionApp({
      deps: {
        listMessageReactionUsers: (_id, options) => {
          expect(options.limit).toBe(200);
          return many;
        },
        listMessageReactionSummaries: () => [
          { message_id: MSG_ID, emoji: THUMBS, count: 450, first_at: "2025-01-01T00:00:00.000Z", reacted: 0 },
        ],
      },
    });
    const alice = await ctx.login("alice");
    const res = await reactors(ctx, alice, { chatId: CHAT_ID, messageId: MSG_ID });
    expect(res.status).toBe(200);
    expect(res.body.truncated).toBe(true);
    expect(res.body.reactions[0].count).toBe(450);
    expect(res.body.reactions[0].users.length).toBe(200);
  });

  test("nothing for a service message or a message nobody reacted to", async () => {
    const ctx = makeReactionApp();
    const alice = await ctx.login("alice");
    const system = await reactors(ctx, alice, { chatId: CHAT_ID, messageId: SYSTEM_MSG_ID });
    expect(system.status).toBe(200);
    expect(system.body.reactions).toEqual([]);
    const none = await reactors(ctx, alice, { chatId: CHAT_ID, messageId: MSG_ID_2 });
    expect(none.body).toEqual({ messageId: MSG_ID_2, reactions: [], truncated: false });
  });

  describe("channels", () => {
    test("only the owner sees who reacted; subscribers see counts in the message list only", async () => {
      const ctx = makeReactionApp({ chat: { type: "channel", name: "News" } });
      const { alice, bob } = await seed(ctx);
      const owner = await reactors(ctx, alice, { chatId: CHAT_ID, messageId: MSG_ID });
      expect(owner.status).toBe(200);
      expect(owner.body.reactions[0].users.length).toBe(2);
      const subscriber = await reactors(ctx, bob, { chatId: CHAT_ID, messageId: MSG_ID });
      expect(subscriber.status).toBe(403);
      expect(subscriber.body).toEqual({ error: "Only the channel owner can see who reacted." });
    });
  });

  test("works with a database that answers with promises", async () => {
    const ctx = makeReactionApp({ asyncDb: true });
    const { alice } = await seed(ctx);
    const res = await reactors(ctx, alice, { chatId: CHAT_ID, messageId: MSG_ID });
    expect(res.status).toBe(200);
    expect(res.body.reactions[0].users.length).toBe(2);
  });

  test("is rate limited per person", async () => {
    const ctx = makeReactionApp();
    const alice = await ctx.login("alice");
    const bob = await ctx.login("bob");
    const query = { chatId: CHAT_ID, messageId: MSG_ID };
    for (let i = 0; i < 120; i += 1) {
      expect((await reactors(ctx, alice, query)).status).toBe(200);
    }
    const blocked = await reactors(ctx, alice, query);
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: expect.stringMatching(/too many/i) });
    expect((await reactors(ctx, bob, query)).status).toBe(200);
  });
});
