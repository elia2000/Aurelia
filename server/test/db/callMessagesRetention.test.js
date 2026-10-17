import { describe, test, expect, vi, afterAll } from "vitest";
import crypto from "node:crypto";

// The clean-up jobs act on the whole table, so this file works on a database of
// its own instead of the one other test files share. (Runs before any import.)
vi.hoisted(() => {
  const fs = process.getBuiltinModule("node:fs");
  const os = process.getBuiltinModule("node:os");
  const path = process.getBuiltinModule("node:path");
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "call-retention-"));
});

const { dbKnex } = await import("../../db/knex.js");
const {
  addChatMember,
  adminGetAll,
  adminGetRow,
  adminRun,
  adminSave,
  createChat,
  createMessage,
  createCallMessage,
  createUser,
  getAll,
  hideMessageForUser,
  run,
} = await import("../../db.js");
const { createTextRetentionJobs } = await import("../../lib/textRetentionJobs.js");

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

async function seedDm() {
  const tag = unique();
  const caller = await createUser(`rt_${tag}_a`, "hash", "Caller", null, "#10b981");
  const callee = await createUser(`rt_${tag}_b`, "hash", "Callee", null, "#3b82f6");
  const chatId = await createChat(`rt dm ${tag}`, "dm", { createdByUserId: caller });
  await addChatMember(chatId, caller, "member");
  await addChatMember(chatId, callee, "member");
  return { caller, callee, chatId };
}

const entry = (seed, overrides = {}) => ({
  chatId: seed.chatId,
  callerId: seed.caller,
  calleeId: seed.callee,
  callId: crypto.randomUUID(),
  kind: "audio",
  outcome: "completed",
  durationSec: 10,
  expiresAt: null,
  markReadBy: seed.callee,
  ...overrides,
});

const exists = async (id) =>
  (await getAll(dbKnex("chat_messages").select("id").where({ id }))).length === 1;
const expiryOf = async (id) =>
  (await getAll(dbKnex("chat_messages").select("expires_at").where({ id })))[0]?.expires_at;

const makeJobs = ({ days = 7, emitChatEvent = () => {} } = {}) =>
  createTextRetentionJobs({
    getSetting: (key) => (key === "MESSAGE_TEXT_RETENTION" ? days : 0),
    adminGetAll,
    adminGetRow,
    adminRun,
    adminSave,
    emitChatEvent,
  });

const PAST = "2000-01-01T00:00:00.000Z";
const FUTURE = "2999-01-01T00:00:00.000Z";

describe("call entries obey message retention", () => {
  test("an expired entry is deleted together with its read mark and hide mark", async () => {
    const seed = await seedDm();
    const emitChatEvent = vi.fn();
    const call = await createCallMessage(entry(seed, { expiresAt: PAST }));
    await hideMessageForUser(call.id, seed.caller);

    await makeJobs({ emitChatEvent }).cleanupExpiredTextOnlyMessages();

    expect(await exists(call.id)).toBe(false);
    const reads = await getAll(dbKnex("chat_message_reads").select("*").where({ message_id: call.id }));
    const hides = await getAll(dbKnex("hidden_chat_messages").select("*").where({ message_id: call.id }));
    expect(reads).toEqual([]);
    expect(hides).toEqual([]);
    expect(emitChatEvent).toHaveBeenCalledWith(seed.chatId, {
      type: "chat_message_deleted",
      chatId: seed.chatId,
      messageIds: expect.arrayContaining([call.id]),
    });
  });

  test("an entry that has not expired stays", async () => {
    const seed = await seedDm();
    const call = await createCallMessage(entry(seed, { expiresAt: FUTURE }));
    await makeJobs().cleanupExpiredTextOnlyMessages();
    expect(await exists(call.id)).toBe(true);
  });

  test("an entry without an expiry stays", async () => {
    const seed = await seedDm();
    const call = await createCallMessage(entry(seed));
    await makeJobs().cleanupExpiredTextOnlyMessages();
    expect(await exists(call.id)).toBe(true);
  });

  test("nothing is deleted while retention is switched off", async () => {
    const seed = await seedDm();
    const call = await createCallMessage(entry(seed, { expiresAt: PAST }));
    const result = await makeJobs({ days: 0 }).cleanupExpiredTextOnlyMessages();
    expect(result.removedMessages).toBe(0);
    expect(await exists(call.id)).toBe(true);
  });

  test("the call id can be recorded again once the entry has expired", async () => {
    const seed = await seedDm();
    const args = entry(seed, { expiresAt: PAST });
    await createCallMessage(args);
    await makeJobs().cleanupExpiredTextOnlyMessages();
    expect((await createCallMessage(args)).created).toBe(true);
  });
});

describe("call entries written before retention was switched on", () => {
  test("get an expiry like text messages do", async () => {
    const seed = await seedDm();
    const call = await createCallMessage(entry(seed));
    const text = await createMessage(seed.chatId, seed.caller, "hello");
    await run(dbKnex("chat_messages").whereIn("id", [call.id, text]).update({ created_at: "2026-01-01 00:00:00" }));

    await makeJobs({ days: 3 }).backfillTextMessageExpiry();

    expect(String(await expiryOf(call.id)).slice(0, 10)).toBe("2026-01-04");
    expect(String(await expiryOf(text)).slice(0, 10)).toBe("2026-01-04");
  });

  test("keep an expiry they already have", async () => {
    const seed = await seedDm();
    const call = await createCallMessage(entry(seed, { expiresAt: FUTURE }));
    await makeJobs({ days: 3 }).backfillTextMessageExpiry();
    expect(await expiryOf(call.id)).toBe(FUTURE);
  });

  test("are left alone while retention is off", async () => {
    const seed = await seedDm();
    const call = await createCallMessage(entry(seed));
    const pending = await makeJobs({ days: 0 }).backfillTextMessageExpiry();
    expect(pending).toBe(0);
    expect(await expiryOf(call.id)).toBeNull();
  });

  test("an ordinary empty message does not get an expiry", async () => {
    const seed = await seedDm();
    const empty = await createMessage(seed.chatId, seed.caller, "");
    await makeJobs({ days: 3 }).backfillTextMessageExpiry();
    expect(await expiryOf(empty)).toBeNull();
  });
});
