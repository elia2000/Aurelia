import { describe, test, expect, beforeAll, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import { dbKnex } from "../../db/knex.js";
import {
  addChatMember,
  adminGetAll,
  adminRun,
  createChat,
  createMessage,
  createMessageFiles,
  createUser,
  deleteChatById,
  deleteUserById,
  findChatById,
  getAll,
  getFirstUnreadMessage,
  hideMessageForEveryone,
  hideMessageForUser,
  listChatsForUser,
  listPinnedMessageIds,
  listPinnedMessages,
  pinMessage,
  run,
  unpinAllMessages,
  unpinMessage,
  updateGroupChat,
} from "../../db.js";
import { removePinsOfMessages } from "../../lib/pinCleanup.js";
import { buildPinServiceBody } from "../../lib/serviceMessages.js";

const unique = () => crypto.randomBytes(5).toString("hex");

// Every test works in its own users/chat so the shared on-disk test database
// never makes tests depend on each other.
async function seedChat({ type = "group", members = 3, messages = 2 } = {}) {
  const tag = unique();
  const users = [];
  for (let i = 0; i < members; i += 1) {
    const id = await createUser(`pin_${tag}_${i}`, "hash", `Nick ${i}`, null, "#10b981");
    users.push(id);
  }
  const chatId = await createChat(`pin chat ${tag}`, type, { createdByUserId: users[0] });
  for (let i = 0; i < users.length; i += 1) {
    await addChatMember(chatId, users[i], i === 0 ? "owner" : "member");
  }
  const messageIds = [];
  for (let i = 0; i < messages; i += 1) {
    messageIds.push(await createMessage(chatId, users[i % users.length], `message ${i}`));
  }
  return { tag, users, chatId, messageIds };
}

const pinOf = (chatId, messageId, userId, max = 20) => pinMessage({ chatId, messageId, userId, max });
const rawPinCount = async (where) =>
  Number((await getAll(dbKnex("chat_pinned_messages").count({ n: "*" }).where(where)))[0].n);

describe("pinMessage", () => {
  test("pins a message and says when", async () => {
    const { users, chatId, messageIds } = await seedChat();
    const result = await pinOf(chatId, messageIds[0], users[1]);
    expect(result.status).toBe("pinned");
    expect(result.pinnedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(await rawPinCount({ chat_id: chatId })).toBe(1);
  });

  test("is idempotent: the pin, its time and its author stay as they were", async () => {
    const { users, chatId, messageIds } = await seedChat();
    const first = await pinOf(chatId, messageIds[0], users[0]);
    const again = await pinOf(chatId, messageIds[0], users[1]);
    expect(again).toEqual({ status: "already", pinnedAt: first.pinnedAt });
    const [row] = await getAll(dbKnex("chat_pinned_messages").where({ chat_id: chatId }));
    expect(row.pinned_by).toBe(users[0]);
    expect(row.pinned_at).toBe(first.pinnedAt);
  });

  test("refuses the pin that would exceed the limit and keeps what is pinned", async () => {
    const { users, chatId, messageIds } = await seedChat({ messages: 3 });
    expect((await pinOf(chatId, messageIds[0], users[0], 2)).status).toBe("pinned");
    expect((await pinOf(chatId, messageIds[1], users[0], 2)).status).toBe("pinned");
    expect(await pinOf(chatId, messageIds[2], users[0], 2)).toEqual({ status: "limit", pinnedAt: null });
    expect(await rawPinCount({ chat_id: chatId })).toBe(2);
    expect(await rawPinCount({ message_id: messageIds[2] })).toBe(0);
  });

  test("a full chat still answers 'already' for a message that is pinned", async () => {
    const { users, chatId, messageIds } = await seedChat();
    await pinOf(chatId, messageIds[0], users[0], 1);
    expect((await pinOf(chatId, messageIds[0], users[0], 1)).status).toBe("already");
  });

  test("the limit is per chat", async () => {
    const a = await seedChat();
    const b = await seedChat();
    await pinOf(a.chatId, a.messageIds[0], a.users[0], 1);
    expect((await pinOf(b.chatId, b.messageIds[0], b.users[0], 1)).status).toBe("pinned");
  });

  test("a nonsense limit is at least 1", async () => {
    const { users, chatId, messageIds } = await seedChat();
    expect((await pinOf(chatId, messageIds[0], users[0], 0)).status).toBe("pinned");
    expect((await pinOf(chatId, messageIds[1], users[0], -4)).status).toBe("limit");
  });

  test("pins made in the same millisecond keep their order", async () => {
    const { users, chatId, messageIds } = await seedChat({ messages: 3 });
    const frozen = Date.now() + 120_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(frozen);
    try {
      for (const id of messageIds) await pinOf(chatId, id, users[0]);
    } finally {
      now.mockRestore();
    }
    const listed = await listPinnedMessages(chatId, users[0]);
    expect(listed.map((r) => r.message_id)).toEqual([...messageIds].reverse());
    const times = listed.map((r) => r.pinned_at);
    expect(new Set(times).size).toBe(3);
  });

  test("a message that does not exist cannot be pinned and leaves nothing behind", async () => {
    const { users, chatId } = await seedChat();
    await expect(
      Promise.resolve().then(() => pinOf(chatId, crypto.randomUUID(), users[0])),
    ).rejects.toThrow();
    expect(await rawPinCount({ chat_id: chatId })).toBe(0);
    // The failed attempt did not poison later work.
    const { messageIds } = await seedChat();
    expect(messageIds.length).toBeGreaterThan(0);
  });
});

describe("unpinMessage / unpinAllMessages", () => {
  test("remove pins and report how many", async () => {
    const { users, chatId, messageIds } = await seedChat();
    await pinOf(chatId, messageIds[0], users[0]);
    await pinOf(chatId, messageIds[1], users[0]);

    expect(await unpinMessage(chatId, messageIds[0])).toBe(1);
    expect(await unpinMessage(chatId, messageIds[0])).toBe(0);
    expect(await unpinAllMessages(chatId)).toBe(1);
    expect(await unpinAllMessages(chatId)).toBe(0);
  });

  test("never touch another chat", async () => {
    const a = await seedChat();
    const b = await seedChat();
    await pinOf(a.chatId, a.messageIds[0], a.users[0]);
    await pinOf(b.chatId, b.messageIds[0], b.users[0]);
    // A message id used with the wrong chat removes nothing.
    expect(await unpinMessage(a.chatId, b.messageIds[0])).toBe(0);
    await unpinAllMessages(a.chatId);
    expect(await rawPinCount({ chat_id: b.chatId })).toBe(1);
  });

  test("nothing to do without ids", async () => {
    expect(await unpinMessage(null, null)).toBe(0);
    expect(await unpinAllMessages(null)).toBe(0);
  });
});

describe("listPinnedMessages", () => {
  test("lists the newest pin first with what the preview needs", async () => {
    const { users, chatId, messageIds } = await seedChat();
    await pinOf(chatId, messageIds[0], users[1]);
    await pinOf(chatId, messageIds[1], users[2]);

    const rows = await listPinnedMessages(chatId, users[0]);
    expect(rows.map((r) => r.message_id)).toEqual([messageIds[1], messageIds[0]]);
    expect(rows[0]).toMatchObject({
      pinned_by: users[2],
      chat_id: chatId,
      sender_id: users[1],
      body: "message 1",
      sender_nickname: "Nick 1",
      file_count: 0,
      first_file_mime: null,
      first_file_kind: null,
      e2ee_envelope: null,
    });
    expect(rows[0].sender_username).toMatch(/^pin_/);
    expect(rows[0].message_created_at).toBeTruthy();
    // Nothing secret about the people involved.
    expect(rows[0]).not.toHaveProperty("password_hash");
  });

  test("tells the first attachment of a message", async () => {
    const { users, chatId } = await seedChat({ messages: 0 });
    const messageId = await createMessage(chatId, users[0], "photos");
    await createMessageFiles(messageId, [
      { kind: "media", originalName: "a.png", storedName: `a-${unique()}.png`, mimeType: "image/png", sizeBytes: 1 },
      { kind: "media", originalName: "b.mp4", storedName: `b-${unique()}.mp4`, mimeType: "video/mp4", sizeBytes: 1 },
    ]);
    await pinOf(chatId, messageId, users[0]);
    const [row] = await listPinnedMessages(chatId, users[1]);
    expect(Number(row.file_count)).toBe(2);
    expect(row.first_file_mime).toBe("image/png");
    expect(row.first_file_kind).toBe("media");
  });

  test("leaves out messages deleted for everyone", async () => {
    const { users, chatId, messageIds } = await seedChat();
    await pinOf(chatId, messageIds[0], users[0]);
    await pinOf(chatId, messageIds[1], users[0]);
    await hideMessageForEveryone(messageIds[0]);
    expect((await listPinnedMessages(chatId, users[1])).map((r) => r.message_id)).toEqual([messageIds[1]]);
  });

  test("leaves out messages the viewer deleted for themselves, and only for them", async () => {
    const { users, chatId, messageIds } = await seedChat();
    await pinOf(chatId, messageIds[0], users[0]);
    await hideMessageForUser(messageIds[0], users[1]);
    expect(await listPinnedMessages(chatId, users[1])).toEqual([]);
    expect(await listPinnedMessages(chatId, users[2])).toHaveLength(1);
  });

  test("shows a message whose sender account is gone", async () => {
    const { users, chatId, messageIds } = await seedChat();
    await pinOf(chatId, messageIds[1], users[0]); // written by users[1]
    await deleteUserById(users[1]);
    const rows = await listPinnedMessages(chatId, users[0]);
    expect(rows).toHaveLength(1);
    expect(rows[0].sender_username ?? null).toBeNull();
  });

  test("is capped at 100 and answers with nothing for no chat", async () => {
    expect(await listPinnedMessages(null, "u")).toEqual([]);
    const { users, chatId, messageIds } = await seedChat();
    await pinOf(chatId, messageIds[0], users[0]);
    expect(await listPinnedMessages(chatId, users[0], { limit: 100000 })).toHaveLength(1);
    expect(await listPinnedMessages(chatId, users[0], { limit: "x" })).toHaveLength(1);
  });

  test("a pin never shows a message of another chat", async () => {
    const a = await seedChat();
    const b = await seedChat();
    // A row that disagrees with its message about the chat (cannot be made through the API).
    await run(
      dbKnex("chat_pinned_messages").insert({
        chat_id: a.chatId,
        message_id: b.messageIds[0],
        pinned_by: a.users[0],
        pinned_at: new Date().toISOString(),
      }),
    );
    expect(await listPinnedMessages(a.chatId, a.users[0])).toEqual([]);
  });

  test("reads the whole list with one statement", async () => {
    const { users, chatId, messageIds } = await seedChat({ messages: 10 });
    for (const id of messageIds) await pinOf(chatId, id, users[0]);
    const { default: Database } = await import("better-sqlite3");
    const prepare = vi.spyOn(Database.prototype, "prepare");
    try {
      const rows = await listPinnedMessages(chatId, users[1]);
      expect(rows).toHaveLength(10);
      const selects = prepare.mock.calls.filter(([sql]) => /chat_pinned_messages/i.test(String(sql)));
      expect(selects).toHaveLength(1);
    } finally {
      prepare.mockRestore();
    }
  });
});

describe("listPinnedMessageIds", () => {
  test("answers for a whole page of messages at once, for this chat only", async () => {
    const a = await seedChat({ messages: 3 });
    const b = await seedChat();
    await pinOf(a.chatId, a.messageIds[0], a.users[0]);
    await pinOf(a.chatId, a.messageIds[2], a.users[0]);
    await pinOf(b.chatId, b.messageIds[0], b.users[0]);

    const rows = await listPinnedMessageIds(a.chatId, [...a.messageIds, b.messageIds[0]]);
    expect(rows.map((r) => r.message_id).sort()).toEqual([a.messageIds[0], a.messageIds[2]].sort());
  });

  test("has nothing for no ids and does not query", async () => {
    const { chatId } = await seedChat();
    expect(await listPinnedMessageIds(chatId, [])).toEqual([]);
    expect(await listPinnedMessageIds(chatId, null)).toEqual([]);
    expect(await listPinnedMessageIds(null, ["x"])).toEqual([]);
  });

  test("a page of 500 messages is one statement", async () => {
    const { users, chatId, messageIds } = await seedChat();
    await pinOf(chatId, messageIds[0], users[0]);
    const ids = [messageIds[0], ...Array.from({ length: 499 }, () => crypto.randomUUID())];
    const { default: Database } = await import("better-sqlite3");
    const prepare = vi.spyOn(Database.prototype, "prepare");
    try {
      const rows = await listPinnedMessageIds(chatId, ids);
      expect(rows).toHaveLength(1);
      expect(prepare.mock.calls.filter(([sql]) => /chat_pinned_messages/i.test(String(sql)))).toHaveLength(1);
    } finally {
      prepare.mockRestore();
    }
  });
});

describe("cleanup", () => {
  test("deleting a chat removes its pins and no other chat's", async () => {
    const a = await seedChat();
    const b = await seedChat();
    await pinOf(a.chatId, a.messageIds[0], a.users[0]);
    await pinOf(b.chatId, b.messageIds[0], b.users[0]);
    await deleteChatById(a.chatId);
    expect(await rawPinCount({ chat_id: a.chatId })).toBe(0);
    expect(await rawPinCount({ chat_id: b.chatId })).toBe(1);
  });

  test("deleting the account of whoever pinned keeps the pin", async () => {
    const { users, chatId, messageIds } = await seedChat();
    await pinOf(chatId, messageIds[0], users[2]);
    await deleteUserById(users[2]);
    const rows = await getAll(dbKnex("chat_pinned_messages").where({ chat_id: chatId }));
    expect(rows).toHaveLength(1);
    expect(rows[0].pinned_by).toBeNull();
    const listed = await listPinnedMessages(chatId, users[0]);
    expect(listed).toHaveLength(1);
    expect(listed[0].pinned_by).toBeNull();
  });

  test("deleting the only owner of a chat removes the chat and the pins in it", async () => {
    const { users, chatId, messageIds } = await seedChat({ members: 1 });
    await pinOf(chatId, messageIds[0], users[0]);
    await deleteUserById(users[0]);
    expect(await rawPinCount({ chat_id: chatId })).toBe(0);
    expect(await findChatById(chatId)).toBeFalsy();
  });

  test("deleting a message row takes its pin with it", async () => {
    const { users, chatId, messageIds } = await seedChat();
    await pinOf(chatId, messageIds[0], users[0]);
    await run(dbKnex("chat_messages").where("id", messageIds[0]).del());
    expect(await rawPinCount({ message_id: messageIds[0] })).toBe(0);
  });

  test("removePinsOfMessages removes pins before their messages and reports which", async () => {
    const a = await seedChat({ messages: 3 });
    const b = await seedChat();
    await pinOf(a.chatId, a.messageIds[0], a.users[0]);
    await pinOf(a.chatId, a.messageIds[1], a.users[0]);
    await pinOf(b.chatId, b.messageIds[0], b.users[0]);

    const removed = await removePinsOfMessages({ adminGetAll, adminRun }, [
      a.messageIds[0],
      a.messageIds[2],
      b.messageIds[0],
      null,
    ]);
    expect(removed.map((r) => `${r.chat_id}:${r.message_id}`).sort()).toEqual(
      [`${a.chatId}:${a.messageIds[0]}`, `${b.chatId}:${b.messageIds[0]}`].sort(),
    );
    expect(await rawPinCount({ chat_id: a.chatId })).toBe(1);
    expect(await rawPinCount({ chat_id: b.chatId })).toBe(0);
    expect(await removePinsOfMessages({ adminGetAll, adminRun }, [])).toEqual([]);
  });
});

describe("the members-can-pin chat setting", () => {
  test("is off for a new group", async () => {
    const { chatId } = await seedChat();
    expect(Number((await findChatById(chatId)).allow_member_pins)).toBe(0);
  });

  test("changes only when asked to", async () => {
    const { users, chatId } = await seedChat();
    const base = { name: "Renamed", groupUsername: `g_${unique()}`, groupVisibility: "public", allowMemberInvites: true };

    await updateGroupChat(chatId, { ...base, allowMemberPins: true });
    expect(Number((await findChatById(chatId)).allow_member_pins)).toBe(1);

    // An update that says nothing about it (rename, avatar change) leaves it on.
    await updateGroupChat(chatId, { ...base, name: "Renamed again" });
    expect(Number((await findChatById(chatId)).allow_member_pins)).toBe(1);

    // Anything that is not a real boolean is ignored.
    await updateGroupChat(chatId, { ...base, allowMemberPins: "0" });
    expect(Number((await findChatById(chatId)).allow_member_pins)).toBe(1);

    await updateGroupChat(chatId, { ...base, allowMemberPins: false });
    expect(Number((await findChatById(chatId)).allow_member_pins)).toBe(0);

    const listed = (await listChatsForUser(users[0])).find((c) => c.id === chatId);
    expect(Number(listed.allow_member_pins)).toBe(0);
  });
});

describe("the \"X pinned a message\" entry", () => {
  test("never counts as unread and is never the first unread message", async () => {
    const { users, chatId, messageIds } = await seedChat({ type: "dm", members: 2, messages: 1 });
    // users[0] wrote message 0; users[1] pins it, which writes a service entry.
    const serviceId = await createMessage(
      chatId,
      users[1],
      buildPinServiceBody(messageIds[0]),
      null,
      null,
      null,
      { allowPlaintextSystemMessage: true },
    );

    // For users[0] the only thing unread would be the service entry.
    const chats = await listChatsForUser(users[0]);
    const chat = chats.find((c) => c.id === chatId);
    expect(Number(chat.unread_count)).toBe(0);
    expect(await getFirstUnreadMessage(chatId, users[0])).toBeNull();

    // A real message after it is what counts.
    const realId = await createMessage(chatId, users[1], "and one more");
    expect((await getFirstUnreadMessage(chatId, users[0])).id).toBe(realId);
    const after = (await listChatsForUser(users[0])).find((c) => c.id === chatId);
    expect(Number(after.unread_count)).toBe(1);
    expect(serviceId).toBeTruthy();
  });

  test("is stored readable even when text encryption is on, and is not the chat's last message", async () => {
    const { users, chatId, messageIds } = await seedChat({ type: "dm", members: 2, messages: 1 });
    const serviceId = await createMessage(
      chatId,
      users[1],
      buildPinServiceBody(messageIds[0]),
      null,
      null,
      null,
      { allowPlaintextSystemMessage: true },
    );
    const [row] = await getAll(dbKnex("chat_messages").select("body").where("id", serviceId));
    expect(row.body).toBe(`[[system:pinned:${messageIds[0]}]]`);

    const chat = (await listChatsForUser(users[0])).find((c) => c.id === chatId);
    expect(chat.last_message_id).toBe(messageIds[0]);
  });
});

describe("pinMessage on PostgreSQL", () => {
  let originalDbClient;
  beforeAll(() => {
    originalDbClient = process.env.DB_CLIENT;
  });
  afterEach(() => {
    if (originalDbClient === undefined) delete process.env.DB_CLIENT;
    else process.env.DB_CLIENT = originalDbClient;
    vi.restoreAllMocks();
  });

  const fakeTransaction = ({ existing = null, count = 0 } = {}) => {
    const calls = [];
    vi.spyOn(dbKnex, "transaction").mockImplementation(async (callback) => {
      const trx = (table) => {
        const builder = {
          select: () => builder,
          count: () => builder,
          where: () => builder,
          first: () => {
            // A pin lookup selects pinned_at; the count query asks for a count.
            builder.kind = builder.kind || "lookup";
            return builder;
          },
          insert: (row) => {
            calls.push({ op: "insert", table, row });
            return Promise.resolve([1]);
          },
          then: (resolve, reject) => {
            const answer = builder.counting ? { n: count } : existing;
            return Promise.resolve(answer).then(resolve, reject);
          },
        };
        const original = builder.count;
        builder.count = (...args) => {
          builder.counting = true;
          return original(...args);
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

  test("runs in one transaction, takes a per-chat advisory lock first and returns a promise", async () => {
    process.env.DB_CLIENT = "postgres";
    const calls = fakeTransaction({ existing: null, count: 0 });
    const pending = pinMessage({ chatId: "chat-1", messageId: "msg-1", userId: "u-1", max: 20 });
    expect(typeof pending?.then).toBe("function");
    const result = await pending;
    expect(result.status).toBe("pinned");

    expect(calls[0].op).toBe("raw");
    expect(calls[0].sql).toMatch(/pg_advisory_xact_lock/);
    expect(calls[0].bindings[0]).toContain("chat-1");
    expect(calls.find((c) => c.op === "insert")).toMatchObject({
      table: "chat_pinned_messages",
      row: { chat_id: "chat-1", message_id: "msg-1", pinned_by: "u-1", pinned_at: result.pinnedAt },
    });
  });

  test("a pin that exists is 'already' and writes nothing", async () => {
    process.env.DB_CLIENT = "postgres";
    const calls = fakeTransaction({ existing: { pinned_at: "2025-01-01T00:00:00.000Z" }, count: 5 });
    const result = await pinMessage({ chatId: "chat-1", messageId: "msg-1", userId: "u-1", max: 20 });
    expect(result).toEqual({ status: "already", pinnedAt: "2025-01-01T00:00:00.000Z" });
    expect(calls.some((c) => c.op === "insert")).toBe(false);
  });

  test("a full chat is 'limit' and writes nothing", async () => {
    process.env.DB_CLIENT = "postgres";
    const calls = fakeTransaction({ existing: null, count: 20 });
    const result = await pinMessage({ chatId: "chat-1", messageId: "msg-1", userId: "u-1", max: 20 });
    expect(result).toEqual({ status: "limit", pinnedAt: null });
    expect(calls.some((c) => c.op === "insert")).toBe(false);
  });
});
