// Request ceilings per address and 15 minutes (API_RATE_LIMIT, STATIC_RATE_LIMIT).
// They are a flood guard, not the brute-force protection (sign-in has its own
// limit, see loginGuard.js). Everybody behind one VPN, proxy or CDN address
// shares a bucket, so the defaults are generous.

export const DEFAULT_API_RATE_LIMIT = 10000;
export const DEFAULT_STATIC_RATE_LIMIT = 5000;

/** A positive whole number from `value`, otherwise `fallback`. */
export function rateLimitMax(value, fallback) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return fallback;
  const number = Number(text);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}
