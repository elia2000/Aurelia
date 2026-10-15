/**
 * Migration 043: E2EE envelope on messages.
 *
 * `e2ee_envelope` holds the JSON envelope of an end-to-end encrypted message
 * (currently round video messages): the per-recipient wrapped content keys,
 * IVs, the sender's signature and an encrypted poster frame. The media bytes
 * themselves live in the regular file storage as opaque ciphertext. The
 * server stores and relays the envelope but cannot open it.
 *
 * Idempotency: guarded by hasColumn; safe to re-run.
 */
export const migration043MessageE2eeEnvelope = {
  version: 43,
  up: ({ db, tableExists, hasColumn }) => {
    if (!tableExists("chat_messages")) return;
    if (!hasColumn("chat_messages", "e2ee_envelope")) {
      db.run("ALTER TABLE chat_messages ADD COLUMN e2ee_envelope TEXT");
    }
  },
};
