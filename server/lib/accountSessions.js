// Helpers for the "active sessions" list: what is remembered about a device
// and how it is shown.
//
// Privacy: a session keeps the browser family and the operating system only
// ("Firefox on Linux"), taken from the User-Agent header at sign-in. No
// version numbers (they identify a device far more precisely than people
// expect), no raw User-Agent string and no IP address are stored.

export const SESSION_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // matches the cookie's Max-Age
export const SESSION_TOUCH_INTERVAL_MS = 60 * 1000;

export const AUTH_METHODS = Object.freeze({
  PASSWORD: "password",
  PASSWORD_2FA: "password_2fa",
  RECOVERY_CODE: "recovery_code",
  REGISTRATION: "registration",
});

const BROWSERS = [
  ["Edge", /\b(?:Edg|EdgA|EdgiOS|Edge)\//],
  ["Opera", /\b(?:OPR|Opera)\//],
  ["Samsung Internet", /SamsungBrowser\//],
  ["Firefox", /\b(?:Firefox|FxiOS)\//],
  ["Chrome", /\b(?:Chrome|CriOS|Chromium)\//],
  ["Safari", /\bSafari\//],
];

const SYSTEMS = [
  ["iOS", /\b(?:iPhone|iPad|iPod)\b/],
  ["Android", /\bAndroid\b/],
  ["ChromeOS", /\bCrOS\b/],
  ["Windows", /\bWindows\b/],
  ["macOS", /\bMac OS X\b|\bMacintosh\b/],
  ["Linux", /\bLinux\b|\bX11\b/],
];

/** { browser, os } from a User-Agent header. Unknown parts come back as "". */
export function parseUserAgent(userAgent) {
  const ua = String(userAgent || "").slice(0, 512);
  const browser = BROWSERS.find(([, pattern]) => pattern.test(ua))?.[0] || "";
  const os = SYSTEMS.find(([, pattern]) => pattern.test(ua))?.[0] || "";
  return { browser, os };
}

/** The one-line summary that is stored with the session ("Firefox on Linux"). */
export function summarizeUserAgent(userAgent) {
  const { browser, os } = parseUserAgent(userAgent);
  if (browser && os) return `${browser} on ${os}`;
  if (browser) return browser;
  if (os) return `Unknown browser on ${os}`;
  return "Unknown device";
}

/**
 * Database timestamps come as "YYYY-MM-DD HH:MM:SS" (SQLite, UTC, no zone) or
 * as Postgres text such as "2026-01-02 03:04:05.123456+00". Returns an ISO
 * string, or null when the value is not a date.
 */
export function toIsoTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  let text = String(value).trim().replace(" ", "T");
  if (/[+-]\d{2}$/.test(text)) text += ":00";
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(text)) text += "Z";
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function sessionAgeMs(createdAt, now = Date.now()) {
  const iso = toIsoTimestamp(createdAt);
  return iso ? now - new Date(iso).getTime() : 0;
}

/** True when a session row is older than the cookie that carries it. */
export function isSessionExpired(createdAt, now = Date.now()) {
  return sessionAgeMs(createdAt, now) > SESSION_MAX_AGE_MS;
}

/** What the API returns for one session. Never includes the token. */
export function serializeSession(row, currentPublicId) {
  const summary = String(row.user_agent || "").trim();
  const [browser, os] = summary.includes(" on ") ? summary.split(" on ") : [summary, ""];
  const method = row.auth_method || null;
  return {
    id: row.public_id,
    current: Boolean(currentPublicId) && row.public_id === currentPublicId,
    device: summary || "Unknown device",
    browser: browser || null,
    os: os || null,
    method,
    viaPassword:
      method === AUTH_METHODS.PASSWORD ||
      method === AUTH_METHODS.PASSWORD_2FA ||
      method === AUTH_METHODS.RECOVERY_CODE,
    createdAt: toIsoTimestamp(row.created_at),
    lastSeenAt: toIsoTimestamp(row.last_seen),
  };
}

/** This device first, then the most recently active. */
export function sortSessions(list) {
  return [...list].sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    return String(b.lastSeenAt || "").localeCompare(String(a.lastSeenAt || ""));
  });
}
