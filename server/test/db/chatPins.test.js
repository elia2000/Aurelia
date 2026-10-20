import { describe, test, expect } from "vitest";
import crypto from "node:crypto";
import { dbKnex } from "../../db/knex.js";
import {
  addChatMember,
  createChat,
  createMessage,
  createUser,
  deleteChatById,
  deleteUserById,
  ensureSavedChatForUser,
  getAll,
  hideChatsForUser,
  listChatPinHolders,
  listChatPins,
  listChatPinsForUsers,
  listChatsForUser,
  pinChat,
  removeChatMember,
  removeChatPins,
  reorderChatPins,
  run,
  unhideChat,
} from "../../db.js";

const unique = () => crypto.randomBytes(5).toString("hex");

// Every test works in its own users and chats so the shared on-disk test
// database never makes tests depend on each other.
async function seedUser(tag, index = 0) {
  return createUser(`cp_${tag}_${index}`, "hash", `Nick ${index}`, null, "#10b981");
}

async function seedChat(users, { type = "group", name = "chat" } = {}) {
  const chatId = await createChat(`${name} ${unique()}`, type, { createdByUserId: users[0] });
  for (let i = 0; i < users.length; i += 1) {
    await addChatMember(chatId, users[i], i === 0 ? "owner" : "member");
  }
  return chatId;
}

/** A chat for `userId` with `count` other chats, oldest first. */
async function seedChats(userId, count, other = null) {
  const members = other ? [userId, other] : [userId];
  const chats = [];
  for (let i = 0; i < count; i += 1) chats.push(await seedChat(members, { name: `c${i}` }));
  return chats;
}

/** Posts a message at a fixed time so the "latest message" order is known. */
async function postAt(chatId, userId, createdAt) {
  const id = await createMessage(chatId, userId, `hello ${unique()}`);
  await run(dbKnex("chat_messages").where({ id }).update({ created_at: createdAt }));
  return id;
}

const pinOf = (userId, chatId, max = 5) => pinChat({ userId, chatId, max });
const idsOf = async (userId) => (await listChatPins(userId)).map((row) => row.chat_id);
const rawRows = async (where) => getAll(dbKnex("chat_pins").where(where));
const listedIds = async (userId) => (await listChatsForUser(userId)).map((chat) => chat.id);

describe("pinChat", () => {
  test("pins a chat at the top: position 0, everything else moves down", async () => {
    const tag = unique();
    const me = await seedUser(tag);
    const [a, b, c] = await seedChats(me, 3);

    expect(await pinOf(me, a)).toEqual({ status: "pinned", position: 0 });
    expect(await pinOf(me, b)).toEqual({ status: "pinned", position: 0 });
    expect(await pinOf(me, c)).toEqual({ status: "pinned", position: 0 });

    const rows = await listChatPins(me);
    expect(rows.map((r) => [r.chat_id, Number(r.position)])).toEqual([
      [c, 0],
      [b, 1],
      [a, 2],
    ]);
  });

  test("is idempotent: a pinned chat keeps its place and nothing moves", async () => {
    const me = await seedUser(unique());
    const [a, b] = await seedChats(me, 2);
    await pinOf(me, a);
    await pinOf(me, b);

    expect(await pinOf(me, a)).toEqual({ status: "already", position: 1 });
    expect(await idsOf(me)).toEqual([b, a]);
  });

  test("refuses the pin that would exceed the limit and keeps what is pinned", async () => {
    const me = await seedUser(unique());
    const [a, b, c] = await seedChats(me, 3);
    expect((await pinOf(me, a, 2)).status).toBe("pinned");
    expect((await pinOf(me, b, 2)).status).toBe("pinned");

    expect(await pinOf(me, c, 2)).toEqual({ status: "limit", position: null });
    expect(await idsOf(me)).toEqual([b, a]);
    expect(await rawRows({ user_id: me, chat_id: c })).toEqual([]);
  });

  test("a full list still answers 'already' for a chat that is pinned", async () => {
    const me = await seedUser(unique());
    const [a] = await seedChats(me, 1);
    await pinOf(me, a, 1);
    expect((await pinOf(me, a, 1)).status).toBe("already");
  });

  test("the limit is per person, not global", async () => {
    const tag = unique();
    const alice = await seedUser(tag, 0);
    const bob = await seedUser(tag, 1);
    const [shared, own] = [await seedChat([alice, bob]), await seedChat([bob])];
    expect((await pinOf(alice, shared, 1)).status).toBe("pinned");
    expect((await pinOf(bob, shared, 1)).status).toBe("pinned");
    expect((await pinOf(bob, own, 1)).status).toBe("limit");
  });

  test("a nonsense limit is at least 1", async () => {
    const me = await seedUser(unique());
    const [a, b] = await seedChats(me, 2);
    expect((await pinOf(me, a, 0)).status).toBe("pinned");
    expect((await pinOf(me, b, -4)).status).toBe("limit");
  });

  test("somebody else's chat cannot be pinned", async () => {
    const tag = unique();
    const alice = await seedUser(tag, 0);
    const bob = await seedUser(tag, 1);
    const private_ = await seedChat([alice]);
    expect(await pinOf(bob, private_)).toEqual({ status: "not_member", position: null });
    expect(await pinOf(bob, crypto.randomUUID())).toEqual({ status: "not_member", position: null });
    expect(await rawRows({ user_id: bob })).toEqual([]);
  });

  test("a hidden chat cannot be pinned, an unhidden one can", async () => {
    const me = await seedUser(unique());
    const [a] = await seedChats(me, 1);
    await hideChatsForUser(me, [a]);
    expect(await pinOf(me, a)).toEqual({ status: "hidden", position: null });
    expect(await rawRows({ user_id: me })).toEqual([]);

    await unhideChat(me, a);
    expect((await pinOf(me, a)).status).toBe("pinned");
  });

  test("pins left behind by a membership that ended do not count against the limit", async () => {
    const tag = unique();
    const me = await seedUser(tag, 0);
    const friend = await seedUser(tag, 1);
    const gone = await seedChat([friend, me]);
    const [a, b] = await seedChats(me, 2);
    await pinOf(me, gone, 2);
    await pinOf(me, a, 2);
    // A path that forgot to clean up: the membership goes, the pin row stays.
    await run(dbKnex("chat_members").where({ chat_id: gone, user_id: me }).del());
    expect(await rawRows({ user_id: me, chat_id: gone })).toHaveLength(1);

    expect((await pinOf(me, b, 2)).status).toBe("pinned");
    expect(await idsOf(me)).toEqual([b, a]);
    // The stale row was swept and the positions are tidy again.
    expect(await rawRows({ user_id: me, chat_id: gone })).toEqual([]);
    expect((await listChatPins(me)).map((r) => Number(r.position))).toEqual([0, 1]);
  });

  test("a stale pin at the top is swept without leaving a gap in the numbering", async () => {
    const tag = unique();
    const me = await seedUser(tag, 0);
    const friend = await seedUser(tag, 1);
    const gone = await seedChat([friend, me]);
    const [a, b] = await seedChats(me, 2);
    await pinOf(me, a, 5);
    await pinOf(me, gone, 5);
    // order: gone (0), a (1); then the membership ends without cleanup.
    await run(dbKnex("chat_members").where({ chat_id: gone, user_id: me }).del());

    expect((await pinOf(me, b, 5)).status).toBe("pinned");
    expect((await listChatPins(me)).map((r) => [r.chat_id, Number(r.position)])).toEqual([
      [b, 0],
      [a, 1],
    ]);
  });

  test("pinning is private: another person's pins and positions never move", async () => {
    const tag = unique();
    const alice = await seedUser(tag, 0);
    const bob = await seedUser(tag, 1);
    const shared = await seedChat([alice, bob]);
    const aliceOnly = await seedChat([alice]);
    await pinOf(alice, shared);
    await pinOf(alice, aliceOnly);
    const before = await listChatPins(bob);

    await pinOf(bob, shared);
    expect(await idsOf(alice)).toEqual([aliceOnly, shared]);
    expect(before).toEqual([]);
    expect(await idsOf(bob)).toEqual([shared]);
  });
});

describe("listChatPins", () => {
  test("lists only the person's own pins, top first, as the chat list shows them", async () => {
    const tag = unique();
    const alice = await seedUser(tag, 0);
    const bob = await seedUser(tag, 1);
    const [a, b] = await seedChats(alice, 2, bob);
    await pinOf(alice, a);
    await pinOf(alice, b);
    await pinOf(bob, a);
    expect(await idsOf(alice)).toEqual([b, a]);
    expect(await idsOf(bob)).toEqual([a]);
  });

  test("leaves out chats the person is no longer in or has hidden", async () => {
    const tag = unique();
    const me = await seedUser(tag, 0);
    const friend = await seedUser(tag, 1);
    const [stays, left, hidden] = await seedChats(me, 3, friend);
    await pinOf(me, stays);
    await pinOf(me, left);
    await pinOf(me, hidden);
    await run(dbKnex("chat_members").where({ chat_id: left, user_id: me }).del());
    await run(dbKnex("hidden_chats").insert({ user_id: me, chat_id: hidden }));
    expect(await idsOf(me)).toEqual([stays]);
  });

  test("nothing for nobody", async () => {
    expect(await listChatPins(null)).toEqual([]);
    expect(await listChatPins(crypto.randomUUID())).toEqual([]);
  });
});

describe("removeChatPins", () => {
  test("removes the pins of the given chats, reports how many and closes the gaps", async () => {
    const me = await seedUser(unique());
    const [a, b, c, d] = await seedChats(me, 4);
    for (const id of [a, b, c, d]) await pinOf(me, id, 10);
    // order: d(0) c(1) b(2) a(3)

    expect(await removeChatPins(me, [c, a])).toBe(2);
    expect((await listChatPins(me)).map((r) => [r.chat_id, Number(r.position)])).toEqual([
      [d, 0],
      [b, 1],
    ]);
  });

  test("a chat that is not pinned is not an error", async () => {
    const me = await seedUser(unique());
    const [a, b] = await seedChats(me, 2);
    await pinOf(me, a);
    expect(await removeChatPins(me, [b])).toBe(0);
    expect(await removeChatPins(me, [])).toBe(0);
    expect(await removeChatPins(me, null)).toBe(0);
    expect(await removeChatPins(null, [a])).toBe(0);
    expect(await idsOf(me)).toEqual([a]);
  });

  test("a very long list of ids is handled, and ids that cannot be chats are ignored", async () => {
    const me = await seedUser(unique());
    const [a, b] = await seedChats(me, 2);
    await pinOf(me, a);
    await pinOf(me, b);
    const noise = Array.from({ length: 1500 }, () => crypto.randomUUID());
    expect(await removeChatPins(me, [...noise, a, 7, null, { x: 1 }, "", undefined])).toBe(1);
    expect(await idsOf(me)).toEqual([b]);
  });

  test("hiding with a very long list of ids still clears the pins in it", async () => {
    const me = await seedUser(unique());
    const [a, b] = await seedChats(me, 2);
    await pinOf(me, a);
    await pinOf(me, b);
    const noise = Array.from({ length: 1500 }, () => crypto.randomUUID());
    await hideChatsForUser(me, [...noise, a]);
    expect(await idsOf(me)).toEqual([b]);
  });

  test("only the caller's pin goes: other people keep theirs", async () => {
    const tag = unique();
    const alice = await seedUser(tag, 0);
    const bob = await seedUser(tag, 1);
    const shared = await seedChat([alice, bob]);
    await pinOf(alice, shared);
    await pinOf(bob, shared);
    expect(await removeChatPins(alice, [shared])).toBe(1);
    expect(await idsOf(alice)).toEqual([]);
    expect(await idsOf(bob)).toEqual([shared]);
  });
});

describe("reorderChatPins", () => {
  test("applies the new order", async () => {
    const me = await seedUser(unique());
    const [a, b, c] = await seedChats(me, 3);
    for (const id of [a, b, c]) await pinOf(me, id);
    // order: c b a
    expect(await reorderChatPins(me, [a, c, b])).toEqual({ status: "ok", changed: true });
    expect((await listChatPins(me)).map((r) => [r.chat_id, Number(r.position)])).toEqual([
      [a, 0],
      [c, 1],
      [b, 2],
    ]);
  });

  test("the same order is accepted and changes nothing", async () => {
    const me = await seedUser(unique());
    const [a, b] = await seedChats(me, 2);
    await pinOf(me, a);
    await pinOf(me, b);
    expect(await reorderChatPins(me, [b, a])).toEqual({ status: "ok", changed: false });
  });

  test("an empty list is fine for a person with no pins", async () => {
    const me = await seedUser(unique());
    expect(await reorderChatPins(me, [])).toEqual({ status: "ok", changed: false });
  });

  test.each([
    ["a pinned chat is missing", (p) => [p.a]],
    ["a chat that is not pinned is added", (p) => [p.a, p.b, p.c]],
    ["a chat is listed twice", (p) => [p.a, p.a]],
    ["a chat of somebody else is listed", (p) => [p.a, p.foreign]],
    ["a chat that does not exist is listed", (p) => [p.a, crypto.randomUUID()]],
    ["the list is empty", () => []],
  ])("refuses the order when %s and changes nothing", async (_name, build) => {
    const tag = unique();
    const me = await seedUser(tag, 0);
    const other = await seedUser(tag, 1);
    const [a, b, c] = await seedChats(me, 3);
    const foreign = await seedChat([other]);
    await pinOf(me, a);
    await pinOf(me, b);
    const before = await listChatPins(me);

    expect(await reorderChatPins(me, build({ a, b, c, foreign }))).toEqual({
      status: "mismatch",
      changed: false,
    });
    expect(await listChatPins(me)).toEqual(before);
  });

  test("a person cannot reorder with another person's set", async () => {
    const tag = unique();
    const alice = await seedUser(tag, 0);
    const bob = await seedUser(tag, 1);
    const [a] = await seedChats(alice, 1);
    const [b] = await seedChats(bob, 1);
    await pinOf(alice, a);
    await pinOf(bob, b);
    expect((await reorderChatPins(alice, [b])).status).toBe("mismatch");
    expect(await idsOf(bob)).toEqual([b]);
    expect(await idsOf(alice)).toEqual([a]);
  });

  test("another person's order is untouched", async () => {
    const tag = unique();
    const alice = await seedUser(tag, 0);
    const bob = await seedUser(tag, 1);
    const [a, b] = await seedChats(alice, 2, bob);
    for (const id of [a, b]) {
      await pinOf(alice, id);
      await pinOf(bob, id);
    }
    // both: b a
    await reorderChatPins(alice, [a, b]);
    expect(await idsOf(alice)).toEqual([a, b]);
    expect(await idsOf(bob)).toEqual([b, a]);
  });
});

describe("listChatsForUser", () => {
  test("pinned chats come first by position, then the usual order (latest message first)", async () => {
    const tag = unique();
    const me = await seedUser(tag);
    const [old, mid, recent, newest] = await seedChats(me, 4);
    await postAt(old, me, "2030-01-01 10:00:00");
    await postAt(mid, me, "2030-01-02 10:00:00");
    await postAt(recent, me, "2030-01-03 10:00:00");
    await postAt(newest, me, "2030-01-04 10:00:00");

    expect(await listedIds(me)).toEqual([newest, recent, mid, old]);

    await pinOf(me, old);
    await pinOf(me, mid);
    // pinned: mid (0), old (1); the rest by latest message.
    expect(await listedIds(me)).toEqual([mid, old, newest, recent]);

    await reorderChatPins(me, [old, mid]);
    expect(await listedIds(me)).toEqual([old, mid, newest, recent]);
  });

  test("a message in a pinned chat does not move it above a higher pin", async () => {
    const me = await seedUser(unique());
    const [a, b] = await seedChats(me, 2);
    await pinOf(me, a);
    await pinOf(me, b);
    await postAt(a, me, "2031-05-05 10:00:00");
    expect(await listedIds(me)).toEqual([b, a]);
  });

  test("every chat says whether it is pinned and where; the others say null", async () => {
    const me = await seedUser(unique());
    const [a, b, c] = await seedChats(me, 3);
    await pinOf(me, a);
    await pinOf(me, b);
    const byId = new Map((await listChatsForUser(me)).map((chat) => [chat.id, chat]));
    expect(Number(byId.get(b).pin_position)).toBe(0);
    expect(Number(byId.get(a).pin_position)).toBe(1);
    expect(byId.get(c).pin_position).toBeNull();
  });

  test("one person's pins never change another person's list", async () => {
    const tag = unique();
    const alice = await seedUser(tag, 0);
    const bob = await seedUser(tag, 1);
    const [a, b, c] = await seedChats(alice, 3, bob);
    await postAt(a, alice, "2032-01-01 10:00:00");
    await postAt(b, alice, "2032-01-02 10:00:00");
    await postAt(c, alice, "2032-01-03 10:00:00");
    const bobBefore = await listedIds(bob);
    const aliceBefore = await listedIds(alice);
    expect(bobBefore).toEqual([c, b, a]);

    await pinOf(alice, a);

    expect(await listedIds(alice)).toEqual([a, c, b]);
    expect(await listedIds(bob)).toEqual(bobBefore);
    expect(aliceBefore).toEqual([c, b, a]);
    const bobsView = new Map((await listChatsForUser(bob)).map((chat) => [chat.id, chat]));
    expect(bobsView.get(a).pin_position).toBeNull();
  });

  test("a chat appears once even when two people pinned it", async () => {
    const tag = unique();
    const alice = await seedUser(tag, 0);
    const bob = await seedUser(tag, 1);
    const [a] = await seedChats(alice, 1, bob);
    await pinOf(alice, a);
    await pinOf(bob, a);
    expect(await listedIds(alice)).toEqual([a]);
    expect(await listedIds(bob)).toEqual([a]);
  });

  test("a hidden chat is not listed, and a stale pin on it changes nothing", async () => {
    const me = await seedUser(unique());
    const [a, b] = await seedChats(me, 2);
    await pinOf(me, a);
    await run(dbKnex("hidden_chats").insert({ user_id: me, chat_id: a }));
    expect(await listedIds(me)).toEqual([b]);
  });

  test("the saved-messages chat can be pinned like any other and sorts with the pins", async () => {
    const me = await seedUser(unique());
    const [a] = await seedChats(me, 1);
    await postAt(a, me, "2033-01-01 10:00:00");
    const saved = await ensureSavedChatForUser(me);
    expect(await pinOf(me, saved.id)).toEqual({ status: "pinned", position: 0 });
    const list = await listChatsForUser(me);
    expect(list[0].id).toBe(saved.id);
    expect(list[0].type).toBe("saved");
    expect(Number(list[0].pin_position)).toBe(0);
    expect(list.map((chat) => chat.id)).toContain(a);
  });

  test("unread counts and the last message are the same pinned or not", async () => {
    const tag = unique();
    const me = await seedUser(tag, 0);
    const friend = await seedUser(tag, 1);
    const [a] = await seedChats(me, 1, friend);
    const messageId = await postAt(a, friend, "2034-01-01 10:00:00");
    const before = (await listChatsForUser(me)).find((chat) => chat.id === a);
    await pinOf(me, a);
    const after = (await listChatsForUser(me)).find((chat) => chat.id === a);
    expect(Number(after.unread_count)).toBe(1);
    expect(after.unread_count).toEqual(before.unread_count);
    expect(after.last_message_id).toBe(messageId);
    expect(after.last_time).toBe(before.last_time);
  });
});

describe("cleanup", () => {
  test("leaving or being removed from a chat clears the person's pin only", async () => {
    const tag = unique();
    const alice = await seedUser(tag, 0);
    const bob = await seedUser(tag, 1);
    const [a, b] = await seedChats(alice, 2, bob);
    await pinOf(alice, a);
    await pinOf(alice, b);
    await pinOf(bob, a);

    await removeChatMember(a, alice);
    expect(await idsOf(alice)).toEqual([b]);
    // No row is left behind, not just hidden from the view.
    expect(await rawRows({ user_id: alice, chat_id: a })).toEqual([]);
    expect(await idsOf(bob)).toEqual([a]);
  });

  test("a chat that comes back after hiding is not pinned any more", async () => {
    const me = await seedUser(unique());
    const [a, b] = await seedChats(me, 2);
    await pinOf(me, a);
    await pinOf(me, b);

    await hideChatsForUser(me, [a]);
    expect(await rawRows({ user_id: me, chat_id: a })).toEqual([]);
    expect(await idsOf(me)).toEqual([b]);
    await unhideChat(me, a);
    expect(await idsOf(me)).toEqual([b]);
    const view = (await listChatsForUser(me)).find((chat) => chat.id === a);
    expect(view.pin_position).toBeNull();
  });

  test("hiding several chats at once clears all of their pins", async () => {
    const me = await seedUser(unique());
    const [a, b, c] = await seedChats(me, 3);
    for (const id of [a, b, c]) await pinOf(me, id);
    await hideChatsForUser(me, [a, c]);
    expect(await idsOf(me)).toEqual([b]);
  });

  test("hiding does not touch other people's pins of the same chat", async () => {
    const tag = unique();
    const alice = await seedUser(tag, 0);
    const bob = await seedUser(tag, 1);
    const [a] = await seedChats(alice, 1, bob);
    await pinOf(alice, a);
    await pinOf(bob, a);
    await hideChatsForUser(alice, [a]);
    expect(await idsOf(bob)).toEqual([a]);
  });

  test("deleting a chat removes everybody's pin of it", async () => {
    const tag = unique();
    const alice = await seedUser(tag, 0);
    const bob = await seedUser(tag, 1);
    const [a, b] = await seedChats(alice, 2, bob);
    await pinOf(alice, a);
    await pinOf(bob, a);
    await pinOf(alice, b);

    await deleteChatById(a);
    expect(await rawRows({ chat_id: a })).toEqual([]);
    expect(await idsOf(alice)).toEqual([b]);
    expect(await idsOf(bob)).toEqual([]);
  });

  test("deleting an account removes its pins and leaves everybody else's", async () => {
    const tag = unique();
    const alice = await seedUser(tag, 0);
    const bob = await seedUser(tag, 1);
    const [a] = await seedChats(alice, 1, bob);
    await pinOf(alice, a);
    await pinOf(bob, a);

    await deleteUserById(bob);
    expect(await rawRows({ user_id: bob })).toEqual([]);
    expect(await idsOf(alice)).toEqual([a]);
  });

  test("deleting the account of a chat's only member removes the chat and its pin", async () => {
    const me = await seedUser(unique());
    const [a] = await seedChats(me, 1);
    await pinOf(me, a);
    await deleteUserById(me);
    expect(await rawRows({ chat_id: a })).toEqual([]);
  });
});

describe("listChatPinHolders / listChatPinsForUsers", () => {
  test("the holders of a chat are the people who pinned it", async () => {
    const tag = unique();
    const alice = await seedUser(tag, 0);
    const bob = await seedUser(tag, 1);
    const carol = await seedUser(tag, 2);
    const [a, b] = [await seedChat([alice, bob, carol]), await seedChat([alice, bob, carol])];
    await pinOf(alice, a);
    await pinOf(carol, a);
    await pinOf(bob, b);

    const holders = await listChatPinHolders(a);
    expect(holders.map((h) => h.user_id).sort()).toEqual([alice, carol].sort());
    expect(holders.find((h) => h.user_id === alice).username).toBe(`cp_${tag}_0`);
    expect(await listChatPinHolders(crypto.randomUUID())).toEqual([]);
    expect(await listChatPinHolders(null)).toEqual([]);
  });

  test("the pins of several people in one query", async () => {
    const tag = unique();
    const alice = await seedUser(tag, 0);
    const bob = await seedUser(tag, 1);
    const [a, b] = await seedChats(alice, 2, bob);
    await pinOf(alice, a);
    await pinOf(alice, b);
    await pinOf(bob, a);

    const rows = await listChatPinsForUsers([alice, bob]);
    expect(rows.filter((r) => r.user_id === alice).map((r) => r.chat_id)).toEqual([b, a]);
    expect(rows.filter((r) => r.user_id === bob).map((r) => r.chat_id)).toEqual([a]);
    expect(await listChatPinsForUsers([])).toEqual([]);
    expect(await listChatPinsForUsers(null)).toEqual([]);
  });
});
