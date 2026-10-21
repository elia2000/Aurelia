// What this browser knows about the pinned messages of each chat, kept outside
// React state so that a realtime event for ANY chat (one that is not open) lands
// in the right place, and the bar under the chat header re-draws on its own.
//
// Sources:
//   - GET /api/chats/:id/pins                -> loadChatPins (when a chat opens)
//   - the person's own pin / unpin / unpin-all -> the answer of the call is the list
//   - message_pinned / message_unpinned / messages_unpinned_all (realtime)
// The rules for the list are in ./messagePins.js (pure and tested).

import {
  listMessagePins,
  pinMessage,
  unpinAllMessages,
  unpinMessage,
} from "../api/pinsApi.js";
import { showToast } from "./toast.js";
import { getMaxPinnedMessages } from "./pinLimits.js";
import { normalizeUuid } from "./uuidUtils.js";
import {
  describePinError,
  hasPin,
  normalizePinList,
  removePin,
  samePins,
} from "./messagePins.js";

// Chats whose pins are remembered; the least recently used go first.
const MAX_RECORDS = 60;
// A reload after an edit of a pinned message waits for the burst to settle.
const PREVIEW_RELOAD_DELAY_MS = 350;
// A list that changed while it was being fetched is fetched again, this often at most.
const MAX_REFETCHES = 2;

const EMPTY = Object.freeze([]);

/**
 * status: idle (never asked) | loading | ready | stale (ask again when shown) | error
 * @type {Map<string, { pins: Array, status: string, version: number, inflight: Promise<void>|null, loadedAt: number }>}
 */
const records = new Map();
/** @type {Map<string, Set<() => void>>} */
const listeners = new Map();
/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const reloadTimers = new Map();
/** Writes on their way, "chat:message" or "chat:*", so a double tap is one call. */
const writing = new Set();

let boundUserId = null;

const notify = (chatId) => {
  const set = listeners.get(chatId);
  if (!set) return;
  for (const listener of [...set]) listener();
};

const touch = (chatId, record) => {
  records.delete(chatId);
  records.set(chatId, record);
  if (records.size <= MAX_RECORDS) return;
  for (const [id, other] of records) {
    if (records.size <= MAX_RECORDS) break;
    if (id === chatId || other.inflight) continue;
    records.delete(id);
    notify(id);
  }
};

const ensureRecord = (chatId) => {
  let record = records.get(chatId);
  if (!record) {
    record = { pins: EMPTY, status: "idle", version: 0, inflight: null, loadedAt: 0 };
    touch(chatId, record);
  }
  return record;
};

/** The pins of a chat, newest first (the same array until they change). */
export function getChatPins(chatId) {
  const id = normalizeUuid(chatId);
  return (id && records.get(id)?.pins) || EMPTY;
}

export function getChatPinsStatus(chatId) {
  const id = normalizeUuid(chatId);
  return (id && records.get(id)?.status) || "idle";
}

export function isMessagePinned(chatId, messageId) {
  return hasPin(getChatPins(chatId), messageId);
}

/** For useSyncExternalStore: calls `listener` when this chat's pins change. */
export function subscribeToChatPins(chatId, listener) {
  const id = normalizeUuid(chatId);
  if (!id) return () => {};
  let set = listeners.get(id);
  if (!set) {
    set = new Set();
    listeners.set(id, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (!set.size && listeners.get(id) === set) listeners.delete(id);
  };
}

// --- whose pins these are ---

export function resetPinStore() {
  reloadTimers.forEach((timer) => clearTimeout(timer));
  reloadTimers.clear();
  writing.clear();
  const known = [...records.keys()];
  records.clear();
  known.forEach(notify);
}

/** Forgets everything when another person signs in without a page reload. */
export function bindPinStoreToUser(userId) {
  const id = normalizeUuid(userId) || null;
  if (id === boundUserId) return;
  const previous = boundUserId;
  boundUserId = id;
  if (previous) resetPinStore();
}

// --- writing the list ---

function setPins(chatId, pins, { status = "ready", bump = true } = {}) {
  const record = ensureRecord(chatId);
  const changedPins = !samePins(record.pins, pins);
  const changedStatus = record.status !== status;
  if (bump) record.version += 1;
  if (changedPins) record.pins = pins.length ? pins : EMPTY;
  record.status = status;
  touch(chatId, record);
  if (changedPins || changedStatus) notify(chatId);
}

/** A list the server just sent (an answer to our own write or a read). */
const applyServerList = (chatId, rawPins) => {
  ensureRecord(chatId).loadedAt = Date.now();
  setPins(chatId, normalizePinList(rawPins));
};

// --- reading ---

/**
 * Asks the server for the pins of a chat. Without `force` a list that is
 * already known is left alone. Several callers share one request; a list that
 * changed while it travelled (a realtime event) is read again.
 */
export function loadChatPins(chatId, { force = false } = {}) {
  const id = normalizeUuid(chatId);
  if (!id) return Promise.resolve();
  const record = ensureRecord(id);
  if (record.inflight) {
    // The answer on its way may predate whatever made the caller ask again.
    if (force) record.version += 1;
    return record.inflight;
  }
  if (!force && (record.status === "ready" || record.status === "loading")) {
    return Promise.resolve();
  }
  const run = async () => {
    for (let attempt = 0; attempt <= MAX_REFETCHES; attempt += 1) {
      const startVersion = record.version;
      if (record.status !== "ready") {
        record.status = "loading";
        notify(id);
      }
      let response;
      let data = null;
      try {
        response = await listMessagePins(id);
        data = await response.json().catch(() => null);
      } catch {
        // Offline or aborted: keep what we know. It is read again when the
        // connection comes back (invalidateAllPins).
        setPins(id, record.pins, { status: "error", bump: false });
        return;
      }
      if (!response.ok) {
        // A chat we no longer belong to has no pins for us.
        const gone = response.status === 403 || response.status === 404;
        setPins(id, gone ? EMPTY : record.pins, { status: gone ? "ready" : "error", bump: false });
        return;
      }
      // An event arrived while the answer travelled: it may be older than the
      // event, so read again (a few times at most).
      if (record.version !== startVersion && attempt < MAX_REFETCHES) continue;
      applyServerList(id, data?.pins);
      return;
    }
  };
  record.inflight = run().finally(() => {
    record.inflight = null;
  });
  return record.inflight;
}

function scheduleReload(chatId) {
  if (reloadTimers.has(chatId)) return;
  reloadTimers.set(
    chatId,
    setTimeout(() => {
      reloadTimers.delete(chatId);
      void loadChatPins(chatId, { force: true });
    }, PREVIEW_RELOAD_DELAY_MS),
  );
}

// A list read this recently needs no second read when the connection opens.
const FRESH_MS = 4000;

/** Marks every list as old (the connection dropped and came back). */
export function invalidateAllPins() {
  const now = Date.now();
  for (const [id, record] of records) {
    if (record.status === "ready" && now - record.loadedAt < FRESH_MS) continue;
    if (record.status === "ready" || record.status === "error") {
      record.status = "stale";
      notify(id);
    }
  }
}

// --- the person's own changes ---

const failureNotice = (status, body) =>
  describePinError({ status, body, fallbackMax: getMaxPinnedMessages() });

async function write(key, chatId, { optimistic, request }) {
  if (writing.has(key)) return { ok: false, busy: true };
  writing.add(key);
  const record = ensureRecord(chatId);
  const before = { pins: record.pins, status: record.status };
  if (optimistic) setPins(chatId, optimistic(record.pins), { status: "ready" });
  const versionAfterOptimistic = record.version;
  try {
    const response = await request();
    const body = await response.json().catch(() => null);
    if (response.ok) {
      applyServerList(chatId, body?.pins);
      return { ok: true, status: response.status, body };
    }
    // Put back what was there, unless a newer event already changed the list.
    if (optimistic && record.version === versionAfterOptimistic) {
      setPins(chatId, before.pins, { status: before.status === "idle" ? "ready" : before.status });
    }
    if (response.status === 403 || response.status === 404) scheduleReload(chatId);
    showToast(failureNotice(response.status, body));
    return { ok: false, status: response.status, body };
  } catch {
    if (optimistic && record.version === versionAfterOptimistic) {
      setPins(chatId, before.pins, { status: before.status === "idle" ? "ready" : before.status });
    }
    showToast("Couldn't update the pinned messages. Check your connection.");
    return { ok: false, status: 0, body: null };
  } finally {
    writing.delete(key);
  }
}

export function pinChatMessage(chatId, messageId) {
  const chat = normalizeUuid(chatId);
  const message = normalizeUuid(messageId);
  if (!chat || !message) return Promise.resolve({ ok: false });
  return write(`${chat}:${message}`, chat, {
    request: () => pinMessage(chat, message),
  });
}

export function unpinChatMessage(chatId, messageId) {
  const chat = normalizeUuid(chatId);
  const message = normalizeUuid(messageId);
  if (!chat || !message) return Promise.resolve({ ok: false });
  return write(`${chat}:${message}`, chat, {
    optimistic: (pins) => removePin(pins, message),
    request: () => unpinMessage(chat, message),
  });
}

export function unpinAllChatMessages(chatId) {
  const chat = normalizeUuid(chatId);
  if (!chat) return Promise.resolve({ ok: false });
  return write(`${chat}:*`, chat, {
    optimistic: () => EMPTY,
    request: () => unpinAllMessages(chat),
  });
}

// --- realtime ---

export const PIN_EVENT_TYPES = new Set([
  "message_pinned",
  "message_unpinned",
  "messages_unpinned_all",
]);

/**
 * message_pinned says only WHICH message was pinned, so the list (with the
 * preview) is read again; the other two events are applied on the spot.
 * A chat that was never opened here has nothing to update.
 */
export function applyRealtimePinEvent(payload) {
  const chatId = normalizeUuid(payload?.chatId);
  const record = chatId ? records.get(chatId) : null;
  if (!record) return;
  if (payload.type === "message_pinned") {
    const messageId = normalizeUuid(payload?.messageId);
    if (!messageId || hasPin(record.pins, messageId)) return;
    void loadChatPins(chatId, { force: true });
    return;
  }
  if (payload.type === "message_unpinned") {
    const messageId = normalizeUuid(payload?.messageId);
    if (!messageId) return;
    record.version += 1;
    const next = removePin(record.pins, messageId);
    if (next !== record.pins) setPins(chatId, next, { status: record.status, bump: false });
    return;
  }
  if (payload.type === "messages_unpinned_all") {
    record.version += 1;
    setPins(chatId, EMPTY, { status: "ready", bump: false });
  }
}

/** A pinned message was edited: its preview is read again. */
export function refreshPinnedMessagePreview(chatId, messageId) {
  const id = normalizeUuid(chatId);
  const record = id ? records.get(id) : null;
  if (!record || !hasPin(record.pins, messageId)) return;
  scheduleReload(id);
}
