import { describe, test, expect, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import {
  addChatMember,
  createChat,
  createMessage,
  createUser,
  findMessageById,
  findMessagesByIds,
  getMessages,
  hideMessageForEveryone,
  hideMessageForUser,
  listMessageIdsHiddenForUser,
} from "../../db.js";
import { allocateAscendingIds } from "../../lib/batchMessages.js";

const unique = () => crypto.randomBytes(5).toString("hex");

async function seed({ messages = 3 } = {}) {
  const tag = unique();
  const alice = await createUser(`bm_${tag}_a`, "hash", "Alice", null, "#10b981");
  const bob = await createUser(`bm_${tag}_b`, "hash", "Bob", null, "#10b981");
  const chatId = await createChat(`batch ${tag}`, "group", { createdByUserId: alice });
  await addChatMember(chatId, alice, "owner");
  await addChatMember(chatId, bob, "member");
  const ids = [];
  for (let i = 0; i < messages; i += 1) {
    ids.push(await createMessage(chatId, i % 2 ? bob : alice, `message ${i} ${tag}`));
  }
  return { tag, alice, bob, chatId, ids };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("findMessagesByIds", () => {
  test("returns the same rows findMessageById does, in one call", async () => {
    const { ids } = await seed({ messages: 4 });
    const rows = await findMessagesByIds(ids);
    expect(rows).toHaveLength(4);
    for (const id of ids) {
      const expected = await findMessageById(id);
      expect(rows.find((row) => row.id === id)).toEqual(expected);
    }
  });

  test("the text comes back readable (stored encrypted, decrypted like a single lookup)", async () => {
    const { ids, tag } = await seed({ messages: 2 });
    const rows = await findMessagesByIds(ids);
    expect(rows.map((row) => row.body).sort()).toEqual([`message 0 ${tag}`, `message 1 ${tag}`]);
  });

  test("ids that do not exist are simply missing; a repeated id comes once", async () => {
    const { ids } = await seed({ messages: 2 });
    const rows = await findMessagesByIds([ids[0], "00000000-0000-4000-8000-0000000000ff", ids[0], null, ""]);
    expect(rows.map((row) => row.id)).toEqual([ids[0]]);
  });

  test("a message deleted for everyone is still returned, with the mark (the caller decides)", async () => {
    const { ids } = await seed({ messages: 2 });
    await hideMessageForEveryone(ids[0]);
    const rows = await findMessagesByIds(ids);
    expect(rows.find((row) => row.id === ids[0]).hidden_everyone_at).toBeTruthy();
    expect(rows.find((row) => row.id === ids[1]).hidden_everyone_at).toBeNull();
  });

  test("carries the columns the forward and delete checks read", async () => {
    const { ids } = await seed({ messages: 1 });
    const [row] = await findMessagesByIds(ids);
    for (const column of [
      "id",
      "chat_id",
      "user_id",
      "body",
      "edited_body",
      "hidden_everyone_at",
      "created_at",
      "e2ee_envelope",
      "call_id",
      "call_kind",
      "call_outcome",
      "call_duration_sec",
      "forwarded_from_label",
    ]) {
      expect(row, column).toHaveProperty(column);
    }
  });

  test("more ids than a multi-select can send are fine", async () => {
    const { ids } = await seed({ messages: 3 });
    const filler = Array.from({ length: 150 }, (_, i) => `00000000-0000-4000-8000-${(0x9000 + i).toString(16).padStart(12, "0")}`);
    const rows = await findMessagesByIds([...filler, ...ids]);
    expect(rows.map((row) => row.id).sort()).toEqual([...ids].sort());
  });

  test("nothing asked, nothing returned", async () => {
    expect(await findMessagesByIds([])).toEqual([]);
    expect(await findMessagesByIds()).toEqual([]);
    expect(await findMessagesByIds(null)).toEqual([]);
  });

  test("on PostgreSQL an empty request still answers with a promise", async () => {
    vi.stubEnv("DB_CLIENT", "postgres");
    const answer = findMessagesByIds([]);
    expect(typeof answer.then).toBe("function");
    expect(await answer).toEqual([]);
  });
});

describe("listMessageIdsHiddenForUser", () => {
  test("lists the messages the person removed from their own view, and only theirs", async () => {
    const { ids, alice, bob } = await seed({ messages: 4 });
    await hideMessageForUser(ids[0], alice);
    await hideMessageForUser(ids[1], bob);
    await hideMessageForUser(ids[2], alice);

    const mine = await listMessageIdsHiddenForUser(ids, alice);
    expect(mine.map((r) => r.message_id).sort()).toEqual([ids[0], ids[2]].sort());
    const his = await listMessageIdsHiddenForUser(ids, bob);
    expect(his.map((r) => r.message_id)).toEqual([ids[1]]);
  });

  test("only asks about the ids it was given", async () => {
    const { ids, alice } = await seed({ messages: 3 });
    await hideMessageForUser(ids[0], alice);
    await hideMessageForUser(ids[1], alice);
    const rows = await listMessageIdsHiddenForUser([ids[1], ids[2]], alice);
    expect(rows.map((r) => r.message_id)).toEqual([ids[1]]);
  });

  test("nothing hidden, no person or no ids: nothing", async () => {
    const { ids, alice } = await seed({ messages: 2 });
    expect(await listMessageIdsHiddenForUser(ids, alice)).toEqual([]);
    expect(await listMessageIdsHiddenForUser([], alice)).toEqual([]);
    expect(await listMessageIdsHiddenForUser(ids, null)).toEqual([]);
    expect(await listMessageIdsHiddenForUser(undefined, alice)).toEqual([]);
  });

  test("on PostgreSQL an empty request still answers with a promise", async () => {
    vi.stubEnv("DB_CLIENT", "postgres");
    const answer = listMessageIdsHiddenForUser([], "x");
    expect(typeof answer.then).toBe("function");
    expect(await answer).toEqual([]);
  });
});

describe("createMessage with an id of its own", () => {
  test("uses the id it is given", async () => {
    const { chatId, alice } = await seed({ messages: 0 });
    const wanted = crypto.randomUUID();
    const id = await createMessage(chatId, alice, "hello", null, null, null, { id: wanted });
    expect(id).toBe(wanted);
    expect((await findMessageById(wanted)).body).toBe("hello");
  });

  test("an id that is not a UUID is ignored and a fresh one is made", async () => {
    const { chatId, alice } = await seed({ messages: 0 });
    for (const bad of ["not-a-uuid", "", null, undefined, 42]) {
      const id = await createMessage(chatId, alice, "hello", null, null, null, { id: bad });
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(id).not.toBe(bad);
    }
  });

  test("without options nothing changes", async () => {
    const { chatId, alice } = await seed({ messages: 0 });
    const a = await createMessage(chatId, alice, "one");
    const b = await createMessage(chatId, alice, "two", null, null, null, { allowPlaintextSystemMessage: false });
    expect(a).not.toBe(b);
  });

  test("messages written in the same second with ascending ids stay in the order they were written", async () => {
    const { chatId, alice, bob } = await seed({ messages: 0 });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2031-05-05T10:00:00Z"));

    const newIds = allocateAscendingIds(30);
    const bodies = [];
    for (let i = 0; i < newIds.length; i += 1) {
      bodies.push(`forwarded ${i}`);
      await createMessage(chatId, i % 2 ? alice : bob, `forwarded ${i}`, null, null, null, { id: newIds[i] });
    }
    const { messages } = await getMessages(chatId, { limit: 100, viewerUserId: alice });
    expect(messages.map((m) => m.body)).toEqual(bodies);
    expect(new Set(messages.map((m) => m.created_at)).size).toBe(1);
  });
});
