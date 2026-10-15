import { describe, test, expect } from "vitest";
import crypto from "node:crypto";
import { readCallsConfig, buildIceServers } from "../../lib/callsConfig.js";

describe("readCallsConfig", () => {
  test("defaults: enabled, no servers, 6h credentials", () => {
    const cfg = readCallsConfig({});
    expect(cfg.enabled).toBe(true);
    expect(cfg.turnUrls).toEqual([]);
    expect(cfg.stunUrls).toEqual([]);
    expect(cfg.credentialTtlSeconds).toBe(21600);
  });

  test("parses URL lists, ignoring junk schemes", () => {
    const cfg = readCallsConfig({
      CALLS_TURN_URLS: "turn:t.example.com:3478?transport=udp, turns:t.example.com:5349, http://evil, ",
      CALLS_STUN_URLS: "stun:t.example.com:3478",
      CALLS_ENABLED: "false",
      CALLS_TURN_CREDENTIAL_TTL_SECONDS: "7200",
    });
    expect(cfg.turnUrls).toEqual(["turn:t.example.com:3478?transport=udp", "turns:t.example.com:5349"]);
    expect(cfg.stunUrls).toEqual(["stun:t.example.com:3478"]);
    expect(cfg.enabled).toBe(false);
    expect(cfg.credentialTtlSeconds).toBe(7200);
  });

  test("ignores a TTL that is too small", () => {
    expect(readCallsConfig({ CALLS_TURN_CREDENTIAL_TTL_SECONDS: "5" }).credentialTtlSeconds).toBe(21600);
  });
});

describe("buildIceServers", () => {
  test("returns no relay when TURN is not configured", () => {
    const out = buildIceServers(readCallsConfig({}), "user-1");
    expect(out.iceServers).toEqual([]);
    expect(out.hasRelay).toBe(false);
  });

  test("issues coturn REST-API credentials: username=<expiry>:<user>, HMAC-SHA1", () => {
    const cfg = readCallsConfig({
      CALLS_TURN_URLS: "turn:t.example.com:3478",
      CALLS_TURN_SECRET: "s3cret",
      CALLS_TURN_CREDENTIAL_TTL_SECONDS: "3600",
    });
    const nowMs = 1_700_000_000_000;
    const out = buildIceServers(cfg, "user-1", nowMs);
    const turn = out.iceServers.find((s) => s.username);
    expect(turn.username).toBe(`${1_700_000_000 + 3600}:user-1`);
    const expected = crypto.createHmac("sha1", "s3cret").update(turn.username).digest("base64");
    expect(turn.credential).toBe(expected);
    expect(out.hasRelay).toBe(true);
    expect(out.ttlSeconds).toBe(3600);
  });

  test("force-relay is only advertised when a relay exists", () => {
    const withRelay = readCallsConfig({
      CALLS_TURN_URLS: "turn:t.example.com:3478",
      CALLS_TURN_SECRET: "s",
      CALLS_FORCE_RELAY: "true",
    });
    expect(buildIceServers(withRelay, "u").forceRelay).toBe(true);
    const noRelay = readCallsConfig({ CALLS_FORCE_RELAY: "true" });
    expect(noRelay.forceRelay).toBe(true);
    expect(buildIceServers(noRelay, "u").forceRelay).toBe(false);
    expect(buildIceServers(readCallsConfig({}), "u").forceRelay).toBe(false);
  });

  test("does not hand out TURN URLs without a secret", () => {
    const cfg = readCallsConfig({ CALLS_TURN_URLS: "turn:t.example.com:3478" });
    expect(buildIceServers(cfg, "u").iceServers).toEqual([]);
  });
});
