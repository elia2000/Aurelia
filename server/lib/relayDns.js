import dns from "node:dns";
import net from "node:net";

// A relay (TURN) host name that sits behind Cloudflare's proxy ("orange cloud")
// can never work: that proxy only forwards web traffic on a few ports, and
// answers for the name with Cloudflare's own addresses, where nothing listens
// on 3478. It is the most common reason a call rings and then never connects,
// so the server looks for it and says so instead of leaving people guessing.
// (Cloudflare Spectrum, a paid product, can proxy other traffic; it is rare.)

// https://www.cloudflare.com/ips/
const CLOUDFLARE_V4 = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22",
  "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
  "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
  "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
];
const CLOUDFLARE_V6 = [
  "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32",
  "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32",
];

const cloudflare = new net.BlockList();
for (const cidr of CLOUDFLARE_V4) {
  const [address, prefix] = cidr.split("/");
  cloudflare.addSubnet(address, Number(prefix), "ipv4");
}
for (const cidr of CLOUDFLARE_V6) {
  const [address, prefix] = cidr.split("/");
  cloudflare.addSubnet(address, Number(prefix), "ipv6");
}

export function isCloudflareAddress(address) {
  const family = net.isIP(String(address || ""));
  if (!family) return false;
  return cloudflare.check(String(address), family === 6 ? "ipv6" : "ipv4");
}

/** Host names (not IP addresses) in a list of stun:/turn:/turns: URLs. */
export function relayHosts(urls) {
  const hosts = [];
  for (const url of urls || []) {
    const rest = String(url).replace(/^(stuns?|turns?):/i, "").split("?")[0];
    if (rest.startsWith("[")) continue; // an IPv6 literal
    const host = rest.split(":")[0].trim().toLowerCase();
    if (host && !net.isIP(host) && !hosts.includes(host)) hosts.push(host);
  }
  return hosts;
}

/**
 * @param {object} [options]
 * @param {Function} [options.lookup]  (host) => Promise<[{address, family}]>
 * @param {number}   [options.ttlMs]   how long an answer is remembered
 * @param {number}   [options.timeoutMs] a lookup slower than this counts as "not known"
 */
export function createRelayDnsCheck({
  lookup = (host) => dns.promises.lookup(host, { all: true }),
  ttlMs = 5 * 60 * 1000,
  timeoutMs = 1500,
  now = () => Date.now(),
} = {}) {
  const cache = new Map(); // host -> {at, proxied}

  async function isProxied(host) {
    const hit = cache.get(host);
    if (hit && now() - hit.at < ttlMs) return hit.proxied;
    let proxied = false;
    let timer;
    try {
      const addresses = await Promise.race([
        lookup(host),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
          if (typeof timer.unref === "function") timer.unref();
        }),
      ]);
      proxied = (addresses || []).some((entry) => isCloudflareAddress(entry.address));
    } catch (_) {
      proxied = false; // not known is not an accusation
    } finally {
      clearTimeout(timer);
    }
    cache.set(host, { at: now(), proxied });
    return proxied;
  }

  return {
    /** @returns {Promise<{proxied: boolean, hosts: string[], warnings: string[]}>} */
    async inspect(config) {
      const hosts = [];
      for (const host of relayHosts(config?.turnUrls)) {
        if (await isProxied(host)) hosts.push(host);
      }
      return {
        proxied: hosts.length > 0,
        hosts,
        warnings: hosts.map(
          (host) =>
            `The relay host "${host}" resolves to Cloudflare. Cloudflare's proxy (orange cloud) cannot carry TURN, so calls between different networks will stay on "Connecting". Set its DNS record to "DNS only" (grey cloud), or put the server's IP address in CALLS_TURN_URLS.`,
        ),
      };
    },
  };
}
