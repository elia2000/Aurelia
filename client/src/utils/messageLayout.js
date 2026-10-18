// Layout helpers for a message bubble: reading direction of a text and how the
// finished HTML of a message body ends (it decides where the time goes).

const RTL_CHAR = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
const LTR_CHAR = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]/;

// Direction of the first strong letter, like dir="auto" does. Only the text
// after the last blank line counts: that is the paragraph the time sits under.
export const getTextDirection = (text) => {
  const paragraphs = String(text || "").trim().split(/\n\s*\n/);
  const last = paragraphs[paragraphs.length - 1] || "";
  for (const ch of last) {
    if (RTL_CHAR.test(ch)) return "rtl";
    if (LTR_CHAR.test(ch)) return "ltr";
  }
  return "ltr";
};

const BLOCK_TAGS = new Set([
  "ul",
  "ol",
  "blockquote",
  "pre",
  "div",
  "table",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
]);

// How the HTML of a message body ends:
//   "inline" - plain text or inline markup: the time fits after the last word
//   "p"      - a paragraph: the time fits after its last word
//   "block"  - a list, quote, code block...: the time needs its own row
export const getBodyTailKind = (html) => {
  const trimmed = String(html || "").trimEnd();
  if (!trimmed) return "inline";
  if (/<hr\b[^>]*>$/i.test(trimmed)) return "block";
  const closing = trimmed.match(/<\/([a-z0-9]+)>$/i);
  if (!closing) return "inline";
  const tag = closing[1].toLowerCase();
  if (tag === "p") return "p";
  if (BLOCK_TAGS.has(tag)) return "block";
  return "inline";
};

// Width (px) of the icons MessageMeta draws (the icon plus its gap).
const STATUS_ICON_PX = 18;
const EXPIRY_ICON_PX = 16;

// What a bubble keeps free at the end of its last text line so the time, which
// is drawn over the bubble's bottom corner, never covers a word. The text part
// is the very string MessageMeta prints; the icons are a fixed width.
export const getMetaSpacer = ({
  timeLabel,
  isEdited,
  expiryLabel,
  viewsLabel,
  hasStatusIcon,
}) => {
  const text = [expiryLabel, isEdited ? "edited" : "", timeLabel, viewsLabel]
    .filter(Boolean)
    .join(" ")
    .replace(/["\\]/g, "")
    .replace(/\p{Cc}/gu, "");
  const extraPx =
    (hasStatusIcon ? STATUS_ICON_PX : 0) +
    (expiryLabel ? EXPIRY_ICON_PX : 0) +
    2;
  return { text, extraPx };
};

// Pictures and videos are scaled to fit a box, like Telegram does: a tall photo
// gives a narrow bubble instead of a very tall one.
export const MEDIA_MAX_WIDTH_PX = 352;
export const MEDIA_MIN_WIDTH_PX = 180;

export const getMediaMaxHeightPx = (isDesktop) => (isDesktop ? 420 : 340);

// The key MessageFiles stores a picture's measured ratio under.
export const getMediaAspectKey = (file) =>
  file?.id || `${file?.name || ""}-${file?.sizeBytes || 0}`;

// Width / height of a picture or video: the measured ratio when the browser has
// loaded it, else the size the server stored, else a stable guess. Extreme
// shapes are clamped to keep the bubble usable.
export const resolveMediaAspectRatio = ({ file, cachedRatio, isVideo = false }) => {
  const clamp = (ratio) => Math.min(2.4, Math.max(0.42, ratio));
  const cached = Number(cachedRatio);
  if (Number.isFinite(cached) && cached > 0) return clamp(cached);
  const width = Number(file?.width);
  const height = Number(file?.height);
  if (!(width > 0) || !(height > 0)) return isVideo ? 16 / 9 : 1;
  return clamp(width / height);
};

// Bubble width (px) for a single picture or video of the given ratio.
export const getMediaBubbleWidthPx = ({ ratio, isDesktop }) => {
  const byHeight = getMediaMaxHeightPx(isDesktop) * ratio;
  return Math.round(
    Math.max(MEDIA_MIN_WIDTH_PX, Math.min(MEDIA_MAX_WIDTH_PX, byHeight)),
  );
};
