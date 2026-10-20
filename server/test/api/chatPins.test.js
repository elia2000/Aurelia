import { describe, test, expect, vi } from "vitest";
import request from "supertest";
import {
  ALICE_ID,
  BOB_ID,
  BOBS,
  DM,
  G,
  MISSING,
  PASSWORD,
  SAVED,
  SECRET,
  idsOf,
  listAs,
  makeChatPinApp,
  orderAs,
  pinAs,
} from "../helpers/chatPinFixture.js";

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const pinAll = async (ctx, username, chatIds) => {
  for (const id of chatIds) {
    const res = await pinAs(ctx, username, id, true);
    expect(res.status).toBe(200);
  }
};

describe("PUT /api/chats/:chatId/pin", () => {
  test("pins a chat and answers with the pins", async () => {
    const ctx = makeChatPinApp();
    const res = await pinAs(ctx, "alice", G[0]);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      chatId: G[0],
      pinned: true,
      pinPosition: 0,
      pins: [{ chatId: G[0], position: 0 }],
    });
    expect(ctx.pins.get(ALICE_ID)).toHaveLength(1);
  });

  test("a newly pinned chat goes to the top of the pinned block", async () => {
    const ctx = makeChatPinApp();
    await pinAs(ctx, "alice", G[0]);
    await pinAs(ctx, "alice", G[1]);
    const res = await pinAs(ctx, "alice", G[2]);
    expect(res.body.pinPosition).toBe(0);
    expect(res.body.pins).toEqual([
      { chatId: G[2], position: 0 },
      { chatId: G[1], position: 1 },
      { chatId: G[0], position: 2 },
    ]);
  });

  test("pinning twice is harmless: same place, no second event", async () => {
    const ctx = makeChatPinApp();
    await pinAs(ctx, "alice", G[0]);
    await pinAs(ctx, "alice", G[1]);
    ctx.sse.length = 0;

    const res = await pinAs(ctx, "alice", G[0]);
    expect(res.status).toBe(200);
    expect(res.body.pinned).toBe(true);
    expect(res.body.pinPosition).toBe(1);
    expect(idsOf(res)).toEqual([G[1], G[0]]);
    expect(ctx.pinEventsFor("alice")).toEqual([]);
  });

  test("unpinning removes the pin and closes the gap", async () => {
    const ctx = makeChatPinApp();
    await pinAll(ctx, "alice", [G[0], G[1], G[2]]);
    // order: G2 G1 G0
    const res = await pinAs(ctx, "alice", G[1], false);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      chatId: G[1],
      pinned: false,
      pinPosition: null,
      pins: [
        { chatId: G[2], position: 0 },
        { chatId: G[0], position: 1 },
      ],
    });
  });

  test("unpinning a chat that is not pinned is harmless and silent", async () => {
    const ctx = makeChatPinApp();
    const res = await pinAs(ctx, "alice", G[0], false);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chatId: G[0], pinned: false, pinPosition: null, pins: [] });
    expect(ctx.pinEventsFor("alice")).toEqual([]);
  });

  test("direct chats and Saved Messages can be pinned", async () => {
    const ctx = makeChatPinApp();
    expect((await pinAs(ctx, "alice", DM)).status).toBe(200);
    expect((await pinAs(ctx, "alice", SAVED)).status).toBe(200);
    expect((await pinAs(ctx, "bob", DM)).status).toBe(200);
  });

  describe("the limit", () => {
    test("is 5 by default; the sixth pin is refused with a clear code", async () => {
      const ctx = makeChatPinApp();
      await pinAll(ctx, "alice", G.slice(0, 5));
      const res = await pinAs(ctx, "alice", G[5]);
      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        error: "You can pin at most 5 chats. Unpin one first.",
        code: "pin_limit",
        max: 5,
      });
      // Nothing was dropped or reordered to make room.
      expect(ctx.pins.get(ALICE_ID).map((r) => r.chat_id)).not.toContain(G[5]);
      expect(ctx.pins.get(ALICE_ID)).toHaveLength(5);
    });

    test("MAX_PINNED_CHATS changes it", async () => {
      const ctx = makeChatPinApp({ settings: { MAX_PINNED_CHATS: 2 } });
      await pinAll(ctx, "alice", [G[0], G[1]]);
      const res = await pinAs(ctx, "alice", G[2]);
      expect(res.status).toBe(409);
      expect(res.body.max).toBe(2);
      expect(ctx.calls.pinChat.at(-1).max).toBe(2);
    });

    test.each([
      [0, 1],
      [-5, 1],
      [4000, 30],
      ["junk", 5],
    ])("a setting of %j is read as %j", async (setting, expected) => {
      const ctx = makeChatPinApp({ settings: { MAX_PINNED_CHATS: setting } });
      await pinAs(ctx, "alice", G[0]);
      expect(ctx.calls.pinChat.at(-1).max).toBe(expected);
    });

    test("unpinning makes room again", async () => {
      const ctx = makeChatPinApp({ settings: { MAX_PINNED_CHATS: 1 } });
      await pinAs(ctx, "alice", G[0]);
      expect((await pinAs(ctx, "alice", G[1])).status).toBe(409);
      await pinAs(ctx, "alice", G[0], false);
      expect((await pinAs(ctx, "alice", G[1])).status).toBe(200);
    });

    test("a chat that is already pinned is not refused when the list is full", async () => {
      const ctx = makeChatPinApp({ settings: { MAX_PINNED_CHATS: 2 } });
      await pinAll(ctx, "alice", [G[0], G[1]]);
      expect((await pinAs(ctx, "alice", G[0])).status).toBe(200);
    });

    test("is per person: one person's pins never use up another's", async () => {
      const ctx = makeChatPinApp({ settings: { MAX_PINNED_CHATS: 2 } });
      await pinAll(ctx, "alice", [G[0], G[1]]);
      expect((await pinAs(ctx, "bob", G[0])).status).toBe(200);
      expect((await pinAs(ctx, "bob", G[1])).status).toBe(200);
      expect((await pinAs(ctx, "bob", G[2])).status).toBe(409);
    });

    test("a refused pin sends no event", async () => {
      const ctx = makeChatPinApp({ settings: { MAX_PINNED_CHATS: 1 } });
      await pinAs(ctx, "alice", G[0]);
      ctx.sse.length = 0;
      await pinAs(ctx, "alice", G[1]);
      expect(ctx.pinEventsFor("alice")).toEqual([]);
    });
  });

  describe("authorisation", () => {
    test("needs a session", async () => {
      const ctx = makeChatPinApp();
      const res = await request(ctx.app).put(`/api/chats/${G[0]}/pin`).send({ pinned: true });
      expect(res.status).toBe(401);
      expect(ctx.calls.pinChat).toHaveLength(0);
    });

    test("a chat the caller is not in is refused, and so is one that does not exist - with the same answer", async () => {
      const ctx = makeChatPinApp();
      const foreign = await pinAs(ctx, "alice", SECRET);
      const missing = await pinAs(ctx, "alice", MISSING);
      const bobs = await pinAs(ctx, "alice", BOBS);
      for (const res of [foreign, missing, bobs]) {
        expect(res.status).toBe(403);
        expect(res.body).toEqual({ error: "Not a member of this chat." });
      }
      expect(ctx.calls.pinChat).toHaveLength(0);
      expect(ctx.pins.get(ALICE_ID) || []).toHaveLength(0);
    });

    test("unpinning a chat the caller is not in is refused too", async () => {
      const ctx = makeChatPinApp();
      const res = await pinAs(ctx, "alice", SECRET, false);
      expect(res.status).toBe(403);
      expect(ctx.calls.removeChatPins).toHaveLength(0);
    });

    test("someone who left the chat cannot pin it any more", async () => {
      const ctx = makeChatPinApp();
      const cookie = await ctx.login("bob");
      await request(ctx.app).post(`/api/chats/group/${G[0]}/leave`).set("Cookie", cookie).send({ username: "bob" });
      expect((await pinAs(ctx, "bob", G[0])).status).toBe(403);
    });

    test("a hidden chat cannot be pinned (409 chat_hidden); unpinning it is fine", async () => {
      const ctx = makeChatPinApp();
      const cookie = await ctx.login("alice");
      await request(ctx.app).post("/api/chats/hide").set("Cookie", cookie).send({ username: "alice", chatIds: [G[0]] });

      const res = await pinAs(ctx, "alice", G[0]);
      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        error: "This chat is hidden. Open it before pinning it.",
        code: "chat_hidden",
      });
      expect((await pinAs(ctx, "alice", G[0], false)).status).toBe(200);
    });

    test("a banned account is refused even with a live session", async () => {
      const ctx = makeChatPinApp();
      const cookie = await ctx.login("alice");
      ctx.userStore.users.get("alice").banned = true;
      const res = await request(ctx.app).put(`/api/chats/${G[0]}/pin`).set("Cookie", cookie).send({ pinned: true });
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "Account is banned." });
      expect(ctx.calls.pinChat).toHaveLength(0);
    });

    test("a deleted account (session without a user) gets 404", async () => {
      const ctx = makeChatPinApp();
      const cookie = await ctx.login("alice");
      ctx.userStore.users.delete("alice");
      const res = await request(ctx.app).put(`/api/chats/${G[0]}/pin`).set("Cookie", cookie).send({ pinned: true });
      expect([401, 404]).toContain(res.status);
      expect(ctx.calls.pinChat).toHaveLength(0);
    });

    test("a username in the body must be the signed-in person's", async () => {
      const ctx = makeChatPinApp();
      const res = await pinAs(ctx, "alice", G[0], true, { username: "bob" });
      expect(res.status).toBe(403);
      expect(ctx.calls.pinChat).toHaveLength(0);
      expect((await pinAs(ctx, "alice", G[0], true, { username: "Alice" })).status).toBe(200);
    });
  });

  describe("input validation", () => {
    test.each([
      ["not a UUID", "nope"],
      ["a SQL fragment", "1' OR '1'='1"],
      ["too short", "9a000000"],
    ])("a chat id that is %s is a 400", async (_name, chatId) => {
      const ctx = makeChatPinApp();
      const cookie = await ctx.login("alice");
      const res = await request(ctx.app)
        .put(`/api/chats/${encodeURIComponent(chatId)}/pin`)
        .set("Cookie", cookie)
        .send({ pinned: true });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/chatId/);
      expect(ctx.calls.pinChat).toHaveLength(0);
    });

    test.each([
      ["missing", undefined],
      ["null", null],
      ["a string", "true"],
      ["a number", 1],
      ["an object", {}],
      ["an array", [true]],
    ])("'pinned' that is %s is a 400", async (_name, value) => {
      const ctx = makeChatPinApp();
      const cookie = await ctx.login("alice");
      const res = await request(ctx.app)
        .put(`/api/chats/${G[0]}/pin`)
        .set("Cookie", cookie)
        .send(value === undefined ? {} : { pinned: value });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "Field 'pinned' must be true or false." });
      expect(ctx.calls.pinChat).toHaveLength(0);
      expect(ctx.calls.removeChatPins).toHaveLength(0);
    });

    test("a request without a body is a 400, not a crash", async () => {
      const ctx = makeChatPinApp();
      const cookie = await ctx.login("alice");
      const res = await request(ctx.app).put(`/api/chats/${G[0]}/pin`).set("Cookie", cookie);
      expect(res.status).toBe(400);
    });
  });

  describe("rate limit", () => {
    test("30 changes a minute per person; the next is a 429, other people are not affected", async () => {
      const ctx = makeChatPinApp();
      for (let i = 0; i < 30; i += 1) {
        const res = await pinAs(ctx, "alice", G[0], i % 2 === 1);
        expect(res.status).toBe(200);
      }
      const limited = await pinAs(ctx, "alice", G[0]);
      expect(limited.status).toBe(429);
      expect(limited.body).toEqual({ error: "Too many pin requests. Please slow down." });
      expect((await pinAs(ctx, "bob", G[0])).status).toBe(200);
    });

    test("reordering shares the bucket", async () => {
      const ctx = makeChatPinApp();
      for (let i = 0; i < 30; i += 1) await orderAs(ctx, "alice", []);
      expect((await pinAs(ctx, "alice", G[0])).status).toBe(429);
    });
  });

  describe("failures", () => {
    test("a database error is a 500 with the usual error shape, and no event", async () => {
      const ctx = makeChatPinApp({
        deps: {
          pinChat: () => {
            throw new Error("disk is full");
          },
        },
      });
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const res = await pinAs(ctx, "alice", G[0]);
      spy.mockRestore();
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "Unable to update the pinned chat." });
      expect(ctx.pinEventsFor("alice")).toEqual([]);
    });

    test("a broken realtime hub does not undo or fail the pin", async () => {
      const ctx = makeChatPinApp({
        deps: {
          emitSseEvent: () => {
            throw new Error("hub is down");
          },
        },
      });
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const res = await pinAs(ctx, "alice", G[0]);
      spy.mockRestore();
      expect(res.status).toBe(200);
      expect(ctx.pins.get(ALICE_ID)).toHaveLength(1);
    });

    test("works the same when the database answers asynchronously (Postgres)", async () => {
      const ctx = makeChatPinApp({ asyncDb: true });
      const first = await pinAs(ctx, "alice", G[0]);
      const second = await pinAs(ctx, "alice", G[1]);
      expect(second.status).toBe(200);
      expect(second.body.pins).toEqual([
        { chatId: G[1], position: 0 },
        { chatId: G[0], position: 1 },
      ]);
      expect(first.status).toBe(200);
      expect((await pinAs(ctx, "alice", G[1], false)).body.pins).toEqual([{ chatId: G[0], position: 0 }]);
    });
  });
});

describe("PUT /api/chats/pins/order", () => {
  test("applies the new order and answers with the pins", async () => {
    const ctx = makeChatPinApp();
    await pinAll(ctx, "alice", [G[0], G[1], G[2]]);
    // order: G2 G1 G0
    const res = await orderAs(ctx, "alice", [G[0], G[2], G[1]]);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      pins: [
        { chatId: G[0], position: 0 },
        { chatId: G[2], position: 1 },
        { chatId: G[1], position: 2 },
      ],
    });
  });

  test("the same order is accepted and silent", async () => {
    const ctx = makeChatPinApp();
    await pinAll(ctx, "alice", [G[0], G[1]]);
    ctx.sse.length = 0;
    const res = await orderAs(ctx, "alice", [G[1], G[0]]);
    expect(res.status).toBe(200);
    expect(ctx.pinEventsFor("alice")).toEqual([]);
  });

  test("an empty list is fine for a person with no pins", async () => {
    const ctx = makeChatPinApp();
    const res = await orderAs(ctx, "alice", []);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pins: [] });
  });

  describe("must be exactly the caller's pinned set", () => {
    const setup = async () => {
      const ctx = makeChatPinApp();
      await pinAll(ctx, "alice", [G[0], G[1]]);
      // order: G1 G0
      ctx.sse.length = 0;
      return ctx;
    };

    test.each([
      ["a pinned chat is missing", () => [G[0]]],
      ["an extra chat is listed", () => [G[0], G[1], G[2]]],
      ["a chat the caller is not in is listed", () => [G[0], SECRET]],
      ["a chat that does not exist is listed", () => [G[0], MISSING]],
      ["the list is empty", () => []],
    ])("%s: 409 with the real pins, nothing changes, no event", async (_name, build) => {
      const ctx = await setup();
      const res = await orderAs(ctx, "alice", build());
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("pin_set_mismatch");
      expect(res.body.error).toMatch(/exactly the chats you have pinned/);
      expect(res.body.pins).toEqual([
        { chatId: G[1], position: 0 },
        { chatId: G[0], position: 1 },
      ]);
      expect(ctx.pinEventsFor("alice")).toEqual([]);
      expect(ctx.pins.get(ALICE_ID).find((r) => r.chat_id === G[1]).position).toBe(0);
    });

    test("a refusal never shows anybody else's pins", async () => {
      const ctx = await setup();
      await pinAs(ctx, "bob", G[3]);
      const res = await orderAs(ctx, "alice", [G[3]]);
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).not.toContain(G[3]);
    });
  });

  describe("input validation", () => {
    test.each([
      ["no list", {}],
      ["a string", { chatIds: G[0] }],
      ["an object", { chatIds: { 0: G[0] } }],
      ["null", { chatIds: null }],
    ])("%s is a 400", async (_name, body) => {
      const ctx = makeChatPinApp();
      const cookie = await ctx.login("alice");
      const res = await request(ctx.app).put("/api/chats/pins/order").set("Cookie", cookie).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/chatIds/);
      expect(ctx.calls.reorderChatPins).toHaveLength(0);
    });

    test.each([
      ["a number", [1]],
      ["text that is no UUID", ["nope"]],
      ["null", [null]],
      ["an object", [{ id: G[0] }]],
      ["a UUID with spaces around it", [` ${G[0]} `]],
    ])("an entry that is %s is a 400", async (_name, chatIds) => {
      const ctx = makeChatPinApp();
      const res = await orderAs(ctx, "alice", chatIds);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/UUID/);
      expect(ctx.calls.reorderChatPins).toHaveLength(0);
    });

    test("duplicates are a 400", async () => {
      const ctx = makeChatPinApp();
      const res = await orderAs(ctx, "alice", [G[0], G[0]]);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/twice/);
    });

    test("more than 30 entries are a 400 before the database is touched", async () => {
      const ctx = makeChatPinApp();
      const res = await orderAs(
        ctx,
        "alice",
        Array.from({ length: 31 }, (_, i) => uuid(i + 1)),
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/at most 30/);
      expect(ctx.calls.reorderChatPins).toHaveLength(0);
    });

    test("the body is not a place to smuggle a different person", async () => {
      const ctx = makeChatPinApp();
      const res = await orderAs(ctx, "alice", [], { username: "bob" });
      expect(res.status).toBe(403);
    });
  });

  describe("authorisation", () => {
    test("needs a session", async () => {
      const ctx = makeChatPinApp();
      const res = await request(ctx.app).put("/api/chats/pins/order").send({ chatIds: [] });
      expect(res.status).toBe(401);
    });

    test("a banned account is refused", async () => {
      const ctx = makeChatPinApp();
      const cookie = await ctx.login("alice");
      ctx.userStore.users.get("alice").banned = true;
      const res = await request(ctx.app).put("/api/chats/pins/order").set("Cookie", cookie).send({ chatIds: [] });
      expect(res.status).toBe(403);
      expect(ctx.calls.reorderChatPins).toHaveLength(0);
    });

    test("always acts on the signed-in person's pins", async () => {
      const ctx = makeChatPinApp();
      await pinAll(ctx, "alice", [G[0], G[1]]);
      await pinAll(ctx, "bob", [G[0], G[1]]);
      await orderAs(ctx, "bob", [G[0], G[1]]);
      expect(ctx.calls.reorderChatPins.at(-1).userId).toBe(BOB_ID);
      // alice's order is untouched: G1 G0
      expect(ctx.pins.get(ALICE_ID).find((r) => r.chat_id === G[1]).position).toBe(0);
    });
  });

  test("a database error is a 500 with the usual error shape", async () => {
    const ctx = makeChatPinApp({
      deps: {
        reorderChatPins: () => {
          throw new Error("boom");
        },
      },
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await orderAs(ctx, "alice", []);
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Unable to reorder the pinned chats." });
  });
});

describe("the chat_pins_changed event", () => {
  test("pinning tells the person's own sessions, with the full list", async () => {
    const ctx = makeChatPinApp();
    await pinAs(ctx, "alice", G[0]);
    await pinAs(ctx, "alice", G[1]);
    expect(ctx.pinEventsFor("alice")).toEqual([
      { type: "chat_pins_changed", pinned: [{ chatId: G[0], position: 0 }] },
      {
        type: "chat_pins_changed",
        pinned: [
          { chatId: G[1], position: 0 },
          { chatId: G[0], position: 1 },
        ],
      },
    ]);
  });

  test("unpinning the last pin sends the empty list", async () => {
    const ctx = makeChatPinApp();
    await pinAs(ctx, "alice", G[0]);
    ctx.sse.length = 0;
    await pinAs(ctx, "alice", G[0], false);
    expect(ctx.pinEventsFor("alice")).toEqual([{ type: "chat_pins_changed", pinned: [] }]);
  });

  test("reordering sends the new order", async () => {
    const ctx = makeChatPinApp();
    await pinAll(ctx, "alice", [G[0], G[1]]);
    ctx.sse.length = 0;
    await orderAs(ctx, "alice", [G[0], G[1]]);
    expect(ctx.pinEventsFor("alice")).toEqual([
      {
        type: "chat_pins_changed",
        pinned: [
          { chatId: G[0], position: 0 },
          { chatId: G[1], position: 1 },
        ],
      },
    ]);
  });

  test("goes to the person only: not to another member of the chat, not to the chat", async () => {
    const ctx = makeChatPinApp();
    await pinAs(ctx, "alice", G[0]);
    await orderAs(ctx, "alice", [G[0]]);
    await pinAs(ctx, "alice", G[0], false);
    expect(ctx.pinEventsFor("bob")).toEqual([]);
    expect(ctx.pinEventsFor("carol")).toEqual([]);
    expect(ctx.sse.filter((e) => e.payload.type === "chat_pins_changed").every((e) => e.username === "alice")).toBe(
      true,
    );
    // emitChatEvent fans out to every member of a chat: it is never used for pins.
    expect(ctx.chatEvents).toEqual([]);
  });

  test("the payload has nothing but chat ids and positions", async () => {
    const ctx = makeChatPinApp();
    await pinAs(ctx, "alice", G[0]);
    const [payload] = ctx.pinEventsFor("alice");
    expect(Object.keys(payload).sort()).toEqual(["pinned", "type"]);
    expect(Object.keys(payload.pinned[0]).sort()).toEqual(["chatId", "position"]);
  });

  test("a person's change never produces an event for somebody else", async () => {
    const ctx = makeChatPinApp();
    await pinAs(ctx, "alice", G[0]);
    await pinAs(ctx, "bob", G[0]);
    expect(ctx.pinEventsFor("alice")).toHaveLength(1);
    expect(ctx.pinEventsFor("bob")).toEqual([
      { type: "chat_pins_changed", pinned: [{ chatId: G[0], position: 0 }] },
    ]);
  });
});

describe("GET /api/chats (the chat list)", () => {
  test("says for every chat whether it is pinned and where, pinned chats first", async () => {
    const ctx = makeChatPinApp();
    await pinAll(ctx, "alice", [G[4], G[2]]);
    // pinned: G2 (0), G4 (1)
    const res = await listAs(ctx, "alice");
    expect(res.status).toBe(200);
    const chats = res.body.chats;
    expect(chats[0]).toMatchObject({ id: G[2], pinned: true, pinPosition: 0 });
    expect(chats[1]).toMatchObject({ id: G[4], pinned: true, pinPosition: 1 });
    for (const chat of chats.slice(2)) {
      expect(chat.pinned).toBe(false);
      expect(chat.pinPosition).toBeNull();
    }
    // The raw database column is not part of the API.
    expect(chats.every((chat) => !("pin_position" in chat))).toBe(true);
  });

  test("keeps the order the database gave: it does not re-sort", async () => {
    const ctx = makeChatPinApp();
    await pinAll(ctx, "alice", [G[0], G[1], G[2]]);
    await orderAs(ctx, "alice", [G[0], G[1], G[2]]);
    const res = await listAs(ctx, "alice");
    expect(res.body.chats.slice(0, 3).map((c) => c.id)).toEqual([G[0], G[1], G[2]]);
  });

  test("a person with no pins sees pinned:false everywhere", async () => {
    const ctx = makeChatPinApp();
    const res = await listAs(ctx, "alice");
    expect(res.body.chats.length).toBeGreaterThan(0);
    expect(res.body.chats.every((c) => c.pinned === false && c.pinPosition === null)).toBe(true);
  });

  test("the Saved Messages chat is pinned and sorted like any other", async () => {
    const ctx = makeChatPinApp();
    await pinAs(ctx, "alice", SAVED);
    const res = await listAs(ctx, "alice");
    expect(res.body.chats[0]).toMatchObject({ id: SAVED, type: "saved", pinned: true, pinPosition: 0 });
  });

  test("one person's pins do not show in another person's list", async () => {
    const ctx = makeChatPinApp();
    await pinAll(ctx, "alice", [G[0], G[1]]);
    const bobs = await listAs(ctx, "bob");
    expect(bobs.body.chats.every((c) => c.pinned === false && c.pinPosition === null)).toBe(true);
    const bobsOrder = bobs.body.chats.map((c) => c.id);
    await pinAs(ctx, "bob", G[3]);
    const alices = await listAs(ctx, "alice");
    expect(alices.body.chats.find((c) => c.id === G[3]).pinned).toBe(false);
    expect(alices.body.chats.map((c) => c.id)[0]).toBe(G[1]);
    expect(bobsOrder).toContain(G[3]);
  });

  test("costs one list query: no query per chat", async () => {
    const ctx = makeChatPinApp();
    await pinAll(ctx, "alice", [G[0], G[1], G[2]]);
    ctx.calls.listChatsForUser.length = 0;
    ctx.calls.listChatPins.length = 0;
    await listAs(ctx, "alice");
    expect(ctx.calls.listChatsForUser).toHaveLength(1);
    expect(ctx.calls.listChatPins).toHaveLength(0);
    expect(ctx.calls.listChatPinHolders).toHaveLength(0);
  });

  test("a chat the person hid is not in the list, pinned or not", async () => {
    const ctx = makeChatPinApp();
    await pinAs(ctx, "alice", G[0]);
    const cookie = await ctx.login("alice");
    await request(ctx.app).post("/api/chats/hide").set("Cookie", cookie).send({ username: "alice", chatIds: [G[0]] });
    const res = await listAs(ctx, "alice");
    expect(res.body.chats.find((c) => c.id === G[0])).toBeUndefined();
  });
});

describe("cleanup through the chat routes", () => {
  const post = async (ctx, username, url, body) => {
    const cookie = await ctx.login(username);
    return request(ctx.app).post(url).set("Cookie", cookie).send({ username, ...body });
  };

  test("leaving a group removes the pin and tells the person's other devices", async () => {
    const ctx = makeChatPinApp();
    await pinAll(ctx, "bob", [G[0], G[1]]);
    await pinAll(ctx, "alice", [G[0]]);
    ctx.sse.length = 0;

    const res = await post(ctx, "bob", `/api/chats/group/${G[0]}/leave`, {});
    expect(res.status).toBe(200);
    expect(ctx.pins.get(BOB_ID).map((r) => r.chat_id)).toEqual([G[1]]);
    expect(ctx.pinEventsFor("bob")).toEqual([
      { type: "chat_pins_changed", pinned: [{ chatId: G[1], position: 0 }] },
    ]);
    // Alice kept hers and heard nothing about it.
    expect(ctx.pins.get(ALICE_ID).map((r) => r.chat_id)).toEqual([G[0]]);
    expect(ctx.pinEventsFor("alice")).toEqual([]);
  });

  test("leaving a chat that was not pinned sends no pin event", async () => {
    const ctx = makeChatPinApp();
    await pinAs(ctx, "bob", G[1]);
    ctx.sse.length = 0;
    await post(ctx, "bob", `/api/chats/group/${G[0]}/leave`, {});
    expect(ctx.pinEventsFor("bob")).toEqual([]);
    expect(ctx.pins.get(BOB_ID)).toHaveLength(1);
  });

  test("the owner who leaves a chat they were alone in (it is deleted) loses the pin too", async () => {
    const ctx = makeChatPinApp();
    await pinAs(ctx, "carol", SECRET);
    ctx.sse.length = 0;
    const res = await post(ctx, "carol", `/api/chats/group/${SECRET}/leave`, {});
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
    expect(ctx.pins.get(ALICE_ID) || []).toHaveLength(0);
    expect((ctx.pins.get("ca0ca0ca-0c1c-4c2c-8c3c-c5c5c5c5c5c5") || []).length).toBe(0);
    expect(ctx.pinEventsFor("carol")).toEqual([{ type: "chat_pins_changed", pinned: [] }]);
  });

  test("being removed from a group removes the member's pin only", async () => {
    const ctx = makeChatPinApp();
    await pinAll(ctx, "bob", [G[0], G[2]]);
    await pinAll(ctx, "alice", [G[0]]);
    ctx.sse.length = 0;

    const res = await post(ctx, "alice", `/api/chats/group/${G[0]}/remove-member`, { targetUsername: "bob" });
    expect(res.status).toBe(200);
    expect(ctx.pins.get(BOB_ID).map((r) => r.chat_id)).toEqual([G[2]]);
    expect(ctx.pinEventsFor("bob")).toEqual([
      { type: "chat_pins_changed", pinned: [{ chatId: G[2], position: 0 }] },
    ]);
    expect(ctx.pins.get(ALICE_ID).map((r) => r.chat_id)).toEqual([G[0]]);
    expect(ctx.pinEventsFor("alice")).toEqual([]);
  });

  test("a failed removal (not the owner) leaves the pin alone", async () => {
    const ctx = makeChatPinApp();
    await pinAs(ctx, "alice", G[0]);
    const res = await post(ctx, "bob", `/api/chats/group/${G[0]}/remove-member`, { targetUsername: "alice" });
    expect(res.status).toBe(403);
    expect(ctx.pins.get(ALICE_ID)).toHaveLength(1);
    expect(ctx.pinEventsFor("alice").length).toBe(1); // only the original pin event
  });

  test("hiding chats removes their pins and sends one event", async () => {
    const ctx = makeChatPinApp();
    await pinAll(ctx, "bob", [G[0], G[1], G[2]]);
    ctx.sse.length = 0;

    const res = await post(ctx, "bob", "/api/chats/hide", { chatIds: [G[0], G[2]] });
    expect(res.status).toBe(200);
    expect(ctx.pins.get(BOB_ID).map((r) => r.chat_id)).toEqual([G[1]]);
    expect(ctx.pinEventsFor("bob")).toEqual([
      { type: "chat_pins_changed", pinned: [{ chatId: G[1], position: 0 }] },
    ]);
  });

  test("hiding something that was not pinned sends no pin event", async () => {
    const ctx = makeChatPinApp();
    await pinAs(ctx, "bob", G[1]);
    ctx.sse.length = 0;
    await post(ctx, "bob", "/api/chats/hide", { chatIds: [G[0]] });
    expect(ctx.pinEventsFor("bob")).toEqual([]);
  });

  test("hiding survives garbage ids next to real ones", async () => {
    const ctx = makeChatPinApp();
    await pinAs(ctx, "bob", G[0]);
    const res = await post(ctx, "bob", "/api/chats/hide", { chatIds: [G[0], "nope", 7, null, { x: 1 }] });
    expect(res.status).toBe(200);
    expect(ctx.pins.get(BOB_ID)).toHaveLength(0);
  });

  test("hiding a chat does not remove other people's pins of it", async () => {
    const ctx = makeChatPinApp();
    await pinAs(ctx, "alice", G[0]);
    await pinAs(ctx, "bob", G[0]);
    await post(ctx, "bob", "/api/chats/hide", { chatIds: [G[0]] });
    expect(ctx.pins.get(ALICE_ID)).toHaveLength(1);
    expect(ctx.pins.get(BOB_ID)).toHaveLength(0);
  });

  test("deleting a group removes everybody's pin and tells each person", async () => {
    const ctx = makeChatPinApp();
    await pinAll(ctx, "alice", [G[0], G[1]]);
    await pinAll(ctx, "bob", [G[0]]);
    ctx.sse.length = 0;

    const res = await post(ctx, "alice", `/api/chats/group/${G[0]}/delete`, { password: PASSWORD });
    expect(res.status).toBe(200);
    expect(ctx.pins.get(ALICE_ID).map((r) => r.chat_id)).toEqual([G[1]]);
    expect(ctx.pins.get(BOB_ID)).toEqual([]);
    expect(ctx.pinEventsFor("alice")).toEqual([
      { type: "chat_pins_changed", pinned: [{ chatId: G[1], position: 0 }] },
    ]);
    expect(ctx.pinEventsFor("bob")).toEqual([{ type: "chat_pins_changed", pinned: [] }]);
  });

  test("deleting a chat nobody pinned sends no pin events", async () => {
    const ctx = makeChatPinApp();
    ctx.sse.length = 0;
    const res = await post(ctx, "alice", `/api/chats/group/${G[3]}/delete`, { password: PASSWORD });
    expect(res.status).toBe(200);
    expect(ctx.sse.filter((e) => e.payload.type === "chat_pins_changed")).toEqual([]);
  });
});
