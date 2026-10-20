/**
 * An in-memory stand-in for db.js createCallMessage with the same contract:
 * one row per call id, and `created` says whether THIS call inserted it. The
 * SQL itself (unique index, savepoint, read marks) is covered by
 * test/db/callMessages.test.js.
 */
import { vi } from "vitest";
import { generateUuid } from "../../lib/uuidUtils.js";

export function makeCallMessageStore({ createdAt = "2026-10-17 10:00:00" } = {}) {
  const rows = new Map();
  const create = vi.fn((args) => {
    const existing = [...rows.values()].find((row) => row.call_id === args.callId);
    if (existing) return { id: existing.id, created: false, createdAt: existing.created_at };
    const id = generateUuid();
    rows.set(id, {
      id,
      chat_id: args.chatId,
      user_id: args.callerId,
      body: "",
      call_id: args.callId,
      call_kind: args.kind,
      call_outcome: args.outcome,
      call_duration_sec: args.durationSec,
      expires_at: args.expiresAt,
      read_by: args.markReadBy,
      created_at: createdAt,
    });
    return { id, created: true, createdAt };
  });
  return {
    rows,
    create,
    list: () => [...rows.values()],
    byCall: (callId) => [...rows.values()].filter((row) => row.call_id === callId),
  };
}
