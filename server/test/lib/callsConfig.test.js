import { describe, test, expect } from "vitest";
import crypto from "node:crypto";
import { readCallsConfig, buildIceServers, callsConfigWarnings } from "../../lib/callsConfig.js";

describe("readCallsConfig", () => {
  test("defaults: enabled, no servers, 6h credentials", () => {
    const cfg = readCallsConfig({});
    expect(cfg.enabled).toBe(true);
    expect(cfg.turnUrls).toEqual([]);
    expect(cfg.stunUrls).toEqual([]);
    expect(cfg.credentialTtlSeconds).toBe(21600);
  });

  test("CALLS_TURN_HOST is the short way to name the relay: turn.example.com becomes the stun: and turn: addresses", () => {
    expect(readCallsConfig({ CALLS_TURN_HOST: "turn.example.com" }).turnUrls).toEqual(["turn:turn.example.com:3478"]);
    expect(readCallsConfig({ CALLS_TURN_HOST: "turn.example.com" }).stunUrls).toEqual(["stun:turn.example.com:3478"]);
    const custom = readCallsConfig({ CALLS_TURN_HOST: " TURN.Example.com ", CALLS_TURN_PORT: "5000" });
    expect(custom.turnUrls).toEqual(["turn:turn.example.com:5000"]);
    expect(readCallsConfig({ CALLS_TURN_HOST: "203.0.113.7" }).turnUrls).toEqual(["turn:203.0.113.7:3478"]);
    // an explicit URL list wins, and junk is ignored
    expect(readCallsConfig({ CALLS_TURN_HOST: "turn.example.com", CALLS_TURN_URLS: "turn:other.example.com:3478" }).turnUrls).toEqual([
      "turn:other.example.com:3478",
    ]);
    for (const bad of ["https://turn.example.com", "turn.example.com/x", "a b", "turn.example.com:3478", "x;y"]) {
      expect(readCallsConfig({ CALLS_TURN_HOST: bad }).turnUrls).toEqual([]);
    }
    expect(readCallsConfig({ CALLS_TURN_HOST: "turn.example.com", CALLS_TURN_PORT: "99999" }).turnUrls).toEqual(["turn:turn.example.com:3478"]);
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

  test("a TURN address also gets a TCP variant (VPNs and proxies often carry only TCP)", () => {
    const cfg = readCallsConfig({
      CALLS_TURN_URLS:
        "stun:t.example.com:3478, turn:t.example.com:3478, turn:u.example.com:3478?transport=udp, turn:v.example.com:80?transport=tcp, turns:t.example.com:5349",
      CALLS_TURN_SECRET: "s",
    });
    const turn = buildIceServers(cfg, "u").iceServers.find((s) => s.username);
    expect(turn.urls).toEqual([
      "stun:t.example.com:3478",
      "turn:t.example.com:3478",
      "turn:t.example.com:3478?transport=tcp",
      "turn:u.example.com:3478?transport=udp",
      "turn:u.example.com:3478?transport=tcp",
      // Already TCP, or TLS (which is TCP): nothing to add.
      "turn:v.example.com:80?transport=tcp",
      "turns:t.example.com:5349",
    ]);
  });

  test("an operator who wants UDP only can switch the extra TCP addresses off", () => {
    const cfg = readCallsConfig({
      CALLS_TURN_URLS: "turn:t.example.com:3478, turn:u.example.com:3478?transport=udp",
      CALLS_TURN_SECRET: "s",
      CALLS_TURN_TCP_FALLBACK: "false",
    });
    expect(cfg.turnTcpFallback).toBe(false);
    const turn = buildIceServers(cfg, "u").iceServers.find((s) => s.username);
    expect(turn.urls).toEqual(["turn:t.example.com:3478", "turn:u.example.com:3478?transport=udp"]);
    expect(readCallsConfig({}).turnTcpFallback).toBe(true);
  });

  test("the TCP variant is not added twice when it is already listed", () => {
    const cfg = readCallsConfig({
      CALLS_TURN_URLS: "turn:t.example.com:3478, turn:t.example.com:3478?transport=tcp",
      CALLS_TURN_SECRET: "s",
    });
    const turn = buildIceServers(cfg, "u").iceServers.find((s) => s.username);
    expect(turn.urls).toEqual(["turn:t.example.com:3478", "turn:t.example.com:3478?transport=tcp"]);
  });

  test("force-relay is honoured with a relay and FAILS CLOSED without one", () => {
    const withRelay = readCallsConfig({
      CALLS_TURN_URLS: "turn:t.example.com:3478",
      CALLS_TURN_SECRET: "s",
      CALLS_FORCE_RELAY: "true",
    });
    const ok = buildIceServers(withRelay, "u");
    expect(ok.forceRelay).toBe(true);
    expect(ok.relayUnavailable).toBe(false);

    // A typo in the secret must never silently expose both IP addresses.
    const noRelay = buildIceServers(readCallsConfig({ CALLS_FORCE_RELAY: "true" }), "u");
    expect(noRelay.forceRelay).toBe(true);
    expect(noRelay.relayUnavailable).toBe(true);
    expect(noRelay.iceServers).toEqual([]);

    const plain = buildIceServers(readCallsConfig({}), "u");
    expect(plain.forceRelay).toBe(false);
    expect(plain.relayUnavailable).toBe(false);
  });

  test("start-up warnings explain relay misconfiguration", () => {
    expect(callsConfigWarnings(readCallsConfig({}))).toEqual([]);
    expect(callsConfigWarnings(readCallsConfig({ CALLS_ENABLED: "false", CALLS_FORCE_RELAY: "true" }))).toEqual([]);
    expect(callsConfigWarnings(readCallsConfig({ CALLS_FORCE_RELAY: "true" })).join(" ")).toMatch(/refused/);
    expect(callsConfigWarnings(readCallsConfig({ CALLS_TURN_URLS: "turn:a:3478" })).join(" ")).toMatch(/SECRET is empty/);
    expect(callsConfigWarnings(readCallsConfig({ CALLS_TURN_SECRET: "x" })).join(" ")).toMatch(/URLS is empty/);
  });

  test("does not hand out TURN URLs without a secret", () => {
    const cfg = readCallsConfig({ CALLS_TURN_URLS: "turn:t.example.com:3478" });
    expect(buildIceServers(cfg, "u").iceServers).toEqual([]);
  });
});
