import { describe, test, expect, vi } from "vitest";
import { isCloudflareAddress, relayHosts, createRelayDnsCheck } from "../../lib/relayDns.js";

describe("isCloudflareAddress", () => {
  test.each([
    ["104.16.0.1", true],
    ["172.67.153.9", true],
    ["188.114.97.3", true],
    ["2606:4700:3030::6815:1", true],
    ["203.0.113.5", false],
    ["95.216.1.1", false],
    ["2a01:4f8::1", false],
    ["not-an-ip", false],
  ])("%s -> %s", (ip, expected) => {
    expect(isCloudflareAddress(ip)).toBe(expected);
  });
});

describe("relayHosts", () => {
  test("takes the host names out of turn:, turns: and stun: addresses", () => {
    expect(
      relayHosts([
        "stun:turn.example.com:3478",
        "turn:turn.example.com:3478?transport=udp",
        "turns:Relay.Example.org:5349",
        "turn:203.0.113.5:3478",
        "turn:[2001:db8::1]:3478",
        "turn:other.example.com",
      ]),
    ).toEqual(["turn.example.com", "relay.example.org", "other.example.com"]);
  });
});

describe("createRelayDnsCheck", () => {
  const cfg = (urls) => ({ turnUrls: urls });
  const resolving = (table) =>
    vi.fn(async (host) => {
      if (!(host in table)) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
      return table[host].map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    });

  test("spots a relay name that is behind Cloudflare's proxy", async () => {
    const check = createRelayDnsCheck({ lookup: resolving({ "turn.example.com": ["104.21.5.6", "172.67.1.2"] }) });
    const result = await check.inspect(cfg(["turn:turn.example.com:3478"]));
    expect(result.proxied).toBe(true);
    expect(result.hosts).toEqual(["turn.example.com"]);
    expect(result.warnings.join(" ")).toMatch(/turn\.example\.com/);
    expect(result.warnings.join(" ")).toMatch(/DNS only/);
  });

  test("a relay on its own address is fine, and so is a bare IP address", async () => {
    const lookup = resolving({ "turn.example.com": ["203.0.113.5"] });
    const check = createRelayDnsCheck({ lookup });
    expect((await check.inspect(cfg(["turn:turn.example.com:3478", "turn:198.51.100.7:3478"]))).proxied).toBe(false);
    expect(lookup).toHaveBeenCalledTimes(1); // the IP address needs no lookup
  });

  test("a name that cannot be resolved is not an accusation", async () => {
    const check = createRelayDnsCheck({ lookup: resolving({}) });
    const result = await check.inspect(cfg(["turn:gone.example.com:3478"]));
    expect(result.proxied).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  test("answers are remembered for a while, then looked up again", async () => {
    let now = 1_000;
    const lookup = resolving({ "turn.example.com": ["104.21.5.6"] });
    const check = createRelayDnsCheck({ lookup, ttlMs: 60_000, now: () => now });
    await check.inspect(cfg(["turn:turn.example.com:3478"]));
    await check.inspect(cfg(["turn:turn.example.com:3478"]));
    expect(lookup).toHaveBeenCalledTimes(1);
    now += 61_000;
    await check.inspect(cfg(["turn:turn.example.com:3478"]));
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  test("a slow resolver never holds up a call: the answer is 'not known' after the time limit", async () => {
    const slow = vi.fn(() => new Promise(() => {}));
    const check = createRelayDnsCheck({ lookup: slow, timeoutMs: 20 });
    const result = await check.inspect(cfg(["turn:slow.example.com:3478"]));
    expect(result.proxied).toBe(false);
  });

  test("no relay configured: nothing to look up", async () => {
    const lookup = vi.fn();
    const check = createRelayDnsCheck({ lookup });
    expect((await check.inspect(cfg([]))).proxied).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });
});
