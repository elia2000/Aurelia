// The contrast guard of the theme colour. The accent can be any colour (a
// colour of the day, a custom one), but white text on a yellow button or a
// navy accent text on a dark panel is unreadable. This file lists the pairs of
// colours the UI really puts on top of each other, in light and dark mode,
// with the contrast each one needs, and
//   - `auditScale(scale)` measures a scale of 11 shades against all of them
//     (the unit test sweeps every palette colour and ~200 others through it);
//   - `guardScale(shades)` repairs a scale: a shade that fails a pair has its
//     lightness (and only its lightness: OKLCH hue and chroma stay) nudged in
//     fixed steps until the pair passes. Nothing is touched while all pairs
//     pass, and the same colour always gives the same result.
//
// Thresholds (WCAG 2.2): 4.5:1 for text, 3:1 for icons, rings, dots and the
// bold white label of a filled accent control (1.4.11 / large-text floor).
// One softer floor, 2:1, keeps the white label readable on the lighter hover
// fill (a pointer-only, momentary state; not a WCAG level, a guard rail).

import { composite, contrastRatio, oklchToHex } from "./colorMath.js";

const WHITE = "#ffffff";
const BLACK = "#000000";
const SLATE_50 = "#f8fafc";
const SLATE_100 = "#f1f5f9";
const SLATE_800 = "#1e293b";
const SLATE_900 = "#0f172a";
const SLATE_950 = "#020617";
const CHAT_DARK = "#0b1320"; // the chat area's background in dark mode

/** A shade of the accent scale as a colour reference. */
const shade = (n) => n;
/** `fg` (a reference) at opacity `a` over `over` (a reference), like a translucent Tailwind class. */
const tint = (fg, a, over) => ({ fg, a, over });

/** The colour a reference stands for in `scale`: "#rrggbb", a shade number or tint(). */
export function resolveRef(ref, scale) {
  if (typeof ref === "number") return scale[ref];
  if (typeof ref === "string") return ref;
  return composite(resolveRef(ref.fg, scale), ref.a, resolveRef(ref.over, scale));
}

/** The accent shades a reference is made of, the translucent colour first. */
function refShades(ref) {
  if (typeof ref === "number") return [ref];
  if (typeof ref === "string") return [];
  return [...refShades(ref.fg), ...refShades(ref.over)];
}

const A = shade;
const LIGHT_TEXT_SURFACES = [WHITE, SLATE_50, A(50), A(100), tint(WHITE, 0.9, A(100))];
const DARK_SURFACES = [SLATE_900, SLATE_950, CHAT_DARK];
const DARK_TINTS = [tint(A(500), 0.1, SLATE_900), tint(A(500), 0.1, SLATE_950)];
// The call screen is always dark: slate or black, with a translucent chip over a
// video. The chip is measured over black and over the worst frame a video can
// have, a white one.
const CALL_CHIP = composite(SLATE_900, 0.7, BLACK);
const CALL_CHIP_BRIGHT = composite(SLATE_900, 0.7, WHITE);
// The "you are sharing your screen" banner stays over the raw video when the
// details fade out: rose-950 at 90%, over black or over a white frame.
const ROSE_950 = "#4c0519";
const SHARING_BANNER = composite(ROSE_950, 0.9, BLACK);
const SHARING_BANNER_BRIGHT = composite(ROSE_950, 0.9, WHITE);

/**
 * Every pair: `fg` on `bg`, needing `min`. When one fails, a shade gives way:
 * `move` says which side ("fg" or "bg"; by default the one made of accent
 * shades, the text if both are), and `lighter` which side is the lighter one,
 * which fixes the direction (text is darker than a light surface and lighter
 * than a dark one; a white label is lighter than its fill).
 */
const PAIRS = [];
function add(theme, id, min, fgs, bgs, use, { move, lighter = theme === "light" ? "bg" : "fg" } = {}) {
  for (const fg of [].concat(fgs)) {
    for (const bg of [].concat(bgs)) PAIRS.push({ theme, id, min, fg, bg, use, move, lighter });
  }
}

// ── light mode ───────────────────────────────────────────────────────────────
add("light", "label-on-fill", 3, WHITE, A(500), "white label on a filled accent: buttons, reaction chip, toast", { move: "bg", lighter: "fg" });
add("light", "label-on-strong-fill", 4.5, WHITE, A(600), "white label on the stronger fill: unread counter, call banner, call-entry button, tooltip", { move: "bg", lighter: "fg" });
add("light", "label-on-hover-fill", 4.5, WHITE, A(700), "white label on the darkest hover fill", { move: "bg", lighter: "fg" });
add("light", "label-on-soft-hover-fill", 2, WHITE, A(400), "white label on the lighter hover fill of a filled button (momentary, pointer only)", { move: "bg", lighter: "fg" });
add("light", "text-700", 4.5, A(700), LIGHT_TEXT_SURFACES, "accent text, links, chips and badges on white, slate-50 or a tint");
add("light", "text-700-hover", 4.5, A(700), tint(A(200), 0.7, WHITE), "accent text on a hovered chip or round button (emerald-200/70)");
add("light", "text-600", 4.5, A(600), LIGHT_TEXT_SURFACES, "smaller accent text and icons-with-text on white or a tint");
add("light", "text-800", 4.5, A(800), [WHITE, A(50), A(100), A(200)], "reaction chip text, call entry and link preview site name in an own bubble");
add("light", "own-bubble-text", 4.5, A(950), A(200), "text in an own message bubble");
add("light", "own-bubble-meta", 4.5, tint(A(900), 0.7, A(200)), A(200), "time and ticks in an own bubble, the description of a link preview card");
add("light", "pending-tick", 4.5, tint(A(900), 0.8, WHITE), WHITE, "the pending tick in the chat list");
add("light", "icon-500", 3, A(500), [WHITE, SLATE_50, A(50)], "icons, dots, progress, outlines and focus rings in the accent");
add("light", "ring-on-bubble", 3, A(700), [WHITE, SLATE_50, A(50), A(200)], "focus ring on a message bubble: the link preview card on another person's bubble or your own (accent-tinted)");
add("light", "text-on-tint", 4.5, [SLATE_800, "#334155"], [A(50), A(100), A(200)], "ordinary text on a hovered or selected row", { move: "bg" });
add("light", "selection", 4.5, SLATE_900, tint(A(500), 0.35, WHITE), "selected text", { move: "bg" });
add("light", "ticked-row", 4.5, SLATE_800, tint(A(500), 0.15, A(100)), "text in a ticked (selected) message row", { move: "bg" });

// ── dark mode ────────────────────────────────────────────────────────────────
add("dark", "text-200", 4.5, A(200), [...DARK_SURFACES, ...DARK_TINTS, tint(A(500), 0.2, SLATE_900), tint(A(950), 0.4, SLATE_900), tint(A(900), 0.4, SLATE_900)], "accent text and chips on dark panels");
add("dark", "text-300", 4.5, A(300), [...DARK_SURFACES, ...DARK_TINTS, tint(A(500), 0.2, SLATE_900), tint(A(500), 0.3, SLATE_950)], "accent text on dark panels and tinted rows");
add("dark", "text-400", 4.5, A(400), [...DARK_SURFACES, tint(A(500), 0.1, SLATE_900)], "smaller accent text on dark panels");
add("dark", "text-100", 4.5, A(100), [tint(A(500), 0.2, SLATE_900), tint(A(500), 0.2, SLATE_950), A(800)], "light accent text on a tinted or dark-filled surface");
add("dark", "text-200-soft", 4.5, tint(A(200), 0.8, A(800)), A(800), "small time stamp in an own bubble", { move: "bg" });
add("dark", "icon-500", 3, A(500), DARK_SURFACES, "icons, dots, toggles, progress and outlines in the accent");
add("dark", "ring-300", 3, A(300), [SLATE_950, SLATE_900], "focus ring on a dark panel");
add("dark", "ring-400", 3, A(400), [SLATE_950, SLATE_900], "focus ring and slider on the call screen");
add("dark", "ring-on-bubble", 3, A(300), [A(800), tint(SLATE_800, 0.75, CHAT_DARK)], "focus ring on a message bubble: the link preview card on your own (accent) bubble or another person's");
add("dark", "own-bubble-text", 4.5, WHITE, A(800), "text in an own message bubble", { move: "bg" });
add("dark", "own-bubble-meta", 4.5, tint(A(50), 0.7, A(800)), A(800), "time and ticks in an own bubble, the description of a link preview card", { move: "bg" });
add("dark", "button-text", 4.5, A(950), A(400), "dark label on the light accent button", { lighter: "bg" });
add("dark", "selection", 4.5, SLATE_100, tint(A(500), 0.45, SLATE_900), "selected text", { move: "bg" });
add("dark", "text-on-tint", 4.5, [SLATE_100, WHITE], [tint(A(500), 0.1, SLATE_900), tint(A(500), 0.2, SLATE_950), tint(A(500), 0.3, SLATE_950)], "ordinary text on a hovered, selected or checked row", { move: "bg" });
add("dark", "call-chip", 4.5, A(200), [CALL_CHIP, CALL_CHIP_BRIGHT], "the encrypted chip over a video, a dark one or the brightest frame");
// Fixed colours (not the accent), listed so that nobody lightens the banner without the table noticing.
add("dark", "sharing-banner", 4.5, ["#fff1f2", "#ffe4e6"], [SHARING_BANNER, SHARING_BANNER_BRIGHT], "the screen-sharing banner (rose-50 and rose-100 text) over a video, a dark one or the brightest frame");
add("dark", "sharing-banner-stop", 4.5, WHITE, "#e11d48", "the white label of the banner's Stop sharing button (rose-600)");
// The key-change notices of a direct chat are drawn with fixed amber and rose (opaque, so a bright wallpaper cannot wash them out).
add("light", "key-notice-warning", 4.5, "#78350f", "#fffbeb", "the amber notice \"a contact added a new device\" (amber-900 on amber-50)");
add("light", "key-notice-danger", 4.5, "#881337", "#fff1f2", "the red notice \"Safety number changed\" (rose-900 on rose-50)");
add("dark", "key-notice-warning", 4.5, "#fef3c7", "#451a03", "the amber notice in dark mode (amber-100 on amber-950)");
add("dark", "key-notice-danger", 4.5, "#ffe4e6", ROSE_950, "the red notice in dark mode (rose-100 on rose-950)");

export const AUDIT_PAIRS = Object.freeze(PAIRS.map((pair) => Object.freeze(pair)));

/**
 * Measures a scale ({50: "#...", ... 950: "#..."}) against every pair.
 * @returns {{theme, id, use, fg, bg, ratio, min}[]} the pairs that fail
 */
export function auditScale(scale, pairs = AUDIT_PAIRS) {
  const failing = [];
  for (const pair of pairs) {
    const fg = resolveRef(pair.fg, scale);
    const bg = resolveRef(pair.bg, scale);
    const ratio = contrastRatio(fg, bg);
    if (ratio < pair.min) failing.push({ theme: pair.theme, id: pair.id, use: pair.use, fg, bg, ratio, min: pair.min });
  }
  return failing;
}

// ── the repair ───────────────────────────────────────────────────────────────
const STEP = 0.004; // OKLCH lightness per nudge
const MARGIN = 0.02; // aim a hair above the minimum so that rounding elsewhere cannot tip it
const MAX_NUDGES = 260;
const L_FLOOR = 0.1;
const L_CEIL = 0.995;
const MIN_GAP = 0.012; // lightness between neighbouring shades, so the scale stays in order
const ORDER = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];

/** Which shade gives way in a pair, and in which direction (-1 darker, +1 lighter). */
function request(pair) {
  const fgShades = refShades(pair.fg);
  const bgShades = refShades(pair.bg);
  const side = pair.move || (fgShades.length ? "fg" : "bg");
  const movers = side === "fg" ? fgShades : bgShades;
  if (!movers.length) return null;
  // the lighter side moves lighter, the darker one darker
  return { shade: movers[0], direction: side === pair.lighter ? 1 : -1 };
}

/**
 * Repairs a scale in place of building a new look: `shades` maps each shade to
 * `{L, C, h, hex}` (OKLCH plus the colour as it stands). A shade that fails a
 * pair is nudged lighter or darker, `STEP` at a time, until every pair
 * passes; shades that pass are returned exactly as they came. Outward shades
 * (50-400 lighter, 600-950 darker) are then kept in order.
 * @returns {Record<number, {L, C, h, hex, eased: boolean}>}
 */
export function guardScale(shades, { only = null } = {}) {
  const state = {};
  for (const n of ORDER) if (shades[n] && (!only || only.includes(n))) state[n] = { ...shades[n], eased: false };
  const hexes = () => Object.fromEntries(Object.entries(state).map(([n, s]) => [n, s.hex]));
  const pairs = only
    ? AUDIT_PAIRS.filter((p) => [...refShades(p.fg), ...refShades(p.bg)].every((n) => only.includes(n)))
    : AUDIT_PAIRS;
  // A pair that passes is left alone. One that fails is nudged until it clears
  // its minimum by MARGIN, so that rounding elsewhere cannot tip it back.
  const latched = new Set();

  for (let i = 0; i < MAX_NUDGES; i += 1) {
    const scale = hexes();
    const wanted = new Map();
    for (const pair of pairs) {
      const ratio = contrastRatio(resolveRef(pair.fg, scale), resolveRef(pair.bg, scale));
      if (ratio < pair.min) latched.add(pair);
      if (!latched.has(pair) || ratio >= pair.min + MARGIN) continue;
      const need = request(pair);
      if (!need) continue;
      if (!wanted.has(need.shade)) wanted.set(need.shade, new Set());
      wanted.get(need.shade).add(need.direction);
    }
    if (!wanted.size) break;
    let moved = false;
    for (const [n, directions] of wanted) {
      if (directions.size !== 1) continue; // pulled both ways: nothing can satisfy both, leave it for the audit to report
      const s = state[n];
      const L = Math.min(L_CEIL, Math.max(L_FLOOR, s.L + [...directions][0] * STEP));
      if (L === s.L) continue;
      s.L = L;
      s.hex = oklchToHex(s);
      s.eased = true;
      moved = true;
    }
    if (!moved) break;
  }

  // Keep the scale in order: outward shades never cross their inner neighbour.
  const lower = ORDER.filter((n) => n < 500 && state[n]).reverse(); // 400 .. 50
  const upper = ORDER.filter((n) => n > 500 && state[n]); // 600 .. 950
  let previous = state[500];
  for (const n of lower) {
    if (previous && state[n].L < previous.L + MIN_GAP) {
      state[n].L = Math.min(L_CEIL, previous.L + MIN_GAP);
      state[n].hex = oklchToHex(state[n]);
      state[n].eased = true;
    }
    previous = state[n];
  }
  previous = state[500];
  for (const n of upper) {
    if (previous && state[n].L > previous.L - MIN_GAP) {
      state[n].L = Math.max(L_FLOOR, previous.L - MIN_GAP);
      state[n].hex = oklchToHex(state[n]);
      state[n].eased = true;
    }
    previous = state[n];
  }
  return state;
}
