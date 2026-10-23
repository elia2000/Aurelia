// Brute-force protection for everything that checks a password or a second
// factor (sign in, change password, delete account, turn 2FA off).
//
// Only FAILED attempts are counted. Three buckets, all sliding windows:
//   - per IP address + account name   : stops a script hammering one account
//   - per account name (any IP)       : slows a distributed guess at one account
//   - per IP address                  : stops one machine walking a username list
// Unknown account names are counted exactly like known ones, so the limit can
// not be used to find out which names exist.
//
// State is in memory and per process (a restart or a second instance starts
// fresh). A signed-in route passes the user id instead of an account name.

import { createThrottle } from "./throttle.js";
import { logAuthFailure } from "./authFailureLog.js";

export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

const clip = (value) => String(value ?? "").trim().toLowerCase().slice(0, 128);

export function createLoginGuard({
  windowMs = LOGIN_WINDOW_MS,
  perPairMax = 8,
  perAccountMax = 30,
  perIpMax = 60,
  now = () => Date.now(),
  // Called with { ip, account } for every failure, e.g. to write the
  // `auth_failed` line fail2ban reads (lib/authFailureLog.js).
  onFailure = null,
} = {}) {
  const pair = createThrottle({ windowMs, max: perPairMax, now });
  const account = createThrottle({ windowMs, max: perAccountMax, now });
  const ip = createThrottle({ windowMs, max: perIpMax, now });

  const keys = ({ ip: address, account: name }) => ({
    pairKey: `${clip(address)}|${clip(name)}`,
    accountKey: clip(name),
    ipKey: clip(address),
  });

  return {
    windowSeconds: Math.ceil(windowMs / 1000),
    /** { allowed: boolean } - call before checking the credentials. */
    check(who) {
      const { pairKey, accountKey, ipKey } = keys(who);
      const allowed =
        pair.remaining(pairKey) > 0 && account.remaining(accountKey) > 0 && ip.remaining(ipKey) > 0;
      return { allowed };
    },
    recordFailure(who) {
      const { pairKey, accountKey, ipKey } = keys(who);
      pair.take(pairKey);
      account.take(accountKey);
      ip.take(ipKey);
      if (onFailure) onFailure(who);
    },
    /** A good sign-in clears the pair bucket only: the account and IP buckets keep counting. */
    recordSuccess(who) {
      pair.reset(keys(who).pairKey);
    },
  };
}

/** One guard shared by every route module that registers on the same `deps`. */
export function loginGuardFor(deps) {
  // Every failure is also written as one `auth_failed` line (see authFailureLog.js);
  // a test can pass its own `logAuthFailure` in deps to capture or silence it.
  if (!deps.loginGuard) {
    deps.loginGuard = createLoginGuard({ onFailure: deps.logAuthFailure || logAuthFailure });
  }
  return deps.loginGuard;
}

export function sendTooManyAttempts(res, guard) {
  res.setHeader("Retry-After", String(guard?.windowSeconds || 900));
  return res.status(429).json({ error: "Too many attempts. Try again later." });
}
