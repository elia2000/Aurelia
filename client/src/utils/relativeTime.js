const UNITS = [
  ["day", 24 * 60 * 60 * 1000],
  ["hour", 60 * 60 * 1000],
  ["minute", 60 * 1000],
];

/**
 * "Active now", "5 minutes ago", "3 hours ago", "yesterday", "12 days ago", or
 * the date for anything older than 30 days. Pure: pass `now` in tests.
 */
export function formatRelativeTime(value, now = Date.now(), locale = "en") {
  const time = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(time)) return "";
  const diff = Math.max(0, now - time);
  if (diff < 60 * 1000) return "Active now";
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const [unit, ms] of UNITS) {
    if (diff >= ms) {
      const amount = Math.floor(diff / ms);
      if (unit === "day" && amount > 30) break;
      return formatter.format(-amount, unit);
    }
  }
  return new Date(time).toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });
}

/** "Jan 2, 2026" - for "signed in on". */
export function formatShortDate(value, locale = "en") {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "";
  return new Date(time).toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });
}
