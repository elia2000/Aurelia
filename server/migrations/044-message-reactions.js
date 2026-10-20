/**
 * Migration 044: Message reactions.
 *
 * One row per (message, person, emoji). The composite primary key makes a
 * repeated reaction impossible and serves lookups by message. Rows disappear
 * with their message and with the person who made them (ON DELETE CASCADE);
 * the deletion code paths also remove them explicitly so databases that do not
 * enforce foreign keys stay clean too.
 *
 * Ids are the UUID text keys of migration 036. `created_at` is written
 * explicitly from JS (ISO 8601, no column default) so the same schema behaves
 * identically on SQLite and Postgres (see migration 039).
 *
 * Idempotency: CREATE ... IF NOT EXISTS; safe to re-run.
 */
export const migration044MessageReactions = {
  version: 44,
  up: ({ db, tableExists }) => {
    if (!tableExists("chat_messages") || !tableExists("users")) return;

    db.run(`
      CREATE TABLE IF NOT EXISTS message_reactions (
        message_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        emoji TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (message_id, user_id, emoji),
        FOREIGN KEY (message_id) REFERENCES chat_messages(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    db.run(
      "CREATE INDEX IF NOT EXISTS idx_message_reactions_message ON message_reactions(message_id)",
    );
    // Deleting an account looks reactions up by person.
    db.run(
      "CREATE INDEX IF NOT EXISTS idx_message_reactions_user ON message_reactions(user_id)",
    );
  },
};
