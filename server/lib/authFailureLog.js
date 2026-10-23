// One stable log line per failed credential check (wrong password, wrong 2FA
// code, ...), written to stdout so it lands in the systemd journal or in
// `docker logs`. It exists for fail2ban (deploy/fail2ban/) and for an operator
// who wants to see who is guessing; docs/Fail2ban.md describes the format.
//
//   2026-10-22T21:30:00.123Z [auth] auth_failed ip=203.0.113.9 user=3f9a1c2b7d4e reason=credentials
//
// - ip     the client address as Express resolves it (req.ip, so it follows the
//          "trust proxy" setting), or "unknown" when it is not a valid address.
//          Anything that is not a plain IP address is never copied into the log,
//          so a forged X-Forwarded-For value cannot inject text or fake a line.
// - user   a 12 character keyed hash of the account name that was tried, or "-".
//          The key is random per process: the same name gives the same value
//          until the server restarts, but a leaked log can not be used to guess
//          names or passwords typed into the user name box offline. Unknown
//          accounts are hashed exactly like known ones.
// - reason a short fixed word, never user input.
//
// Passwords, codes and raw account names are never written.

import crypto from "node:crypto";
import net from "node:net";

const HASH_KEY = crypto.randomBytes(32);
const REASON = /^[a-z0-9_-]{1,24}$/;

/** A plain IP address (IPv4-mapped IPv6 turned into IPv4, zone dropped), or null. */
export function normalizeIp(value) {
  let text = String(value ?? "").trim().toLowerCase();
  if (!text || text.length > 64) return null;
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (mapped) text = mapped[1];
  return net.isIP(text) ? text : null;
}

/** Keyed short hash of an account name, "-" when there is none. */
export function hashAccountName(name) {
  const text = String(name ?? "").trim().toLowerCase().slice(0, 128);
  if (!text) return "-";
  return crypto.createHmac("sha256", HASH_KEY).update(text).digest("hex").slice(0, 12);
}

export function formatAuthFailure({ ip, account, reason } = {}, now = new Date()) {
  const safeReason = REASON.test(String(reason ?? "")) ? reason : "credentials";
  return `${now.toISOString()} [auth] auth_failed ip=${normalizeIp(ip) ?? "unknown"} user=${hashAccountName(account)} reason=${safeReason}`;
}

/** Writes the line to stdout (or to `sink`, for tests). */
export function logAuthFailure(who, sink = console.log) {
  try {
    sink(formatAuthFailure(who));
  } catch {
    // logging must never break a sign-in
  }
}
