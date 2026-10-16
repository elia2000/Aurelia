// The emoji picker's data, built from `emoji-datasource-apple` (loaded only
// when the picker is opened: it is a large file).

export const CATEGORY_ORDER = [
  "Smileys & Emotion",
  "People & Body",
  "Animals & Nature",
  "Food & Drink",
  "Travel & Places",
  "Activities",
  "Objects",
  "Symbols",
  "Flags",
];

export const SKIN_TONES = [
  { id: "default", label: "Default", code: null },
  { id: "1F3FB", label: "Light", code: "1F3FB" },
  { id: "1F3FC", label: "Medium-light", code: "1F3FC" },
  { id: "1F3FD", label: "Medium", code: "1F3FD" },
  { id: "1F3FE", label: "Medium-dark", code: "1F3FE" },
  { id: "1F3FF", label: "Dark", code: "1F3FF" },
];

const RECENT_KEY = "aurelle-emoji-recent";
const MAX_RECENT = 24;

const fromUnified = (unified) =>
  String.fromCodePoint(...String(unified).split("-").map((h) => Number.parseInt(h, 16)));

/**
 * @param {Array} raw  the contents of emoji-datasource-apple/emoji.json
 * @returns {{categories: Array<{id: string, emojis: Array}>}}
 */
export function buildEmojiIndex(raw) {
  const byCategory = new Map(CATEGORY_ORDER.map((id) => [id, []]));
  const sorted = [...raw].sort((a, b) => a.sort_order - b.sort_order);
  for (const item of sorted) {
    if (!item.has_img_apple || !byCategory.has(item.category)) continue;
    const skins = {};
    for (const [key, variation] of Object.entries(item.skin_variations || {})) {
      // Only the single-tone variations (a hand, not a couple with two tones).
      if (!variation.has_img_apple || key.includes("-")) continue;
      skins[key] = { char: fromUnified(variation.unified), image: variation.image };
    }
    byCategory.get(item.category).push({
      char: fromUnified(item.unified),
      image: item.image,
      name: String(item.name || "").toLowerCase(),
      shortName: item.short_name,
      shortNames: item.short_names || [item.short_name],
      ...(Object.keys(skins).length ? { skins } : {}),
    });
  }
  return { categories: CATEGORY_ORDER.map((id) => ({ id, emojis: byCategory.get(id) })) };
}

/** Emoji whose name matches, those named exactly as searched first. */
export function searchEmoji(index, query, limit = 120) {
  const q = String(query || "").trim().toLowerCase().replace(/^:|:$/g, "");
  if (!q) return [];
  const exact = [];
  const starts = [];
  const contains = [];
  for (const category of index.categories) {
    for (const emoji of category.emojis) {
      if (emoji.shortNames.some((n) => n === q)) exact.push(emoji);
      else if (emoji.shortNames.some((n) => n.startsWith(q)) || emoji.name.startsWith(q)) starts.push(emoji);
      else if (emoji.shortNames.some((n) => n.includes(q)) || emoji.name.includes(q)) contains.push(emoji);
    }
  }
  return [...exact, ...starts, ...contains].slice(0, limit);
}

/** The emoji wearing a skin tone, if it has one (otherwise the emoji itself). */
export function applySkinTone(emoji, toneId) {
  const variation = toneId && toneId !== "default" ? emoji.skins?.[toneId] : null;
  return variation ? { ...emoji, char: variation.char, image: variation.image } : emoji;
}

const defaultStorage = () => (typeof localStorage === "undefined" ? null : localStorage);

export function loadRecent(storage = defaultStorage()) {
  try {
    const list = JSON.parse(storage?.getItem(RECENT_KEY) || "[]");
    return Array.isArray(list) ? list.filter((c) => typeof c === "string").slice(0, MAX_RECENT) : [];
  } catch (_) {
    return [];
  }
}

export function addRecent(char, storage = defaultStorage()) {
  const list = [char, ...loadRecent(storage).filter((c) => c !== char)].slice(0, MAX_RECENT);
  try {
    storage?.setItem(RECENT_KEY, JSON.stringify(list));
  } catch (_) {
    // storage full or blocked: the list lasts until the page closes
  }
  return list;
}
