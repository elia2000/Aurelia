// Theme colour: every person can pick the accent colour of the app (or let it
// change every day, from a palette the admin sets). The app's accent is
// Tailwind's emerald scale, so changing the colour is a matter of replacing
// those CSS variables: every `emerald-*` class follows.

export const MAX_COLORS = 30;
export const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
export const DEFAULT_THEME_COLOR = "#10b981";

// The same thirty colours the server falls back to (server/lib/themePalette.js).
export const DEFAULT_PALETTE = Object.freeze([
  "#10b981", "#059669", "#0d9488", "#0891b2", "#0284c7", "#2563eb", "#4f46e5", "#7c3aed", "#9333ea", "#c026d3",
  "#db2777", "#e11d48", "#dc2626", "#ea580c", "#d97706", "#ca8a04", "#65a30d", "#16a34a", "#14b8a6", "#06b6d4",
  "#0ea5e9", "#3b82f6", "#6366f1", "#8b5cf6", "#a855f7", "#d946ef", "#ec4899", "#f43f5e", "#ef4444", "#f97316",
]);

/** "#RGB" / "#RRGGBB" (with or without "#") -> "#rrggbb", or null. */
export function normalizeHex(value) {
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(text)) return `#${text.split("").map((c) => c + c).join("").toLowerCase()}`;
  if (/^[0-9a-f]{6}$/i.test(text)) return `#${text.toLowerCase()}`;
  return null;
}

/** 1 to 30 clean colours from whatever the server sent; the built-in palette when unusable. */
export function parsePalette(value) {
  const list = Array.isArray(value) ? value : [];
  const out = [];
  for (const item of list) {
    const hex = normalizeHex(item);
    if (hex && !out.includes(hex)) out.push(hex);
    if (out.length >= MAX_COLORS) break;
  }
  return out.length ? out : [...DEFAULT_PALETTE];
}

/** A small stable hash (FNV-1a) of a string. */
export function hashString(text) {
  let hash = 0x811c9dc5;
  const input = String(text ?? "");
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** The number of the local calendar day (it changes at the person's midnight). */
export function dayNumber(date = new Date()) {
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000);
}

/**
 * Today's colour for a person: it steps to the next colour of the palette every
 * day, and people start at different places so that they do not all match.
 */
export function dailyColor(palette, userKey, date = new Date()) {
  const colors = parsePalette(palette);
  return colors[(dayNumber(date) + hashString(userKey)) % colors.length];
}

// ── colour maths (OKLab, so that the shades look evenly spaced) ───────────────
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

function hexToOklch(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => toLinear(parseInt(hex.slice(i, i + 2), 16) / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L, C: Math.hypot(a, bb), h: Math.atan2(bb, a) };
}

function oklchToLinear({ L, C, h }) {
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const inGamut = (rgb) => rgb.every((c) => c >= -0.0001 && c <= 1.0001);

function oklchToHex(color) {
  // Too colourful for the screen at this lightness: take colour out until it fits.
  let { C } = color;
  let rgb = oklchToLinear({ ...color, C });
  for (let i = 0; i < 24 && !inGamut(rgb); i += 1) {
    C *= 0.9;
    rgb = oklchToLinear({ ...color, C });
  }
  return `#${rgb
    .map((c) => Math.round(Math.min(1, Math.max(0, fromLinear(Math.min(1, Math.max(0, c))))) * 255).toString(16).padStart(2, "0"))
    .join("")}`;
}

// Lightness and colourfulness of each step, taken from Tailwind's own scales.
const TARGET_L = { 50: 0.979, 100: 0.95, 200: 0.905, 300: 0.845, 400: 0.765, 500: 0.696, 600: 0.596, 700: 0.508, 800: 0.432, 900: 0.378, 950: 0.262 };
const CHROMA = { 50: 0.12, 100: 0.25, 200: 0.45, 300: 0.7, 400: 0.9, 500: 1, 600: 0.95, 700: 0.8, 800: 0.65, 900: 0.55, 950: 0.4 };
const L_MIN = 0.45; // darker than this the colour hardly reads as itself
const L_MAX = 0.72; // lighter than this white text on it is unreadable

/**
 * The 11 shades of an accent colour, from 50 (almost white) to 950 (almost
 * black), with the colour itself at 500. A colour too light for white text
 * (a bright yellow) is eased darker first.
 */
export function colorScale(hex) {
  const base = normalizeHex(hex) || DEFAULT_THEME_COLOR;
  const own = hexToOklch(base);
  const L500 = Math.min(L_MAX, Math.max(L_MIN, own.L));
  const eased = L500 !== own.L;
  const scale = {};
  for (const shade of SHADES) {
    if (shade === 500) {
      scale[500] = eased ? oklchToHex({ L: L500, C: own.C, h: own.h }) : base;
      continue;
    }
    const t = TARGET_L[shade];
    const L =
      shade < 500
        ? L500 + (0.985 - L500) * ((t - TARGET_L[500]) / (TARGET_L[50] - TARGET_L[500]))
        : L500 - (L500 - 0.22) * ((TARGET_L[500] - t) / (TARGET_L[500] - TARGET_L[950]));
    scale[shade] = oklchToHex({ L, C: own.C * CHROMA[shade], h: own.h });
  }
  return scale;
}

/** Sets (or, with null, clears) the accent colour of the whole app. */
export function applyThemeColor(
  hex,
  {
    root = typeof document === "undefined" ? null : document.documentElement,
    meta = typeof document === "undefined" ? null : document.querySelector('meta[name="theme-color"]:not([media])'),
  } = {},
) {
  if (!root) return;
  const color = normalizeHex(hex);
  if (!color) {
    for (const shade of SHADES) root.style.removeProperty(`--color-emerald-${shade}`);
    root.style.removeProperty("--theme-chat-bg");
    return;
  }
  const scale = colorScale(color);
  for (const shade of SHADES) root.style.setProperty(`--color-emerald-${shade}`, scale[shade]);
  root.style.setProperty("--theme-chat-bg", scale[100]); // the chat area's own background colour
  if (meta) meta.setAttribute("content", color);
}

// ── the person's choice ──────────────────────────────────────────────────────
const STORAGE_PREFIX = "aurelle-theme-color:";

/** @returns {{mode: "default"|"random"|"custom", color?: string}} */
export function loadThemePreference(userKey, storage = typeof localStorage === "undefined" ? null : localStorage) {
  try {
    const parsed = JSON.parse(storage?.getItem(`${STORAGE_PREFIX}${userKey}`) || "null");
    if (parsed?.mode === "random") return { mode: "random" };
    if (parsed?.mode === "custom" && normalizeHex(parsed.color)) return { mode: "custom", color: normalizeHex(parsed.color) };
  } catch (_) {
    // unreadable: the default look
  }
  return { mode: "default" };
}

export function saveThemePreference(userKey, preference, storage = typeof localStorage === "undefined" ? null : localStorage) {
  try {
    storage?.setItem(`${STORAGE_PREFIX}${userKey}`, JSON.stringify(preference));
  } catch (_) {
    // storage full or blocked: the choice lasts until the page closes
  }
}

/** The colour a preference means right now, or null for the built-in look. */
export function resolveThemeColor(preference, palette, userKey, date = new Date()) {
  if (preference?.mode === "random") return dailyColor(palette, userKey, date);
  if (preference?.mode === "custom") return normalizeHex(preference.color);
  return null;
}
