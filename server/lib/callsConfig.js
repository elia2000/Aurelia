import crypto from "node:crypto";

// Call (WebRTC) configuration, read from the environment.
//
//   CALLS_ENABLED                     default true
//   CALLS_TURN_URLS                   comma-separated turn:/turns:/stun: URLs
//   CALLS_TURN_SECRET                 coturn `static-auth-secret`
//   CALLS_TURN_CREDENTIAL_TTL_SECONDS default 21600 (6h)
//   CALLS_STUN_URLS                   extra comma-separated stun: URLs
//   CALLS_FORCE_RELAY                 default false; send ALL media through the
//                                     TURN relay so the two people never learn
//                                     each other's IP address (needs TURN)
//
// With no STUN/TURN configured calls still connect on a LAN or between hosts
// with public addresses, but NOT across typical NATs. No third-party STUN
// server is used by default so a self-hosted install never leaks peer IPs to
// an outside party.

const splitUrls = (raw) =>
  String(raw || "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => /^(stun|stuns|turn|turns):/i.test(item));

const truthy = (raw, fallback) => {
  if (raw === undefined || raw === null || raw === "") return fallback;
  return ["1", "true", "yes", "y", "on"].includes(String(raw).trim().toLowerCase());
};

export function readCallsConfig(env = process.env) {
  const ttlRaw = Number(env.CALLS_TURN_CREDENTIAL_TTL_SECONDS);
  return {
    enabled: truthy(env.CALLS_ENABLED, true),
    turnUrls: splitUrls(env.CALLS_TURN_URLS),
    stunUrls: splitUrls(env.CALLS_STUN_URLS),
    turnSecret: String(env.CALLS_TURN_SECRET || "").trim(),
    forceRelay: truthy(env.CALLS_FORCE_RELAY, false),
    credentialTtlSeconds:
      Number.isFinite(ttlRaw) && ttlRaw >= 60 ? Math.trunc(ttlRaw) : 6 * 60 * 60,
  };
}

/**
 * Builds the RTCConfiguration `iceServers` list. TURN credentials follow the
 * coturn "TURN REST API" scheme: username = "<expiry>:<userId>", credential =
 * base64(HMAC-SHA1(secret, username)). They are short-lived and per user.
 */
export function buildIceServers(config, userId, nowMs = Date.now()) {
  const servers = [];
  if (config.stunUrls.length) servers.push({ urls: config.stunUrls });
  let expiresAt = null;
  if (config.turnUrls.length && config.turnSecret) {
    expiresAt = Math.floor(nowMs / 1000) + config.credentialTtlSeconds;
    const username = `${expiresAt}:${userId}`;
    const credential = crypto
      .createHmac("sha1", config.turnSecret)
      .update(username)
      .digest("base64");
    servers.push({ urls: config.turnUrls, username, credential });
  }
  const hasRelay = Boolean(expiresAt);
  return {
    iceServers: servers,
    hasRelay,
    // "Never reveal IP addresses" must fail CLOSED: when the operator asked
    // for relay-only calls but no relay is usable, calls are refused instead
    // of quietly falling back to a direct connection that exposes both IPs.
    forceRelay: Boolean(config.forceRelay),
    relayUnavailable: Boolean(config.forceRelay && !hasRelay),
    expiresAt,
    ttlSeconds: hasRelay ? config.credentialTtlSeconds : null,
  };
}

/** Misconfigurations worth logging once at start-up. */
export function callsConfigWarnings(config) {
  const warnings = [];
  if (!config.enabled) return warnings;
  const hasRelay = Boolean(config.turnUrls.length && config.turnSecret);
  if (config.forceRelay && !hasRelay) {
    warnings.push(
      "CALLS_FORCE_RELAY is on but CALLS_TURN_URLS / CALLS_TURN_SECRET are not both set. Calls will be refused until a relay is configured (they will NOT fall back to direct connections).",
    );
  }
  if (config.turnUrls.length && !config.turnSecret) {
    warnings.push("CALLS_TURN_URLS is set but CALLS_TURN_SECRET is empty: the relay is unusable.");
  }
  if (!config.turnUrls.length && config.turnSecret) {
    warnings.push("CALLS_TURN_SECRET is set but CALLS_TURN_URLS is empty: the relay is unusable.");
  }
  return warnings;
}
