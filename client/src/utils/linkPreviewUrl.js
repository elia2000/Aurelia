// Which link of a message gets a preview card: the FIRST link, as the message
// shows it. The finished HTML of the message body (see utils/markdown.js) is
// read rather than the raw text, so exactly the links the person sees are the
// candidates: an address inside a code block, or in a message that is shown as
// plain text, is not a link there and gets no card. Links that could never get
// a card (not http/https, with a user name or password in them, into this very
// app) are dropped here; everything else is the server's decision (it also
// refuses private addresses and ports other than 80 and 443).

const MAX_URL_LENGTH = 2048;
const ANCHOR = /<a\b[^>]*?\shref="([^"]*)"[^>]*>/i;

const decodeAttribute = (value) =>
  String(value)
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&#x0*27;|&apos;/gi, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/**
 * A link that may be previewed, as a string without its #fragment, or "".
 * Links to this very app (an invite, a path) are not previewed.
 */
export function normalizePreviewUrl(value, origin = typeof window === "undefined" ? "" : window.location.origin) {
  const text = String(value ?? "").trim();
  if (!text || text.length > MAX_URL_LENGTH || /\s/.test(text)) return "";
  let url;
  try {
    url = new URL(text);
  } catch {
    return "";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "";
  if (url.username || url.password) return "";
  if (origin && url.origin === origin) return "";
  url.hash = "";
  return url.href;
}

/** The address of the first link in a message's finished HTML that may be previewed, or "". */
export function findPreviewUrl(html, origin) {
  const source = String(html ?? "");
  if (!source.includes("<a")) return "";
  const match = ANCHOR.exec(source);
  return match ? normalizePreviewUrl(decodeAttribute(match[1]), origin) : "";
}
