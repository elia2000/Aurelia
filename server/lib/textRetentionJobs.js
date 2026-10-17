import { dbKnex } from "../db/knex.js";
import { removePinsOfMessages } from "./pinCleanup.js";
import { emitUnpinnedMessages } from "./pins.js";

/**
 * MESSAGE_TEXT_RETENTION: messages without attachments expire a number of days
 * after they were written and are then deleted.
 *
 * - `backfillTextMessageExpiry` gives the messages written before retention
 *   was switched on (or without an expiry) one.
 * - `cleanupExpiredTextOnlyMessages` deletes the ones that have expired,
 *   together with everything that hangs on them (reactions, pins, read marks,
 *   "delete for me" marks), and tells the chats.
 *
 * Call history entries (migration 047) are text-like for this purpose: they
 * have no attachments and an empty body, so they are named explicitly.
 */
export function createTextRetentionJobs({
  getSetting,
  adminGetRow,
  adminGetAll,
  adminRun,
  adminSave,
  emitChatEvent,
}) {
  const chunkArray = (items = [], size = 500) => {
    const chunks = [];
    for (let index = 0; index < items.length; index += size) {
      chunks.push(items.slice(index, index + size));
    }
    return chunks;
  };

  // Text with something in it, or a call history entry (whose text is empty).
  const hasTextOrIsCallEntry = (builder) => {
    builder.where(function () {
      this.whereRaw("TRIM(body) != ''").orWhereNotNull("call_id");
    });
  };

  async function backfillTextMessageExpiry() {
    const textRetentionDays = getSetting("MESSAGE_TEXT_RETENTION");
    if (textRetentionDays <= 0) return 0;

    const rawRow = adminGetRow(
      dbKnex("chat_messages")
        .count({ n: "*" })
        .where((builder) => {
          builder.whereNull("expires_at").orWhere("expires_at", "");
        })
        .whereNull("hidden_everyone_at")
        .whereNotNull("body")
        .modify(hasTextOrIsCallEntry)
        .whereRaw("body NOT LIKE '[[system:%]]'")
        .whereNotExists(
          dbKnex("chat_message_files")
            .select(1)
            .whereRaw("chat_message_files.message_id = chat_messages.id"),
        )
        .first(),
    );
    const row = rawRow && typeof rawRow.then === "function" ? await rawRow : rawRow;

    const pending = Number(row?.n || 0);
    if (!pending) return 0;

    // (With an asynchronous database this is a promise: wait for it, so the
    // count below is only reported once the expiry is really set.)
    const updated = adminRun(
      dbKnex("chat_messages")
        .where((builder) => {
          builder.whereNull("expires_at").orWhere("expires_at", "");
        })
        .whereNull("hidden_everyone_at")
        .whereNotNull("body")
        .modify(hasTextOrIsCallEntry)
        .whereRaw("body NOT LIKE '[[system:%]]'")
        .whereNotExists(
          dbKnex("chat_message_files")
            .select(1)
            .whereRaw("chat_message_files.message_id = chat_messages.id"),
        )
        .update({
          expires_at: dbKnex.raw("datetime(created_at, '+' || ? || ' days')", [textRetentionDays]),
        }),
    );

    if (updated && typeof updated.then === "function") await updated;
    adminSave();
    return pending;
  }

  async function cleanupExpiredTextOnlyMessages() {
    if (getSetting("MESSAGE_TEXT_RETENTION") <= 0) {
      return { removedMessages: 0 };
    }

    const rawRows = adminGetAll(
      dbKnex("chat_messages")
        .select("id", "chat_id")
        .whereNotNull("expires_at")
        .where("expires_at", "!=", "")
        .whereNull("hidden_everyone_at")
        .whereRaw("julianday(expires_at) <= julianday(?)", [new Date().toISOString()])
        .whereNotExists(
          dbKnex("chat_message_files")
            .select(1)
            .whereRaw("chat_message_files.message_id = chat_messages.id"),
        ),
    );
    const rows = Array.isArray(rawRows) ? rawRows : (await rawRows) || [];

    const messageIds = rows.map((row) => row?.id).filter(Boolean);

    if (!messageIds.length) {
      return { removedMessages: 0 };
    }

    const deletedByChat = new Map();
    rows.forEach((row) => {
      const chatId = row?.chat_id;
      const messageId = row?.id;
      if (!chatId || !messageId) return;
      const list = deletedByChat.get(chatId) || [];
      list.push(messageId);
      deletedByChat.set(chatId, list);
    });

    const unpinned = [];
    adminRun("BEGIN");
    try {
      chunkArray(messageIds, 500).forEach((chunk) => {
        adminRun(dbKnex("message_reactions").whereIn("message_id", chunk).del());
        const removedPins = removePinsOfMessages({ adminGetAll, adminRun }, chunk);
        if (Array.isArray(removedPins)) unpinned.push(...removedPins);
        adminRun(dbKnex("chat_message_reads").whereIn("message_id", chunk).del());
        adminRun(dbKnex("hidden_chat_messages").whereIn("message_id", chunk).del());
        adminRun(dbKnex("chat_messages").whereIn("id", chunk).del());
      });
      adminRun("COMMIT");
    } catch (error) {
      adminRun("ROLLBACK");
      throw error;
    }

    adminSave();
    deletedByChat.forEach((ids, chatId) => {
      emitChatEvent(chatId, {
        type: "chat_message_deleted",
        chatId: chatId,
        messageIds: ids,
      });
    });
    emitUnpinnedMessages(emitChatEvent, unpinned);

    return { removedMessages: messageIds.length };
  }

  return { backfillTextMessageExpiry, cleanupExpiredTextOnlyMessages };
}
