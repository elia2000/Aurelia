// The colours people can have as their theme ("random" picks one of these for
// each person each day). The admin sets them in the admin panel as hex codes.

export const MAX_THEME_COLORS = 30;

// Thirty readable mid-tones (Tailwind's 500/600 steps), used until the admin
// sets their own.
export const DEFAULT_THEME_PALETTE = Object.freeze([
  "#10b981", "#059669", "#0d9488", "#0891b2", "#0284c7", "#2563eb", "#4f46e5", "#7c3aed", "#9333ea", "#c026d3",
  "#db2777", "#e11d48", "#dc2626", "#ea580c", "#d97706", "#ca8a04", "#65a30d", "#16a34a", "#14b8a6", "#06b6d4",
  "#0ea5e9", "#3b82f6", "#6366f1", "#8b5cf6", "#a855f7", "#d946ef", "#ec4899", "#f43f5e", "#ef4444", "#f97316",
]);

/** "#RGB" / "#RRGGBB" (with or without "#") -> "#rrggbb", or null. */
export function normalizeHex(value) {
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(text)) {
    return `#${text.split("").map((c) => c + c).join("").toLowerCase()}`;
  }
  if (/^[0-9a-f]{6}$/i.test(text)) return `#${text.toLowerCase()}`;
  return null;
}

/** Splits on commas, semicolons and white space; the order is kept, duplicates and junk dropped. */
export function tokenizePalette(value) {
  const parts = Array.isArray(value) ? value : String(value ?? "").split(/[\s,;]+/);
  return parts.map((part) => String(part ?? "").trim()).filter(Boolean);
}

/** A usable list of 1 to 30 colours; the built-in palette when there is nothing usable. */
export function parseThemePalette(value) {
  const out = [];
  for (const token of tokenizePalette(value)) {
    const hex = normalizeHex(token);
    if (hex && !out.includes(hex)) out.push(hex);
    if (out.length >= MAX_THEME_COLORS) break;
  }
  return out.length ? out : [...DEFAULT_THEME_PALETTE];
}

/**
 * What people who never chose a colour get: "random" (the shared colour of the
 * day), "default" (the built-in green) or one fixed "#rrggbb" for everybody.
 * Anything unclear means "random".
 */
export function parseThemeDefault(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "default" || text === "green") return "default";
  if (text === "random" || !text) return "random";
  return normalizeHex(text) || "random";
}

/** Like parseThemeDefault, but null when the value is not one of the allowed spellings. */
export function parseThemeDefaultStrict(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return "random";
  if (text === "random" || text === "default" || text === "green") return parseThemeDefault(text);
  return normalizeHex(text);
}
