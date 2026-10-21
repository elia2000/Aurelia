/**
 * Migration 049: gives group_removed_members its removed_by_user_id column back.
 *
 * Migration 012 created the table with `removed_by_user_id`. On SQLite,
 * migration 036 rebuilt it (to turn the ids into UUID text) with only
 * chat_id, user_id and removed_at, but markGroupMemberRemoved still writes the
 * column. Removing a member then failed with "table group_removed_members has
 * no column named removed_by_user_id": the marker that keeps a removed person
 * from joining again on their own was never stored, and the "X was removed"
 * line and the list refresh after it were skipped.
 *
 * The column is nullable text (the id of the person who removed them), so rows
 * written since 036 stay valid. PostgreSQL kept the column through 036, so
 * there this is a no-op.
 *
 * Idempotency: guarded ALTER; safe to re-run.
 */
export const migration049GroupRemovedByColumn = {
  version: 49,
  up: ({ db, tableExists, hasColumn }) => {
    if (!tableExists("group_removed_members")) return;
    if (hasColumn("group_removed_members", "removed_by_user_id")) return;
    db.run("ALTER TABLE group_removed_members ADD COLUMN removed_by_user_id TEXT");
  },
};
