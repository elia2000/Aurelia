/**
 * Migration 046: Pinned chats.
 *
 * `chat_pins` holds one row per (person, chat) the person pinned to the top of
 * their own chat list. Pins are private to the person: they never change what
 * anybody else sees. The composite primary key (user_id, chat_id) makes pinning
 * idempotent and serves the join the chat list makes; `position` orders a
 * person's pins (0 is the top, a new pin goes to the top) and is served by
 * (user_id, position). Rows disappear with their chat and with their person
 * (ON DELETE CASCADE). The deletion code paths also remove them explicitly so
 * databases that do not enforce foreign keys stay clean too, and leaving,
 * being removed from and hiding a chat clear the pin.
 *
 * Ids are the UUID text keys of migration 036. `pinned_at` is written
 * explicitly from JS (ISO 8601, no column default) so the same schema behaves
 * identically on SQLite and Postgres (see migration 039).
 *
 * Idempotency: CREATE ... IF NOT EXISTS; safe to re-run.
 */
export const migration046ChatPins = {
  version: 46,
  up: ({ db, tableExists }) => {
    if (!tableExists("chats") || !tableExists("users")) return;

    db.run(`
      CREATE TABLE IF NOT EXISTS chat_pins (
        user_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        pinned_at TEXT NOT NULL,
        PRIMARY KEY (user_id, chat_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
      )
    `);
    db.run(
      "CREATE INDEX IF NOT EXISTS idx_chat_pins_user_position ON chat_pins(user_id, position)",
    );
    // Deleting a chat looks its pins up by chat.
    db.run("CREATE INDEX IF NOT EXISTS idx_chat_pins_chat ON chat_pins(chat_id)");
  },
};
