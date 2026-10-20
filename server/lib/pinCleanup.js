import { dbKnex } from "../db/knex.js";

/**
 * Removes the pins of messages that are about to be deleted (retention,
 * missing files, admin tools) and returns which ones there were, as
 * `[{ chat_id, message_id }]`, so the caller can tell the chat with
 * lib/pins.js emitUnpinnedMessages() once the messages are really gone.
 *
 * Call it inside the transaction that deletes the messages, before the
 * `chat_messages` rows go. `adminGetAll` / `adminRun` are the helpers the
 * surrounding cleanup code already uses. With an asynchronous database the
 * rows come back as a promise.
 */
export function removePinsOfMessages({ adminGetAll, adminRun }, messageIds) {
  const ids = Array.from(
    new Set((Array.isArray(messageIds) ? messageIds : []).filter(Boolean)),
  );
  if (!ids.length) return [];

  const rows = adminGetAll(
    dbKnex("chat_pinned_messages").select("chat_id", "message_id").whereIn("message_id", ids),
  );
  const remove = () => adminRun(dbKnex("chat_pinned_messages").whereIn("message_id", ids).del());

  if (rows && typeof rows.then === "function") {
    return rows.then((found) => {
      remove();
      return found || [];
    });
  }
  remove();
  return rows || [];
}
