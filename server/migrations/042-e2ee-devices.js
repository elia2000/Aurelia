/**
 * Migration 042: End-to-end encryption device directory.
 *
 * Every browser/app install ("device") generates an identity key pair on the
 * client and registers only the PUBLIC halves here. The server never sees a
 * private key. Peers fetch these public keys to
 *   - authenticate call signaling (ECDSA signatures), and
 *   - wrap per-message content keys (ECDH) for round video messages.
 *
 * Timestamps are written explicitly from JS (no column defaults) so the same
 * schema behaves identically on SQLite and Postgres (see migration 039).
 *
 * Idempotency: CREATE ... IF NOT EXISTS; safe to re-run.
 */
export const migration042E2eeDevices = {
  version: 42,
  up: ({ db }) => {
    db.run(`
      CREATE TABLE IF NOT EXISTS e2ee_devices (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        label TEXT,
        ecdh_public TEXT NOT NULL,
        ecdsa_public TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        revoked_at TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    db.run(
      "CREATE INDEX IF NOT EXISTS idx_e2ee_devices_user ON e2ee_devices(user_id, revoked_at)",
    );
  },
};
