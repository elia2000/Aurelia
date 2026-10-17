import { describe, test, expect, vi, afterAll } from "vitest";
import crypto from "node:crypto";

// A database of its own: the other test files share one on-disk SQLite file,
// and writers in different workers can make each other wait ("database is
// locked"). (Runs before any import.)
vi.hoisted(() => {
  const fs = process.getBuiltinModule("node:fs");
  const os = process.getBuiltinModule("node:os");
  const path = process.getBuiltinModule("node:path");
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "call-messages-"));
});

const { dbKnex } = await import("../../db/knex.js");
const db = await import("../../db.js");
const {
  addChatMember,
  createChat,
  createMessage,
  createUser,
  deleteChatById,
  findMessageById,
  getAll,
  getFirstUnreadMessage,
  getMessageReadByUser,
  getMessages,
  getTotalUnreadCount,
  hideMessageForUser,
  listChatsForUser,
  markMessagesRead,
  run,
} = db;

const unique = () => crypto.randomBytes(5).toString("hex");

afterAll(() => {
  try {
    process
      .getBuiltinModule("node:fs")
      .rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

// Every test works in its own users and chat so the shared test database never
// makes tests depend on each other.
async function seedDm() {
  const tag = unique();
  const caller = await createUser(`cm_${tag}_a`, "hash", "Caller", null, "#10b981");
  const callee = await createUser(`cm_${tag}_b`, "hash", "Callee", null, "#3b82f6");
  const chatId = await createChat(`cm dm ${tag}`, "dm", { createdByUserId: caller });
  await addChatMember(chatId, caller, "member");
  await addChatMember(chatId, callee, "member");
  return { tag, caller, callee, chatId };
}

const newCall = (seed, overrides = {}) => ({
  chatId: seed.chatId,
  callerId: seed.caller,
  calleeId: seed.callee,
  callId: crypto.randomUUID(),
  kind: "audio",
  outcome: "completed",
  durationSec: 42,
  expiresAt: null,
  markReadBy: seed.callee,
  ...overrides,
});

const rawRow = async (id) =>
  (await getAll(dbKnex("chat_messages").select("*").where({ id })))[0];

const chatRow = async (userId, chatId) =>
  (await listChatsForUser(userId)).find((chat) => chat.id === chatId);

describe("createCallMessage", () => {
  test("writes one entry from the caller with empty text and the call columns", async () => {
    const seed = await seedDm();
    const args = newCall(seed, { kind: "video", outcome: "completed", durationSec: 83 });
    const result = await db.createCallMessage(args);

    expect(result.created).toBe(true);
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    const row = await rawRow(result.id);
    expect(row).toMatchObject({
      chat_id: seed.chatId,
      user_id: seed.caller,
      body: "",
      created_at: result.createdAt,
      call_id: args.callId,
      call_kind: "video",
      call_outcome: "completed",
      call_duration_sec: 83,
      expires_at: null,
      edited: 0,
      hidden_everyone_at: null,
      reply_to_message_id: null,
      client_request_id: null,
      e2ee_envelope: null,
    });
  });

  test("the same call id never makes a second entry", async () => {
    const seed = await seedDm();
    const args = newCall(seed);
    const first = await db.createCallMessage(args);
    const second = await db.createCallMessage({ ...args, outcome: "failed", durationSec: null });
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
    const rows = await getAll(dbKnex("chat_messages").select("id", "call_outcome").where({ call_id: args.callId }));
    expect(rows).toHaveLength(1);
    // The first answer stands.
    expect(rows[0].call_outcome).toBe("completed");
  });

  test("many requests at the same moment still make one entry, and only one says it created it", async () => {
    const seed = await seedDm();
    const args = newCall(seed, { outcome: "missed", durationSec: null, markReadBy: null });
    const results = await Promise.all(Array.from({ length: 8 }, () => db.createCallMessage(args)));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    const rows = await getAll(dbKnex("chat_messages").count({ n: "*" }).where({ call_id: args.callId }));
    expect(Number(rows[0].n)).toBe(1);
  });

  test("a duplicate leaves the read marks of the first entry alone", async () => {
    const seed = await seedDm();
    const args = newCall(seed, { outcome: "missed", durationSec: null, markReadBy: null });
    const first = await db.createCallMessage(args);
    await db.createCallMessage({ ...args, markReadBy: seed.callee });
    expect(await getMessageReadByUser([first.id], seed.callee)).toEqual([]);
  });

  test("an entry stores its expiry", async () => {
    const seed = await seedDm();
    const expiresAt = "2030-01-01T00:00:00.000Z";
    const { id } = await db.createCallMessage(newCall(seed, { expiresAt }));
    expect((await rawRow(id)).expires_at).toBe(expiresAt);
  });

  describe("who has read it", () => {
    test("a completed call is read by the callee from the start", async () => {
      const seed = await seedDm();
      const { id } = await db.createCallMessage(newCall(seed));
      const row = await rawRow(id);
      expect(row.read_by_user_id).toBe(seed.callee);
      expect(row.read_at).toBeTruthy();
      expect((await getMessageReadByUser([id], seed.callee)).map((r) => r.message_id)).toEqual([id]);
    });

    test("a missed call is not read by anybody", async () => {
      const seed = await seedDm();
      const { id } = await db.createCallMessage(
        newCall(seed, { outcome: "missed", durationSec: null, markReadBy: null }),
      );
      const row = await rawRow(id);
      expect(row.read_by_user_id).toBeNull();
      expect(row.read_at).toBeNull();
      expect(await getMessageReadByUser([id], seed.callee)).toEqual([]);
    });

    test("the entry is never marked read for the person who made the call", async () => {
      const seed = await seedDm();
      const { id } = await db.createCallMessage(newCall(seed));
      expect(await getMessageReadByUser([id], seed.caller)).toEqual([]);
    });
  });
});

describe("unread counts", () => {
  test.each(["completed", "declined", "cancelled", "busy", "failed"])(
    "a %s call is not unread for anybody",
    async (outcome) => {
      const seed = await seedDm();
      const { id } = await db.createCallMessage(
        newCall(seed, { outcome, durationSec: outcome === "completed" ? 5 : null }),
      );
      expect((await chatRow(seed.callee, seed.chatId)).unread_count).toBe(0);
      expect((await chatRow(seed.caller, seed.chatId)).unread_count).toBe(0);
      expect(await getTotalUnreadCount(seed.callee)).toBe(0);
      expect(await getTotalUnreadCount(seed.caller)).toBe(0);
      expect(await getFirstUnreadMessage(seed.chatId, seed.callee)).toBeNull();
      expect(id).toBeTruthy();
    },
  );

  test("a missed call is unread for the callee only", async () => {
    const seed = await seedDm();
    const { id } = await db.createCallMessage(
      newCall(seed, { outcome: "missed", durationSec: null, markReadBy: null }),
    );
    expect(Number((await chatRow(seed.callee, seed.chatId)).unread_count)).toBe(1);
    expect(Number((await chatRow(seed.caller, seed.chatId)).unread_count)).toBe(0);
    expect(Number(await getTotalUnreadCount(seed.callee))).toBe(1);
    expect(Number(await getTotalUnreadCount(seed.caller))).toBe(0);
    expect((await getFirstUnreadMessage(seed.chatId, seed.callee)).id).toBe(id);
    expect(await getFirstUnreadMessage(seed.chatId, seed.caller)).toBeNull();
  });

  test("opening the chat reads the missed call", async () => {
    const seed = await seedDm();
    const { id } = await db.createCallMessage(
      newCall(seed, { outcome: "missed", durationSec: null, markReadBy: null }),
    );
    await markMessagesRead(seed.chatId, seed.callee);
    expect(Number((await chatRow(seed.callee, seed.chatId)).unread_count)).toBe(0);
    expect(Number(await getTotalUnreadCount(seed.callee))).toBe(0);
    expect(await getFirstUnreadMessage(seed.chatId, seed.callee)).toBeNull();
    expect((await getMessageReadByUser([id], seed.callee)).length).toBe(1);
    expect((await rawRow(id)).read_by_user_id).toBe(seed.callee);
  });

  test("missed calls add up with text messages", async () => {
    const seed = await seedDm();
    await createMessage(seed.chatId, seed.caller, "are you there?");
    await db.createCallMessage(newCall(seed, { outcome: "missed", durationSec: null, markReadBy: null }));
    await db.createCallMessage(newCall(seed, { outcome: "missed", durationSec: null, markReadBy: null }));
    await db.createCallMessage(newCall(seed, { outcome: "completed" }));
    expect(Number((await chatRow(seed.callee, seed.chatId)).unread_count)).toBe(3);
  });

  test("a missed call that the callee hid for themselves is not unread", async () => {
    const seed = await seedDm();
    const { id } = await db.createCallMessage(
      newCall(seed, { outcome: "missed", durationSec: null, markReadBy: null }),
    );
    await hideMessageForUser(id, seed.callee);
    expect(Number((await chatRow(seed.callee, seed.chatId)).unread_count)).toBe(0);
    expect(Number(await getTotalUnreadCount(seed.callee))).toBe(0);
    expect(await getFirstUnreadMessage(seed.chatId, seed.callee)).toBeNull();
  });
});

describe("the chat list", () => {
  test("a call can be the last message, with its structured columns and an empty text", async () => {
    const seed = await seedDm();
    await createMessage(seed.chatId, seed.caller, "earlier");
    // created_at has one-second resolution, so make the call clearly newer.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const call = await db.createCallMessage(newCall(seed, { kind: "video", durationSec: 61 }));
    const forCallee = await chatRow(seed.callee, seed.chatId);
    expect(forCallee).toMatchObject({
      last_message_id: call.id,
      last_message: "",
      last_sender_id: seed.caller,
      last_call_id: expect.any(String),
      last_call_kind: "video",
      last_call_outcome: "completed",
      last_call_duration_sec: 61,
    });
    const forCaller = await chatRow(seed.caller, seed.chatId);
    expect(forCaller.last_call_outcome).toBe("completed");
    expect(forCaller.last_sender_id).toBe(seed.caller);
  });

  test("a text message has no call columns", async () => {
    const seed = await seedDm();
    await createMessage(seed.chatId, seed.caller, "hello");
    const row = await chatRow(seed.callee, seed.chatId);
    expect(row.last_message).toBe("hello");
    expect(row.last_call_id).toBeNull();
    expect(row.last_call_kind).toBeNull();
    expect(row.last_call_outcome).toBeNull();
    expect(row.last_call_duration_sec).toBeNull();
  });

  test("a call that one person hid for themselves is not their last message", async () => {
    const seed = await seedDm();
    await createMessage(seed.chatId, seed.caller, "earlier");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const call = await db.createCallMessage(newCall(seed));
    await hideMessageForUser(call.id, seed.callee);
    expect((await chatRow(seed.callee, seed.chatId)).last_message).toBe("earlier");
    expect((await chatRow(seed.caller, seed.chatId)).last_call_outcome).toBe("completed");
  });

  test("a chat the callee hid is not in their list, but the entry is still written", async () => {
    const seed = await seedDm();
    await db.hideChatsForUser(seed.callee, [seed.chatId]);
    const result = await db.createCallMessage(
      newCall(seed, { outcome: "missed", durationSec: null, markReadBy: null }),
    );
    expect(result.created).toBe(true);
    expect(await chatRow(seed.callee, seed.chatId)).toBeUndefined();
    expect(await chatRow(seed.caller, seed.chatId)).toBeTruthy();
  });
});

describe("reading messages", () => {
  test("a page of messages carries the call columns of each entry", async () => {
    const seed = await seedDm();
    await createMessage(seed.chatId, seed.caller, "text");
    const call = await db.createCallMessage(newCall(seed, { kind: "video", outcome: "completed", durationSec: 7 }));
    const { messages } = await getMessages(seed.chatId, { viewerUserId: seed.callee });
    const entry = messages.find((m) => m.id === call.id);
    expect(entry).toMatchObject({
      body: "",
      user_id: seed.caller,
      call_id: expect.any(String),
      call_kind: "video",
      call_outcome: "completed",
      call_duration_sec: 7,
    });
    const text = messages.find((m) => m.body === "text");
    expect(text.call_id).toBeNull();
  });

  test("findMessageById knows it is a call", async () => {
    const seed = await seedDm();
    const args = newCall(seed);
    const call = await db.createCallMessage(args);
    expect(await findMessageById(call.id)).toMatchObject({
      id: call.id,
      chat_id: seed.chatId,
      user_id: seed.caller,
      body: "",
      call_id: args.callId,
      call_kind: "audio",
      call_outcome: "completed",
      call_duration_sec: 42,
    });
  });

  test("a call hidden for yourself is gone from your timeline only", async () => {
    const seed = await seedDm();
    const call = await db.createCallMessage(newCall(seed));
    await hideMessageForUser(call.id, seed.callee);
    const forCallee = await getMessages(seed.chatId, { viewerUserId: seed.callee });
    const forCaller = await getMessages(seed.chatId, { viewerUserId: seed.caller });
    expect(forCallee.messages.map((m) => m.id)).not.toContain(call.id);
    expect(forCaller.messages.map((m) => m.id)).toContain(call.id);
  });

  test("hiding it again is harmless", async () => {
    const seed = await seedDm();
    const call = await db.createCallMessage(newCall(seed));
    await hideMessageForUser(call.id, seed.caller);
    await hideMessageForUser(call.id, seed.caller);
    const { messages } = await getMessages(seed.chatId, { viewerUserId: seed.caller });
    expect(messages.map((m) => m.id)).not.toContain(call.id);
  });
});

describe("clean-up", () => {
  test("deleting the chat deletes its entries and frees the call ids", async () => {
    const seed = await seedDm();
    const args = newCall(seed);
    await db.createCallMessage(args);
    await deleteChatById(seed.chatId);
    const rows = await getAll(dbKnex("chat_messages").select("id").where({ call_id: args.callId }));
    expect(rows).toEqual([]);
  });

  test("once an entry is deleted its call id can be recorded again", async () => {
    const seed = await seedDm();
    const args = newCall(seed);
    const call = await db.createCallMessage(args);
    await run(dbKnex("chat_message_reads").where({ message_id: call.id }).del());
    await run(dbKnex("chat_messages").where({ id: call.id }).del());
    const again = await db.createCallMessage(args);
    expect(again.created).toBe(true);
  });
});
