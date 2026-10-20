/**
 * Migration 048: Saved GIFs, and the animated flag of message files.
 *
 * `user_gifs` is one person's own collection of GIFs (animated GIF / WebP /
 * APNG). It is strictly private: every query filters by `user_id`, the bytes
 * live under a key that starts with the owner's id (`gifs/<userId>/<uuid>.<ext>`,
 * unique across the table) and nothing else refers to a row. Rows disappear
 * with their person (ON DELETE CASCADE); the deletion code paths also remove
 * them, and the stored files, explicitly so databases that do not enforce
 * foreign keys stay clean too.
 *
 *   storage_driver     "local" | "remote" | "s3": where the bytes were written,
 *                      so a later change of the storage setup cannot lose them
 *   mime / width / height / frames / size_bytes   checked from the bytes, never
 *                      taken from the client
 *   sha256             of the (decrypted) bytes; UNIQUE per person, which is what
 *                      makes saving the same picture twice a no-op even when two
 *                      requests race
 *   source_message_id / source_file_id   where it was saved from (a plain note,
 *                      no foreign key: deleting or expiring the message must
 *                      not touch the copy). File ids are integers; the column
 *                      is TEXT like the message id next to it.
 *
 * The (user_id, created_at) index serves the list (newest first) and the
 * "oldest ones go first" eviction when a person is over the limit.
 *
 * `chat_message_files.is_animated` marks an attachment that is an animated
 * image (GIF, animated WebP, APNG), so clients can show it like a GIF. It is
 * decided by the server from the file's bytes.
 *
 * Ids are the UUID text keys of migration 036. `created_at` is written
 * explicitly from JS (ISO 8601, no column default) so the same schema behaves
 * identically on SQLite and Postgres (see migration 039).
 *
 * Idempotency: guarded ALTER and CREATE ... IF NOT EXISTS; safe to re-run.
 */
export const migration048SavedGifs = {
  version: 48,
  up: ({ db, tableExists, hasColumn }) => {
    if (tableExists("chat_message_files") && !hasColumn("chat_message_files", "is_animated")) {
      db.run("ALTER TABLE chat_message_files ADD COLUMN is_animated INTEGER NOT NULL DEFAULT 0");
    }

    if (!tableExists("users")) return;

    db.run(`
      CREATE TABLE IF NOT EXISTS user_gifs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        storage_key TEXT NOT NULL,
        storage_driver TEXT NOT NULL DEFAULT 'local',
        mime TEXT NOT NULL,
        width INTEGER,
        height INTEGER,
        frames INTEGER,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        source_message_id TEXT,
        source_file_id TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    db.run(
      "CREATE INDEX IF NOT EXISTS idx_user_gifs_user_created ON user_gifs(user_id, created_at)",
    );
    db.run(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_user_gifs_user_sha256 ON user_gifs(user_id, sha256)",
    );
    db.run(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_user_gifs_storage_key ON user_gifs(storage_key)",
    );
  },
};
