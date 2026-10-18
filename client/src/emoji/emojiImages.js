import emojiRegex from "emoji-regex";
// A message of only a few emoji is shown big; how big is the person's choice
// (Settings -> Appearance). Loading this also puts that choice on the page.
import "./emojiSize.js";

// Emoji are shown as Apple-style pictures (like Telegram does) instead of
// whatever the device draws. The pictures are served from /emoji/apple/64/ (the
// build copies them from the `emoji-datasource-apple` package); where one is
// missing the browser shows the alt text, which is the plain emoji.

export const EMOJI_IMAGE_BASE = "/emoji/apple/64/";
/** A message of at most this many emoji (and nothing else) is a "jumbo" one. */
export const MAX_JUMBO_EMOJI = 3;

const SEQUENCE = emojiRegex();

// emoji-regex also matches symbols that are text unless asked to be emoji
// (a bare ©, ❤ or ™). Only draw what is an emoji on its own: it carries the
// emoji variation selector, joins others, is a flag or keycap, or is emoji by
// default.
const asksToBeEmoji = (sequence) =>
  /\uFE0F|\u200D|\u20E3/.test(sequence) ||
  /^\p{Regional_Indicator}{2}$/u.test(sequence) ||
  /^\p{Emoji_Presentation}/u.test(sequence);

/** "👋🏽" -> "1f44b-1f3fd.png" */
export function emojiFilename(sequence) {
  const points = [...String(sequence)].map((c) => c.codePointAt(0).toString(16).padStart(4, "0"));
  return `${points.join("-")}.png`;
}

const escapeAttr = (value) => String(value).replace(/[&"<>]/g, (c) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" })[c]);

function imageHtml(sequence, jumbo) {
  return `<img class="${jumbo ? "emoji emoji-jumbo" : "emoji"}" alt="${escapeAttr(sequence)}" src="${EMOJI_IMAGE_BASE}${emojiFilename(sequence)}" draggable="false">`;
}

function replaceInText(text, jumbo) {
  return text.replace(SEQUENCE, (sequence) => (asksToBeEmoji(sequence) ? imageHtml(sequence, jumbo) : sequence));
}

/**
 * Replaces the emoji in the TEXT of an HTML string with pictures. Tag
 * attributes and code are left as they are. `html` must already be sanitised
 * (it is, wherever messages are rendered): nothing but our own <img> is added.
 */
export function emojifyHtml(html, { jumbo = false } = {}) {
  const source = String(html || "");
  if (!source) return "";
  let quick = false;
  SEQUENCE.lastIndex = 0;
  quick = SEQUENCE.test(source);
  if (!quick) return source;
  // A ">" inside a quoted attribute value (title="a > b") does not end the tag.
  const parts = source.split(/(<(?:[^>"']|"[^"]*"|'[^']*')*>)/);
  let codeDepth = 0;
  return parts
    .map((part) => {
      if (part.startsWith("<")) {
        const tag = /^<\s*(\/?)\s*([a-z0-9]+)/i.exec(part);
        if (tag && (tag[2].toLowerCase() === "code" || tag[2].toLowerCase() === "pre")) {
          codeDepth = Math.max(0, codeDepth + (tag[1] ? -1 : 1));
        }
        return part;
      }
      return codeDepth ? part : replaceInText(part, jumbo);
    })
    .join("");
}

/** A message that is nothing but one to three emoji is shown big, like Telegram. */
export function isJumboEmojiText(text) {
  const value = String(text || "").trim();
  if (!value) return false;
  let count = 0;
  const rest = value.replace(SEQUENCE, (sequence) => {
    if (!asksToBeEmoji(sequence)) return sequence;
    count += 1;
    return "";
  });
  return count > 0 && count <= MAX_JUMBO_EMOJI && rest.trim() === "";
}

/**
 * When a picture is missing, the same emoji may be spelled the other way (with
 * or without the variation selector): the one other address to try.
 * @param {string} src     the address that failed
 * @param {number} tried   how many other spellings were already tried
 */
export function fallbackEmojiSrc(src, tried = 0) {
  if (tried >= 1 || typeof src !== "string" || !src.startsWith(EMOJI_IMAGE_BASE)) return null;
  const name = src.slice(EMOJI_IMAGE_BASE.length).replace(/\.png$/, "");
  const points = name.split("-");
  const other = name.includes("fe0f")
    ? points.filter((p) => p !== "fe0f").join("-")
    : [points[0], "fe0f", ...points.slice(1)].join("-");
  return `${EMOJI_IMAGE_BASE}${other}.png`;
}

let installed = false;
/** One listener for every emoji picture: a failed one tries its other spelling. */
export function installEmojiFallback(doc = typeof document === "undefined" ? null : document) {
  if (installed || !doc) return;
  installed = true;
  doc.addEventListener(
    "error",
    (event) => {
      const el = event.target;
      if (!el || el.tagName !== "IMG" || !el.classList?.contains("emoji")) return;
      const tried = Number(el.dataset.fallback || 0);
      const next = fallbackEmojiSrc(el.getAttribute("src"), tried);
      el.dataset.fallback = String(tried + 1);
      if (next) el.setAttribute("src", next);
    },
    true,
  );
}
