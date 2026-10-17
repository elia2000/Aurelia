import { describe, test, expect, vi } from "vitest";
import crypto from "node:crypto";
import { dbKnex } from "../../db/knex.js";
import {
  addChatMember,
  adminGetAll,
  adminGetRow,
  adminRun,
  adminSave,
  createChat,
  createMessage,
  createMessageFiles,
  createUser,
  getAll,
  listMessageFilesByMessageIds,
  pinMessage,
} from "../../db.js";
import { createMessageFileJobs } from "../../lib/messageFileJobs.js";
import { emitUnpinnedMessages } from "../../lib/pins.js";

const unique = () => crypto.randomBytes(5).toString("hex");

async function seedPinnedPhoto(expiresAt = "2000-01-01T00:00:00.000Z") {
  const tag = unique();
  const author = await createUser(`pret_${tag}_a`, "hash", "A", null, "#10b981");
  const chatId = await createChat(`pret chat ${tag}`, "group", { createdByUserId: author });
  await addChatMember(chatId, author, "owner");
  const messageId = await createMessage(chatId, author, "photo");
  await createMessageFiles(messageId, [
    {
      kind: "media",
      originalName: "photo.png",
      storedName: `pret-${tag}.png`,
      mimeType: "image/png",
      sizeBytes: 10,
      expiresAt,
    },
  ]);
  await pinMessage({ chatId, messageId, userId: author, max: 20 });
  return { author, chatId, messageId };
}

const countPins = async (messageId) =>
  Number(
    (await getAll(dbKnex("chat_pinned_messages").count({ n: "*" }).where({ message_id: messageId })))[0].n,
  );

const makeJobs = (overrides = {}) =>
  createMessageFileJobs({
    getSetting: () => 7,
    adminGetAll,
    adminGetRow,
    adminRun,
    adminSave,
    listMessageFilesByMessageIds,
    removeStoredFileNames: () => {},
    uploadRootDir: "/nonexistent/uploads",
    fs: { existsSync: () => false, rmSync: () => {}, mkdirSync: () => {}, unlinkSync: () => {} },
    path: {
      join: (...parts) => parts.join("/"),
      basename: (value) => String(value).split("/").pop(),
    },
    ...overrides,
  });

describe("pins and message retention", () => {
  test("a message removed because its file is gone takes its pin with it and reports the unpin", async () => {
    const { chatId, messageId } = await seedPinnedPhoto();
    expect(await countPins(messageId)).toBe(1);

    const result = await makeJobs().cleanupMissingMessageFiles([messageId]);

    expect(result.changed).toBe(true);
    expect(result.deletedMessageIds).toContain(messageId);
    expect(result.unpinned).toEqual([{ chat_id: chatId, message_id: messageId }]);
    expect(await countPins(messageId)).toBe(0);
  });

  test("the report becomes a message_unpinned event for the chat", async () => {
    const { chatId, messageId } = await seedPinnedPhoto();
    const result = await makeJobs().cleanupMissingMessageFiles([messageId]);

    const emit = vi.fn();
    emitUnpinnedMessages(emit, result.unpinned);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(chatId, { type: "message_unpinned", chatId, messageId });
  });

  test("a message that is kept keeps its pin", async () => {
    const { messageId } = await seedPinnedPhoto();
    const files = await listMessageFilesByMessageIds([messageId]);
    const jobs = makeJobs({
      // The file is there, so nothing is missing.
      fs: { existsSync: () => true, rmSync: () => {}, mkdirSync: () => {}, unlinkSync: () => {} },
    });
    const result = await jobs.cleanupMissingMessageFiles([messageId]);
    expect(files.length).toBe(1);
    expect(result.changed).toBe(false);
    expect(await countPins(messageId)).toBe(1);
  });

  test("expiry cleanup deletes the pins before the messages", async () => {
    const statements = [];
    const adminRunSpy = vi.fn((sqlOrBuilder) => {
      const sql = typeof sqlOrBuilder === "string" ? sqlOrBuilder : sqlOrBuilder.toSQL().sql;
      statements.push(sql);
    });
    const messageId = crypto.randomUUID();
    const chatId = crypto.randomUUID();
    const rows = {
      expired: [{ stored_name: "old.png" }],
      shared: [{ message_id: messageId }],
      files: [{ message_id: messageId, stored_name: "old.png", storage_driver: "local" }],
      pins: [{ chat_id: chatId, message_id: messageId }],
    };

    const jobs = makeJobs({
      adminGetAll: (builder) => {
        const sql = builder.toSQL().sql;
        if (/chat_pinned_messages/i.test(sql)) return rows.pins;
        if (/distinct `?"?stored_name/i.test(sql)) return rows.expired;
        if (/distinct `?"?message_id/i.test(sql)) return rows.shared;
        return [];
      },
      adminGetRow: () => null,
      adminRun: adminRunSpy,
      adminSave: () => {},
      listMessageFilesByMessageIds: () => rows.files,
    });

    const result = await jobs.cleanupExpiredMessageFiles();
    expect(result.removedMessages).toBe(1);
    expect(result.unpinned).toEqual(rows.pins);

    const pinDelete = statements.findIndex((sql) => /delete from .?chat_pinned_messages/i.test(sql));
    const messageDelete = statements.findIndex((sql) => /delete from .?chat_messages/i.test(sql));
    expect(pinDelete).toBeGreaterThanOrEqual(0);
    expect(messageDelete).toBeGreaterThan(pinDelete);
  });

  test("expiry cleanup with a real database removes the pin of an expired message", async () => {
    const { messageId } = await seedPinnedPhoto("2000-01-01T00:00:00.000Z");
    expect(await countPins(messageId)).toBe(1);
    const result = await makeJobs().cleanupExpiredMessageFiles();
    expect(result.removedMessages).toBeGreaterThanOrEqual(1);
    expect(await countPins(messageId)).toBe(0);
    expect(result.unpinned.some((row) => row.message_id === messageId)).toBe(true);
  });
});
