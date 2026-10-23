import crypto from "node:crypto";

/**
 * Migration 050: per-session metadata for the "active sessions" list, and the
 * link from a session to the things that belong to the browser behind it.
 *
 * sessions
 *   - public_id    random UUID shown to the owner instead of the session token
 *                  or the sequential row id, so a session can be named in the
 *                  API without exposing anything that authenticates.
 *   - user_agent   the browser + OS summary ("Firefox on Linux"), never the raw
 *                  header. No IP address is stored.
 *   - auth_method  how the session was created: password, password_2fa,
 *                  recovery_code or registration.
 *   (created_at and last_seen already existed.)
 *
 * push_subscriptions.session_public_id and e2ee_devices.session_public_id
 *   Remember which session registered the subscription / device, so signing a
 *   session out can stop its notifications and retire its device key.
 *
 * Existing sessions get a public_id here; their other columns stay NULL, which
 * the list shows as "Unknown device".
 *
 * Idempotency: guarded ALTERs, CREATE INDEX IF NOT EXISTS and a backfill that
 * only touches rows still without a public_id; safe to re-run on every start.
 */
export const migration050SessionMetadata = {
  version: 50,
  up: async ({ db, tableExists, hasColumn, getAll }) => {
    if (tableExists("sessions")) {
      if (!hasColumn("sessions", "public_id")) {
        await db.run("ALTER TABLE sessions ADD COLUMN public_id TEXT");
      }
      if (!hasColumn("sessions", "user_agent")) {
        await db.run("ALTER TABLE sessions ADD COLUMN user_agent TEXT");
      }
      if (!hasColumn("sessions", "auth_method")) {
        await db.run("ALTER TABLE sessions ADD COLUMN auth_method TEXT");
      }
      const missing = (await getAll("SELECT id FROM sessions WHERE public_id IS NULL")) || [];
      for (const row of missing) {
        await db.run("UPDATE sessions SET public_id = ? WHERE id = ?", [
          crypto.randomUUID(),
          row.id,
        ]);
      }
      await db.run(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_public_id ON sessions(public_id)",
      );
    }

    if (tableExists("push_subscriptions") && !hasColumn("push_subscriptions", "session_public_id")) {
      await db.run("ALTER TABLE push_subscriptions ADD COLUMN session_public_id TEXT");
    }
    if (tableExists("e2ee_devices") && !hasColumn("e2ee_devices", "session_public_id")) {
      await db.run("ALTER TABLE e2ee_devices ADD COLUMN session_public_id TEXT");
    }
  },
};
