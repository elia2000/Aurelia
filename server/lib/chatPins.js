// Pure helpers for pinned chats (the per-person "pin conversations to the top of
// the chat list" feature). No I/O, so every rule here is unit tested without a
// database. Pinned *messages* live in lib/pins.js.

import { isValidUuid } from "./uuidUtils.js";

export const MAX_PINNED_CHATS_MIN = 1;
export const MAX_PINNED_CHATS_MAX = 30;
export const MAX_PINNED_CHATS_DEFAULT = 5;

/** The `MAX_PINNED_CHATS` setting, clamped to the supported 1-30 range. */
export function clampMaxPinnedChats(value) {
  // Nothing configured (null, undefined, "") is the default, not zero.
  if (value === null || value === undefined || String(value).trim() === "") {
    return MAX_PINNED_CHATS_DEFAULT;
  }
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return MAX_PINNED_CHATS_DEFAULT;
  return Math.min(MAX_PINNED_CHATS_MAX, Math.max(MAX_PINNED_CHATS_MIN, n));
}

const toPosition = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

/** Rows of chat_pins ordered the way the chat list shows them (top first). */
function sortedPinRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      chatId: row?.chat_id ? String(row.chat_id) : "",
      position: toPosition(row?.position),
    }))
    .filter((row) => row.chatId && row.position !== null)
    .sort((a, b) =>
      a.position !== b.position
        ? a.position - b.position
        : a.chatId < b.chatId
          ? -1
          : a.chatId > b.chatId
            ? 1
            : 0,
    );
}

/**
 * The `pinned` list of the "chat_pins_changed" event and of the pin API
 * responses: `[{ chatId, position }]`, top first. `position` is only an order
 * key (0 is the top); do not assume the numbers are contiguous.
 */
export function toPinnedPayload(rows) {
  return sortedPinRows(rows).map(({ chatId, position }) => ({ chatId, position }));
}

/**
 * Which rows must be rewritten so the positions of an ordered set are exactly
 * 0..n-1 again (after a pin was removed). Returns `[{ chatId, position }]`.
 */
export function planCompaction(rows) {
  const updates = [];
  sortedPinRows(rows).forEach((row, index) => {
    if (row.position !== index) updates.push({ chatId: row.chatId, position: index });
  });
  return updates;
}

/**
 * What pinning `chatId` does given the person's current pins (`rows`, any
 * order): "already" (with where it is), "limit" when `max` pins are used up, or
 * "insert".
 */
export function decideChatPin({ rows, chatId, max }) {
  const current = sortedPinRows(rows);
  const existing = current.find((row) => row.chatId === chatId);
  if (existing) return { action: "already", position: existing.position };
  if (current.length >= Math.max(1, Math.trunc(Number(max)) || 1)) return { action: "limit" };
  return { action: "insert" };
}

/**
 * Applies a requested order to the current pins. The request must be exactly
 * the current set (same chats, each once): a client that is out of date does
 * not get to drop or invent pins. Returns `{ ok: true, updates }` with only the
 * rows that move, or `{ ok: false }`.
 */
export function planReorder(currentRows, requestedChatIds) {
  const current = sortedPinRows(currentRows);
  const requested = Array.isArray(requestedChatIds) ? requestedChatIds : [];
  if (requested.length !== current.length) return { ok: false };
  const wanted = new Set(requested);
  if (wanted.size !== requested.length) return { ok: false };
  const positionOf = new Map(current.map((row) => [row.chatId, row.position]));
  if (!requested.every((chatId) => positionOf.has(chatId))) return { ok: false };

  const updates = [];
  requested.forEach((chatId, index) => {
    if (positionOf.get(chatId) !== index) updates.push({ chatId, position: index });
  });
  return { ok: true, updates };
}

/**
 * Validates the body of PUT /api/chats/pins/order. Does not look at the
 * database; whether the list is the caller's pinned set is decided later.
 */
export function parseOrderBody(body) {
  const chatIds = body && typeof body === "object" ? body.chatIds : undefined;
  if (!Array.isArray(chatIds)) {
    return { ok: false, error: "Field 'chatIds' must be a list of chat ids." };
  }
  if (chatIds.length > MAX_PINNED_CHATS_MAX) {
    return {
      ok: false,
      error: `Field 'chatIds' can have at most ${MAX_PINNED_CHATS_MAX} entries.`,
    };
  }
  const seen = new Set();
  for (const value of chatIds) {
    if (typeof value !== "string" || value !== value.trim() || !isValidUuid(value)) {
      return { ok: false, error: "Field 'chatIds' must only contain valid UUIDs." };
    }
    if (seen.has(value)) {
      return { ok: false, error: "Field 'chatIds' lists a chat twice." };
    }
    seen.add(value);
  }
  return { ok: true, chatIds: [...chatIds] };
}

/**
 * One "chat_pins_changed" delivery per person: `holders` are the people whose
 * pins just changed ([{ user_id, username }]), `rows` their pins afterwards
 * ([{ user_id, chat_id, position }]). A person left with nothing pinned still
 * gets the empty list, so their other devices clear it.
 */
export function buildPinsChangedEvents(holders, rows) {
  const byUser = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const userId = row?.user_id;
    if (!userId) continue;
    const list = byUser.get(userId) || [];
    list.push(row);
    byUser.set(userId, list);
  }
  const events = [];
  for (const holder of Array.isArray(holders) ? holders : []) {
    const username = String(holder?.username || "").trim().toLowerCase();
    if (!username) continue;
    events.push({
      targetUsername: username,
      payload: {
        type: "chat_pins_changed",
        pinned: toPinnedPayload(byUser.get(holder.user_id) || []),
      },
    });
  }
  return events;
}
