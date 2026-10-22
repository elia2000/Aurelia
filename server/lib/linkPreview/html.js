/**
 * A small, hardened reader for the few tags a link preview needs.
 *
 * The page belongs to a stranger, so nothing here builds a DOM, runs or loads
 * anything: it walks the text once, finds <title> and <meta> tags in the head,
 * and returns plain strings. The strings are shown as TEXT by the client, never
 * as HTML, but they are cleaned anyway (entities decoded once, control and
 * bidi-override characters removed, white space collapsed, length limited).
 *
 * Limits keep a hostile page cheap: at most MAX_TAGS tags are looked at, a
 * tag longer than MAX_TAG_LENGTH is skipped, an attribute value is cut at
 * MAX_ATTRIBUTE_LENGTH, and reading stops at <body> (the head is over).
 */

import { addressFamily } from "./addresses.js";

export const TITLE_MAX_CHARS = 120;
export const DESCRIPTION_MAX_CHARS = 240;
export const SITE_NAME_MAX_CHARS = 60;

const MAX_TAGS = 5000;
const MAX_UNREADABLE_TAGS = 100;
const MAX_TAG_LENGTH = 8192;
const MAX_ATTRIBUTE_LENGTH = 4096;
const MAX_ATTRIBUTES = 64;
const MAX_TITLE_SOURCE = 2048;
const MAX_META_KEYS = 200;

// Elements whose content is not markup.
const RAW_TEXT_TAGS = new Set(["script", "style", "textarea", "template"]);

const WANTED_META = new Set([
  "og:title", "og:description", "og:site_name",
  "og:image", "og:image:url", "og:image:secure_url",
  "twitter:title", "twitter:description", "twitter:image", "twitter:image:src",
  "description",
]);

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ndash: "\u2013", mdash: "\u2014", hellip: "\u2026", bull: "\u2022", middot: "\u00b7",
  lsquo: "\u2018", rsquo: "\u2019", sbquo: "\u201a", ldquo: "\u201c", rdquo: "\u201d", bdquo: "\u201e",
  laquo: "\u00ab", raquo: "\u00bb", copy: "\u00a9", reg: "\u00ae", trade: "\u2122",
  euro: "\u20ac", pound: "\u00a3", yen: "\u00a5", cent: "\u00a2", deg: "\u00b0",
  plusmn: "\u00b1", times: "\u00d7", divide: "\u00f7", frac12: "\u00bd", frac14: "\u00bc",
  larr: "\u2190", rarr: "\u2192", uarr: "\u2191", darr: "\u2193", hearts: "\u2665",
  eacute: "\u00e9", egrave: "\u00e8", agrave: "\u00e0", aacute: "\u00e1", ouml: "\u00f6",
  uuml: "\u00fc", auml: "\u00e4", szlig: "\u00df", ntilde: "\u00f1", ccedil: "\u00e7",
};

/** Decodes &amp; &#39; &#x1F600; once. Unknown or invalid references stay as written. */
export function decodeEntities(text) {
  return String(text).replace(/&(#[xX][0-9a-fA-F]{1,8}|#[0-9]{1,10}|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isInteger(code) || code < 1 || code > 0x10ffff) return "\ufffd";
      if (code >= 0xd800 && code <= 0xdfff) return "\ufffd";
      return String.fromCodePoint(code);
    }
    const named = NAMED_ENTITIES[body];
    return named === undefined ? whole : named;
  });
}

// C0 and C1 controls, line/paragraph separators, the byte order mark, the
// interlinear annotation marks and the bidi embedding/override/isolate
// controls (they can make text read differently than it is written).
const UNWANTED = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff\ufff9-\ufffb]/g;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * Plain, single-line, length-limited text from an attribute value or element
 * content. Returns "" when nothing is left.
 */
export function cleanText(value, maxChars) {
  if (value === undefined || value === null) return "";
  // Work on a bounded piece: a hostile page can offer megabytes of "title".
  let text = decodeEntities(String(value).slice(0, maxChars * 8));
  text = text.replace(UNWANTED, " ").replace(/\s+/g, " ").trim();
  text = text.replace(LONE_SURROGATE, "");
  const points = Array.from(text);
  if (points.length > maxChars) text = `${points.slice(0, maxChars - 1).join("").trimEnd()}\u2026`;
  return text;
}

const isSpace = (char) => char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f";

/**
 * Reads attributes from `from` up to the closing ">" of the tag. Returns
 * { attrs, end } with `end` just after ">", or null when the tag does not end
 * in a sensible distance.
 */
function readTag(html, from) {
  const limit = Math.min(html.length, from + MAX_TAG_LENGTH);
  const attrs = new Map();
  let i = from;
  while (i < limit) {
    const char = html[i];
    if (char === ">") return { attrs, end: i + 1 };
    if (isSpace(char) || char === "/") {
      i += 1;
      continue;
    }
    // attribute name
    let nameEnd = i;
    while (nameEnd < limit && !isSpace(html[nameEnd]) && html[nameEnd] !== "=" && html[nameEnd] !== ">" && html[nameEnd] !== "/") {
      nameEnd += 1;
    }
    const name = html.slice(i, nameEnd).toLowerCase();
    i = nameEnd;
    while (i < limit && isSpace(html[i])) i += 1;
    let value = "";
    if (html[i] === "=") {
      i += 1;
      while (i < limit && isSpace(html[i])) i += 1;
      const quote = html[i];
      if (quote === '"' || quote === "'") {
        // Looked for inside this tag's allowance only: a quote that never
        // closes must not make every tag scan the rest of the page.
        const inside = html.slice(i + 1, limit);
        const close = inside.indexOf(quote);
        if (close === -1) return null;
        value = inside.slice(0, close);
        i += close + 2;
      } else {
        let valueEnd = i;
        while (valueEnd < limit && !isSpace(html[valueEnd]) && html[valueEnd] !== ">") valueEnd += 1;
        value = html.slice(i, valueEnd);
        i = valueEnd;
      }
    }
    // The first of a repeated attribute wins, as in a browser.
    if (name && !attrs.has(name) && attrs.size < MAX_ATTRIBUTES) {
      attrs.set(name, value.length > MAX_ATTRIBUTE_LENGTH ? value.slice(0, MAX_ATTRIBUTE_LENGTH) : value);
    }
  }
  return null;
}

/**
 * Finds the <title> and the interesting <meta> tags.
 *
 * @param {string} html
 * @returns {{ meta: Record<string, string>, titleTag: string }}
 *   `meta` holds the first value of each wanted key (og:title, description, ...)
 *   as it was written (not yet cleaned); `titleTag` is the raw <title> text.
 */
export function extractMetadata(html) {
  const text = String(html ?? "");
  const meta = Object.create(null);
  let metaKeys = 0;
  let titleTag = "";
  let titleSeen = false;
  let tags = 0;
  let unreadable = 0;
  let i = 0;

  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt === -1) break;
    const next = text[lt + 1];

    if (next === "!" || next === "?") {
      if (text.startsWith("<!--", lt)) {
        const end = text.indexOf("-->", lt + 4);
        if (end === -1) break;
        i = end + 3;
      } else {
        const end = text.indexOf(">", lt + 2);
        if (end === -1) break;
        i = end + 1;
      }
      continue;
    }

    const closing = next === "/";
    const nameStart = lt + (closing ? 2 : 1);
    const nameMatch = /^[a-zA-Z][a-zA-Z0-9:-]{0,31}/.exec(text.slice(nameStart, nameStart + 33));
    if (!nameMatch) {
      i = lt + 1;
      continue;
    }
    const name = nameMatch[0].toLowerCase();
    if (++tags > MAX_TAGS) break;

    const tag = readTag(text, nameStart + nameMatch[0].length);
    if (!tag) {
      // Not a tag we can read (never closes, or absurdly long): treat the "<" as
      // text. A real page has hardly any of these; a hostile one is not worth more.
      if (++unreadable > MAX_UNREADABLE_TAGS) break;
      i = lt + 1;
      continue;
    }
    i = tag.end;
    if (closing) continue;

    if (name === "body") break; // the head is over
    if (name === "meta") {
      const key = String(tag.attrs.get("property") ?? tag.attrs.get("name") ?? "").trim().toLowerCase();
      if (WANTED_META.has(key) && !(key in meta) && tag.attrs.has("content") && metaKeys < MAX_META_KEYS) {
        meta[key] = tag.attrs.get("content");
        metaKeys += 1;
      }
    } else if (name === "title") {
      // Only a window after the tag is looked at, so a page full of unclosed
      // <title> tags cannot make every one of them scan the rest of the page.
      const windowText = text.slice(i, i + MAX_TITLE_SOURCE);
      const found = /<\/title/i.exec(windowText);
      if (!titleSeen) {
        titleTag = found ? windowText.slice(0, found.index) : windowText;
        titleSeen = true;
      }
      if (found) {
        const after = windowText.indexOf(">", found.index);
        i += after === -1 ? found.index : after + 1;
      } else {
        i += windowText.length;
      }
    } else if (RAW_TEXT_TAGS.has(name)) {
      const close = new RegExp(`</${name}`, "gi");
      close.lastIndex = i;
      const found = close.exec(text);
      if (!found) break;
      const after = text.indexOf(">", found.index);
      if (after === -1) break;
      i = after + 1;
    }
  }
  return { meta, titleTag };
}

/** The charset a page declares in its first bytes (<meta charset>, http-equiv), lower-case, or "". */
export function sniffMetaCharset(headBytes) {
  const head = Buffer.from(headBytes).toString("latin1");
  const direct = /<meta[^>]+charset\s*=\s*["']?\s*([a-zA-Z0-9_:.-]{1,40})/i.exec(head);
  return direct ? direct[1].toLowerCase() : "";
}

/** Page bytes -> text. The header's charset wins, then <meta>, then UTF-8; unknown names fall back to UTF-8. */
export function decodeHtml(bytes, contentTypeHeader = "") {
  const fromHeader = /charset\s*=\s*["']?([a-zA-Z0-9_:.-]{1,40})/i.exec(String(contentTypeHeader))?.[1]?.toLowerCase() || "";
  const label = fromHeader || sniffMetaCharset(bytes.subarray(0, 2048)) || "utf-8";
  let decoder;
  try {
    decoder = new TextDecoder(label);
  } catch {
    decoder = new TextDecoder("utf-8");
  }
  return decoder.decode(bytes);
}

const firstClean = (candidates, maxChars) => {
  for (const candidate of candidates) {
    const cleaned = cleanText(candidate, maxChars);
    if (cleaned) return cleaned;
  }
  return "";
};

/** An http(s) URL (absolute, or relative to `base`) as a string, or "". */
export function resolveHttpUrl(value, base) {
  const raw = String(value ?? "").trim();
  if (!raw || raw.length > 2048 || /[\u0000-\u001f\u007f]/.test(raw)) return "";
  try {
    const url = new URL(decodeEntities(raw), base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    if (url.username || url.password) return "";
    url.hash = "";
    return url.href;
  } catch {
    return "";
  }
}

/**
 * Page text -> what the card shows. `pageUrl` is the final address of the page
 * (after redirects); it names the site when the page does not, and relative
 * image addresses are resolved against it.
 *
 * @returns {{ title: string, description: string, siteName: string, imageCandidates: string[] }}
 */
export function parsePreviewFields(html, pageUrl) {
  const { meta, titleTag } = extractMetadata(html);
  const title = firstClean([meta["og:title"], meta["twitter:title"], titleTag], TITLE_MAX_CHARS);
  const description = firstClean(
    [meta["og:description"], meta["twitter:description"], meta.description],
    DESCRIPTION_MAX_CHARS,
  );
  let host = "";
  try {
    host = new URL(pageUrl).hostname.replace(/^www\./i, "");
  } catch {
    host = "";
  }
  if (host.startsWith("[") || addressFamily(host)) host = "";
  const siteName = firstClean([meta["og:site_name"], host], SITE_NAME_MAX_CHARS);

  const imageCandidates = [];
  for (const key of ["og:image", "og:image:secure_url", "og:image:url", "twitter:image", "twitter:image:src"]) {
    const resolved = resolveHttpUrl(meta[key], pageUrl);
    if (resolved && !imageCandidates.includes(resolved)) imageCandidates.push(resolved);
  }
  return { title, description, siteName, imageCandidates };
}
