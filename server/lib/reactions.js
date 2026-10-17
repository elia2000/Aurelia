// Pure helpers for message reactions. No I/O, so every rule here is unit
// tested without a database.

export const MAX_REACTION_UTF16_UNITS = 32;
export const REACTION_USERS_CAP = 200;
export const REACTIONS_PER_USER_MIN = 1;
export const REACTIONS_PER_USER_MAX = 3;
export const REACTIONS_PER_USER_DEFAULT = 1;

// One emoji "element": a pictographic character (with an optional emoji/text
// variation selector or skin tone) and an optional tag sequence (the England,
// Scotland and Wales flags). `(?=\p{Emoji})` keeps out the unassigned code
// points that are Extended_Pictographic only so that future emoji work.
const ELEMENT_SOURCE =
  String.raw`(?=\p{Emoji})\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?(?:[\u{E0020}-\u{E007E}]+\u{E007F})?`;

// A single emoji is either a (ZWJ-joined) sequence of elements, a flag made of
// two regional indicators, or a keycap (1 + optional VS16 + U+20E3).
const SINGLE_EMOJI_RE = new RegExp(
  String.raw`^(?:${ELEMENT_SOURCE}(?:‍${ELEMENT_SOURCE})*|\p{Regional_Indicator}{2}|[0-9#*]️?⃣)$`,
  "u",
);

const ELEMENT_G_RE = new RegExp(
  String.raw`(?=\p{Emoji})(\p{Extended_Pictographic})(️|\p{Emoji_Modifier})?((?:[\u{E0020}-\u{E007E}]+\u{E007F})?)`,
  "gu",
);
const EMOJI_PRESENTATION_RE = /^\p{Emoji_Presentation}$/u;
const KEYCAP_RE = /^([0-9#*])️?⃣$/u;

const graphemeSegmenter =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter("en", { granularity: "grapheme" })
    : null;

function isSingleGrapheme(value) {
  if (!graphemeSegmenter) return true;
  let count = 0;
  for (const _segment of graphemeSegmenter.segment(value)) {
    count += 1;
    if (count > 1) return false;
  }
  return count === 1;
}

// Text-style symbols (a heart, a smiley face, ...) are sent with and without
// the emoji variation selector by different keyboards. Store one spelling so
// they are the same reaction and toggle each other.
function canonicalizeEmoji(emoji) {
  const keycap = KEYCAP_RE.exec(emoji);
  if (keycap) return `${keycap[1]}️⃣`;
  return emoji.replace(ELEMENT_G_RE, (match, base, selector, tags) =>
    selector || tags || EMOJI_PRESENTATION_RE.test(base) ? match : `${base}️`,
  );
}

/**
 * Validates that `value` is exactly one emoji (one grapheme cluster, at most
 * 32 UTF-16 units) and returns its canonical spelling. Arbitrary text, several
 * emoji, whitespace and non-strings are rejected.
 */
export function normalizeReactionEmoji(value) {
  if (typeof value !== "string" || value.length === 0) {
    return { ok: false, error: "Reaction must be a single emoji." };
  }
  if (value.length > MAX_REACTION_UTF16_UNITS) {
    return { ok: false, error: "Reaction must be a single emoji." };
  }
  if (!isSingleGrapheme(value) || !SINGLE_EMOJI_RE.test(value)) {
    return { ok: false, error: "Reaction must be a single emoji." };
  }
  const emoji = canonicalizeEmoji(value);
  if (emoji.length > MAX_REACTION_UTF16_UNITS) {
    return { ok: false, error: "Reaction must be a single emoji." };
  }
  return { ok: true, emoji };
}

/**
 * Interprets the `emoji` field of a react request: `null` or "" means "remove
 * my reaction(s)"; anything else must be a single emoji. A missing field is an
 * error so a malformed body can never wipe reactions by accident.
 */
export function parseReactRequestEmoji(value) {
  if (value === null || value === "") return { ok: true, emoji: null };
  if (value === undefined) {
    return { ok: false, error: "Field 'emoji' is required (use null to remove your reaction)." };
  }
  return normalizeReactionEmoji(value);
}

/** The `MAX_REACTIONS_PER_USER` setting, clamped to the supported 1-3 range. */
export function clampReactionsPerUser(value) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return REACTIONS_PER_USER_DEFAULT;
  return Math.min(REACTIONS_PER_USER_MAX, Math.max(REACTIONS_PER_USER_MIN, n));
}

/**
 * Decides what a react request changes (Telegram semantics).
 *
 * @param {string[]} current  the caller's emoji on the message, oldest first
 * @param {string|null} requested  the emoji sent (null = remove everything)
 * @param {number} max  reactions one person may have on one message
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
  const limit = clampReactionsPerUser(max);
  // Make room for the new one by dropping the oldest. With a limit of 1 this
  // replaces the previous reaction.
  const overflow = Math.max(0, existing.length - (limit - 1));
  return { add: requested, remove: existing.slice(0, overflow) };
}

/**
 * Groups aggregate rows ({ message_id, emoji, count, first_at, reacted }) into
 * Map<messageId, [{ emoji, count, reacted }]>, most used first, ties broken by
 * who reacted first.
 */
export function summarizeReactionRows(rows) {
  const grouped = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const messageId = row?.message_id;
    const emoji = row?.emoji;
    if (!messageId || !emoji) continue;
    const list = grouped.get(messageId) || [];
    list.push({
      emoji,
      count: Number(row.count) || 0,
      reacted: Boolean(Number(row.reacted)),
      firstAt: String(row.first_at || ""),
    });
    grouped.set(messageId, list);
  }
  const result = new Map();
  for (const [messageId, list] of grouped) {
    list.sort(
      (a, b) =>
        b.count - a.count ||
        (a.firstAt < b.firstAt ? -1 : a.firstAt > b.firstAt ? 1 : 0) ||
        (a.emoji < b.emoji ? -1 : a.emoji > b.emoji ? 1 : 0),
    );
    result.set(
      messageId,
      list.map(({ emoji, count, reacted }) => ({ emoji, count, reacted })),
    );
  }
  return result;
}

/** The broadcast form of a summary: no per-viewer `reacted` flag. */
export function toReactionCounts(reactions) {
  return (Array.isArray(reactions) ? reactions : []).map(({ emoji, count }) => ({
    emoji,
    count,
  }));
}

// Service messages ("X joined", ...) cannot be reacted to; see serviceMessages.js.
export { isServiceMessageBody } from "./serviceMessages.js";
