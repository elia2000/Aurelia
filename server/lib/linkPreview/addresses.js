/**
 * Which IP addresses a link preview may connect to.
 *
 * The server fetches a page on behalf of a person, so the page's address must
 * never be one that only the server can reach (its own machine, the private
 * network, a cloud metadata endpoint). Only a PUBLIC address is allowed:
 *
 *   IPv4  everything except the reserved blocks listed in V4_BLOCKED
 *         (this-network, private, CGNAT, loopback, link-local incl. the
 *         169.254.169.254 metadata endpoint, documentation, benchmarking,
 *         multicast, reserved/broadcast).
 *   IPv6  only global unicast (2000::/3), minus the blocks inside it that are
 *         not ordinary public hosts (IETF protocol assignments incl. Teredo,
 *         documentation, 6to4). That leaves out ::, ::1, fc00::/7, fe80::/10,
 *         ff00::/8 and the NAT64 prefixes (64:ff9b::/96, 64:ff9b:1::/48)
 *         without having to list them.
 *   IPv4-mapped IPv6 (::ffff:a.b.c.d) is judged by the IPv4 address inside.
 *
 * Anything that does not parse is NOT public. No DNS and no network here.
 */

import net from "node:net";

// [address, prefix length]
const V4_BLOCKED = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay anycast (deprecated)
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, incl. 255.255.255.255
];

/** "a.b.c.d" (plain decimal, no leading zeros) -> unsigned 32-bit number, or null. */
export function parseIPv4(text) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(text ?? ""));
  if (!match) return null;
  let value = 0;
  for (let i = 1; i <= 4; i += 1) {
    const part = match[i];
    // "010" is octal to some parsers and decimal to others: refuse to guess.
    if (part.length > 1 && part.startsWith("0")) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

const V4_BLOCKS = V4_BLOCKED.map(([address, prefix]) => {
  const base = parseIPv4(address);
  const size = 2 ** (32 - prefix);
  return { start: base, end: base + size - 1 };
});

export function isPublicIPv4Number(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) return false;
  return !V4_BLOCKS.some((block) => value >= block.start && value <= block.end);
}

/**
 * An IPv6 address (optionally in [brackets]) -> eight 16-bit numbers, or null.
 * A zone id ("fe80::1%eth0") is refused.
 */
export function parseIPv6(input) {
  let text = String(input ?? "").trim();
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  if (!text || text.includes("%") || !net.isIPv6(text)) return null;

  // "::ffff:1.2.3.4": turn the dotted tail into two groups.
  if (text.includes(".")) {
    const cut = text.lastIndexOf(":");
    const v4 = parseIPv4(text.slice(cut + 1));
    if (v4 === null) return null;
    text = `${text.slice(0, cut + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  let groups;
  if (halves.length === 2) {
    const tail = halves[1] ? halves[1].split(":") : [];
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null;
    groups = [...head, ...Array(fill).fill("0"), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const words = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    words.push(parseInt(group, 16));
  }
  return words;
}

export function isPublicIPv6Words(words) {
  if (!Array.isArray(words) || words.length !== 8) return false;
  // ::ffff:a.b.c.d is an IPv4 address in disguise.
  if (
    words[0] === 0 && words[1] === 0 && words[2] === 0 &&
    words[3] === 0 && words[4] === 0 && words[5] === 0xffff
  ) {
    return isPublicIPv4Number(words[6] * 65536 + words[7]);
  }
  // Only 2000::/3 (global unicast) can be a public host.
  if ((words[0] & 0xe000) !== 0x2000) return false;
  if (words[0] === 0x2001 && words[1] < 0x0200) return false; // 2001::/23: Teredo, benchmarking, ORCHID, ...
  if (words[0] === 0x2001 && words[1] === 0x0db8) return false; // 2001:db8::/32 documentation
  if (words[0] === 0x2002) return false; // 2002::/16 6to4
  if (words[0] === 0x3fff && (words[1] & 0xf000) === 0) return false; // 3fff::/20 documentation
  return true;
}

/** true only for a well-formed IPv4 or IPv6 address that is a public host. */
export function isPublicAddress(address) {
  const text = String(address ?? "").trim();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) {
    const value = parseIPv4(text);
    return value !== null && isPublicIPv4Number(value);
  }
  const words = parseIPv6(text);
  return words !== null && isPublicIPv6Words(words);
}

/** 4, 6 or 0 (not an address). Brackets around an IPv6 literal are allowed. */
export function addressFamily(address) {
  const text = String(address ?? "").trim();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) return parseIPv4(text) === null ? 0 : 4;
  return parseIPv6(text) ? 6 : 0;
}
