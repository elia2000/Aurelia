import { describe, expect, test } from "vitest";
import { setTimeout as sleep } from "node:timers/promises";
import { LinkPreviewError, USER_AGENT, createGuardedFetcher } from "../../lib/linkPreview/guardedFetch.js";
import {
  PUBLIC_IP,
  PUBLIC_IP_2,
  htmlResponse,
  makeResolver,
  makeTransport,
  redirectTo,
} from "../helpers/linkPreviewFixture.js";

const HTML = { maxBytes: 64 * 1024, contentTypes: ["text/html"] };

async function codeOf(promise) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(LinkPreviewError);
    return error.code;
  }
  return "no error";
}

function setup({ dns = { "example.com": [PUBLIC_IP], "other.example.org": [PUBLIC_IP_2] }, handler, ...options } = {}) {
  const resolve = makeResolver(dns);
  const transport = makeTransport(handler || (() => htmlResponse("<title>Hi</title>")));
  const fetchGuarded = createGuardedFetcher({ resolve, transport, ...options });
  return { resolve, transport, fetchGuarded };
}

describe("a normal fetch", () => {
  test("connects to the address that was resolved and checked, and sends only fixed headers", async () => {
    const { fetchGuarded, transport, resolve } = setup();
    const result = await fetchGuarded("https://example.com/page?q=1", HTML);
    expect(result.status).toBe(200);
    expect(result.contentType).toBe("text/html");
    expect(result.url.href).toBe("https://example.com/page?q=1");
    expect(result.body.toString()).toContain("<title>Hi</title>");

    expect(resolve.calls).toEqual(["example.com"]);
    expect(transport.requests).toHaveLength(1);
    const [request] = transport.requests;
    expect(request.addresses).toEqual([{ address: PUBLIC_IP, family: 4 }]);
    expect(request.headers["User-Agent"]).toBe(USER_AGENT);
    expect(request.headers["Accept-Encoding"]).toBe("identity");
    const names = Object.keys(request.headers).map((name) => name.toLowerCase());
    expect(names).not.toContain("cookie");
    expect(names).not.toContain("referer");
    expect(names).not.toContain("authorization");
    expect(names).not.toContain("content-length"); // no request body
  });

  test("an address typed into the link needs no DNS but is checked all the same", async () => {
    const { fetchGuarded, resolve, transport } = setup();
    await fetchGuarded(`http://${PUBLIC_IP}/x`, HTML);
    expect(resolve.calls).toEqual([]);
    expect(transport.requests[0].addresses).toEqual([{ address: PUBLIC_IP, family: 4 }]);
  });

  test("an IPv6 answer is passed on as IPv6", async () => {
    const { fetchGuarded, transport } = setup({ dns: { "example.com": ["2606:4700:4700::1111", PUBLIC_IP] } });
    await fetchGuarded("https://example.com/", HTML);
    expect(transport.requests[0].addresses).toEqual([
      { address: "2606:4700:4700::1111", family: 6 },
      { address: PUBLIC_IP, family: 4 },
    ]);
  });

  test("the media type is compared without its parameters and in any case", async () => {
    const { fetchGuarded } = setup({
      handler: () => ({ status: 200, headers: { "Content-Type": "TEXT/HTML ; Charset=UTF-8" }, body: "<title>x</title>" }),
    });
    expect((await fetchGuarded("https://example.com/", HTML)).contentType).toBe("text/html");
  });
});

describe("host names that resolve to private addresses (DNS pointing inside)", () => {
  test.each([
    ["127.0.0.1", "loopback"],
    ["10.1.2.3", "private"],
    ["169.254.169.254", "metadata endpoint"],
    ["192.168.0.10", "private"],
    ["100.64.0.9", "carrier-grade NAT"],
    ["0.0.0.0", "this network"],
    ["::1", "IPv6 loopback"],
    ["fd00::5", "unique local"],
    ["fe80::1", "link-local"],
    ["::ffff:127.0.0.1", "IPv4-mapped loopback"],
    ["::ffff:10.0.0.1", "IPv4-mapped private"],
    ["64:ff9b::7f00:1", "NAT64"],
  ])("%s (%s) is refused and nothing is connected to", async (address) => {
    const { fetchGuarded, transport } = setup({ dns: { "evil.example.com": [address] } });
    expect(await codeOf(fetchGuarded("https://evil.example.com/", HTML))).toBe("blocked_address");
    expect(transport.requests).toEqual([]);
  });

  test("one private address among public ones refuses the whole answer", async () => {
    const { fetchGuarded, transport } = setup({ dns: { "mixed.example.com": [PUBLIC_IP, "10.0.0.1"] } });
    expect(await codeOf(fetchGuarded("https://mixed.example.com/", HTML))).toBe("blocked_address");
    expect(transport.requests).toEqual([]);
  });

  test("the name is looked up once and the connection uses that answer (no rebinding)", async () => {
    // First answer is public, any later one would be the metadata endpoint.
    const { fetchGuarded, resolve, transport } = setup({
      dns: { "rebind.example.com": (n) => (n === 1 ? [PUBLIC_IP] : ["169.254.169.254"]) },
    });
    await fetchGuarded("https://rebind.example.com/", HTML);
    expect(resolve.calls).toEqual(["rebind.example.com"]);
    expect(transport.requests[0].addresses).toEqual([{ address: PUBLIC_IP, family: 4 }]);
  });

  test("a rebinding answer for a REDIRECT target is looked up and refused", async () => {
    const { fetchGuarded, transport } = setup({
      dns: {
        "example.com": [PUBLIC_IP],
        "rebind.example.com": (n) => (n === 1 ? [PUBLIC_IP_2] : ["127.0.0.1"]),
      },
      handler: ({ host }) => (host === "example.com" ? redirectTo("https://rebind.example.com/") : htmlResponse("<title>x</title>")),
    });
    // The redirect target is a different name: it gets its own lookup, its own checks.
    const result = await fetchGuarded("https://example.com/", HTML);
    expect(result.url.href).toBe("https://rebind.example.com/");
    expect(transport.requests.map((r) => r.addresses[0].address)).toEqual([PUBLIC_IP, PUBLIC_IP_2]);
  });

  test("a name that does not resolve fails without connecting", async () => {
    const { fetchGuarded, transport } = setup();
    expect(await codeOf(fetchGuarded("https://nowhere.example.net/", HTML))).toBe("dns_failed");
    expect(transport.requests).toEqual([]);
  });

  test("an empty or nonsense answer fails", async () => {
    for (const answer of [[], ["not-an-ip"], [""]]) {
      const { fetchGuarded } = setup({ dns: { "odd.example.com": answer } });
      const code = await codeOf(fetchGuarded("https://odd.example.com/", HTML));
      expect(["dns_failed"]).toContain(code);
    }
  });

  test("a lookup that never answers is cut off by the deadline", async () => {
    const fetchGuarded = createGuardedFetcher({
      resolve: () => new Promise(() => {}),
      transport: makeTransport(() => htmlResponse("")),
    });
    expect(await codeOf(fetchGuarded("https://example.com/", { ...HTML, timeoutMs: 40 }))).toBe("timeout");
  });
});

describe("redirects are checked again at every hop", () => {
  const redirecting = (map, dns) =>
    setup({
      dns: { "example.com": [PUBLIC_IP], "other.example.org": [PUBLIC_IP_2], ...dns },
      handler: ({ url }) => (url in map ? redirectTo(map[url]) : htmlResponse("<title>end</title>")),
    });

  test("a redirect to a public page is followed (relative and absolute)", async () => {
    const { fetchGuarded } = redirecting({
      "https://example.com/a": "/b",
      "https://example.com/b": "https://other.example.org/c?x=1",
    });
    const result = await fetchGuarded("https://example.com/a", HTML);
    expect(result.url.href).toBe("https://other.example.org/c?x=1");
  });

  test.each([
    ["http://127.0.0.1/", "loopback"],
    ["http://169.254.169.254/latest/meta-data/", "metadata endpoint"],
    ["http://2130706433/", "decimal loopback"],
    ["http://0x7f.1/", "hex loopback"],
    ["http://[::1]/", "IPv6 loopback"],
    ["http://10.0.0.1/admin", "private"],
    ["http://localhost/", "localhost"],
    ["http://intranet/", "single-label name"],
    ["http://example.com:8080/", "other port"],
    ["http://example.com:6379/", "redis port"],
    ["http://user:pw@example.com/", "credentials"],
    ["ftp://example.com/", "ftp"],
    ["file:///etc/passwd", "file"],
    ["javascript:alert(1)", "javascript"],
    ["gopher://example.com/", "gopher"],
  ])("a redirect to %s (%s) is refused", async (target) => {
    const { fetchGuarded, transport } = redirecting({ "https://example.com/": target });
    expect(await codeOf(fetchGuarded("https://example.com/", HTML))).toBe("blocked_redirect");
    expect(transport.requests).toHaveLength(1); // only the first page was ever requested
  });

  test("a redirect to a name that resolves to a private address is refused", async () => {
    const { fetchGuarded, transport } = redirecting(
      { "https://example.com/": "https://sneaky.example.org/" },
      { "sneaky.example.org": ["192.168.1.1"] },
    );
    expect(await codeOf(fetchGuarded("https://example.com/", HTML))).toBe("blocked_address");
    expect(transport.requests).toHaveLength(1);
  });

  test("three redirects are followed, a fourth is not", async () => {
    const chain = {
      "https://example.com/1": "/2",
      "https://example.com/2": "/3",
      "https://example.com/3": "/4",
      "https://example.com/4": "/5",
    };
    const { fetchGuarded } = redirecting(chain);
    expect((await fetchGuarded("https://example.com/2", HTML)).url.href).toBe("https://example.com/5");
    expect(await codeOf(fetchGuarded("https://example.com/1", HTML))).toBe("too_many_redirects");
  });

  test("a redirect loop is refused", async () => {
    const { fetchGuarded, transport } = redirecting({
      "https://example.com/a": "/b",
      "https://example.com/b": "/a",
    });
    expect(await codeOf(fetchGuarded("https://example.com/a", HTML))).toBe("redirect_loop");
    expect(transport.requests).toHaveLength(2);
  });

  test("a page that redirects to itself is a loop", async () => {
    const { fetchGuarded } = redirecting({ "https://example.com/self": "/self" });
    expect(await codeOf(fetchGuarded("https://example.com/self", HTML))).toBe("redirect_loop");
  });

  test.each([
    ["no Location", {}],
    ["an empty Location", { location: "" }],
    ["a huge Location", { location: `/${"a".repeat(3000)}` }],
  ])("a redirect with %s is refused", async (_name, headers) => {
    const { fetchGuarded } = setup({ handler: () => ({ status: 302, headers, body: "" }) });
    expect(await codeOf(fetchGuarded("https://example.com/", HTML))).toBe("bad_redirect");
  });

  test.each([301, 302, 303, 307, 308])("status %i is a redirect", async (status) => {
    const { fetchGuarded } = setup({
      handler: ({ url }) => (url.endsWith("/start") ? redirectTo("/end", status) : htmlResponse("<title>x</title>")),
    });
    expect((await fetchGuarded("https://example.com/start", HTML)).url.pathname).toBe("/end");
  });

  test("no cookie is carried from one hop to the next, and every request is a bodyless GET", async () => {
    const { fetchGuarded, transport } = setup({
      handler: ({ url }) =>
        url.endsWith("/start")
          ? { status: 302, headers: { location: "/end", "set-cookie": "sid=abc; Path=/" }, body: "" }
          : htmlResponse("<title>x</title>", { "set-cookie": "tracker=1" }),
    });
    await fetchGuarded("https://example.com/start", HTML);
    for (const request of transport.requests) {
      expect(Object.keys(request.headers).map((n) => n.toLowerCase())).not.toContain("cookie");
    }
  });
});

describe("responses that are not a page", () => {
  test.each([
    ["application/json", '{"a":1}'],
    ["text/plain", "hello"],
    ["image/png", "\u0089PNG"],
    ["application/pdf", "%PDF"],
    ["application/octet-stream", "x"],
    ["text/html-sandboxed", "<title>x</title>"],
    ["application/xhtml+xml", "<title>x</title>"],
    [undefined, "<title>no type</title>"],
  ])("content type %s is refused", async (type, body) => {
    const { fetchGuarded } = setup({
      handler: () => ({ status: 200, headers: type ? { "content-type": type } : {}, body }),
    });
    expect(await codeOf(fetchGuarded("https://example.com/", HTML))).toBe("bad_content_type");
  });

  test.each([404, 403, 410, 500, 502, 503, 204, 304, 100])("status %i is refused", async (status) => {
    const { fetchGuarded } = setup({ handler: () => ({ status, headers: { "content-type": "text/html" }, body: "<title>x</title>" }) });
    expect(await codeOf(fetchGuarded("https://example.com/", HTML))).toBe("bad_status");
  });

  test.each(["gzip", "br", "deflate", "compress"])("a %s response is refused (no decompression)", async (encoding) => {
    const { fetchGuarded } = setup({
      handler: () => htmlResponse("<title>x</title>", { "content-encoding": encoding }),
    });
    expect(await codeOf(fetchGuarded("https://example.com/", HTML))).toBe("bad_encoding");
  });

  test("an identity response is fine", async () => {
    const { fetchGuarded } = setup({ handler: () => htmlResponse("<title>x</title>", { "content-encoding": "identity" }) });
    expect((await fetchGuarded("https://example.com/", HTML)).status).toBe(200);
  });

  test("a connection that fails is a plain 'network' failure (no detail leaks)", async () => {
    const { fetchGuarded } = setup({ handler: () => Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:80"), { code: "ECONNREFUSED" }) });
    const error = await fetchGuarded("https://example.com/", HTML).catch((e) => e);
    expect(error).toBeInstanceOf(LinkPreviewError);
    expect(error.code).toBe("network");
    expect(error.message).not.toMatch(/10\.0\.0\.1|ECONNREFUSED/);
  });
});

describe("size limits", () => {
  test("a page bigger than the limit is cut there and used as it is", async () => {
    const { fetchGuarded } = setup({
      handler: () => ({
        status: 200,
        headers: { "content-type": "text/html" },
        body: ["<title>t</title>", "x".repeat(40), "y".repeat(40), "z".repeat(40)],
      }),
    });
    const result = await fetchGuarded("https://example.com/", { ...HTML, maxBytes: 70 });
    expect(result.truncated).toBe(true);
    expect(result.body.length).toBe(70);
  });

  test("a page of exactly the limit is not 'truncated'", async () => {
    const body = "a".repeat(100);
    const { fetchGuarded } = setup({ handler: () => ({ status: 200, headers: { "content-type": "text/html" }, body }) });
    const result = await fetchGuarded("https://example.com/", { ...HTML, maxBytes: 100 });
    expect(result.truncated).toBe(false);
    expect(result.body.length).toBe(100);
  });

  test("an endless page is read only up to the limit and the download is stopped", async () => {
    const state = { pulled: 0, closed: false };
    async function* endless() {
      try {
        for (;;) {
          state.pulled += 1;
          yield Buffer.alloc(1024, 97);
        }
      } finally {
        state.closed = true;
      }
    }
    const { fetchGuarded } = setup({
      handler: () => ({ status: 200, headers: { "content-type": "text/html" }, body: endless() }),
    });
    const result = await fetchGuarded("https://example.com/", { ...HTML, maxBytes: 10 * 1024 });
    expect(result.body.length).toBe(10 * 1024);
    expect(result.truncated).toBe(true);
    expect(state.pulled).toBeLessThanOrEqual(12);
    await sleep(5);
    expect(state.closed).toBe(true);
  });

  test("a response that must fit is refused when Content-Length says it is too big, before reading it", async () => {
    const state = { read: false };
    async function* body() {
      state.read = true;
      yield Buffer.from("x");
    }
    const { fetchGuarded } = setup({
      handler: () => ({ status: 200, headers: { "content-type": "image/png", "content-length": "5000000" }, body: body() }),
    });
    expect(await codeOf(fetchGuarded("https://example.com/i.png", { maxBytes: 1000, mustFit: true }))).toBe("too_large");
    expect(state.read).toBe(false);
  });

  test("a response that must fit is refused when it turns out bigger than it said", async () => {
    const { fetchGuarded } = setup({
      handler: () => ({ status: 200, headers: { "content-type": "image/png", "content-length": "10" }, body: [Buffer.alloc(600), Buffer.alloc(600)] }),
    });
    expect(await codeOf(fetchGuarded("https://example.com/i.png", { maxBytes: 1000, mustFit: true }))).toBe("too_large");
  });

  test("a response that must fit and does is returned whole", async () => {
    const { fetchGuarded } = setup({
      handler: () => ({ status: 200, headers: { "content-type": "image/png" }, body: [Buffer.alloc(500), Buffer.alloc(500)] }),
    });
    const result = await fetchGuarded("https://example.com/i.png", { maxBytes: 1000, mustFit: true });
    expect(result.body.length).toBe(1000);
    expect(result.truncated).toBe(false);
  });
});

describe("time limit", () => {
  test("a server that drips one byte at a time (slow loris) is cut off at the deadline", async () => {
    const state = { closed: false };
    async function* drip() {
      try {
        for (;;) {
          await sleep(15);
          yield Buffer.from("x");
        }
      } finally {
        state.closed = true;
      }
    }
    const { fetchGuarded } = setup({
      handler: () => ({ status: 200, headers: { "content-type": "text/html" }, body: drip() }),
    });
    const started = Date.now();
    expect(await codeOf(fetchGuarded("https://example.com/", { ...HTML, timeoutMs: 120 }))).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(1000);
    await sleep(60);
    expect(state.closed).toBe(true);
  });

  test("a server that never answers is cut off at the deadline", async () => {
    const fetchGuarded = createGuardedFetcher({
      resolve: makeResolver({ "example.com": [PUBLIC_IP] }),
      transport: () => new Promise(() => {}),
    });
    expect(await codeOf(fetchGuarded("https://example.com/", { ...HTML, timeoutMs: 40 }))).toBe("timeout");
  });

  test("one deadline covers all the redirects together", async () => {
    // Every hop takes 40 ms; the whole fetch is allowed 100 ms.
    const resolve = makeResolver({ "example.com": [PUBLIC_IP] });
    const fetchGuarded = createGuardedFetcher({
      resolve,
      transport: makeTransport(async ({ url }) => {
        await sleep(40);
        const n = Number(url.split("/").pop());
        return n < 3 ? redirectTo(`/${n + 1}`) : htmlResponse("<title>x</title>");
      }),
    });
    expect(await codeOf(fetchGuarded("https://example.com/0", { ...HTML, timeoutMs: 100 }))).toBe("timeout");
  });

  test("the abort signal reaches the transport, so a real socket is destroyed", async () => {
    let seen;
    const fetchGuarded = createGuardedFetcher({
      resolve: makeResolver({ "example.com": [PUBLIC_IP] }),
      transport: (request) => {
        seen = request.signal;
        return new Promise(() => {});
      },
    });
    await codeOf(fetchGuarded("https://example.com/", { ...HTML, timeoutMs: 30 }));
    expect(seen.aborted).toBe(true);
  });
});

describe("the arguments", () => {
  test("a size limit is required", async () => {
    const { fetchGuarded } = setup();
    await expect(fetchGuarded("https://example.com/", {})).rejects.toThrow(TypeError);
  });

  test("a link that may not be fetched fails before any lookup", async () => {
    const { fetchGuarded, resolve, transport } = setup();
    expect(await codeOf(fetchGuarded("http://127.0.0.1/", HTML))).toBe("invalid_url");
    expect(await codeOf(fetchGuarded("http://example.com:8080/", HTML))).toBe("invalid_url");
    expect(resolve.calls).toEqual([]);
    expect(transport.requests).toEqual([]);
  });
});
