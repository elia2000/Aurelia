/**
 * Migration 047: Call history entries in the chat.
 *
 * When a call between two people ends, the server writes ONE message into
 * their direct chat ("Outgoing call 0:23", "Missed call", "Declined", ...).
 * It is an ordinary `chat_messages` row (empty body, written by the caller) so
 * it sorts, hides, expires, counts as unread and is deleted exactly like any
 * other message; four nullable columns say what it is:
 *
 *   call_id            the call's UUID. Its UNIQUE index is what makes the entry
 *                      appear exactly once per call, whichever of the two people
 *                      (or the expiry sweeper) ends it first.
 *   call_kind          "audio" | "video"
 *   call_outcome       "completed" | "missed" | "declined" | "cancelled" |
 *                      "busy" | "failed"
 *   call_duration_sec  whole seconds, only for "completed"
 *
 * Every ordinary message keeps all four at NULL. The unique index is not
 * partial on purpose: NULLs never collide, on SQLite and on Postgres alike, and
 * a plain unique index is what `ON CONFLICT (call_id) DO NOTHING` can use on
 * both. Because nothing outside the row refers to a call entry, deleting the
 * message (retention, "delete for me" bookkeeping, chat or account deletion) is
 * all the clean-up there is.
 *
 * Idempotency: guarded ALTERs and CREATE ... IF NOT EXISTS; safe to re-run.
 */
export const migration047CallMessages = {
  version: 47,
  up: ({ db, tableExists, hasColumn }) => {
    if (!tableExists("chat_messages")) return;

    if (!hasColumn("chat_messages", "call_id")) {
      db.run("ALTER TABLE chat_messages ADD COLUMN call_id TEXT");
    }
    if (!hasColumn("chat_messages", "call_kind")) {
      db.run("ALTER TABLE chat_messages ADD COLUMN call_kind TEXT");
    }
    if (!hasColumn("chat_messages", "call_outcome")) {
      db.run("ALTER TABLE chat_messages ADD COLUMN call_outcome TEXT");
    }
    if (!hasColumn("chat_messages", "call_duration_sec")) {
      db.run("ALTER TABLE chat_messages ADD COLUMN call_duration_sec INTEGER");
    }

    db.run(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_messages_call_id ON chat_messages(call_id)",
    );
  },
};
