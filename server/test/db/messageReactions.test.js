import { describe, test, expect, beforeAll, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import { dbKnex } from "../../db/knex.js";
import {
  addChatMember,
  createChat,
  createMessage,
  createUser,
  deleteChatById,
  deleteUserById,
  getAll,
  hideMessageForUser,
  isMessageHiddenForUser,
  listMessageReactionSummaries,
  listMessageReactionUsers,
  run,
  toggleMessageReaction,
} from "../../db.js";
import { summarizeReactionRows } from "../../lib/reactions.js";

const THUMBS = "\u{1F44D}";
const HEART = "❤️";
const FIRE = "\u{1F525}";
const LAUGH = "\u{1F602}";

const unique = () => crypto.randomBytes(5).toString("hex");

// Every test works in its own users/chat so the shared on-disk test database
// never makes tests depend on each other.
async function seedChat({ type = "group", members = 3 } = {}) {
  const tag = unique();
  const users = [];
  for (let i = 0; i < members; i += 1) {
    const id = await createUser(`rx_${tag}_${i}`, "hash", `Nick ${i}`, null, "#10b981");
    users.push(id);
  }
  const chatId = await createChat(`rx chat ${tag}`, type, { createdByUserId: users[0] });
  for (let i = 0; i < users.length; i += 1) {
    await addChatMember(chatId, users[i], i === 0 ? "owner" : "member");
  }
  const messageId = await createMessage(chatId, users[0], "hello");
  return { tag, users, chatId, messageId };
}

const reactionsOf = async (messageId, viewerId) => {
  const rows = await listMessageReactionSummaries([messageId], viewerId);
  return summarizeReactionRows(rows).get(messageId) || [];
};

const rawReactionCount = async (where) => {
  const rows = await getAll(dbKnex("message_reactions").count({ n: "*" }).where(where));
  return Number(rows[0].n);
};

describe("toggleMessageReaction", () => {
  test("adds a first reaction", async () => {
    const { users, messageId } = await seedChat();
    const result = await toggleMessageReaction({
      messageId,
      userId: users[1],
      emoji: THUMBS,
      maxPerUser: 1,
    });
    expect(result).toEqual({ added: THUMBS, removed: [] });
    expect(await reactionsOf(messageId, users[1])).toEqual([
      { emoji: THUMBS, count: 1, reacted: true },
    ]);
  });

  test("with a limit of 1 a different emoji replaces the previous one", async () => {
    const { users, messageId } = await seedChat();
    await toggleMessageReaction({ messageId, userId: users[1], emoji: THUMBS, maxPerUser: 1 });
    const result = await toggleMessageReaction({
      messageId,
      userId: users[1],
      emoji: HEART,
      maxPerUser: 1,
    });
    expect(result).toEqual({ added: HEART, removed: [THUMBS] });
    expect(await reactionsOf(messageId, users[1])).toEqual([
      { emoji: HEART, count: 1, reacted: true },
    ]);
  });

  test("sending the same emoji again removes it", async () => {
    const { users, messageId } = await seedChat();
    await toggleMessageReaction({ messageId, userId: users[1], emoji: THUMBS, maxPerUser: 1 });
    const result = await toggleMessageReaction({
      messageId,
      userId: users[1],
      emoji: THUMBS,
      maxPerUser: 1,
    });
    expect(result).toEqual({ added: null, removed: [THUMBS] });
    expect(await reactionsOf(messageId, users[1])).toEqual([]);
  });

  test("null removes everything the person has, and nothing of anybody else's", async () => {
    const { users, messageId } = await seedChat();
    await toggleMessageReaction({ messageId, userId: users[1], emoji: THUMBS, maxPerUser: 3 });
    await toggleMessageReaction({ messageId, userId: users[1], emoji: HEART, maxPerUser: 3 });
    await toggleMessageReaction({ messageId, userId: users[2], emoji: THUMBS, maxPerUser: 3 });
    const result = await toggleMessageReaction({
      messageId,
      userId: users[1],
      emoji: null,
      maxPerUser: 3,
    });
    expect([...result.removed].sort()).toEqual([HEART, THUMBS].sort());
    expect(result.added).toBeNull();
    expect(await reactionsOf(messageId, users[2])).toEqual([
      { emoji: THUMBS, count: 1, reacted: true },
    ]);
  });

  test("removing when there is nothing to remove changes nothing", async () => {
    const { users, messageId } = await seedChat();
    const result = await toggleMessageReaction({
      messageId,
      userId: users[1],
      emoji: null,
      maxPerUser: 1,
    });
    expect(result).toEqual({ added: null, removed: [] });
  });

  test("with a limit of 2 the oldest reaction is pushed out by the third", async () => {
    const { users, messageId } = await seedChat();
    const args = { messageId, userId: users[1], maxPerUser: 2 };
    await toggleMessageReaction({ ...args, emoji: THUMBS });
    await toggleMessageReaction({ ...args, emoji: HEART });
    const third = await toggleMessageReaction({ ...args, emoji: FIRE });
    expect(third).toEqual({ added: FIRE, removed: [THUMBS] });
    const mine = (await reactionsOf(messageId, users[1])).map((r) => r.emoji).sort();
    expect(mine).toEqual([FIRE, HEART].sort());
  });

  test("reactions made within the same millisecond keep their order", async () => {
    const { users, messageId } = await seedChat();
    const frozen = Date.now() + 60_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(frozen);
    try {
      const args = { messageId, userId: users[1], maxPerUser: 2 };
      await toggleMessageReaction({ ...args, emoji: THUMBS });
      await toggleMessageReaction({ ...args, emoji: HEART });
      const third = await toggleMessageReaction({ ...args, emoji: FIRE });
      // The thumb was first even though the heart sorts before it by code point.
      expect(third).toEqual({ added: FIRE, removed: [THUMBS] });
    } finally {
      now.mockRestore();
    }
  });

  test("lowering the limit trims the person's reactions down on their next reaction", async () => {
    const { users, messageId } = await seedChat();
    const base = { messageId, userId: users[1] };
    await toggleMessageReaction({ ...base, emoji: THUMBS, maxPerUser: 3 });
    await toggleMessageReaction({ ...base, emoji: HEART, maxPerUser: 3 });
    await toggleMessageReaction({ ...base, emoji: FIRE, maxPerUser: 3 });
    const result = await toggleMessageReaction({ ...base, emoji: LAUGH, maxPerUser: 1 });
    expect(result.added).toBe(LAUGH);
    expect([...result.removed].sort()).toEqual([FIRE, HEART, THUMBS].sort());
    expect(await reactionsOf(messageId, users[1])).toEqual([
      { emoji: LAUGH, count: 1, reacted: true },
    ]);
  });

  test("a reaction to a message that no longer exists is refused and leaves nothing behind", async () => {
    const { users } = await seedChat();
    await expect(
      Promise.resolve().then(() =>
        toggleMessageReaction({
          messageId: crypto.randomUUID(),
          userId: users[1],
          emoji: THUMBS,
          maxPerUser: 1,
        }),
      ),
    ).rejects.toThrow();
    expect(await rawReactionCount({ user_id: users[1] })).toBe(0);
  });
});

describe("listMessageReactionSummaries", () => {
  test("returns nothing without ids and does not query", async () => {
    expect(await listMessageReactionSummaries([], "u")).toEqual([]);
    expect(await listMessageReactionSummaries(null, "u")).toEqual([]);
  });

  test("summarises a whole page of messages with the viewer's own flag", async () => {
    const { users, chatId, messageId } = await seedChat();
    const second = await createMessage(chatId, users[0], "second");
    const third = await createMessage(chatId, users[0], "third (no reactions)");

    await toggleMessageReaction({ messageId, userId: users[0], emoji: THUMBS, maxPerUser: 1 });
    await toggleMessageReaction({ messageId, userId: users[1], emoji: THUMBS, maxPerUser: 1 });
    await toggleMessageReaction({ messageId, userId: users[2], emoji: HEART, maxPerUser: 1 });
    await toggleMessageReaction({ messageId: second, userId: users[2], emoji: FIRE, maxPerUser: 1 });

    const asZero = summarizeReactionRows(
      await listMessageReactionSummaries([messageId, second, third], users[0]),
    );
    expect(asZero.get(messageId)).toEqual([
      { emoji: THUMBS, count: 2, reacted: true },
      { emoji: HEART, count: 1, reacted: false },
    ]);
    expect(asZero.get(second)).toEqual([{ emoji: FIRE, count: 1, reacted: false }]);
    expect(asZero.has(third)).toBe(false);

    const asTwo = summarizeReactionRows(
      await listMessageReactionSummaries([messageId, second], users[2]),
    );
    expect(asTwo.get(messageId)).toEqual([
      { emoji: THUMBS, count: 2, reacted: false },
      { emoji: HEART, count: 1, reacted: true },
    ]);
    expect(asTwo.get(second)).toEqual([{ emoji: FIRE, count: 1, reacted: true }]);
  });

  test("equal counts are ordered by who reacted first", async () => {
    const { users, messageId } = await seedChat();
    await toggleMessageReaction({ messageId, userId: users[0], emoji: FIRE, maxPerUser: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await toggleMessageReaction({ messageId, userId: users[1], emoji: THUMBS, maxPerUser: 1 });
    expect((await reactionsOf(messageId, users[2])).map((r) => r.emoji)).toEqual([FIRE, THUMBS]);
  });

  test("the whole page is read with one statement", async () => {
    const { users, chatId, messageId } = await seedChat();
    const ids = [messageId];
    for (let i = 0; i < 20; i += 1) ids.push(await createMessage(chatId, users[0], `m${i}`));
    await toggleMessageReaction({ messageId, userId: users[1], emoji: THUMBS, maxPerUser: 1 });

    const { default: Database } = await import("better-sqlite3");
    const prepare = vi.spyOn(Database.prototype, "prepare");
    try {
      const rows = await listMessageReactionSummaries(ids, users[1]);
      expect(rows.length).toBe(1);
      const selects = prepare.mock.calls.filter(([sql]) => /message_reactions/i.test(String(sql)));
      expect(selects.length).toBe(1);
    } finally {
      prepare.mockRestore();
    }
  });
});

describe("listMessageReactionUsers", () => {
  test("lists who reacted, oldest first, optionally for one emoji", async () => {
    const { users, messageId } = await seedChat({ members: 3 });
    await toggleMessageReaction({ messageId, userId: users[0], emoji: THUMBS, maxPerUser: 1 });
    await new Promise((resolve) => setTimeout(resolve, 3));
    await toggleMessageReaction({ messageId, userId: users[1], emoji: HEART, maxPerUser: 1 });
    await new Promise((resolve) => setTimeout(resolve, 3));
    await toggleMessageReaction({ messageId, userId: users[2], emoji: THUMBS, maxPerUser: 1 });

    const all = await listMessageReactionUsers(messageId);
    expect(all.map((r) => r.id)).toEqual([users[0], users[1], users[2]]);
    expect(all[0]).toMatchObject({
      emoji: THUMBS,
      nickname: "Nick 0",
      color: "#10b981",
    });
    expect(all[0]).toHaveProperty("username");
    expect(all[0]).toHaveProperty("avatar_url");
    expect(all[0].created_at).toMatch(/^\d{4}-\d\d-\d\dT/);
    // Never anything secret.
    expect(all[0]).not.toHaveProperty("password_hash");

    const onlyThumbs = await listMessageReactionUsers(messageId, { emoji: THUMBS });
    expect(onlyThumbs.map((r) => r.id)).toEqual([users[0], users[2]]);
  });

  test("is capped", async () => {
    const { users, messageId } = await seedChat({ members: 3 });
    for (const userId of users) {
      await toggleMessageReaction({ messageId, userId, emoji: THUMBS, maxPerUser: 1 });
    }
    expect((await listMessageReactionUsers(messageId, { limit: 2 })).length).toBe(2);
    expect((await listMessageReactionUsers(messageId, { limit: 100000 })).length).toBe(3);
  });

  test("has nothing for a message without reactions or without an id", async () => {
    const { messageId } = await seedChat();
    expect(await listMessageReactionUsers(messageId)).toEqual([]);
    expect(await listMessageReactionUsers(null)).toEqual([]);
  });
});

describe("isMessageHiddenForUser", () => {
  test("is true only for the person who deleted the message for themselves", async () => {
    const { users, messageId } = await seedChat();
    expect(await isMessageHiddenForUser(messageId, users[1])).toBe(false);
    await hideMessageForUser(messageId, users[1]);
    expect(await isMessageHiddenForUser(messageId, users[1])).toBe(true);
    expect(await isMessageHiddenForUser(messageId, users[2])).toBe(false);
    expect(await isMessageHiddenForUser(null, users[1])).toBe(false);
  });
});

describe("cleanup", () => {
  test("deleting a chat removes the reactions on its messages", async () => {
    const { users, chatId, messageId } = await seedChat();
    const other = await seedChat();
    await toggleMessageReaction({ messageId, userId: users[1], emoji: THUMBS, maxPerUser: 1 });
    await toggleMessageReaction({
      messageId: other.messageId,
      userId: other.users[1],
      emoji: THUMBS,
      maxPerUser: 1,
    });

    await deleteChatById(chatId);

    expect(await rawReactionCount({ message_id: messageId })).toBe(0);
    expect(await rawReactionCount({ message_id: other.messageId })).toBe(1);
  });

  test("deleting an account removes that person's reactions everywhere but keeps everybody else's", async () => {
    const { users, messageId } = await seedChat();
    await toggleMessageReaction({ messageId, userId: users[1], emoji: THUMBS, maxPerUser: 1 });
    await toggleMessageReaction({ messageId, userId: users[2], emoji: THUMBS, maxPerUser: 1 });

    await deleteUserById(users[1]);

    expect(await rawReactionCount({ user_id: users[1] })).toBe(0);
    expect(await reactionsOf(messageId, users[2])).toEqual([
      { emoji: THUMBS, count: 1, reacted: true },
    ]);
  });

  test("deleting a message row (retention, admin tools) takes its reactions with it", async () => {
    const { users, messageId } = await seedChat();
    await toggleMessageReaction({ messageId, userId: users[1], emoji: THUMBS, maxPerUser: 1 });
    await run(dbKnex("chat_messages").where("id", messageId).del());
    expect(await rawReactionCount({ message_id: messageId })).toBe(0);
  });
});

describe("toggleMessageReaction on PostgreSQL", () => {
  let originalDbClient;
  beforeAll(() => {
    originalDbClient = process.env.DB_CLIENT;
  });
  afterEach(() => {
    if (originalDbClient === undefined) delete process.env.DB_CLIENT;
    else process.env.DB_CLIENT = originalDbClient;
    vi.restoreAllMocks();
  });

  const fakeTransaction = (existingEmoji = []) => {
    const calls = [];
    vi.spyOn(dbKnex, "transaction").mockImplementation(async (callback) => {
      const trx = (table) => {
        const state = { table, op: "select" };
        const builder = {
          select: () => builder,
          where: () => builder,
          whereIn: (_col, values) => {
            state.values = values;
            return builder;
          },
          orderBy: () => builder,
          del: () => {
            calls.push({ op: "del", table, values: state.values });
            return Promise.resolve(1);
          },
          insert: (row) => {
            calls.push({ op: "insert", table, row });
            return Promise.resolve([1]);
          },
          then: (resolve, reject) =>
            Promise.resolve(existingEmoji.map((emoji) => ({ emoji }))).then(resolve, reject),
        };
        return builder;
      };
      trx.raw = async (sql, bindings) => {
        calls.push({ op: "raw", sql, bindings });
        return { rows: [] };
      };
      return callback(trx);
    });
    return calls;
  };

  test("runs in one transaction, takes a per-person advisory lock first and returns a promise", async () => {
    process.env.DB_CLIENT = "postgres";
    const calls = fakeTransaction([THUMBS]);

    const pending = toggleMessageReaction({
      messageId: "m-1",
      userId: "u-1",
      emoji: HEART,
      maxPerUser: 1,
    });
    expect(typeof pending?.then).toBe("function");
    expect(await pending).toEqual({ added: HEART, removed: [THUMBS] });

    expect(calls[0].op).toBe("raw");
    expect(calls[0].sql).toMatch(/pg_advisory_xact_lock/);
    expect(calls[0].bindings[0]).toContain("m-1");
    expect(calls[0].bindings[0]).toContain("u-1");
    expect(calls.find((c) => c.op === "del")).toMatchObject({
      table: "message_reactions",
      values: [THUMBS],
    });
    expect(calls.find((c) => c.op === "insert")).toMatchObject({
      table: "message_reactions",
      row: { message_id: "m-1", user_id: "u-1", emoji: HEART },
    });
  });

  test("the same emoji again only deletes", async () => {
    process.env.DB_CLIENT = "postgres";
    const calls = fakeTransaction([THUMBS]);
    const result = await toggleMessageReaction({
      messageId: "m-1",
      userId: "u-1",
      emoji: THUMBS,
      maxPerUser: 1,
    });
    expect(result).toEqual({ added: null, removed: [THUMBS] });
    expect(calls.some((c) => c.op === "insert")).toBe(false);
  });
});
