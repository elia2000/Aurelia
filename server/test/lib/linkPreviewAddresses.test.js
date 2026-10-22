import { describe, expect, test } from "vitest";
import {
  addressFamily,
  isPublicAddress,
  parseIPv4,
  parseIPv6,
} from "../../lib/linkPreview/addresses.js";

describe("IPv4: every reserved block is refused", () => {
  // [address, why]
  const blocked = [
    ["0.0.0.0", "this network"],
    ["0.255.255.255", "this network"],
    ["10.0.0.1", "private"],
    ["10.255.255.255", "private"],
    ["100.64.0.0", "carrier-grade NAT"],
    ["100.100.100.100", "carrier-grade NAT"],
    ["100.127.255.255", "carrier-grade NAT"],
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback"],
    ["169.254.0.1", "link-local"],
    ["169.254.169.254", "cloud metadata endpoint"],
    ["172.16.0.1", "private"],
    ["172.20.10.10", "private"],
    ["172.31.255.255", "private"],
    ["192.0.0.1", "IETF protocol assignments"],
    ["192.0.0.170", "IETF protocol assignments"],
    ["192.0.2.1", "documentation"],
    ["192.88.99.1", "6to4 relay"],
    ["192.168.0.1", "private"],
    ["192.168.255.255", "private"],
    ["198.18.0.1", "benchmarking"],
    ["198.19.255.255", "benchmarking"],
    ["198.51.100.7", "documentation"],
    ["203.0.113.7", "documentation"],
    ["224.0.0.1", "multicast"],
    ["239.255.255.250", "multicast"],
    ["240.0.0.1", "reserved"],
    ["255.255.255.255", "broadcast"],
  ];
  test.each(blocked)("%s (%s) is not public", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  // The addresses just outside each block are public: the ranges are not too wide.
  test.each([
    "1.1.1.1", "8.8.8.8", "9.255.255.255", "11.0.0.0", "100.63.255.255", "100.128.0.0",
    "126.255.255.255", "128.0.0.1", "169.253.255.255", "169.255.0.0", "172.15.255.255",
    "172.32.0.0", "192.0.1.1", "192.167.255.255", "192.169.0.0", "198.17.255.255",
    "198.20.0.0", "203.0.112.255", "203.0.114.0", "223.255.255.255", "93.184.216.34",
  ])("%s is public", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});

describe("IPv6: only global unicast is public", () => {
  test.each([
    ["::", "unspecified"],
    ["::1", "loopback"],
    ["0:0:0:0:0:0:0:1", "loopback, long form"],
    ["fc00::1", "unique local fc00::/7"],
    ["fd12:3456:789a::1", "unique local fc00::/7"],
    ["fe80::1", "link-local fe80::/10"],
    ["febf::1", "link-local fe80::/10"],
    ["fec0::1", "site-local"],
    ["ff02::1", "multicast"],
    ["ff00::", "multicast"],
    ["64:ff9b::7f00:1", "NAT64 of 127.0.0.1"],
    ["64:ff9b::a9fe:a9fe", "NAT64 of the metadata endpoint"],
    ["64:ff9b::808:808", "NAT64 of a public IPv4 is refused as well"],
    ["64:ff9b:1::1", "local-use NAT64"],
    ["::127.0.0.1", "IPv4-compatible"],
    ["::7f00:1", "IPv4-compatible"],
    ["100::1", "discard-only"],
    ["2001::1", "Teredo"],
    ["2001:0:4136:e378:8000:63bf:3fff:fdd2", "Teredo"],
    ["2001:2::1", "benchmarking"],
    ["2001:10::1", "ORCHID"],
    ["2001:db8::1", "documentation"],
    ["2002:7f00:1::", "6to4 of 127.0.0.1"],
    ["2002:808:808::", "6to4 of a public IPv4 is refused as well"],
    ["3fff::1", "documentation"],
    ["3fff:0fff::1", "documentation"],
    ["5f00::1", "SRv6"],
    ["4000::1", "not global unicast"],
    ["8000::1", "not global unicast"],
  ])("%s (%s) is not public", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  test.each([
    ["::ffff:127.0.0.1", "IPv4-mapped loopback"],
    ["::ffff:7f00:1", "IPv4-mapped loopback, hex form"],
    ["0:0:0:0:0:ffff:7f00:0001", "IPv4-mapped loopback, long form"],
    ["::ffff:10.1.2.3", "IPv4-mapped private"],
    ["::ffff:169.254.169.254", "IPv4-mapped metadata endpoint"],
    ["::ffff:a9fe:a9fe", "IPv4-mapped metadata endpoint, hex form"],
    ["::ffff:192.168.0.1", "IPv4-mapped private"],
    ["::ffff:0.0.0.0", "IPv4-mapped this network"],
    ["[::1]", "bracketed loopback"],
    ["fe80::1%eth0", "link-local with a zone id"],
  ])("%s (%s) is not public", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  test.each([
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
    "2a00:1450:4001:81b::200e",
    "2400:cb00::1",
    "2620:fe::fe",
    "3ffe::1", // outside 3fff::/20
    "2001:200::1", // just past 2001::/23
    "[2606:4700:4700::1111]",
    "::ffff:8.8.8.8", // an IPv4-mapped PUBLIC address is judged by the IPv4 address
  ])("%s is public", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});

describe("things that are not addresses are not public", () => {
  test.each([
    "", "localhost", "example.com", "1.2.3", "1.2.3.4.5", "256.1.1.1", "1.1.1.256",
    "010.0.0.1", "0x7f.0.0.1", "2130706433", "127.1", "1.2.3.4/8", "1.2.3.4:80",
    "::g", ":::", "1:2:3:4:5:6:7:8:9", "12345::1", "1::2::3", " ", null, undefined, 42,
  ])("%j", (value) => {
    expect(isPublicAddress(value)).toBe(false);
  });
});

describe("parsing", () => {
  test("IPv4 is plain decimal only", () => {
    expect(parseIPv4("1.2.3.4")).toBe(0x01020304);
    expect(parseIPv4("255.255.255.255")).toBe(0xffffffff);
    expect(parseIPv4("01.2.3.4")).toBeNull(); // octal for some parsers
    expect(parseIPv4("1.2.3")).toBeNull();
  });

  test("IPv6 forms all become eight 16-bit words", () => {
    expect(parseIPv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6("::")).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseIPv6("1::")).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseIPv6("2001:db8::ff00:42:8329")).toEqual([0x2001, 0xdb8, 0, 0, 0, 0xff00, 0x42, 0x8329]);
    expect(parseIPv6("::ffff:1.2.3.4")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    expect(parseIPv6("[::1]")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6("fe80::1%25eth0")).toBeNull();
    expect(parseIPv6("1:2:3:4:5:6:7::")).not.toBeNull();
  });

  test("addressFamily", () => {
    expect(addressFamily("1.2.3.4")).toBe(4);
    expect(addressFamily("::1")).toBe(6);
    expect(addressFamily("[::1]")).toBe(6);
    expect(addressFamily("example.com")).toBe(0);
    expect(addressFamily("010.0.0.1")).toBe(0);
  });
});
