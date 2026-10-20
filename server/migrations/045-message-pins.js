/**
 * Migration 045: Pinned messages.
 *
 * `chat_pinned_messages` holds one row per pinned message of a chat. The
 * composite primary key (chat_id, message_id) makes pinning idempotent and
 * serves lookups by chat; the extra index orders a chat's pins newest first.
 * Rows disappear with their chat and with their message (ON DELETE CASCADE).
 * The deletion code paths also remove them explicitly so databases that do
 * not enforce foreign keys stay clean too. `pinned_by` is kept when the person
 * who pinned leaves the platform (ON DELETE SET NULL): the pin belongs to the
 * conversation, not to the account.
 *
 * `chats.allow_member_pins` is the one group setting: when 1, every member of
 * a group (not only its owner) may pin and unpin messages. It is 0 for
 * everything that already exists.
 *
 * Ids are the UUID text keys of migration 036. `pinned_at` is written
 * explicitly from JS (ISO 8601, no column default) so the same schema behaves
 * identically on SQLite and Postgres (see migration 039).
 *
 * Idempotency: CREATE ... IF NOT EXISTS and guarded ALTERs; safe to re-run.
 */
export const migration045MessagePins = {
  version: 45,
  up: ({ db, tableExists, hasColumn }) => {
    if (tableExists("chats") && !hasColumn("chats", "allow_member_pins")) {
      db.run(
        "ALTER TABLE chats ADD COLUMN allow_member_pins INTEGER NOT NULL DEFAULT 0",
      );
    }

    if (!tableExists("chats") || !tableExists("chat_messages") || !tableExists("users")) {
      return;
    }

    db.run(`
      CREATE TABLE IF NOT EXISTS chat_pinned_messages (
        chat_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        pinned_by TEXT,
        pinned_at TEXT NOT NULL,
        PRIMARY KEY (chat_id, message_id),
        FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
        FOREIGN KEY (message_id) REFERENCES chat_messages(id) ON DELETE CASCADE,
        FOREIGN KEY (pinned_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
    db.run(
      "CREATE INDEX IF NOT EXISTS idx_chat_pinned_messages_chat_time ON chat_pinned_messages(chat_id, pinned_at)",
    );
    // Deleting a message looks its pin up by message.
    db.run(
      "CREATE INDEX IF NOT EXISTS idx_chat_pinned_messages_message ON chat_pinned_messages(message_id)",
    );
    // Deleting an account clears `pinned_by` by person.
    db.run(
      "CREATE INDEX IF NOT EXISTS idx_chat_pinned_messages_user ON chat_pinned_messages(pinned_by)",
    );
  },
};
