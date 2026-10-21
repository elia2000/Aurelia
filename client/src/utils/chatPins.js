// Pinned chats ("Pin to top"): the rules for ordering, reordering and for the
// notices the person gets. Everything here is a pure function of its inputs;
// the state lives in the chat list (`pinned` and `pinPosition` on each chat,
// seeded by GET /api/chats and replaced by the `chat_pins_changed` event) and
// the network calls in hooks/chat/useChatPins.js.
//
// The server owns the order: `pinPosition` 0 is the top, and the numbers are
// only an order key (there can be gaps).

import { normalizeUuid } from "./uuidUtils.js";

export const DEFAULT_MAX_PINNED_CHATS = 5;
const MIN_MAX_PINNED_CHATS = 1;
const MAX_MAX_PINNED_CHATS = 30;

/** The limit the server reports (1-30); the default when it is missing. */
export function clampMaxPinnedChats(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < MIN_MAX_PINNED_CHATS) return DEFAULT_MAX_PINNED_CHATS;
  return Math.min(MAX_MAX_PINNED_CHATS, Math.trunc(n));
}

/** True for a chat the person pinned. */
export const isChatPinned = (chat) => Boolean(chat) && chat.pinned === true;

const positionOf = (chat) => {
  const n = Number(chat?.pinPosition);
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
};

/**
 * The server's list ([{ chatId, position }], top first) made safe: valid ids
 * only, each chat once (its first entry wins), sorted by position.
 */
export function normalizePinnedList(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const list = [];
  raw.forEach((entry, order) => {
    const chatId = normalizeUuid(entry?.chatId);
    const position = Number(entry?.position);
    if (!chatId || !Number.isFinite(position) || seen.has(chatId)) return;
    seen.add(chatId);
    list.push({ chatId, position, order });
  });
  list.sort((a, b) => a.position - b.position || a.order - b.order);
  return list.map(({ chatId, position }) => ({ chatId, position }));
}

/**
 * Sets `pinned` and `pinPosition` on every chat from the server's full list
 * (replace, never merge). Returns the same array when nothing changed, so
 * applying the same event twice (the device that made the change hears it
 * again) costs no re-render.
 */
export function applyPinnedList(chats, rawList) {
  if (!Array.isArray(chats)) return chats;
  const positions = new Map(
    normalizePinnedList(rawList).map((entry) => [entry.chatId, entry.position]),
  );
  let changed = false;
  const next = chats.map((chat) => {
    const id = normalizeUuid(chat?.id);
    const position = id ? positions.get(id) : undefined;
    const pinned = position !== undefined;
    const wantedPosition = pinned ? position : null;
    if (
      Boolean(chat?.pinned) === pinned &&
      (chat?.pinPosition ?? null) === wantedPosition
    ) {
      return chat;
    }
    changed = true;
    return { ...chat, pinned, pinPosition: wantedPosition };
  });
  return changed ? next : chats;
}

/** Pinned chats first, in the person's order, then the others as they were. */
export function orderChatsWithPins(chats) {
  if (!Array.isArray(chats) || !chats.some(isChatPinned)) return chats;
  const pinned = [];
  const rest = [];
  chats.forEach((chat, index) => {
    if (isChatPinned(chat)) pinned.push({ chat, index });
    else rest.push(chat);
  });
  pinned.sort((a, b) => positionOf(a.chat) - positionOf(b.chat) || a.index - b.index);
  return [...pinned.map((entry) => entry.chat), ...rest];
}

/** The ids of the pinned chats, top first. */
export function getPinnedChatIds(chats) {
  if (!Array.isArray(chats)) return [];
  return orderChatsWithPins(chats.filter(isChatPinned)).map((chat) => chat.id);
}

/** Sets the pin positions to follow `orderedIds` (the first is the top). */
export function applyPinnedOrder(chats, orderedIds) {
  return applyPinnedList(
    chats,
    (orderedIds || []).map((chatId, position) => ({ chatId, position })),
  );
}

/** Moves the item at `from` to `to`; the same array when nothing moves. */
export function reorderIds(ids, from, to) {
  if (!Array.isArray(ids)) return [];
  const last = ids.length - 1;
  if (from === to || from < 0 || from > last) return ids;
  const target = Math.min(Math.max(to, 0), last);
  if (target === from) return ids;
  const next = ids.slice();
  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved);
  return next;
}

/** Moves one id up (-1) or down (+1); the same array at the ends. */
export function moveId(ids, id, delta) {
  const from = ids.indexOf(id);
  if (from < 0) return ids;
  return reorderIds(ids, from, from + delta);
}

/**
 * What the menu of a chat row may offer: pin or unpin, and (for a pinned
 * chat) a move up or down. `atLimit` is only a hint; the server decides.
 */
export function getChatPinActions(chat, chats, { max = null } = {}) {
  const pinned = isChatPinned(chat);
  const ids = getPinnedChatIds(chats);
  const index = pinned ? ids.indexOf(chat.id) : -1;
  const limit = Number(max);
  return {
    pinned,
    index,
    count: ids.length,
    atLimit: !pinned && Number.isFinite(limit) && limit > 0 && ids.length >= limit,
    canMoveUp: pinned && index > 0,
    canMoveDown: pinned && index >= 0 && index < ids.length - 1,
  };
}

// --- dragging a pinned row ---

/**
 * The slot a dragged row would drop into: `startIndex` moved by how many whole
 * rows the pointer travelled, kept inside the pinned block.
 */
export function dropIndexFor({ startIndex, offsetY, rowHeight, count }) {
  const rows = Math.max(0, Math.trunc(count));
  if (!rows) return 0;
  const start = Math.min(Math.max(Math.trunc(startIndex), 0), rows - 1);
  if (!Number.isFinite(offsetY) || !(rowHeight > 0)) return start;
  return Math.min(Math.max(Math.round(start + offsetY / rowHeight), 0), rows - 1);
}

/** How far the dragged row may travel up and down without leaving the block. */
export function dragOffsetLimits({ startIndex, count, rowHeight }) {
  return {
    min: -startIndex * rowHeight,
    max: Math.max(0, count - 1 - startIndex) * rowHeight,
  };
}

/** The pixels a row that is NOT being dragged slides to make room. */
export function shiftForRow({ index, fromIndex, toIndex, rowHeight }) {
  if (index === fromIndex || fromIndex === toIndex) return 0;
  if (fromIndex < toIndex && index > fromIndex && index <= toIndex) return -rowHeight;
  if (fromIndex > toIndex && index >= toIndex && index < fromIndex) return rowHeight;
  return 0;
}

// --- notices ---

export function pinLimitMessage(max) {
  const n = Number(max);
  if (!Number.isFinite(n) || n < 1) return "You can't pin more chats. Unpin one first.";
  return `You can pin up to ${Math.trunc(n)} ${n === 1 ? "chat" : "chats"}`;
}

/**
 * The notice for a refused pin or reorder. `body` is the server's JSON
 * ({ error, code, max }); `fallbackMax` is the limit /api/app/info reported.
 */
export function describeChatPinError({ status, body, fallbackMax = null } = {}) {
  const code = body?.code;
  if (code === "pin_limit") return pinLimitMessage(body?.max ?? fallbackMax);
  if (code === "chat_hidden") return "This chat is hidden. Open it again to pin it.";
  if (code === "pin_set_mismatch") return "Your pinned chats changed on another device.";
  if (status === 429) return "Too many pin changes. Try again in a minute.";
  if (status === 403) return "You can't pin this chat.";
  return "Couldn't update the pinned chats.";
}
