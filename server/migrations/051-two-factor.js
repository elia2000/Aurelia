/**
 * Migration 051: optional TOTP two-factor sign-in.
 *
 * user_two_factor (one row per user that started or finished enrolment)
 *   - secret_enc       the TOTP secret, AES-256-GCM encrypted with a key derived
 *                      from the server secret (lib/twoFactor.js); never clear text.
 *   - enabled          0 while the person is still setting it up (secret shown,
 *                      no valid code entered yet), 1 once a code was confirmed.
 *   - last_used_step   the 30 second time step of the last accepted code; a code
 *                      is only accepted for a later step (replay protection).
 *
 * user_recovery_codes (single-use fallback codes)
 *   - code_hash        keyed hash of the code, the code itself is shown once.
 *   - used_at          set when the code is spent.
 *
 * Timestamps are written from JS (no defaults), like migration 042, so the
 * tables behave the same on SQLite and Postgres.
 *
 * Idempotency: CREATE ... IF NOT EXISTS; safe to re-run.
 */
export const migration051TwoFactor = {
  version: 51,
  up: ({ db }) => {
    db.run(`
      CREATE TABLE IF NOT EXISTS user_two_factor (
        user_id TEXT PRIMARY KEY,
        secret_enc TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        last_used_step INTEGER,
        created_at TEXT NOT NULL,
        enabled_at TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS user_recovery_codes (
        user_id TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        used_at TEXT,
        PRIMARY KEY (user_id, code_hash),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
  },
};
