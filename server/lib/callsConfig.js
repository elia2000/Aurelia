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
  return {
    iceServers: servers,
    hasRelay: Boolean(expiresAt),
    // Only meaningful (and only honoured) when a relay is actually available;
    // forcing relay-only without one would make every call fail.
    forceRelay: Boolean(config.forceRelay && expiresAt),
    expiresAt,
    ttlSeconds: expiresAt ? config.credentialTtlSeconds : null,
  };
}
