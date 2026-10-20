import { describe, test, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import crypto from "node:crypto";

// A database of its own (runs before any import): the point of this file is
// what happens when ANOTHER connection writes in the middle of an operation,
// and that must be this file's doing alone.
vi.hoisted(() => {
  const fs = process.getBuiltinModule("node:fs");
  const os = process.getBuiltinModule("node:os");
  const path = process.getBuiltinModule("node:path");
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-write-lock-"));
});

const { default: Database } = await import("better-sqlite3");
const db = await import("../../db.js");
const {
  addChatMember,
  createChat,
  createMessage,
  createUser,
  getAll,
  insertSavedGif,
  pinChat,
  pinMessage,
  removeChatPins,
  reorderChatPins,
  toggleMessageReaction,
} = db;
const { dbKnex } = await import("../../db/knex.js");
const { buildSavedGifKey } = await import("../../lib/savedGifs.js");

const path = process.getBuiltinModule("node:path");
const dbFile = path.join(path.resolve(process.env.DATA_DIR), "songbird.db");
const unique = () => crypto.randomBytes(5).toString("hex");

/*
 * Two people writing at once. SQLite lets a transaction that has only read so
 * far become a writer only if nobody else committed since it first read;
 * otherwise the upgrade fails at once with SQLITE_BUSY_SNAPSHOT, and the busy
 * timeout does not help. So an operation that reads first and writes second
 * has to take the write lock before it reads.
 *
 * The test forces the unlucky moment: right after the first SELECT of the
 * operation, a second connection tries to commit a write (and gives up at
 * once if the database is locked). If the operation had only a read snapshot
 * by then, the other connection wins and the operation fails; if it already
 * held the write lock, the other connection is turned away and the operation
 * goes through.
 */
let rival;
let outcome; // what the other connection's write did at the unlucky moment
let restorePrepare = null;

function interleaveRivalWrite() {
  const original = Database.prototype.prepare;
  let armed = false;
  let fired = false;
  outcome = { fired: false, committed: false, error: null };
  Database.prototype.prepare = function patchedPrepare(sql, ...rest) {
    const statement = original.call(this, sql, ...rest);
    if (this.name !== dbFile) return statement;
    const text = String(sql);
    if (/^\s*(begin|savepoint)\b/i.test(text)) armed = true;
    if (!armed || fired || !/^\s*select\b/i.test(text)) return statement;
    return new Proxy(statement, {
      get(target, property) {
        const value = target[property];
        if (typeof value !== "function") return value;
        return (...args) => {
          const result = value.apply(target, args);
          if (!fired && (property === "all" || property === "get")) {
            fired = true;
            outcome.fired = true;
            try {
              rival.prepare("INSERT INTO lock_probe DEFAULT VALUES").run();
              outcome.committed = true;
            } catch (error) {
              outcome.error = error;
            }
          }
          return result;
        };
      },
    });
  };
  restorePrepare = () => {
    Database.prototype.prepare = original;
    restorePrepare = null;
  };
}

beforeAll(() => {
  // timeout 0: a locked database is reported at once instead of waited for.
  rival = new Database(dbFile, { timeout: 0 });
  rival.exec("CREATE TABLE IF NOT EXISTS lock_probe (id INTEGER PRIMARY KEY)");
});

afterEach(() => {
  restorePrepare?.();
});

afterAll(() => {
  try {
    rival?.close();
    process.getBuiltinModule("node:fs").rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

async function seedChat(members = 2) {
  const tag = unique();
  const users = [];
  for (let i = 0; i < members; i += 1) {
    users.push(await createUser(`lock_${tag}_${i}`, "hash", `Nick ${i}`, null, "#10b981"));
  }
  const chatId = await createChat(`lock chat ${tag}`, "group", { createdByUserId: users[0] });
  for (let i = 0; i < users.length; i += 1) {
    await addChatMember(chatId, users[i], i === 0 ? "owner" : "member");
  }
  const messageId = await createMessage(chatId, users[0], "hello");
  return { users, chatId, messageId };
}

async function seedPinnedChats(count = 2) {
  const { users } = await seedChat(1);
  const chats = [];
  for (let i = 0; i < count; i += 1) {
    const chatId = await createChat(`lock pin ${unique()}`, "group", { createdByUserId: users[0] });
    await addChatMember(chatId, users[0], "owner");
    chats.push(chatId);
  }
  return { me: users[0], chats };
}

const gifArgs = (userId, overrides = {}) => {
  const id = overrides.id ?? crypto.randomUUID();
  return {
    id,
    userId,
    storageKey: buildSavedGifKey(userId, id, "gif"),
    storageDriver: "local",
    mime: "image/gif",
    width: 10,
    height: 10,
    frames: 2,
    sizeBytes: 100,
    sha256: crypto.randomBytes(32).toString("hex"),
    sourceMessageId: null,
    sourceFileId: null,
    limit: 10,
    ...overrides,
  };
};

const operations = [
  [
    "reacting to a message",
    async () => {
      const { users, messageId } = await seedChat();
      return () => toggleMessageReaction({ messageId, userId: users[1], emoji: "\u{1F44D}", maxPerUser: 1 });
    },
    (result) => expect(result.added).toBe("\u{1F44D}"),
  ],
  [
    "pinning a message",
    async () => {
      const { users, chatId, messageId } = await seedChat();
      return () => pinMessage({ chatId, messageId, userId: users[0], max: 20 });
    },
    (result) => expect(result.status).toBe("pinned"),
  ],
  [
    "pinning a chat",
    async () => {
      const { me, chats } = await seedPinnedChats(1);
      return () => pinChat({ userId: me, chatId: chats[0], max: 5 });
    },
    (result) => expect(result.status).toBe("pinned"),
  ],
  [
    "unpinning a chat",
    async () => {
      const { me, chats } = await seedPinnedChats(2);
      for (const chatId of chats) await pinChat({ userId: me, chatId, max: 5 });
      return () => removeChatPins(me, [chats[0]]);
    },
    (result) => expect(result).toBe(1),
  ],
  [
    "reordering pinned chats",
    async () => {
      const { me, chats } = await seedPinnedChats(2);
      for (const chatId of chats) await pinChat({ userId: me, chatId, max: 5 });
      // The newest pin is on top, so reversing the list changes the order.
      return () => reorderChatPins(me, [...chats]);
    },
    (result) => expect(result).toEqual({ status: "ok", changed: true }),
  ],
  [
    "saving a GIF",
    async () => {
      const { users } = await seedChat(1);
      return () => insertSavedGif(gifArgs(users[0]));
    },
    (result) => expect(result.status).toBe("created"),
  ],
];

describe("a write that starts with a read takes the write lock first", () => {
  test.each(operations)("%s survives another connection committing in the middle", async (_name, prepare, check) => {
    const operation = await prepare();
    interleaveRivalWrite();
    const result = await operation();
    restorePrepare();

    expect(outcome.fired).toBe(true);
    // The other connection was turned away (it could not write while this
    // operation held the lock), and the operation itself went through.
    expect(outcome.committed).toBe(false);
    expect(outcome.error?.code).toMatch(/^SQLITE_BUSY/);
    check(result);
  });

  test("the lock is let go again afterwards: the other connection can write", async () => {
    const { users, chatId, messageId } = await seedChat();
    await toggleMessageReaction({ messageId, userId: users[1], emoji: "\u{1F525}", maxPerUser: 1 });
    await pinMessage({ chatId, messageId, userId: users[0], max: 20 });
    await insertSavedGif(gifArgs(users[0]));
    expect(() => rival.prepare("INSERT INTO lock_probe DEFAULT VALUES").run()).not.toThrow();
  });

  test("an operation that fails changes nothing and lets go of the lock", async () => {
    const { users } = await seedChat(1);
    const older = gifArgs(users[0]);
    const newer = gifArgs(users[0]);
    await insertSavedGif(older);
    await insertSavedGif(newer);

    // Same id as the newer GIF, different bytes, and the collection is full
    // (limit 2): the older GIF is evicted first, then the insert hits the
    // primary key. Everything it did has to be undone.
    const clash = gifArgs(users[0], { id: newer.id, limit: 2 });
    await expect(Promise.resolve().then(() => insertSavedGif(clash))).rejects.toThrow(/UNIQUE/);

    const rows = await getAll(
      dbKnex("user_gifs").select("id", "sha256").where("user_id", users[0]).orderBy("created_at", "asc"),
    );
    expect(rows).toEqual([
      { id: older.id, sha256: older.sha256 },
      { id: newer.id, sha256: newer.sha256 },
    ]);
    expect(() => rival.prepare("INSERT INTO lock_probe DEFAULT VALUES").run()).not.toThrow();

    // And the connection is usable: nothing is left half open.
    const next = await insertSavedGif(gifArgs(users[0], { limit: 10 }));
    expect(next.status).toBe("created");
  });

  test("read-only outcomes (already pinned) also finish cleanly", async () => {
    const { users, chatId, messageId } = await seedChat();
    expect((await pinMessage({ chatId, messageId, userId: users[0], max: 20 })).status).toBe("pinned");
    expect((await pinMessage({ chatId, messageId, userId: users[0], max: 20 })).status).toBe("already");
    expect(() => rival.prepare("INSERT INTO lock_probe DEFAULT VALUES").run()).not.toThrow();
  });
});
