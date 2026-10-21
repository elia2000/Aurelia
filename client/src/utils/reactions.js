// Message reactions: the rules, with no I/O and no React, so they are unit
// tested on their own. The server (server/lib/reactions.js) is the source of
// truth; the functions here only mirror it where the screen has to guess ahead
// (the optimistic update) and shape what the server sends.
//
// An "entry" is what the client knows about one message's reactions:
//   items:     [{ emoji, count }]   most used first (the server's order)
//   mine:      [emoji]              what the signed-in person reacted with, oldest first
//   mineKnown: boolean              false when it was built from a realtime event alone
//                                   (the event carries counts, not who is "me")
// A list ([{ emoji, count, reacted }]) is the same thing in the shape the
// message list and the chips use.

import { normalizeUuid } from "./uuidUtils.js";

/** The seven reactions offered first, like Telegram's quick reaction bar. */
export const QUICK_REACTIONS = Object.freeze([
  "\u{1F44D}", // thumbs up
  "\u2764\uFE0F", // red heart
  "\u{1F525}", // fire
  "\u{1F970}", // smiling face with hearts
  "\u{1F44F}", // clapping hands
  "\u{1F601}", // beaming face
  "\u{1F914}", // thinking face
]);

/** What a double click / double tap on a message toggles. */
export const HEART_REACTION = "\u2764\uFE0F";

export const MAX_REACTION_UTF16_UNITS = 32;
export const DEFAULT_MAX_REACTIONS_PER_USER = 1;
export const MIN_MAX_REACTIONS_PER_USER = 1;
export const MAX_MAX_REACTIONS_PER_USER = 3;

/** The server lists at most this many people per request. */
export const REACTION_USERS_CAP = 200;

// Same rule as the server: a text-style symbol (a heart, a smiley face) and its
// emoji spelling (+ U+FE0F) are one reaction.
const ELEMENT_G_RE =
  /(?=\p{Emoji})(\p{Extended_Pictographic})(\uFE0F|\p{Emoji_Modifier})?((?:[\u{E0020}-\u{E007E}]+\u{E007F})?)/gu;
const EMOJI_PRESENTATION_RE = /^\p{Emoji_Presentation}$/u;
const KEYCAP_RE = /^([0-9#*])\uFE0F?\u20E3$/u;

/** The emoji in the one spelling the server stores. */
export function canonicalizeEmoji(emoji) {
  const value = String(emoji ?? "");
  const keycap = KEYCAP_RE.exec(value);
  if (keycap) return `${keycap[1]}\uFE0F\u20E3`;
  return value.replace(ELEMENT_G_RE, (match, base, selector, tags) =>
    selector || tags || EMOJI_PRESENTATION_RE.test(base) ? match : `${base}\uFE0F`,
  );
}

/** Reactions one person may have on one message, as a whole number from 1 to 3. */
export function clampMaxReactions(value) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_MAX_REACTIONS_PER_USER;
  return Math.min(MAX_MAX_REACTIONS_PER_USER, Math.max(MIN_MAX_REACTIONS_PER_USER, n));
}

const isUsableEmoji = (emoji) =>
  typeof emoji === "string" && emoji.length > 0 && emoji.length <= MAX_REACTION_UTF16_UNITS;

const toCount = (value) => {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** [{ emoji, count, reacted }] from whatever the server sent: junk is left out. */
export function normalizeReactionList(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const list = [];
  for (const item of raw) {
    const emoji = item?.emoji;
    const count = toCount(item?.count);
    if (!isUsableEmoji(emoji) || !count || seen.has(emoji)) continue;
    seen.add(emoji);
    list.push({ emoji, count, reacted: Boolean(item?.reacted) });
  }
  return list;
}

/** [{ emoji, count }] from an event's `counts`. */
export function normalizeCounts(raw) {
  return normalizeReactionList(raw).map(({ emoji, count }) => ({ emoji, count }));
}

/** The entry for a list that came from the server (the reacted flags are known). */
export function entryFromList(raw) {
  const list = normalizeReactionList(raw);
  return {
    items: list.map(({ emoji, count }) => ({ emoji, count })),
    mine: list.filter((item) => item.reacted).map((item) => item.emoji),
    mineKnown: true,
  };
}

/** [{ emoji, count, reacted }] for the chips. */
export function listFromEntry(entry) {
  if (!entry) return [];
  const mine = new Set(entry.mine);
  return entry.items.map(({ emoji, count }) => ({ emoji, count, reacted: mine.has(emoji) }));
}

const presentEmoji = (items) => new Set(items.map((item) => item.emoji));

/**
 * A fresh server list for a message we already know (a reload, a refresh after
 * a reconnect). The order the person reacted in is not in the list, so what we
 * remember of it is kept for the reactions that are still there.
 */
export function replaceEntry(entry, rawList) {
  const next = entryFromList(rawList);
  if (!entry) return next;
  const known = entry.mine.filter((emoji) => next.mine.includes(emoji));
  const added = next.mine.filter((emoji) => !known.includes(emoji));
  return { ...next, mine: [...known, ...added] };
}

/**
 * A list from the message list or the cache, which may be older than what we
 * hold. It never replaces counts we have; it only supplies the one thing a
 * realtime event cannot: which reactions are mine.
 */
export function seedEntry(entry, rawList) {
  if (!entry) return entryFromList(rawList);
  if (entry.mineKnown) return entry;
  const list = normalizeReactionList(rawList);
  const present = presentEmoji(entry.items);
  const fromList = list.filter((item) => item.reacted && present.has(item.emoji)).map((item) => item.emoji);
  const mine = [...entry.mine, ...fromList.filter((emoji) => !entry.mine.includes(emoji))];
  return { ...entry, mine, mineKnown: true };
}

const sameId = (a, b) =>
  Boolean(a) && Boolean(b) && String(a).toLowerCase() === String(b).toLowerCase();

/**
 * The server's `message_reactions` event on top of what we hold. `counts` is
 * the complete current summary; who is "me" comes from the actor fields: when
 * the actor is the signed-in person, `actorEmoji` was added and
 * `removedEmojis` were taken away (also by their other devices).
 */
export function applyReactionEvent(entry, payload, selfId) {
  const items = normalizeCounts(payload?.counts);
  let mine = entry ? [...entry.mine] : [];
  if (sameId(payload?.actorId, selfId)) {
    const removed = new Set(
      Array.isArray(payload?.removedEmojis)
        ? payload.removedEmojis
        : payload?.removedEmoji
          ? [payload.removedEmoji]
          : [],
    );
    mine = mine.filter((emoji) => !removed.has(emoji));
    const added = payload?.actorEmoji;
    if (isUsableEmoji(added) && !mine.includes(added)) mine.push(added);
  }
  const present = presentEmoji(items);
  mine = mine.filter((emoji) => present.has(emoji));
  return { items, mine, mineKnown: entry ? entry.mineKnown : false };
}

/**
 * The POST /api/messages/react answer: the full summary with the caller's
 * flags, so it is the truth about "mine" too.
 */
export function applyServerSummary(entry, rawList) {
  return replaceEntry(entry, rawList);
}

/**
 * What a tap changes: the same as the server's planReactionChange, so the
 * screen can show the result before the answer arrives. `current` is the
 * person's own emoji, oldest first; `requested` null removes all of them.
 * @returns {{ add: string|null, remove: string[] }}
 */
export function planReactionChange(current, requested, max) {
  const existing = Array.isArray(current) ? current : [];
  if (requested === null || requested === undefined) {
    return { add: null, remove: [...existing] };
  }
  if (existing.includes(requested)) {
    return { add: null, remove: [requested] };
  }
  const limit = clampMaxReactions(max);
  const overflow = Math.max(0, existing.length - (limit - 1));
  return { add: requested, remove: existing.slice(0, overflow) };
}

/**
 * Changes an entry by a delta: the `remove` emoji lose one count (and leave
 * `mine`), the `add` emoji gain one (and join `mine`). Most used first, ties
 * keep their order.
 */
export function applyDelta(entry, { remove = [], add = [] }) {
  const base = entry || { items: [], mine: [], mineKnown: true };
  const removed = new Set(remove);
  let items = base.items
    .map((item) => (removed.has(item.emoji) ? { ...item, count: item.count - 1 } : item))
    .filter((item) => item.count > 0);
  let mine = base.mine.filter((emoji) => !removed.has(emoji));
  for (const emoji of add) {
    const at = items.findIndex((item) => item.emoji === emoji);
    items =
      at >= 0
        ? items.map((item, i) => (i === at ? { ...item, count: item.count + 1 } : item))
        : [...items, { emoji, count: 1 }];
    if (!mine.includes(emoji)) mine = [...mine, emoji];
  }
  items = items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => b.item.count - a.item.count || a.index - b.index)
    .map(({ item }) => item);
  return { ...base, items, mine };
}

const deltaOf = (plan) => ({ remove: plan.remove, add: plan.add ? [plan.add] : [] });

/** Optimistic update for tapping `emoji` (null clears): the new entry and the plan. */
export function applyToggle(entry, emoji, max) {
  const plan = planReactionChange(entry?.mine || [], emoji, max);
  return { entry: applyDelta(entry, deltaOf(plan)), plan };
}

/** Puts back what an optimistic tap changed (the request failed). */
export function revertToggle(entry, plan) {
  const { remove, add } = deltaOf(plan);
  return applyDelta(entry, { remove: add, add: remove });
}

/** True for the messages that cannot be reacted to (system lines, call entries). */
export function isNonReactableMessage(msg) {
  if (!msg || typeof msg !== "object") return true;
  if (msg._systemEvent) return true;
  if (msg.messageType === "call" || msg.type === "call" || msg.call) return true;
  return /^\[\[system:/i.test(String(msg.body ?? ""));
}

/** The id the server knows the message by, or null while it is only local. */
export function getReactionMessageId(msg) {
  if (!msg || typeof msg !== "object") return null;
  return normalizeUuid(msg._serverId) || normalizeUuid(msg.id) || null;
}

/** Can this message take a reaction right now? */
export function canReactToMessage(msg) {
  if (isNonReactableMessage(msg)) return false;
  if (msg._delivery === "sending" || msg._delivery === "failed") return false;
  if (msg._awaitingServerEcho || msg._processingPending) return false;
  return Boolean(getReactionMessageId(msg));
}

/** "👍 3 reactions, you reacted" */
export function reactionAriaLabel({ emoji, count, reacted }) {
  const n = Math.max(0, Number(count) || 0);
  const noun = n === 1 ? "reaction" : "reactions";
  return `${emoji} ${n} ${noun}${reacted ? ", you reacted" : ""}`;
}

/** The server's error text, or a plain one for the status. */
export function reactionErrorMessage(status, serverMessage) {
  if (status === 429) return "Too many reactions. Please slow down.";
  if (status === 404) return "That message is no longer available.";
  if (status === 403) return "You can't react in this chat.";
  const text = String(serverMessage || "").trim();
  return text || "Couldn't update the reaction. Try again.";
}

// --- who reacted ---

/** Window event that asks the chips of one message to open the "who reacted" list. */
export const SHOW_REACTORS_EVENT = "aurelle:show-reactors";

/**
 * May this person see who reacted? In a channel only its owner may (the
 * subscribers are strangers to each other); everywhere else every member may.
 */
export function canListReactors({ chatType, isOwner }) {
  return String(chatType || "").toLowerCase() === "channel" ? Boolean(isOwner) : true;
}

const reactorName = (user) => String(user?.nickname || user?.username || "").trim() || "Unknown";

/**
 * The answer of GET /api/messages/reactions as the list draws it:
 * `{ groups: [{ emoji, count, users: [{ id, name, avatarUrl, color }] }], total, truncated }`.
 * Junk is left out; `total` is the number of reactions (a person who used two
 * emoji counts twice), `count` of a group is the server's true total.
 */
export function normalizeReactorGroups(raw) {
  const source = Array.isArray(raw?.reactions) ? raw.reactions : [];
  const groups = [];
  const seen = new Set();
  for (const group of source) {
    const emoji = group?.emoji;
    if (!isUsableEmoji(emoji) || seen.has(emoji)) continue;
    seen.add(emoji);
    const users = (Array.isArray(group?.users) ? group.users : [])
      .filter((user) => user && (user.id || user.username))
      .map((user) => ({
        id: String(user.id || user.username),
        name: reactorName(user),
        username: String(user.username || ""),
        avatarUrl: String(user.avatarUrl || ""),
        color: String(user.color || ""),
      }));
    groups.push({ emoji, count: Math.max(toCount(group?.count), users.length), users });
  }
  return {
    groups,
    total: groups.reduce((sum, group) => sum + group.count, 0),
    truncated: Boolean(raw?.truncated),
  };
}

/**
 * The rows of one tab of the list. `emoji` "" is the "All" tab: one row per
 * person, with every emoji they used; an emoji tab lists the people who used it.
 * @returns {Array<{ id: string, name: string, avatarUrl: string, color: string, emojis: string[] }>}
 */
export function buildReactorRows(groups, emoji = "") {
  const rows = new Map();
  for (const group of Array.isArray(groups) ? groups : []) {
    if (emoji && group.emoji !== emoji) continue;
    for (const user of group.users) {
      const row = rows.get(user.id);
      if (row) row.emojis.push(group.emoji);
      else rows.set(user.id, { ...user, emojis: [group.emoji] });
    }
  }
  return [...rows.values()];
}

/** The text for a failed "who reacted" request. */
export function reactorsErrorMessage(status, serverMessage) {
  if (status === 403) return "Only the channel owner can see who reacted.";
  if (status === 404) return "That message is no longer available.";
  if (status === 429) return "Too many requests. Try again in a moment.";
  const text = String(serverMessage || "").trim();
  return text || "Couldn't load the list. Try again.";
}
