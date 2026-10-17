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
  toggleMessageReaction,
} from "../../db.js";
import { createMessageFileJobs } from "../../lib/messageFileJobs.js";

const unique = () => crypto.randomBytes(5).toString("hex");

async function seedMessageWithFile() {
  const tag = unique();
  const author = await createUser(`ret_${tag}_a`, "hash", "A", null, "#10b981");
  const reactor = await createUser(`ret_${tag}_b`, "hash", "B", null, "#10b981");
  const chatId = await createChat(`ret chat ${tag}`, "group", { createdByUserId: author });
  await addChatMember(chatId, author, "owner");
  await addChatMember(chatId, reactor, "member");
  const messageId = await createMessage(chatId, author, "photo");
  const storedName = `ret-${tag}.png`;
  await createMessageFiles(messageId, [
    {
      kind: "media",
      originalName: "photo.png",
      storedName,
      mimeType: "image/png",
      sizeBytes: 10,
      expiresAt: "2000-01-01T00:00:00.000Z",
    },
  ]);
  await toggleMessageReaction({ messageId, userId: reactor, emoji: "\u{1F44D}", maxPerUser: 1 });
  return { messageId, storedName, reactor };
}

const countReactions = async (messageId) =>
  Number((await getAll(dbKnex("message_reactions").count({ n: "*" }).where({ message_id: messageId })))[0].n);

describe("reactions and message retention", () => {
  test("a message removed because its file is gone takes its reactions with it", async () => {
    const { messageId } = await seedMessageWithFile();
    expect(await countReactions(messageId)).toBe(1);

    const jobs = createMessageFileJobs({
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
    });

    const result = await jobs.cleanupMissingMessageFiles([messageId]);
    expect(result.changed).toBe(true);
    expect(result.deletedMessageIds).toContain(messageId);
    expect(await countReactions(messageId)).toBe(0);
  });

  test("expiry cleanup deletes the reactions before the messages", async () => {
    const statements = [];
    const adminRunSpy = vi.fn((sqlOrBuilder) => {
      const sql = typeof sqlOrBuilder === "string" ? sqlOrBuilder : sqlOrBuilder.toSQL().sql;
      statements.push(sql);
    });
    const messageId = crypto.randomUUID();
    const rows = {
      expired: [{ stored_name: "old.png" }],
      shared: [{ message_id: messageId }],
      files: [{ message_id: messageId, stored_name: "old.png", storage_driver: "local" }],
    };

    const jobs = createMessageFileJobs({
      getSetting: () => 7,
      adminGetAll: (builder) => {
        const sql = builder.toSQL().sql;
        if (/distinct `?"?stored_name/i.test(sql)) return rows.expired;
        if (/distinct `?"?message_id/i.test(sql)) return rows.shared;
        return [];
      },
      adminGetRow: () => null,
      adminRun: adminRunSpy,
      adminSave: () => {},
      listMessageFilesByMessageIds: () => rows.files,
      removeStoredFileNames: () => {},
      uploadRootDir: "/nonexistent/uploads",
      fs: { existsSync: () => false, rmSync: () => {}, mkdirSync: () => {}, unlinkSync: () => {} },
      path: {
        join: (...parts) => parts.join("/"),
        basename: (value) => String(value).split("/").pop(),
      },
    });

    const result = await jobs.cleanupExpiredMessageFiles();
    expect(result.removedMessages).toBe(1);

    const reactionDelete = statements.findIndex((sql) => /delete from .?message_reactions/i.test(sql));
    const messageDelete = statements.findIndex((sql) => /delete from .?chat_messages/i.test(sql));
    expect(reactionDelete).toBeGreaterThanOrEqual(0);
    expect(messageDelete).toBeGreaterThan(reactionDelete);
  });
});
