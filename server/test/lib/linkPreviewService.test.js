import { afterEach, describe, expect, test } from "vitest";
import crypto from "node:crypto";
import http from "node:http";
import {
  HTML_MAX_BYTES,
  IMAGE_ROUTE_PREFIX,
  MAX_CACHED_IMAGES,
  MAX_FETCHES_PER_OWNER,
  MAX_PARALLEL_FETCHES,
  NEGATIVE_TTL_MS,
  TRANSIENT_NEGATIVE_TTL_MS,
  POSITIVE_TTL_MS,
  LinkPreviewError,
  allowPrivateForTests,
  createLinkPreviewService,
} from "../../lib/linkPreview.js";
import {
  PUBLIC_IP,
  PUBLIC_IP_2,
  html,
  htmlResponse,
  imageResponse,
  makeResolver,
  makeTransport,
  pngBytes,
  redirectTo,
  svgBytes,
} from "../helpers/linkPreviewFixture.js";

const PAGE = "https://example.com/article";
const DNS = {
  "example.com": [PUBLIC_IP],
  "cdn.example.com": [PUBLIC_IP_2],
  "other.example.org": [PUBLIC_IP_2],
};

const OG = (extra = "") =>
  `<title>Fallback</title>
   <meta property="og:title" content="The title">
   <meta property="og:description" content="A short description.">
   <meta property="og:site_name" content="Example">
   ${extra}`;

function setup({ pages = {}, images = {}, dns = DNS, now, serviceOptions = {} } = {}) {
  const clock = { at: 1_000_000 };
  const resolve = makeResolver(dns);
  const transport = makeTransport(({ url }) => {
    if (url in pages) {
      const page = pages[url];
      return typeof page === "function" ? page() : page;
    }
    if (url in images) {
      const image = images[url];
      return typeof image === "function" ? image() : image;
    }
    return { status: 404, headers: { "content-type": "text/html" }, body: "nope" };
  });
  const service = createLinkPreviewService({ resolve, transport, now: now || (() => clock.at), ...serviceOptions });
  return { service, transport, resolve, clock, dns };
}

const codeOf = async (promise) => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(LinkPreviewError);
    return error.code;
  }
  return "no error";
};

describe("building a preview", () => {
  test("title, description, site name and a picture served from our own address", async () => {
    const png = pngBytes(640, 360);
    const { service, transport } = setup({
      pages: { [PAGE]: htmlResponse(OG('<meta property="og:image" content="https://cdn.example.com/cover.png">')) },
      images: { "https://cdn.example.com/cover.png": imageResponse(png) },
    });
    const preview = await service.getPreview(PAGE);
    const id = crypto.createHash("sha256").update(png).digest("hex").slice(0, 32);
    expect(preview).toEqual({
      url: PAGE,
      title: "The title",
      description: "A short description.",
      siteName: "Example",
      image: { url: `${IMAGE_ROUTE_PREFIX}${id}`, width: 640, height: 360 },
    });
    // The picture is OURS: its address is a path on this server, never the other site's.
    expect(preview.image.url.startsWith("/api/link-preview/image/")).toBe(true);
    expect(JSON.stringify(preview)).not.toContain("cdn.example.com");
    expect(service.getImage(id)).toEqual({ bytes: png, mime: "image/png" });
    expect(transport.requests.map((r) => r.url)).toEqual([PAGE, "https://cdn.example.com/cover.png"]);
  });

  test("the page and the picture are both fetched with the same fixed rules", async () => {
    const { service, transport } = setup({
      pages: { [PAGE]: htmlResponse(OG('<meta property="og:image" content="https://cdn.example.com/cover.png">')) },
      images: { "https://cdn.example.com/cover.png": imageResponse(pngBytes()) },
    });
    await service.getPreview(PAGE);
    for (const request of transport.requests) {
      expect(request.headers["User-Agent"]).toMatch(/^AurelleLinkPreview\//);
      expect(request.headers["Accept-Encoding"]).toBe("identity");
      expect(Object.keys(request.headers).map((n) => n.toLowerCase())).not.toContain("cookie");
    }
    expect(transport.requests[0].headers.Accept).toMatch(/text\/html/);
    expect(transport.requests[1].headers.Accept).toMatch(/image\/png/);
  });

  test("a page without a picture has image: null", async () => {
    const { service } = setup({ pages: { [PAGE]: htmlResponse(OG()) } });
    expect((await service.getPreview(PAGE)).image).toBeNull();
  });

  test("a relative picture address is resolved against the FINAL address of the page", async () => {
    const { service, transport } = setup({
      pages: {
        [PAGE]: redirectTo("https://other.example.org/moved/"),
        "https://other.example.org/moved/": htmlResponse(OG('<meta property="og:image" content="cover.png">')),
      },
      images: { "https://other.example.org/moved/cover.png": imageResponse(pngBytes()) },
    });
    const preview = await service.getPreview(PAGE);
    expect(preview.image).not.toBeNull();
    expect(preview.url).toBe(PAGE); // the card answers for the link that was asked about
    expect(transport.requests.map((r) => r.url)).toContain("https://other.example.org/moved/cover.png");
  });

  test("a page with neither title nor description has no preview", async () => {
    const { service } = setup({ pages: { [PAGE]: htmlResponse('<meta property="og:image" content="https://cdn.example.com/c.png">') } });
    expect(await codeOf(service.getPreview(PAGE))).toBe("no_preview");
  });

  test("a page larger than 512 KB is read up to there", async () => {
    const big = `${html(OG())}${"x".repeat(HTML_MAX_BYTES * 2)}`;
    const { service, transport } = setup({ pages: { [PAGE]: { status: 200, headers: { "content-type": "text/html" }, body: big } } });
    expect((await service.getPreview(PAGE)).title).toBe("The title");
    expect(transport.requests).toHaveLength(1);
    expect(HTML_MAX_BYTES).toBe(512 * 1024);
  });

  test("a title past the first 512 KB is not found", async () => {
    const late = `<!doctype html><head>${"<!-- filler -->".repeat(Math.ceil(HTML_MAX_BYTES / 14))}${OG()}</head>`;
    const { service } = setup({ pages: { [PAGE]: { status: 200, headers: { "content-type": "text/html" }, body: late } } });
    expect(await codeOf(service.getPreview(PAGE))).toBe("no_preview");
  });
});

describe("the picture", () => {
  const withImage = (response, extra = {}) =>
    setup({
      pages: { [PAGE]: htmlResponse(OG('<meta property="og:image" content="https://cdn.example.com/cover.png">')) },
      images: { "https://cdn.example.com/cover.png": response },
      ...extra,
    });

  test.each([
    ["an SVG", () => imageResponse(svgBytes(), "image/svg+xml")],
    ["an SVG that says it is a PNG", () => imageResponse(svgBytes(), "image/png")],
    ["an HTML page that says it is a PNG", () => imageResponse(Buffer.from("<script>alert(1)</script>"), "image/png")],
    ["a real PNG that says it is text/html", () => imageResponse(pngBytes(), "text/html")],
  ])("%s", async (name, make) => {
    const { service } = withImage(make());
    const preview = await service.getPreview(PAGE);
    if (name.startsWith("a real PNG")) {
      // The bytes decide, not the header.
      expect(preview.image).not.toBeNull();
    } else {
      expect(preview.image).toBeNull(); // the text is still shown
      expect(preview.title).toBe("The title");
      expect(service.stats().images).toBe(0);
    }
  });

  test.each([
    ["bigger than 400 KB", () => imageResponse(pngBytes(100, 50, 401 * 1024))],
    ["declared enormous", () => imageResponse(pngBytes(60000, 60000))],
    ["not found", () => ({ status: 404, headers: {}, body: "" })],
    ["a server error", () => ({ status: 500, headers: {}, body: "" })],
    ["an endless download", () => ({ status: 200, headers: { "content-type": "image/png" }, body: [Buffer.alloc(300 * 1024), Buffer.alloc(300 * 1024)] })],
    ["compressed", () => ({ ...imageResponse(pngBytes()), headers: { "content-type": "image/png", "content-encoding": "gzip" } })],
  ])("a picture %s is left out and the text stays", async (_name, make) => {
    const { service } = withImage(make());
    const preview = await service.getPreview(PAGE);
    expect(preview.image).toBeNull();
    expect(preview.title).toBe("The title");
  });

  test("a picture on a private address is never requested", async () => {
    const { service, transport } = setup({
      pages: {
        [PAGE]: htmlResponse(
          OG(`<meta property="og:image" content="http://169.254.169.254/latest/meta-data/">
              <meta name="twitter:image" content="http://127.0.0.1/x.png">`),
        ),
      },
    });
    expect((await service.getPreview(PAGE)).image).toBeNull();
    expect(transport.requests.map((r) => r.url)).toEqual([PAGE]);
  });

  test("a picture host that resolves to a private address is not connected to", async () => {
    const { service, transport } = setup({
      pages: { [PAGE]: htmlResponse(OG('<meta property="og:image" content="https://internal.example.com/c.png">')) },
      dns: { ...DNS, "internal.example.com": ["10.0.0.7"] },
    });
    expect((await service.getPreview(PAGE)).image).toBeNull();
    expect(transport.requests.map((r) => r.url)).toEqual([PAGE]);
  });

  test("a picture that redirects somewhere private is not followed", async () => {
    const { service, transport } = setup({
      pages: { [PAGE]: htmlResponse(OG('<meta property="og:image" content="https://cdn.example.com/c.png">')) },
      images: { "https://cdn.example.com/c.png": redirectTo("http://169.254.169.254/latest/meta-data/") },
    });
    expect((await service.getPreview(PAGE)).image).toBeNull();
    expect(transport.requests).toHaveLength(2);
  });

  test("the second candidate is tried when the first one fails, and no more than two", async () => {
    const { service, transport } = setup({
      pages: {
        [PAGE]: htmlResponse(
          OG(`<meta property="og:image" content="https://cdn.example.com/broken.png">
              <meta name="twitter:image" content="https://cdn.example.com/good.png">
              <meta name="twitter:image:src" content="https://cdn.example.com/third.png">`),
        ),
      },
      images: { "https://cdn.example.com/good.png": imageResponse(pngBytes(50, 40)), "https://cdn.example.com/third.png": imageResponse(pngBytes()) },
    });
    const preview = await service.getPreview(PAGE);
    expect(preview.image).toMatchObject({ width: 50, height: 40 });
    expect(transport.requests.map((r) => r.url)).toEqual([PAGE, "https://cdn.example.com/broken.png", "https://cdn.example.com/good.png"]);
  });

  test("with two broken candidates the third is not tried", async () => {
    const { service, transport } = setup({
      pages: {
        [PAGE]: htmlResponse(
          OG(`<meta property="og:image" content="https://cdn.example.com/a.png">
              <meta name="twitter:image" content="https://cdn.example.com/b.png">
              <meta name="twitter:image:src" content="https://cdn.example.com/c.png">`),
        ),
      },
      images: { "https://cdn.example.com/c.png": imageResponse(pngBytes()) },
    });
    expect((await service.getPreview(PAGE)).image).toBeNull();
    expect(transport.requests).toHaveLength(3);
  });

  test("the same picture from two pages is stored once", async () => {
    const png = pngBytes(20, 20);
    const { service } = setup({
      pages: {
        "https://example.com/a": htmlResponse(OG('<meta property="og:image" content="https://cdn.example.com/c.png">')),
        "https://example.com/b": htmlResponse(OG('<meta property="og:image" content="https://cdn.example.com/c.png">')),
      },
      images: { "https://cdn.example.com/c.png": imageResponse(png) },
    });
    const a = await service.getPreview("https://example.com/a");
    const b = await service.getPreview("https://example.com/b");
    expect(a.image.url).toBe(b.image.url);
    expect(service.stats().images).toBe(1);
  });

  test.each(["", "x", "../../etc/passwd", "ABCDEF0123456789ABCDEF0123456789", "0".repeat(31), "0".repeat(33), "0".repeat(32), null, undefined, 5, {}])(
    "getImage(%j) finds nothing",
    (id) => {
      const { service } = setup();
      expect(service.getImage(id)).toBeNull();
    },
  );
});

describe("the cache", () => {
  test("a second request for the same link does not touch the site", async () => {
    const { service, transport } = setup({ pages: { [PAGE]: htmlResponse(OG()) } });
    const first = await service.getPreview(PAGE);
    const second = await service.getPreview(PAGE);
    expect(second).toEqual(first);
    expect(transport.requests).toHaveLength(1);
  });

  test("the #fragment is not part of the link", async () => {
    const { service, transport } = setup({ pages: { [PAGE]: htmlResponse(OG()) } });
    await service.getPreview(`${PAGE}#one`);
    await service.getPreview(`${PAGE}#two`);
    await service.getPreview(`${PAGE}`);
    expect(transport.requests).toHaveLength(1);
  });

  test("a good result is kept for 24 hours", async () => {
    const { service, transport, clock } = setup({ pages: { [PAGE]: htmlResponse(OG()) } });
    await service.getPreview(PAGE);
    clock.at += POSITIVE_TTL_MS - 1;
    await service.getPreview(PAGE);
    expect(transport.requests).toHaveLength(1);
    clock.at += 2;
    await service.getPreview(PAGE);
    expect(transport.requests).toHaveLength(2);
    expect(POSITIVE_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  test("a failure is kept for 1 hour, with the same answer, and then tried again", async () => {
    let broken = true;
    const { service, transport, clock } = setup({
      pages: { [PAGE]: () => (broken ? { status: 500, headers: {}, body: "" } : htmlResponse(OG())) },
    });
    expect(await codeOf(service.getPreview(PAGE))).toBe("bad_status");
    broken = false;
    clock.at += NEGATIVE_TTL_MS - 1;
    expect(await codeOf(service.getPreview(PAGE))).toBe("bad_status");
    expect(transport.requests).toHaveLength(1);
    clock.at += 2;
    expect((await service.getPreview(PAGE)).title).toBe("The title");
    expect(transport.requests).toHaveLength(2);
    expect(NEGATIVE_TTL_MS).toBe(60 * 60 * 1000);
  });

  test("a site that is down is asked once an hour, not once per message", async () => {
    const { service, transport } = setup({ pages: { [PAGE]: { status: 503, headers: {}, body: "" } } });
    for (let i = 0; i < 20; i += 1) await codeOf(service.getPreview(PAGE));
    expect(transport.requests).toHaveLength(1);
  });

  test("a timeout or a name that does not resolve is only remembered for a minute, not an hour", async () => {
    // A slow name server must not turn into "no preview for this site for an hour".
    expect(TRANSIENT_NEGATIVE_TTL_MS).toBeLessThanOrEqual(NEGATIVE_TTL_MS / 10);
    const dns = { ...DNS };
    delete dns["example.com"];
    const { service, transport, clock } = setup({ pages: { [PAGE]: htmlResponse(OG()) }, dns });
    expect(await codeOf(service.getPreview(PAGE))).toBe("dns_failed");
    dns["example.com"] = [PUBLIC_IP];
    clock.at += TRANSIENT_NEGATIVE_TTL_MS - 1;
    expect(await codeOf(service.getPreview(PAGE))).toBe("dns_failed"); // still the remembered answer
    expect(transport.requests).toHaveLength(0);
    clock.at += 2;
    expect((await service.getPreview(PAGE)).title).toBe("The title");
  });

  test("a site that did not answer in time is asked again after a minute", async () => {
    let slow = true;
    const { service, clock } = setup({
      pages: { [PAGE]: () => (slow ? new Promise(() => {}) : htmlResponse(OG())) },
      serviceOptions: { buildTimeoutMs: 40 },
    });
    expect(await codeOf(service.getPreview(PAGE))).toBe("timeout");
    slow = false;
    clock.at += TRANSIENT_NEGATIVE_TTL_MS + 1;
    expect((await service.getPreview(PAGE)).title).toBe("The title");
  });

  test("a failure that is the site's own doing (no title, wrong type) still waits the full hour", async () => {
    const { service, transport, clock } = setup({ pages: { [PAGE]: htmlResponse("") } });
    expect(await codeOf(service.getPreview(PAGE))).toBe("no_preview");
    clock.at += TRANSIENT_NEGATIVE_TTL_MS + 1;
    expect(await codeOf(service.getPreview(PAGE))).toBe("no_preview");
    expect(transport.requests).toHaveLength(1);
  });

  test("a link that may not be fetched costs nothing and is never cached", async () => {
    const { service, transport, resolve } = setup();
    for (const link of ["http://127.0.0.1/", "ftp://example.com/", "http://user:pw@example.com/", "http://example.com:8080/", "nonsense"]) {
      expect(await codeOf(service.getPreview(link))).toBe("invalid_url");
    }
    expect(transport.requests).toEqual([]);
    expect(resolve.calls).toEqual([]);
    expect(service.stats().previews).toBe(0);
  });

  test("a picture pushed out of its (smaller) cache is fetched again, with the text kept", async () => {
    const pages = {};
    const images = {};
    for (let i = 0; i <= MAX_CACHED_IMAGES; i += 1) {
      pages[`https://example.com/p${i}`] = htmlResponse(OG(`<meta property="og:image" content="https://cdn.example.com/i${i}.png">`));
      images[`https://cdn.example.com/i${i}.png`] = imageResponse(pngBytes(10, 10, i));
    }
    const { service, transport } = setup({ pages, images });
    const first = await service.getPreview("https://example.com/p0");
    for (let i = 1; i <= MAX_CACHED_IMAGES; i += 1) await service.getPreview(`https://example.com/p${i}`);
    // Room for MAX_CACHED_IMAGES pictures: the oldest, p0's, is gone.
    expect(service.getImage(first.image.url.replace(IMAGE_ROUTE_PREFIX, ""))).toBeNull();
    const before = transport.requests.length;
    const again = await service.getPreview("https://example.com/p0");
    expect(transport.requests.length).toBe(before + 2); // the page and its picture, once more
    expect(service.getImage(again.image.url.replace(IMAGE_ROUTE_PREFIX, ""))).not.toBeNull();
  });

  test("two requests at the same time share one fetch", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const { service, transport } = setup({ pages: { [PAGE]: async () => (await gate, htmlResponse(OG())) } });
    const a = service.getPreview(PAGE);
    const b = service.getPreview(PAGE);
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    expect(await a).toEqual(await b);
    expect(transport.requests).toHaveLength(1);
  });
});

describe("limits on fetching", () => {
  test("admit() is asked only when a site would really be contacted", async () => {
    let asked = 0;
    const admit = () => {
      asked += 1;
      return true;
    };
    const { service } = setup({ pages: { [PAGE]: htmlResponse(OG()) } });
    await service.getPreview(PAGE, { admit });
    await service.getPreview(PAGE, { admit }); // from the cache
    await service.getPreview(`${PAGE}#again`, { admit }); // from the cache
    expect(asked).toBe(1);
  });

  test("admit() saying no fetches nothing and caches nothing", async () => {
    const { service, transport } = setup({ pages: { [PAGE]: htmlResponse(OG()) } });
    expect(await codeOf(service.getPreview(PAGE, { admit: () => false }))).toBe("rate_limited");
    expect(transport.requests).toEqual([]);
    expect(service.stats().previews).toBe(0);
    expect((await service.getPreview(PAGE, { admit: () => true })).title).toBe("The title");
  });

  test("a request that joins one already running does not ask admit() again", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let asked = 0;
    const { service } = setup({ pages: { [PAGE]: async () => (await gate, htmlResponse(OG())) } });
    const a = service.getPreview(PAGE, { admit: () => (asked += 1, true) });
    const b = service.getPreview(PAGE, { admit: () => (asked += 1, true) });
    release();
    await Promise.all([a, b]);
    expect(asked).toBe(1);
  });

  test(`no more than ${MAX_PARALLEL_FETCHES} sites are fetched at once`, async () => {
    const gate = new Promise(() => {}); // never answers
    const pages = {};
    const dns = { ...DNS };
    for (let i = 0; i <= MAX_PARALLEL_FETCHES; i += 1) {
      pages[`https://example.com/p${i}`] = () => gate;
    }
    const { service } = setup({ pages, dns });
    const running = [];
    for (let i = 0; i < MAX_PARALLEL_FETCHES; i += 1) {
      running.push(service.getPreview(`https://example.com/p${i}`).catch(() => {}));
    }
    expect(service.stats().active).toBe(MAX_PARALLEL_FETCHES);
    expect(await codeOf(service.getPreview(`https://example.com/p${MAX_PARALLEL_FETCHES}`))).toBe("busy");
  });
});

describe("a tarpit site cannot hold a fetch slot for long", () => {
  const IMAGES = `<meta property="og:image" content="https://cdn.example.com/a.png">
                  <meta name="twitter:image" content="https://cdn.example.com/b.png">`;
  const hang = () => new Promise(() => {});

  test("the page and its pictures share ONE deadline, not 5 s each", async () => {
    const { service, transport } = setup({
      pages: { [PAGE]: htmlResponse(OG(IMAGES)) },
      images: { "https://cdn.example.com/a.png": hang, "https://cdn.example.com/b.png": hang },
      serviceOptions: { buildTimeoutMs: 300 },
    });
    const started = Date.now();
    const preview = await service.getPreview(PAGE);
    const took = Date.now() - started;
    expect(preview.title).toBe("The title");
    expect(preview.image).toBeNull(); // the text is kept, the picture is given up on
    expect(took).toBeLessThan(700); // two separate 300 ms deadlines would be 900 ms
    expect(transport.requests.length).toBeGreaterThanOrEqual(2);
    expect(service.stats().active).toBe(0);
  });

  test("the slot is free again once the shared deadline has passed", async () => {
    const { service } = setup({
      pages: { [PAGE]: htmlResponse(OG(IMAGES)) },
      images: { "https://cdn.example.com/a.png": hang, "https://cdn.example.com/b.png": hang },
      serviceOptions: { buildTimeoutMs: 200 },
    });
    const pending = service.getPreview(PAGE);
    expect(service.stats().active).toBe(1);
    await pending;
    expect(service.stats().active).toBe(0);
  });

  test("the page itself gets no more than the whole deadline", async () => {
    const { service } = setup({ pages: { [PAGE]: hang }, serviceOptions: { buildTimeoutMs: 150 } });
    const started = Date.now();
    expect(await codeOf(service.getPreview(PAGE))).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(600);
  });
});

describe("one person cannot take the whole pool", () => {
  const never = () => new Promise(() => {});
  const pagesFor = (count) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`https://example.com/p${i}`, never]));

  test(`a person has at most ${MAX_FETCHES_PER_OWNER} fetches running; others are told it is busy`, async () => {
    expect(MAX_FETCHES_PER_OWNER).toBeLessThan(MAX_PARALLEL_FETCHES);
    const { service, transport } = setup({ pages: pagesFor(MAX_FETCHES_PER_OWNER + 2), serviceOptions: { buildTimeoutMs: 400 } });
    const running = [];
    for (let i = 0; i < MAX_FETCHES_PER_OWNER; i += 1) {
      running.push(service.getPreview(`https://example.com/p${i}`, { owner: "alice" }).catch(() => {}));
    }
    const before = transport.requests.length;
    expect(await codeOf(service.getPreview(`https://example.com/p${MAX_FETCHES_PER_OWNER}`, { owner: "alice" }))).toBe("busy");
    expect(transport.requests.length).toBe(before); // nothing was fetched for it

    // Somebody else is not affected.
    running.push(service.getPreview(`https://example.com/p${MAX_FETCHES_PER_OWNER + 1}`, { owner: "bob" }).catch(() => {}));
    expect(service.stats().active).toBe(MAX_FETCHES_PER_OWNER + 1);
    await Promise.all(running);
  });

  test("a refused request does not use up the person's rate allowance", async () => {
    let admitted = 0;
    const admit = () => (admitted += 1, true);
    const { service } = setup({ pages: pagesFor(MAX_FETCHES_PER_OWNER + 1), serviceOptions: { buildTimeoutMs: 300 } });
    const running = [];
    for (let i = 0; i < MAX_FETCHES_PER_OWNER; i += 1) {
      running.push(service.getPreview(`https://example.com/p${i}`, { owner: "alice", admit }).catch(() => {}));
    }
    expect(admitted).toBe(MAX_FETCHES_PER_OWNER);
    expect(await codeOf(service.getPreview(`https://example.com/p${MAX_FETCHES_PER_OWNER}`, { owner: "alice", admit }))).toBe("busy");
    expect(admitted).toBe(MAX_FETCHES_PER_OWNER);
    await Promise.all(running);
  });

  test("the person can fetch again as soon as one of theirs has finished", async () => {
    const { service } = setup({
      pages: { ...pagesFor(MAX_FETCHES_PER_OWNER), [PAGE]: htmlResponse(OG()) },
      serviceOptions: { buildTimeoutMs: 120 },
    });
    const running = [];
    for (let i = 0; i < MAX_FETCHES_PER_OWNER; i += 1) {
      running.push(service.getPreview(`https://example.com/p${i}`, { owner: "alice" }).catch(() => {}));
    }
    await Promise.all(running); // all timed out
    expect((await service.getPreview(PAGE, { owner: "alice" })).title).toBe("The title");
  });

  test("a request that only joins a running fetch does not count against the person", async () => {
    const { service } = setup({ pages: pagesFor(MAX_FETCHES_PER_OWNER), serviceOptions: { buildTimeoutMs: 200 } });
    const running = [];
    for (let i = 0; i < MAX_FETCHES_PER_OWNER; i += 1) {
      running.push(service.getPreview(`https://example.com/p${i}`, { owner: "alice" }).catch(() => {}));
    }
    const joined = service.getPreview("https://example.com/p0", { owner: "alice" }).catch((error) => error.code);
    expect(await joined).toBe("timeout");
    await Promise.all(running);
  });
});

describe("the test hook can never be switched on in production", () => {
  const FLAG = "LINK_PREVIEW_ALLOW_PRIVATE_FOR_TESTS";

  test.each([
    [{ APP_ENV: "production", [FLAG]: "1" }, "production with the flag"],
    [{ APP_ENV: "Production", [FLAG]: "1" }, "production, any case"],
    [{ APP_ENV: " production ", [FLAG]: "1" }, "production with spaces"],
    [{ [FLAG]: "1" }, "no APP_ENV at all (the server treats that as production)"],
    [{ APP_ENV: "", [FLAG]: "1" }, "an empty APP_ENV"],
    [{ APP_ENV: "development" }, "development without the flag"],
    [{ APP_ENV: "development", [FLAG]: "" }, "an empty flag"],
    [{ APP_ENV: "development", [FLAG]: "0" }, "flag 0"],
    [{ APP_ENV: "development", [FLAG]: "true" }, "flag true (only 1 counts)"],
    [{ APP_ENV: "development", [FLAG]: "yes" }, "flag yes"],
    [{}, "nothing"],
  ])("%j is ignored (%s)", (env) => {
    expect(allowPrivateForTests(env)).toBe(false);
  });

  test.each([
    [{ APP_ENV: "development", [FLAG]: "1" }],
    [{ APP_ENV: "test", [FLAG]: "1" }],
    [{ APP_ENV: "staging", [FLAG]: " 1 " }],
  ])("%j is honoured", (env) => {
    expect(allowPrivateForTests(env)).toBe(true);
  });

  test("it reads the process environment by default", () => {
    const saved = { ...process.env };
    try {
      process.env[FLAG] = "1";
      process.env.APP_ENV = "production";
      expect(allowPrivateForTests()).toBe(false);
      process.env.APP_ENV = "development";
      expect(allowPrivateForTests()).toBe(true);
      delete process.env.APP_ENV;
      expect(allowPrivateForTests()).toBe(false);
    } finally {
      process.env = saved;
    }
  });

  describe("against a real server on 127.0.0.1", () => {
    let server;
    let hits = 0;
    afterEach(async () => {
      if (server) await new Promise((resolve) => (server.closeAllConnections(), server.close(resolve)));
      server = null;
      hits = 0;
    });

    async function start() {
      server = http.createServer((req, res) => {
        hits += 1;
        res.setHeader("content-type", "text/html");
        res.end(html('<meta property="og:title" content="From loopback">'));
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      return `http://127.0.0.1:${server.address().port}/`;
    }

    test("production environment: the flag changes nothing, nothing is fetched", async () => {
      const link = await start();
      const service = createLinkPreviewService({
        allowPrivate: allowPrivateForTests({ APP_ENV: "production", [FLAG]: "1" }),
      });
      expect(await codeOf(service.getPreview(link))).toBe("invalid_url");
      expect(hits).toBe(0);
    });

    test("without APP_ENV the flag changes nothing either", async () => {
      const link = await start();
      const service = createLinkPreviewService({ allowPrivate: allowPrivateForTests({ [FLAG]: "1" }) });
      expect(await codeOf(service.getPreview(link))).toBe("invalid_url");
      expect(hits).toBe(0);
    });

    test("development environment with the flag: loopback is reachable (for the browser check only)", async () => {
      const link = await start();
      const service = createLinkPreviewService({
        allowPrivate: allowPrivateForTests({ APP_ENV: "development", [FLAG]: "1" }),
      });
      expect((await service.getPreview(link)).title).toBe("From loopback");
      expect(hits).toBe(1);
    });
  });
});
