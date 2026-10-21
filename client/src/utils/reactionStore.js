// What this browser knows about message reactions, per message, outside React
// state so that a realtime event for ANY message (one that is not drawn, one in
// another chat) lands in the right place and the chips of a drawn message
// update on their own without the message list re-rendering.
//
// Three sources feed it:
//   - the message list (GET /api/messages)   -> syncReactionsFromServer / seedReactions
//   - the `message_reactions` realtime event -> applyRealtimeReaction
//   - the person's own taps                  -> toggleReaction (optimistic, rolled back on error)
// The rules for each are in ./reactions.js (pure and tested).

import { reactToMessage } from "../api/reactionsApi.js";
import { showToast } from "./toast.js";
import { normalizeUuid } from "./uuidUtils.js";
import {
  DEFAULT_MAX_REACTIONS_PER_USER,
  SHOW_REACTORS_EVENT,
  applyReactionEvent,
  applyServerSummary,
  applyToggle,
  canonicalizeEmoji,
  clampMaxReactions,
  getReactionMessageId,
  listFromEntry,
  normalizeReactionList,
  reactionErrorMessage,
  replaceEntry,
  revertToggle,
  seedEntry,
} from "./reactions.js";

// Reactions of this many messages are remembered; the least recently touched
// go first. (A busy session sees a few thousand at most.)
const MAX_RECORDS = 4000;

const EMPTY_LIST = Object.freeze([]);

/** @type {Map<string, { entry: object, list: Array|null, touchedAt: number }>} */
const records = new Map();
/** @type {Map<string, Set<() => void>>} */
const listeners = new Map();
/** @type {Map<string, { pending: number, chain: Promise<unknown> }>} */
const inflight = new Map();

let maxReactionsPerUser = DEFAULT_MAX_REACTIONS_PER_USER;
let boundUserId = null;

const notify = (id) => {
  const set = listeners.get(id);
  if (!set) return;
  for (const listener of [...set]) listener();
};

const trim = () => {
  if (records.size <= MAX_RECORDS) return;
  for (const id of records.keys()) {
    if (records.size <= MAX_RECORDS) break;
    // a message with a tap on its way is kept
    if (inflight.get(id)?.pending) continue;
    records.delete(id);
    notify(id);
  }
};

const sameEntry = (a, b) =>
  a === b ||
  (a &&
    b &&
    a.mineKnown === b.mineKnown &&
    a.items.length === b.items.length &&
    a.mine.length === b.mine.length &&
    a.items.every((item, i) => item.emoji === b.items[i].emoji && item.count === b.items[i].count) &&
    a.mine.every((emoji, i) => emoji === b.mine[i]));

function setEntry(id, entry, { touch = true } = {}) {
  const previous = records.get(id);
  if (previous && sameEntry(previous.entry, entry)) {
    if (touch) previous.touchedAt = Date.now();
    return false;
  }
  records.delete(id);
  records.set(id, {
    entry,
    list: null,
    touchedAt: touch ? Date.now() : previous?.touchedAt || 0,
  });
  trim();
  notify(id);
  return true;
}

/** The reaction chips of a message: [{ emoji, count, reacted }] (stable until it changes). */
export function getReactionList(messageId) {
  const id = normalizeUuid(messageId);
  const record = id ? records.get(id) : null;
  if (!record || !record.entry.items.length) return EMPTY_LIST;
  if (!record.list) record.list = listFromEntry(record.entry);
  return record.list;
}

export function getReactionEntry(messageId) {
  const id = normalizeUuid(messageId);
  return (id && records.get(id)?.entry) || null;
}

/** For useSyncExternalStore: calls `listener` when this message's reactions change. */
export function subscribeToReactions(messageId, listener) {
  const id = normalizeUuid(messageId);
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

// --- whose reactions these are ---

/**
 * Tells the store who is signed in. When another person signs in without the
 * page being reloaded, what the store knows (which reactions were "mine")
 * belongs to the person before and is forgotten; the chips draw empty until
 * the messages are read again.
 */
export function bindReactionStoreToUser(userId) {
  const id = normalizeUuid(userId) || null;
  if (id === boundUserId) return;
  const previous = boundUserId;
  boundUserId = id;
  if (!previous) return;
  const known = [...records.keys()];
  records.clear();
  inflight.clear();
  for (const messageId of known) notify(messageId);
}

// --- how many reactions one person may leave on one message ---

// Read when a tap is planned, so no screen needs to follow it.
export function setMaxReactionsPerUser(value) {
  maxReactionsPerUser = clampMaxReactions(value);
}
export const getMaxReactionsPerUser = () => maxReactionsPerUser;

// --- from the message list ---

/**
 * Messages that were just drawn (from the screen's state or the cache): lets a
 * message we know nothing about start with the reactions it came with, and an
 * entry that came from an event learn which reactions are mine. What we
 * already know is never replaced by this older data.
 */
export function seedReactions(messages) {
  if (!Array.isArray(messages)) return;
  for (const msg of messages) {
    if (!Array.isArray(msg?.reactions)) continue;
    const id = getReactionMessageId(msg);
    if (!id) continue;
    const record = records.get(id);
    if (record?.entry.mineKnown) continue;
    const list = normalizeReactionList(msg.reactions);
    if (!record && !list.length) continue;
    setEntry(id, seedEntry(record?.entry, list), { touch: false });
  }
}

/**
 * Messages that just came from the server: the truth as of `startedAt` (when
 * the request was sent). A message touched by an event or a tap since then is
 * newer than this answer, and is left alone.
 */
export function syncReactionsFromServer(messages, { startedAt = 0 } = {}) {
  if (!Array.isArray(messages)) return;
  for (const msg of messages) {
    if (!Array.isArray(msg?.reactions)) continue;
    const id = normalizeUuid(msg?.id) || getReactionMessageId(msg);
    if (!id) continue;
    const record = records.get(id);
    if (record && record.touchedAt > startedAt) continue;
    if (inflight.get(id)?.pending) continue;
    const list = normalizeReactionList(msg.reactions);
    if (!record && !list.length) continue;
    setEntry(id, replaceEntry(record?.entry, list), { touch: false });
  }
}

// --- realtime ---

/** The `message_reactions` event. `selfId` is the signed-in person's id. */
export function applyRealtimeReaction(payload, selfId) {
  const id = normalizeUuid(payload?.messageId);
  if (!id || !Array.isArray(payload?.counts)) return;
  const record = records.get(id);
  setEntry(id, applyReactionEvent(record?.entry, payload, selfId));
}

// --- the person's own taps ---

const errorText = (status, data) => reactionErrorMessage(status, data?.error);

/**
 * Taps `emoji` on a message (the same emoji again removes it; null removes all
 * of mine). The screen changes at once and goes back if the server refuses.
 * Taps on one message are sent one after the other.
 * @returns {Promise<{ ok: boolean, status?: number }>}
 */
export function toggleReaction({ chatId, messageId, emoji }) {
  const id = normalizeUuid(messageId);
  const chat = normalizeUuid(chatId);
  if (!id || !chat) return Promise.resolve({ ok: false, status: 400 });
  const canonical = emoji === null || emoji === undefined || emoji === "" ? null : canonicalizeEmoji(emoji);

  const before = records.get(id)?.entry;
  const { entry: optimistic, plan } = applyToggle(before, canonical, maxReactionsPerUser);
  setEntry(id, optimistic);

  const state = inflight.get(id) || { pending: 0, chain: Promise.resolve() };
  state.pending += 1;
  inflight.set(id, state);

  const finish = () => {
    state.pending -= 1;
    if (state.pending <= 0 && inflight.get(id) === state) inflight.delete(id);
  };

  const run = async () => {
    try {
      const response = await reactToMessage({ chatId: chat, messageId: id, emoji: canonical });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setEntry(id, revertToggle(records.get(id)?.entry, plan));
        showToast(errorText(response.status, data));
        return { ok: false, status: response.status };
      }
      // Only the last answer of a burst of taps is the truth about the end state.
      if (state.pending <= 1 && Array.isArray(data?.reactions)) {
        setEntry(id, applyServerSummary(records.get(id)?.entry, data.reactions));
      }
      return { ok: true, status: response.status };
    } catch {
      setEntry(id, revertToggle(records.get(id)?.entry, plan));
      showToast("Couldn't update the reaction. Check your connection.");
      return { ok: false, status: 0 };
    } finally {
      finish();
    }
  };

  const result = state.chain.then(run, run);
  state.chain = result.catch(() => null);
  return result;
}

// --- "who reacted" ---

/** Asks the chips of a message to open the list of people who reacted (the menu item does). */
export function requestShowReactors(messageId, emoji = "") {
  const id = normalizeUuid(messageId);
  if (!id || typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(SHOW_REACTORS_EVENT, { detail: { messageId: id, emoji } }));
}

// --- the cache of chats ---

/**
 * What to write into a cached message so that a reload shows the reactions as
 * they are now: the list we hold, or null to leave the message's own.
 */
export function getReactionsForCache(messageId) {
  const id = normalizeUuid(messageId);
  const record = id ? records.get(id) : null;
  if (!record || !record.entry.mineKnown) return null;
  return listFromEntry(record.entry);
}

/** For tests. */
export function resetReactionStore() {
  records.clear();
  listeners.clear();
  inflight.clear();
  maxReactionsPerUser = DEFAULT_MAX_REACTIONS_PER_USER;
  boundUserId = null;
}
