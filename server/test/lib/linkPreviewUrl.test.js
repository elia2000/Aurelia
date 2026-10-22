import { describe, expect, test } from "vitest";
import { LinkPreviewError, checkLinkUrl } from "../../lib/linkPreview/guardedFetch.js";

const refused = (value, options) => {
  let error;
  try {
    checkLinkUrl(value, options);
  } catch (caught) {
    error = caught;
  }
  expect(error, `expected ${JSON.stringify(value)} to be refused`).toBeInstanceOf(LinkPreviewError);
  expect(error.code).toBe("invalid_url");
};

describe("allowed links", () => {
  test.each([
    "http://example.com/",
    "https://example.com/path?q=1#frag",
    "https://sub.example.co.uk/a/b",
    "http://example.com:80/",
    "https://example.com:443/",
    "https://example.com:80/", // ports 80 and 443 are both fine on either scheme
    "http://93.184.216.34/",
    "https://[2606:4700:4700::1111]/",
    "http://example.com./", // a fully qualified name
    "https://xn--mnchen-3ya.de/",
    "https://münchen.de/",
    "  https://example.com/  ",
  ])("%s", (value) => {
    expect(checkLinkUrl(value)).toBeInstanceOf(URL);
  });

  test("the #fragment is dropped (it is never sent to a server)", () => {
    expect(checkLinkUrl("https://example.com/a?b=1#secret").href).toBe("https://example.com/a?b=1");
  });
});

describe("schemes other than http and https", () => {
  test.each([
    "ftp://example.com/",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "gopher://example.com/",
    "ws://example.com/",
    "wss://example.com/",
    "blob:https://example.com/uuid",
    "mailto:a@example.com",
    "//example.com/",
    "example.com",
    "www.example.com",
    "/relative/path",
  ])("%s", (value) => refused(value));
});

describe("links with a user name or password", () => {
  test.each([
    "http://user:pass@example.com/",
    "https://user@example.com/",
    "http://a@127.0.0.1/",
    "http://127.0.0.1@example.com/", // the host is example.com, the "user" is 127.0.0.1
    "https://example.com@evil.example.org/",
    "http://:pw@example.com/",
    "http://%40@example.com/",
  ])("%s", (value) => refused(value));

  test("a backslash does not hide a second host from the parser we also connect with", () => {
    // WHATWG parsing treats "\" like "/": the host is evil.example.com, the rest is path.
    const url = checkLinkUrl("http://evil.example.com\\@127.0.0.1/");
    expect(url.hostname).toBe("evil.example.com");
  });
});

describe("ports", () => {
  test.each([
    "http://example.com:8080/",
    "http://example.com:22/",
    "http://example.com:6379/",
    "http://example.com:5432/",
    "https://example.com:8443/",
    "https://example.com:444/",
    "http://example.com:1/",
    "http://example.com:65535/",
  ])("%s", (value) => refused(value));
});

describe("addresses written out, in every spelling", () => {
  test.each([
    ["http://127.0.0.1/", "loopback"],
    ["http://127.0.0.1:80/", "loopback with a port"],
    ["http://127.1/", "short form"],
    ["http://127.0.1/", "short form"],
    ["http://2130706433/", "decimal"],
    ["http://0x7f000001/", "hex"],
    ["http://0x7f.1/", "hex and decimal"],
    ["http://0x7f.0x0.0x0.0x1/", "hex"],
    ["http://017700000001/", "octal"],
    ["http://0177.0.0.1/", "octal"],
    ["http://0177.0000.0000.0001/", "octal"],
    ["http://0/", "zero"],
    ["http://0.0.0.0/", "this network"],
    ["http://169.254.169.254/latest/meta-data/", "metadata endpoint"],
    ["http://2852039166/", "metadata endpoint, decimal"],
    ["http://0xa9fea9fe/", "metadata endpoint, hex"],
    ["http://10.0.0.5/", "private"],
    ["http://172.16.0.1/", "private"],
    ["http://192.168.1.1/", "private"],
    ["http://3232235777/", "192.168.1.1 as one number"],
    ["http://0300.0250.0.1/", "192.168.0.1 in octal"],
    ["http://0xc0.0xa8.1.1/", "192.168.1.1 in hex"],
    ["http://100.64.0.1/", "carrier-grade NAT"],
    ["http://224.0.0.1/", "multicast"],
    ["http://255.255.255.255/", "broadcast"],
    ["http://[::1]/", "IPv6 loopback"],
    ["http://[0:0:0:0:0:0:0:1]/", "IPv6 loopback, long form"],
    ["http://[::]/", "IPv6 unspecified"],
    ["http://[::ffff:127.0.0.1]/", "IPv4-mapped loopback"],
    ["http://[::ffff:7f00:1]/", "IPv4-mapped loopback, hex"],
    ["http://[::ffff:169.254.169.254]/", "IPv4-mapped metadata endpoint"],
    ["http://[::ffff:a9fe:a9fe]/", "IPv4-mapped metadata endpoint, hex"],
    ["http://[64:ff9b::7f00:1]/", "NAT64 of loopback"],
    ["http://[fc00::1]/", "unique local"],
    ["http://[fd00::1]/", "unique local"],
    ["http://[fe80::1]/", "link-local"],
    ["http://[ff02::1]/", "multicast"],
    ["http://[2001:db8::1]/", "documentation"],
    ["http://[2002:7f00:1::]/", "6to4 of loopback"],
    ["https://127.0.0.1/", "https"],
    ["https://[::1]:443/", "https with a port"],
  ])("%s (%s)", (value) => refused(value));

  test("a host that is not an IP address but ends like a number is not a valid URL at all", () => {
    refused("http://1.2.3.4.5/");
    refused("http://foo.0x7f/");
    refused("http://256.256.256.256/");
  });
});

describe("host names that only mean something on a private network", () => {
  test.each([
    "http://localhost/",
    "http://localhost./",
    "http://LOCALHOST/",
    "http://app.localhost/",
    "http://intranet/",
    "http://printer/",
    "http://printer.local/",
    "http://metadata.google.internal/",
    "http://router.lan/",
    "http://nas.home/",
    "http://x.corp/",
    "http://host.localdomain/",
    "http://thing.home.arpa/",
    "http://1.0.0.127.in-addr.arpa/",
  ])("%s", (value) => refused(value));
});

describe("malformed input", () => {
  test.each([
    "",
    "   ",
    null,
    undefined,
    42,
    {},
    [],
    "http://",
    "http:///path",
    "https://exa mple.com/",
    "http://example.com/a b",
    "http://exa\tmple.com/",
    "http://example.com/\nHost: evil",
    "http://example.com/\r\nX: y",
    "http://example.com/\u0000",
    `http://example.com/${"a".repeat(2100)}`,
  ])("%j", (value) => refused(value));
});

describe("the test hook (allowPrivate) only lifts the address and port checks", () => {
  test("loopback addresses, odd ports and bare names are allowed", () => {
    expect(checkLinkUrl("http://127.0.0.1:8123/x", { allowPrivate: true }).port).toBe("8123");
    expect(checkLinkUrl("http://localhost:3000/", { allowPrivate: true }).hostname).toBe("localhost");
    expect(checkLinkUrl("http://[::1]:9/", { allowPrivate: true }).hostname).toBe("[::1]");
  });

  test.each([
    "ftp://127.0.0.1/",
    "file:///etc/passwd",
    "http://user:pw@127.0.0.1:8123/",
    "javascript:alert(1)",
    "",
  ])("%s is still refused", (value) => refused(value, { allowPrivate: true }));
});
