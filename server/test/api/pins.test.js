import { describe, test, expect, vi } from "vitest";
import request from "supertest";
import {
  ALICE_ID,
  BOB_ID,
  CAROL_ID,
  CHAT_ID,
  FOREIGN_MSG_ID,
  MSG_ID,
  MSG_ID_2,
  NEW_MSG_ID,
  SYSTEM_MSG_ID,
  flush,
  listAs,
  makePinApp,
  pinAs,
  pinsUrl,
  unpinAllAs,
  unpinAs,
} from "../helpers/pinFixture.js";

const OTHER_CHAT_ID = "c1c1c1c1-d1d1-4e2e-af3f-070707070707";

const eventsOfType = (ctx, type) =>
  ctx.events.filter((e) => e.payload.type === type).map((e) => e.payload);

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const dmMembers = [
  { id: ALICE_ID, username: "alice", role: "member" },
  { id: BOB_ID, username: "bob", role: "member" },
];

describe("POST /api/chats/:chatId/pins", () => {
  test("pins a message and answers with the pins of the chat", async () => {
    const ctx = makePinApp();
    const res = await pinAs(ctx, "alice", MSG_ID);
    expect(res.status).toBe(200);
    expect(res.body.pins).toHaveLength(1);
    expect(res.body.pins[0]).toMatchObject({
      messageId: MSG_ID,
      pinnedBy: ALICE_ID,
      message: {
        id: MSG_ID,
        senderId: BOB_ID,
        senderName: "Bob",
        type: "text",
        text: "hello from bob",
        hasFile: false,
        fileKind: null,
      },
    });
    expect(typeof res.body.pins[0].pinnedAt).toBe("string");
    expect(ctx.pins.rows).toHaveLength(1);
  });

  test("requires a session", async () => {
    const ctx = makePinApp();
    const res = await request(ctx.app).post(pinsUrl()).send({ messageId: MSG_ID });
    expect(res.status).toBe(401);
    expect(ctx.pins.rows).toHaveLength(0);
  });

  test("a banned account is refused", async () => {
    const ctx = makePinApp();
    const cookie = await ctx.login("alice");
    ctx.userStore.users.get("alice").banned = 1;
    const res = await request(ctx.app).post(pinsUrl()).set("Cookie", cookie).send({ messageId: MSG_ID });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/banned/i);
    expect(ctx.pins.rows).toHaveLength(0);
    const list = await request(ctx.app).get(pinsUrl()).set("Cookie", cookie);
    expect(list.status).toBe(403);
  });

  test("a username that is not the signed-in person is refused", async () => {
    const ctx = makePinApp();
    const cookie = await ctx.login("alice");
    const res = await request(ctx.app)
      .post(pinsUrl())
      .set("Cookie", cookie)
      .send({ messageId: MSG_ID, username: "bob" });
    expect(res.status).toBe(403);
    expect(ctx.pins.rows).toHaveLength(0);
  });

  test.each([
    ["missing", undefined, /required/i],
    ["empty", "", /required/i],
    ["not a uuid", "nope", /uuid/i],
    ["a number", 7, /uuid/i],
    ["an object", { id: MSG_ID }, /uuid/i],
    ["an array", [MSG_ID], /uuid/i],
    ["with surrounding spaces", ` ${MSG_ID} `, /uuid/i],
  ])("rejects a messageId that is %s", async (_label, messageId, pattern) => {
    const ctx = makePinApp();
    const res = await pinAs(ctx, "alice", messageId);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(pattern);
    expect(ctx.pins.rows).toHaveLength(0);
  });

  test("a chat id that is not a uuid is a 400", async () => {
    const ctx = makePinApp();
    const res = await pinAs(ctx, "alice", MSG_ID, "not-a-uuid");
    expect(res.status).toBe(400);
  });

  test("a message that does not exist is a 404", async () => {
    const ctx = makePinApp();
    const res = await pinAs(ctx, "alice", NEW_MSG_ID);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Message not found." });
  });

  test("a message of another chat is a 404 that looks like a missing one", async () => {
    const ctx = makePinApp();
    const foreign = await pinAs(ctx, "alice", FOREIGN_MSG_ID);
    const missing = await pinAs(ctx, "alice", NEW_MSG_ID);
    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual(missing.body);
    expect(ctx.pins.rows).toHaveLength(0);
  });

  test("a message deleted for everyone cannot be pinned", async () => {
    const ctx = makePinApp();
    ctx.messages.get(MSG_ID).hidden_everyone_at = "2025-01-01 00:00:00";
    const res = await pinAs(ctx, "alice", MSG_ID);
    expect(res.status).toBe(404);
    expect(ctx.pins.rows).toHaveLength(0);
  });

  test("a message the caller deleted for themselves cannot be pinned by them", async () => {
    const ctx = makePinApp();
    ctx.hide(MSG_ID, ALICE_ID);
    const res = await pinAs(ctx, "alice", MSG_ID);
    expect(res.status).toBe(404);
    expect(ctx.pins.rows).toHaveLength(0);
  });

  test("a service message cannot be pinned", async () => {
    const ctx = makePinApp();
    const res = await pinAs(ctx, "alice", SYSTEM_MSG_ID);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot be pinned/i);
    expect(ctx.pins.rows).toHaveLength(0);
  });

  test("is idempotent: the second request changes nothing and says nothing", async () => {
    const ctx = makePinApp();
    const first = await pinAs(ctx, "alice", MSG_ID);
    const eventsAfterFirst = ctx.events.length;
    const createdAfterFirst = ctx.created.length;

    const again = await pinAs(ctx, "alice", MSG_ID);
    expect(again.status).toBe(200);
    expect(again.body.pins).toEqual(first.body.pins);
    expect(ctx.pins.rows).toHaveLength(1);
    expect(ctx.events.length).toBe(eventsAfterFirst);
    expect(ctx.created.length).toBe(createdAfterFirst);
  });

  test("lists the newest pin first", async () => {
    const ctx = makePinApp();
    await pinAs(ctx, "alice", MSG_ID);
    const res = await pinAs(ctx, "alice", MSG_ID_2);
    expect(res.body.pins.map((p) => p.messageId)).toEqual([MSG_ID_2, MSG_ID]);
  });

  test("works with a database that answers with promises", async () => {
    const ctx = makePinApp({ asyncDb: true });
    const res = await pinAs(ctx, "alice", MSG_ID);
    expect(res.status).toBe(200);
    expect(res.body.pins).toHaveLength(1);
    const unpinned = await unpinAs(ctx, "alice", MSG_ID);
    expect(unpinned.status).toBe(200);
    expect(unpinned.body.pins).toEqual([]);
  });

  test("a message that vanishes between the check and the write is a 404", async () => {
    const ctx = makePinApp({
      deps: {
        pinMessage: async () => {
          throw Object.assign(new Error("FOREIGN KEY constraint failed"), {
            code: "SQLITE_CONSTRAINT_FOREIGNKEY",
          });
        },
      },
    });
    const res = await pinAs(ctx, "alice", MSG_ID);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Message not found." });
    expect(ctx.events).toEqual([]);
  });

  test("a database failure is a 500 without details", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = makePinApp({
      deps: {
        pinMessage: () => {
          throw new Error("secret SQL detail");
        },
      },
    });
    const res = await pinAs(ctx, "alice", MSG_ID);
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("secret");
    expect(res.body.error).toBeTruthy();
    spy.mockRestore();
  });
});

describe("who may pin", () => {
  test("direct message: either person pins and unpins for both", async () => {
    const ctx = makePinApp({ chat: { type: "dm", name: "" }, members: dmMembers });
    expect((await pinAs(ctx, "alice", MSG_ID)).status).toBe(200);
    expect((await pinAs(ctx, "bob", MSG_ID_2)).status).toBe(200);
    expect(ctx.pins.rows).toHaveLength(2);

    // Bob removes the pin Alice made, and the other way round.
    expect((await unpinAs(ctx, "bob", MSG_ID)).status).toBe(200);
    expect((await unpinAs(ctx, "alice", MSG_ID_2)).status).toBe(200);
    expect(ctx.pins.rows).toHaveLength(0);
  });

  test("Saved Messages: the one member pins", async () => {
    const ctx = makePinApp({
      chat: { type: "saved", name: "Saved Messages" },
      members: [{ id: ALICE_ID, username: "alice", role: "owner" }],
    });
    expect((await pinAs(ctx, "alice", MSG_ID_2)).status).toBe(200);
    expect(ctx.pins.rows).toHaveLength(1);
  });

  test("group: the owner pins, a plain member does not", async () => {
    const ctx = makePinApp();
    expect((await pinAs(ctx, "alice", MSG_ID)).status).toBe(200);

    const denied = await pinAs(ctx, "bob", MSG_ID_2);
    expect(denied.status).toBe(403);
    expect(denied.body.error).toMatch(/not allowed to pin/i);
    expect(ctx.pins.rows).toHaveLength(1);
  });

  test("group: a member cannot unpin or clear pins either", async () => {
    const ctx = makePinApp();
    await pinAs(ctx, "alice", MSG_ID);
    expect((await unpinAs(ctx, "bob", MSG_ID)).status).toBe(403);
    expect((await unpinAllAs(ctx, "bob")).status).toBe(403);
    expect(ctx.pins.rows).toHaveLength(1);
  });

  test("group: an administrator role pins", async () => {
    const ctx = makePinApp({
      members: [
        { id: ALICE_ID, username: "alice", role: "owner" },
        { id: BOB_ID, username: "bob", role: "admin" },
      ],
    });
    expect((await pinAs(ctx, "bob", MSG_ID)).status).toBe(200);
  });

  test("group: with the members-can-pin setting every member pins and unpins", async () => {
    const ctx = makePinApp({ chat: { type: "group", name: "Friends", allow_member_pins: 1 } });
    expect((await pinAs(ctx, "bob", MSG_ID)).status).toBe(200);
    expect((await unpinAs(ctx, "bob", MSG_ID)).status).toBe(200);
  });

  test("group: the setting does not let outsiders in", async () => {
    const ctx = makePinApp({ chat: { type: "group", name: "Friends", allow_member_pins: 1 } });
    const res = await pinAs(ctx, "carol", MSG_ID);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Not a member of this chat." });
    expect(ctx.pins.rows).toHaveLength(0);
  });

  test("channel: the owner pins, subscribers never do, whatever the group setting says", async () => {
    const ctx = makePinApp({
      chat: { type: "channel", name: "News", allow_member_pins: 1 },
    });
    expect((await pinAs(ctx, "alice", MSG_ID)).status).toBe(200);
    expect((await pinAs(ctx, "bob", MSG_ID_2)).status).toBe(403);
    expect((await unpinAs(ctx, "bob", MSG_ID)).status).toBe(403);
    expect((await unpinAllAs(ctx, "bob")).status).toBe(403);
    expect(ctx.pins.rows).toHaveLength(1);
  });

  test("mirrored remote channel: only the owner pins posts that came from the other server", async () => {
    const ctx = makePinApp({ chat: { type: "channel", name: "Mirror" } });
    ctx.markRemote(MSG_ID);
    expect((await pinAs(ctx, "bob", MSG_ID)).status).toBe(403);
    expect((await pinAs(ctx, "alice", MSG_ID)).status).toBe(200);
  });

  test("somebody who left, was removed or was banned from the chat never can", async () => {
    // Leaving, being removed and being banned all end membership.
    const ctx = makePinApp({
      chat: { type: "group", name: "Friends", allow_member_pins: 1 },
      deps: { isMember: (_chatId, userId) => userId !== BOB_ID },
    });
    await pinAs(ctx, "alice", MSG_ID);

    expect((await pinAs(ctx, "bob", MSG_ID_2)).status).toBe(403);
    expect((await unpinAs(ctx, "bob", MSG_ID)).status).toBe(403);
    expect((await unpinAllAs(ctx, "bob")).status).toBe(403);
    expect((await listAs(ctx, "bob")).status).toBe(403);
    expect(ctx.pins.rows).toHaveLength(1);
  });

  test("a non-member learns nothing about messages or pins", async () => {
    const ctx = makePinApp();
    await pinAs(ctx, "alice", MSG_ID);
    const real = await pinAs(ctx, "carol", MSG_ID_2);
    const fake = await pinAs(ctx, "carol", NEW_MSG_ID);
    expect(real.status).toBe(403);
    expect(real.body).toEqual(fake.body);
    const listing = await listAs(ctx, "carol");
    expect(listing.status).toBe(403);
    expect(JSON.stringify(listing.body)).not.toContain("hello from bob");
  });

  test("a chat that does not exist cannot be used", async () => {
    const ctx = makePinApp({ deps: { isMember: () => true } });
    const res = await pinAs(ctx, "alice", MSG_ID, OTHER_CHAT_ID);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Chat not found." });
  });
});

describe("the pin limit", () => {
  const messageIds = Array.from({ length: 25 }, (_, i) => uuid(i + 1));
  const seed = (ctx) => messageIds.forEach((id) => ctx.addMessage({ id }));

  test("defaults to 20", async () => {
    const ctx = makePinApp();
    seed(ctx);
    for (let i = 0; i < 20; i += 1) {
      expect((await pinAs(ctx, "alice", messageIds[i])).status).toBe(200);
    }
    const res = await pinAs(ctx, "alice", messageIds[20]);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("pin_limit");
    expect(res.body.error).toMatch(/20/);
    expect(ctx.pins.rows).toHaveLength(20);
  });

  test("follows MAX_PINNED_MESSAGES and refuses instead of dropping the oldest pin", async () => {
    const ctx = makePinApp({ settings: { MAX_PINNED_MESSAGES: 2 } });
    seed(ctx);
    await pinAs(ctx, "alice", messageIds[0]);
    await pinAs(ctx, "alice", messageIds[1]);
    const res = await pinAs(ctx, "alice", messageIds[2]);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: expect.stringMatching(/2/),
      code: "pin_limit",
    });
    expect(ctx.pins.rows.map((r) => r.message_id)).toEqual([messageIds[0], messageIds[1]]);
    expect(eventsOfType(ctx, "message_pinned")).toHaveLength(2);
  });

  test("a full chat still accepts a pin that already exists, and room opens after an unpin", async () => {
    const ctx = makePinApp({ settings: { MAX_PINNED_MESSAGES: 1 } });
    seed(ctx);
    await pinAs(ctx, "alice", messageIds[0]);
    expect((await pinAs(ctx, "alice", messageIds[0])).status).toBe(200);
    expect((await pinAs(ctx, "alice", messageIds[1])).status).toBe(409);
    await unpinAs(ctx, "alice", messageIds[0]);
    expect((await pinAs(ctx, "alice", messageIds[1])).status).toBe(200);
  });

  test("a refused pin writes no service message and sends no event", async () => {
    const ctx = makePinApp({ settings: { MAX_PINNED_MESSAGES: 1 } });
    seed(ctx);
    await pinAs(ctx, "alice", messageIds[0]);
    const events = ctx.events.length;
    const created = ctx.created.length;
    await pinAs(ctx, "alice", messageIds[1]);
    expect(ctx.events.length).toBe(events);
    expect(ctx.created.length).toBe(created);
  });

  test.each([
    [0, 1],
    [-5, 1],
    ["abc", 20],
    [500, 100],
    ["7", 7],
    [null, 20],
  ])("the setting %j is understood as %j", async (setting, expected) => {
    const ctx = makePinApp({ settings: { MAX_PINNED_MESSAGES: setting } });
    await pinAs(ctx, "alice", MSG_ID);
    expect(ctx.pins.calls.pin[0].max).toBe(expected);
  });

  test("the limit is per chat", async () => {
    const ctx = makePinApp({ settings: { MAX_PINNED_MESSAGES: 1 } });
    ctx.pins.rows.push({
      chat_id: OTHER_CHAT_ID,
      message_id: FOREIGN_MSG_ID,
      pinned_by: CAROL_ID,
      pinned_at: "2025-01-01T00:00:00.000Z",
    });
    expect((await pinAs(ctx, "alice", MSG_ID)).status).toBe(200);
  });
});

describe("DELETE /api/chats/:chatId/pins/:messageId", () => {
  test("removes the pin and tells the chat", async () => {
    const ctx = makePinApp();
    await pinAs(ctx, "alice", MSG_ID);
    await pinAs(ctx, "alice", MSG_ID_2);

    const res = await unpinAs(ctx, "alice", MSG_ID);
    expect(res.status).toBe(200);
    expect(res.body.pins.map((p) => p.messageId)).toEqual([MSG_ID_2]);
    expect(eventsOfType(ctx, "message_unpinned")).toEqual([
      { type: "message_unpinned", chatId: CHAT_ID, messageId: MSG_ID },
    ]);
  });

  test("unpinning something that is not pinned is a quiet success", async () => {
    const ctx = makePinApp();
    const res = await unpinAs(ctx, "alice", MSG_ID);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pins: [] });
    expect(ctx.events).toEqual([]);
  });

  test("does not write a service message", async () => {
    const ctx = makePinApp();
    await pinAs(ctx, "alice", MSG_ID);
    const created = ctx.created.length;
    await unpinAs(ctx, "alice", MSG_ID);
    expect(ctx.created.length).toBe(created);
  });

  test("rejects ids that are not uuids", async () => {
    const ctx = makePinApp();
    const cookie = await ctx.login("alice");
    const res = await request(ctx.app).delete(`${pinsUrl()}/nope`).set("Cookie", cookie);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/uuid/i);
  });

  test("requires a session", async () => {
    const ctx = makePinApp();
    const res = await request(ctx.app).delete(`${pinsUrl()}/${MSG_ID}`);
    expect(res.status).toBe(401);
  });

  test("a pin of another chat is not touched", async () => {
    const ctx = makePinApp();
    ctx.pins.rows.push({
      chat_id: OTHER_CHAT_ID,
      message_id: FOREIGN_MSG_ID,
      pinned_by: CAROL_ID,
      pinned_at: "2025-01-01T00:00:00.000Z",
    });
    const res = await unpinAs(ctx, "alice", FOREIGN_MSG_ID);
    expect(res.status).toBe(200);
    expect(ctx.pins.rows).toHaveLength(1);
    expect(ctx.events).toEqual([]);
  });
});

describe("DELETE /api/chats/:chatId/pins", () => {
  test("clears every pin of the chat with one event", async () => {
    const ctx = makePinApp();
    await pinAs(ctx, "alice", MSG_ID);
    await pinAs(ctx, "alice", MSG_ID_2);

    const res = await unpinAllAs(ctx, "alice");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pins: [] });
    expect(ctx.pins.rows).toHaveLength(0);
    expect(eventsOfType(ctx, "messages_unpinned_all")).toEqual([
      { type: "messages_unpinned_all", chatId: CHAT_ID },
    ]);
    expect(eventsOfType(ctx, "message_unpinned")).toEqual([]);
  });

  test("only the pins of this chat go", async () => {
    const ctx = makePinApp();
    await pinAs(ctx, "alice", MSG_ID);
    ctx.pins.rows.push({
      chat_id: OTHER_CHAT_ID,
      message_id: FOREIGN_MSG_ID,
      pinned_by: CAROL_ID,
      pinned_at: "2025-01-01T00:00:00.000Z",
    });
    await unpinAllAs(ctx, "alice");
    expect(ctx.pins.rows.map((r) => r.chat_id)).toEqual([OTHER_CHAT_ID]);
  });

  test("with nothing pinned it is a quiet success", async () => {
    const ctx = makePinApp();
    const res = await unpinAllAs(ctx, "alice");
    expect(res.status).toBe(200);
    expect(ctx.events).toEqual([]);
  });

  test("direct message: either person clears the pins", async () => {
    const ctx = makePinApp({ chat: { type: "dm", name: "" }, members: dmMembers });
    await pinAs(ctx, "alice", MSG_ID);
    expect((await unpinAllAs(ctx, "bob")).status).toBe(200);
    expect(ctx.pins.rows).toHaveLength(0);
  });
});

describe("GET /api/chats/:chatId/pins", () => {
  test("any member reads the pins, newest first", async () => {
    const ctx = makePinApp();
    await pinAs(ctx, "alice", MSG_ID);
    await pinAs(ctx, "alice", MSG_ID_2);

    const res = await listAs(ctx, "bob");
    expect(res.status).toBe(200);
    expect(res.body.pins.map((p) => p.messageId)).toEqual([MSG_ID_2, MSG_ID]);
    expect(Object.keys(res.body.pins[0]).sort()).toEqual(
      ["message", "messageId", "pinnedAt", "pinnedBy"].sort(),
    );
    expect(Object.keys(res.body.pins[0].message).sort()).toEqual(
      ["createdAt", "fileKind", "hasFile", "id", "senderId", "senderName", "text", "type"].sort(),
    );
  });

  test("an empty chat has an empty list", async () => {
    const ctx = makePinApp();
    const res = await listAs(ctx, "alice");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pins: [] });
  });

  test("the preview is plain text of at most 140 characters", async () => {
    const ctx = makePinApp();
    ctx.addMessage({ id: uuid(1), body: `**Hello** _there_ [site](https://x.example) ${"y".repeat(300)}` });
    await pinAs(ctx, "alice", uuid(1));
    const res = await listAs(ctx, "alice");
    const { text } = res.body.pins[0].message;
    expect(Array.from(text).length).toBeLessThanOrEqual(140);
    expect(text.startsWith("Hello there site yyy")).toBe(true);
    expect(text).not.toMatch(/[*_\[\]()]|https/);
  });

  test("shows an edited message the way it reads now", async () => {
    const ctx = makePinApp();
    ctx.messages.get(MSG_ID).edited_body = "now **fixed**";
    await pinAs(ctx, "alice", MSG_ID);
    const res = await listAs(ctx, "alice");
    expect(res.body.pins[0].message.text).toBe("now fixed");
  });

  test("tells what kind of attachment a message has", async () => {
    const ctx = makePinApp();
    ctx.addMessage({ id: uuid(1), body: "look", files: [{ mime_type: "image/png", kind: "media" }] });
    ctx.addMessage({ id: uuid(2), body: "", files: [{ mime_type: "video/mp4", kind: "media" }] });
    ctx.addMessage({ id: uuid(3), body: "", files: [{ mime_type: "audio/ogg", kind: "audio" }] });
    ctx.addMessage({ id: uuid(4), body: "", files: [{ mime_type: "application/pdf", kind: "document" }] });
    for (const n of [1, 2, 3, 4]) await pinAs(ctx, "alice", uuid(n));
    const res = await listAs(ctx, "alice");
    const byId = Object.fromEntries(res.body.pins.map((p) => [p.messageId, p.message]));
    expect(byId[uuid(1)]).toMatchObject({ type: "image", hasFile: true, fileKind: "image", text: "look" });
    expect(byId[uuid(2)]).toMatchObject({ type: "video", hasFile: true, fileKind: "video", text: "" });
    expect(byId[uuid(3)]).toMatchObject({ type: "audio", hasFile: true, fileKind: "audio" });
    expect(byId[uuid(4)]).toMatchObject({ type: "document", hasFile: true, fileKind: "document" });
  });

  test("an encrypted round video is a video note and exposes no envelope", async () => {
    const ctx = makePinApp();
    ctx.addMessage({ id: uuid(1), body: "", e2ee_envelope: '{"secret":"x"}', files: [{ mime_type: "video/mp4", kind: "media" }] });
    await pinAs(ctx, "alice", uuid(1));
    const res = await listAs(ctx, "alice");
    expect(res.body.pins[0].message).toMatchObject({ type: "video_note", hasFile: true, fileKind: "video_note" });
    expect(JSON.stringify(res.body)).not.toContain("secret");
  });

  test("a pinned message deleted for everyone disappears from the list", async () => {
    const ctx = makePinApp();
    await pinAs(ctx, "alice", MSG_ID);
    ctx.messages.get(MSG_ID).hidden_everyone_at = "2025-01-01 00:00:00";
    const res = await listAs(ctx, "alice");
    expect(res.body.pins).toEqual([]);
  });

  test("a message somebody deleted for themselves stays pinned for the others", async () => {
    const ctx = makePinApp();
    await pinAs(ctx, "alice", MSG_ID);
    ctx.hide(MSG_ID, BOB_ID);
    expect((await listAs(ctx, "bob")).body.pins).toEqual([]);
    expect((await listAs(ctx, "alice")).body.pins).toHaveLength(1);
  });

  test("a sender whose account is gone is shown as a deleted user", async () => {
    const ctx = makePinApp();
    ctx.addMessage({ id: uuid(1), user_id: null, body: "orphan" });
    await pinAs(ctx, "alice", uuid(1));
    const res = await listAs(ctx, "alice");
    expect(res.body.pins[0].message).toMatchObject({ senderId: null, senderName: "Deleted user" });
  });

  test("in a channel the channel speaks, not a person", async () => {
    const ctx = makePinApp({ chat: { type: "channel", name: "Daily News" } });
    await pinAs(ctx, "alice", MSG_ID);
    const res = await listAs(ctx, "bob");
    expect(res.body.pins[0].message.senderName).toBe("Daily News");
  });

  test("a failure while loading is a 500 without details", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = makePinApp({
      deps: {
        listPinnedMessages: () => {
          throw new Error("secret SQL detail");
        },
      },
    });
    const res = await listAs(ctx, "alice");
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("secret");
    spy.mockRestore();
  });

  test("needs only one query for the whole list", async () => {
    const ctx = makePinApp();
    for (let i = 1; i <= 10; i += 1) {
      ctx.addMessage({ id: uuid(i) });
      await pinAs(ctx, "alice", uuid(i));
    }
    ctx.pins.calls.list.length = 0;
    const res = await listAs(ctx, "bob");
    expect(res.body.pins).toHaveLength(10);
    expect(ctx.pins.calls.list).toEqual([{ chatId: CHAT_ID, viewerUserId: BOB_ID, limit: 100 }]);
  });
});

describe("realtime events", () => {
  test("a new pin is broadcast to the chat", async () => {
    const ctx = makePinApp();
    const res = await pinAs(ctx, "alice", MSG_ID);
    const pinned = eventsOfType(ctx, "message_pinned");
    expect(pinned).toEqual([
      {
        type: "message_pinned",
        chatId: CHAT_ID,
        messageId: MSG_ID,
        pinnedBy: ALICE_ID,
        pinnedAt: res.body.pins[0].pinnedAt,
      },
    ]);
    expect(ctx.events.find((e) => e.payload.type === "message_pinned").chatId).toBe(CHAT_ID);
  });

  test("nothing is broadcast when the request is refused", async () => {
    const ctx = makePinApp();
    await pinAs(ctx, "bob", MSG_ID); // not allowed
    await pinAs(ctx, "alice", SYSTEM_MSG_ID); // service message
    await pinAs(ctx, "alice", FOREIGN_MSG_ID); // other chat
    await pinAs(ctx, "carol", MSG_ID); // outsider
    expect(ctx.events).toEqual([]);
  });

  test("a broken realtime hub does not undo the pin", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = makePinApp({
      deps: {
        emitChatEvent: () => {
          throw new Error("hub down");
        },
      },
    });
    const res = await pinAs(ctx, "alice", MSG_ID);
    expect(res.status).toBe(200);
    expect(ctx.pins.rows).toHaveLength(1);
    spy.mockRestore();
  });
});

describe("the \"X pinned a message\" entry", () => {
  test("a group gets a service message written by the person who pinned", async () => {
    const ctx = makePinApp();
    await pinAs(ctx, "alice", MSG_ID);
    expect(ctx.created).toHaveLength(1);
    expect(ctx.created[0]).toMatchObject({
      chatId: CHAT_ID,
      userId: ALICE_ID,
      body: `[[system:pinned:${MSG_ID}]]`,
      options: { allowPlaintextSystemMessage: true },
    });
  });

  test("it is broadcast as a chat message with the structured form", async () => {
    const ctx = makePinApp();
    await pinAs(ctx, "alice", MSG_ID);
    const messages = eventsOfType(ctx, "chat_message");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      chatId: CHAT_ID,
      messageId: ctx.created[0].id,
      username: "alice",
      userId: ALICE_ID,
      body: `[[system:pinned:${MSG_ID}]]`,
      service: { action: "pin", messageId: MSG_ID, actorId: ALICE_ID },
    });
    // The pin itself is announced before the timeline entry.
    const order = ctx.events.map((e) => e.payload.type);
    expect(order.indexOf("message_pinned")).toBeLessThan(order.indexOf("chat_message"));
  });

  test.each([
    ["dm", dmMembers],
    ["saved", [{ id: ALICE_ID, username: "alice", role: "owner" }]],
  ])("a %s chat gets it too", async (type, members) => {
    const ctx = makePinApp({ chat: { type, name: "" }, members });
    await pinAs(ctx, "alice", MSG_ID);
    expect(ctx.created).toHaveLength(1);
  });

  test("a channel does not: its feed is what remote servers mirror", async () => {
    const ctx = makePinApp({ chat: { type: "channel", name: "News" } });
    await pinAs(ctx, "alice", MSG_ID);
    expect(ctx.created).toEqual([]);
    expect(eventsOfType(ctx, "chat_message")).toEqual([]);
    expect(eventsOfType(ctx, "message_pinned")).toHaveLength(1);
  });

  test("pinning the same message again writes nothing new", async () => {
    const ctx = makePinApp();
    await pinAs(ctx, "alice", MSG_ID);
    await pinAs(ctx, "alice", MSG_ID);
    await pinAs(ctx, "alice", MSG_ID);
    expect(ctx.created).toHaveLength(1);
  });

  test("a failure writing the entry does not undo the pin", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = makePinApp({
      deps: {
        createMessage: () => {
          throw new Error("disk full");
        },
      },
    });
    const res = await pinAs(ctx, "alice", MSG_ID);
    expect(res.status).toBe(200);
    expect(ctx.pins.rows).toHaveLength(1);
    expect(eventsOfType(ctx, "message_pinned")).toHaveLength(1);
    spy.mockRestore();
  });

  test("it works with a database that answers with promises", async () => {
    const ctx = makePinApp({ asyncDb: true });
    await pinAs(ctx, "alice", MSG_ID);
    expect(ctx.created).toHaveLength(1);
    expect(eventsOfType(ctx, "chat_message")).toHaveLength(1);
  });
});

describe("rate limits", () => {
  test("writes are limited per signed-in person", async () => {
    const ctx = makePinApp({
      chat: { type: "dm", name: "" },
      members: dmMembers,
    });
    const cookieAlice = await ctx.login("alice");
    let last;
    for (let i = 0; i < 31; i += 1) {
      last = await request(ctx.app)
        .delete(`${pinsUrl()}/${MSG_ID}`)
        .set("Cookie", cookieAlice);
    }
    expect(last.status).toBe(429);
    expect(last.body.error).toBeTruthy();

    // Bob has his own allowance.
    const cookieBob = await ctx.login("bob");
    const bob = await request(ctx.app).delete(`${pinsUrl()}/${MSG_ID}`).set("Cookie", cookieBob);
    expect(bob.status).toBe(200);
  });

  test("reading the list is limited too, with a higher allowance", async () => {
    const ctx = makePinApp();
    const cookie = await ctx.login("alice");
    let last;
    for (let i = 0; i < 121; i += 1) {
      last = await request(ctx.app).get(pinsUrl()).set("Cookie", cookie);
    }
    expect(last.status).toBe(429);
  });

  test("a refused request still costs nothing in the database", async () => {
    const ctx = makePinApp();
    const cookie = await ctx.login("alice");
    for (let i = 0; i < 40; i += 1) {
      await request(ctx.app).post(pinsUrl()).set("Cookie", cookie).send({ messageId: "bad" });
    }
    expect(ctx.pins.calls.pin).toEqual([]);
  });
});

describe("pins and the person asking", () => {
  test("the response never contains another person's hidden message", async () => {
    const ctx = makePinApp();
    await pinAs(ctx, "alice", MSG_ID);
    ctx.hide(MSG_ID, ALICE_ID);
    const res = await pinAs(ctx, "alice", MSG_ID_2);
    // Alice deleted MSG_ID for herself, so it is not in her answer.
    expect(res.body.pins.map((p) => p.messageId)).toEqual([MSG_ID_2]);
  });

  test("flush leaves no stray timers or rejections behind", async () => {
    const ctx = makePinApp();
    await pinAs(ctx, "alice", MSG_ID);
    await flush();
    expect(ctx.pins.rows).toHaveLength(1);
  });
});
