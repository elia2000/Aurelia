import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import request from "supertest";
import { makeApp, makeUserStore } from "../helpers/makeApp.js";
import { LinkPreviewError, createLinkPreviewService } from "../../lib/linkPreview.js";
import {
  PUBLIC_IP,
  PUBLIC_IP_2,
  htmlResponse,
  imageResponse,
  makeResolver,
  makeTransport,
  pngBytes,
  svgBytes,
} from "../helpers/linkPreviewFixture.js";

const ALICE = { id: "a0a0a0a0-b1b1-4c2c-8d3d-e4e4e4e4e4e4", username: "alice", nickname: "Alice", banned: false, role: "user" };
const BOB = { id: "b0b0b0b0-c1c1-4d2d-9e3e-f5f5f5f5f5f5", username: "bob", nickname: "Bob", banned: false, role: "user" };
const BANNED = { id: "c0c0c0c0-c1c1-4d2d-9e3e-f5f5f5f5f5f5", username: "carol", nickname: "Carol", banned: true, role: "user" };

const OG = (image = "") =>
  `<meta property="og:title" content="The title"><meta property="og:description" content="About it."><meta property="og:site_name" content="Example">${image}`;

function setup({ enabled = true, service, deps = {}, pages = {}, images = {} } = {}) {
  const resolve = makeResolver({
    "example.com": [PUBLIC_IP],
    "cdn.example.com": [PUBLIC_IP_2],
    ...Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`h${i}.example.com`, [PUBLIC_IP]])),
  });
  const transport = makeTransport(({ url }) => {
    if (url in pages) return pages[url];
    if (url in images) return images[url];
    if (/^https:\/\/h\d+\.example\.com\//.test(url)) return htmlResponse(OG());
    return { status: 404, headers: { "content-type": "text/html" }, body: "" };
  });
  const realService = createLinkPreviewService({ resolve, transport });
  const built = makeApp({
    userStore: makeUserStore([ALICE, BOB, BANNED]),
    settings: { LINK_PREVIEWS: enabled },
    deps: { linkPreviewService: service || realService, env: {}, ...deps },
  });
  for (const [who, user] of Object.entries({ alice: ALICE, bob: BOB, carol: BANNED })) {
    built.sessionStore.createSession(user.id, `token-${who}`);
  }
  const as = (who) => ({
    get: (url) => request(built.app).get(url).set("Cookie", `sid=token-${who}`),
    post: (url) => request(built.app).post(url).set("Cookie", `sid=token-${who}`),
  });
  return { ...built, as, transport, resolve, service: service || realService };
}

describe("authentication", () => {
  test.each([
    ["get", "/api/link-preview?url=https%3A%2F%2Fexample.com%2F"],
    ["post", "/api/link-preview"],
    ["get", `/api/link-preview/image/${"a".repeat(32)}`],
  ])("%s %s needs a session", async (method, url) => {
    const { app, transport } = setup();
    const res = await request(app)[method](url).send({ url: "https://example.com/" });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Not authenticated." });
    expect(transport.requests).toEqual([]);
  });

  test("a banned person gets nothing", async () => {
    const { as, transport } = setup();
    const res = await as("carol").get("/api/link-preview?url=https%3A%2F%2Fexample.com%2F");
    expect(res.status).toBe(403);
    expect(transport.requests).toEqual([]);
  });

  test("a supplied username must be the signed-in person's", async () => {
    const { as } = setup();
    const res = await as("alice").get("/api/link-preview?username=bob&url=https%3A%2F%2Fexample.com%2F");
    expect(res.status).toBe(403);
  });
});

describe("switched off (the default)", () => {
  test("the server's default is off", async () => {
    const { app } = makeApp({ deps: { env: {} } });
    const res = await request(app).get("/api/app/info");
    expect(res.body.linkPreviewsEnabled).toBe(false);
  });

  test.each([
    ["get", "/api/link-preview?url=https%3A%2F%2Fexample.com%2F"],
    ["post", "/api/link-preview"],
    ["get", `/api/link-preview/image/${"a".repeat(32)}`],
  ])("%s %s answers 404 and fetches nothing", async (method, url) => {
    const { as, transport, resolve } = setup({ enabled: false });
    const res = await as("alice")[method](url).send({ url: "https://example.com/" });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Link previews are turned off.", code: "link_previews_disabled" });
    expect(transport.requests).toEqual([]);
    expect(resolve.calls).toEqual([]);
  });

  test("a setting that is missing altogether counts as off", async () => {
    const { as } = setup({ enabled: null });
    expect((await as("alice").get("/api/link-preview?url=https%3A%2F%2Fexample.com%2F")).status).toBe(404);
  });

  test("a preview already made is not served once the admin turns the feature off", async () => {
    let on = true;
    const built = makeApp({
      userStore: makeUserStore([ALICE]),
      deps: { linkPreviewService: setup().service, env: {}, getSetting: () => on },
    });
    built.sessionStore.createSession(ALICE.id, "t");
    const get = () => request(built.app).get("/api/link-preview?url=https%3A%2F%2Fh1.example.com%2F").set("Cookie", "sid=t");
    expect((await get()).status).toBe(200);
    on = false;
    expect((await get()).status).toBe(404);
  });

  test("the app info tells the client when it is on", async () => {
    const { app } = setup({ enabled: true });
    expect((await request(app).get("/api/app/info")).body.linkPreviewsEnabled).toBe(true);
    const off = setup({ enabled: false });
    expect((await request(off.app).get("/api/app/info")).body.linkPreviewsEnabled).toBe(false);
  });
});

describe("asking for a preview", () => {
  const link = "https://example.com/article";

  test("GET with ?url=", async () => {
    const { as } = setup({ pages: { [link]: htmlResponse(OG()) } });
    const res = await as("alice").get(`/api/link-preview?url=${encodeURIComponent(link)}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: link, title: "The title", description: "About it.", siteName: "Example", image: null });
    expect(res.headers["cache-control"]).toBe("private, no-store");
  });

  test("POST with { url } (the address stays out of server and proxy logs)", async () => {
    const { as } = setup({ pages: { [link]: htmlResponse(OG()) } });
    const res = await as("alice").post("/api/link-preview").send({ url: link });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe("The title");
  });

  test("a POST reads the body, not the query string", async () => {
    const { as, transport } = setup({ pages: { [link]: htmlResponse(OG()) } });
    const res = await as("alice")
      .post(`/api/link-preview?url=${encodeURIComponent("https://example.com/other")}`)
      .send({ url: link });
    expect(res.status).toBe(200);
    expect(transport.requests[0].url).toBe(link);
  });

  test("the result has exactly the documented fields", async () => {
    const { as } = setup({
      pages: { [link]: htmlResponse(OG('<meta property="og:image" content="https://cdn.example.com/c.png">')) },
      images: { "https://cdn.example.com/c.png": imageResponse(pngBytes(300, 200)) },
    });
    const res = await as("alice").get(`/api/link-preview?url=${encodeURIComponent(link)}`);
    expect(Object.keys(res.body).sort()).toEqual(["description", "image", "siteName", "title", "url"]);
    expect(Object.keys(res.body.image).sort()).toEqual(["height", "url", "width"]);
    expect(res.body.image).toMatchObject({ width: 300, height: 200 });
    expect(res.body.image.url).toMatch(/^\/api\/link-preview\/image\/[a-f0-9]{32}$/);
  });

  test.each([
    ["no url", "/api/link-preview"],
    ["an empty url", "/api/link-preview?url="],
    ["a repeated url", "/api/link-preview?url=https%3A%2F%2Fexample.com%2F&url=https%3A%2F%2Fexample.org%2F"],
    ["an object url", "/api/link-preview?url[a]=b"],
    ["a loopback address", `/api/link-preview?url=${encodeURIComponent("http://127.0.0.1/")}`],
    ["a metadata address", `/api/link-preview?url=${encodeURIComponent("http://169.254.169.254/latest/meta-data/")}`],
    ["a decimal address", `/api/link-preview?url=${encodeURIComponent("http://2130706433/")}`],
    ["a private network", `/api/link-preview?url=${encodeURIComponent("http://192.168.1.1/")}`],
    ["a file link", `/api/link-preview?url=${encodeURIComponent("file:///etc/passwd")}`],
    ["a user name", `/api/link-preview?url=${encodeURIComponent("http://user:pw@example.com/")}`],
    ["another port", `/api/link-preview?url=${encodeURIComponent("http://example.com:8080/")}`],
  ])("%s is a 400 and nothing is fetched", async (_name, url) => {
    const { as, transport, resolve } = setup();
    const res = await as("alice").get(url);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "This link cannot be previewed.", code: "invalid_url" });
    expect(transport.requests).toEqual([]);
    expect(resolve.calls).toEqual([]);
  });

  test("a POST body that is not a string url is a 400", async () => {
    const { as } = setup();
    for (const body of [{}, { url: 5 }, { url: ["https://example.com/"] }, { url: { href: "https://example.com/" } }, []]) {
      expect((await as("alice").post("/api/link-preview").send(body)).status).toBe(400);
    }
  });

  test("whatever goes wrong with the site, the answer is the same, and says nothing about why", async () => {
    const answers = new Set();
    for (const code of ["blocked_address", "dns_failed", "timeout", "network", "bad_status", "bad_content_type", "bad_encoding", "too_many_redirects", "redirect_loop", "blocked_redirect", "no_preview"]) {
      const { as } = setup({
        service: {
          getPreview: async () => {
            throw new LinkPreviewError(code, `internal detail about ${code} 10.0.0.1`);
          },
          getImage: () => null,
        },
      });
      const res = await as("alice").get(`/api/link-preview?url=${encodeURIComponent(link)}`);
      expect(res.status).toBe(422);
      answers.add(JSON.stringify(res.body));
    }
    expect([...answers]).toEqual([JSON.stringify({ error: "No preview is available for this link.", code: "preview_unavailable" })]);
  });

  test("a private network is probed in vain: a name pointing inside gets the same answer as any other failure", async () => {
    const resolve = makeResolver({ "inside.example.com": ["10.0.0.5"], "gone.example.com": ["93.184.216.34"] });
    const transport = makeTransport(() => ({ status: 500, headers: {}, body: "" }));
    const { as } = setup({ service: createLinkPreviewService({ resolve, transport }) });
    const inside = await as("alice").get(`/api/link-preview?url=${encodeURIComponent("https://inside.example.com/")}`);
    const gone = await as("alice").get(`/api/link-preview?url=${encodeURIComponent("https://gone.example.com/")}`);
    expect(inside.status).toBe(422);
    expect(inside.body).toEqual(gone.body);
    expect(transport.requests.map((r) => r.host)).toEqual(["gone.example.com"]);
  });

  test("an unexpected error is a 500 without details", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { as } = setup({
      service: {
        getPreview: async () => {
          throw new Error("boom: /srv/secret/path");
        },
        getImage: () => null,
      },
    });
    const res = await as("alice").get(`/api/link-preview?url=${encodeURIComponent(link)}`);
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/boom|secret/);
  });

  test("the default wiring is the strict one: loopback is refused without any injected service", async () => {
    const built = makeApp({
      userStore: makeUserStore([ALICE]),
      settings: { LINK_PREVIEWS: true },
      // Even a hostile environment does not help in production.
      deps: { env: { APP_ENV: "production", LINK_PREVIEW_ALLOW_PRIVATE_FOR_TESTS: "1" } },
    });
    built.sessionStore.createSession(ALICE.id, "t");
    const res = await request(built.app).get(`/api/link-preview?url=${encodeURIComponent("http://127.0.0.1:1/")}`).set("Cookie", "sid=t");
    expect(res.status).toBe(400);
  });
});

describe("rate limits", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const get = (as, n) => as.get(`/api/link-preview?url=${encodeURIComponent(`https://h${n}.example.com/`)}`);

  test("30 sites a minute per person; the 31st is a 429 and costs the site nothing", async () => {
    const { as, transport } = setup();
    for (let n = 0; n < 30; n += 1) expect((await get(as("alice"), n)).status).toBe(200);
    const limited = await get(as("alice"), 30);
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe("rate_limited");
    expect(transport.requests).toHaveLength(30);

    // Somebody else has their own allowance.
    expect((await get(as("bob"), 31)).status).toBe(200);

    // A minute later it works again.
    vi.setSystemTime(Date.now() + 61_000);
    expect((await get(as("alice"), 30)).status).toBe(200);
  });

  test("answers from the cache do not use up the allowance", async () => {
    const { as, transport } = setup();
    for (let n = 0; n < 30; n += 1) await get(as("alice"), n);
    // 30 sites fetched: the minute's allowance is gone, but these are known.
    for (let n = 0; n < 30; n += 1) expect((await get(as("alice"), n)).status).toBe(200);
    expect(transport.requests).toHaveLength(30);
  });

  test("a link that fails counts like one that works", async () => {
    const { as } = setup();
    for (let n = 0; n < 30; n += 1) {
      const res = await as("alice").get(`/api/link-preview?url=${encodeURIComponent(`https://missing${n}.example.com/`)}`);
      expect([422]).toContain(res.status); // does not resolve
    }
    // The lookups failed before any connection, but each one was a lookup of a site.
    expect((await get(as("alice"), 1)).status).toBe(429);
  });

  test("300 sites a day, however the minutes are spread", async () => {
    const { as } = setup();
    for (let batch = 0; batch < 10; batch += 1) {
      for (let i = 0; i < 30; i += 1) expect((await get(as("alice"), batch * 30 + i)).status).toBe(200);
      vi.setSystemTime(Date.now() + 61_000);
    }
    const limited = await get(as("alice"), 300);
    expect(limited.status).toBe(429);
    vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000);
    expect((await get(as("alice"), 300)).status).toBe(200);
  });

  test("a person cannot ask for more than 240 answers a minute, cached or not", async () => {
    const { as } = setup();
    await get(as("alice"), 1);
    let ok = 1;
    let last;
    for (let i = 0; i < 260; i += 1) {
      last = await get(as("alice"), 1);
      if (last.status === 200) ok += 1;
    }
    expect(ok).toBe(240);
    expect(last.status).toBe(429);
  });
});

describe("the picture", () => {
  const link = "https://example.com/article";
  const png = pngBytes(64, 48);
  const withPicture = () =>
    setup({
      pages: { [link]: htmlResponse(OG('<meta property="og:image" content="https://cdn.example.com/c.png">')) },
      images: { "https://cdn.example.com/c.png": imageResponse(png) },
    });

  test("is served from the cache with headers that keep it inert", async () => {
    const { as } = withPicture();
    const preview = (await as("alice").get(`/api/link-preview?url=${encodeURIComponent(link)}`)).body;
    const res = await as("alice").get(preview.image.url).buffer(true).parse((r, cb) => {
      const chunks = [];
      r.on("data", (c) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(Buffer.compare(res.body, png)).toBe(0);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["content-length"]).toBe(String(png.length));
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(res.headers["cache-control"]).toBe("private, max-age=86400, immutable");
    expect(res.headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(res.headers.vary).toMatch(/Cookie/);
    expect(res.headers["content-disposition"]).toBeUndefined();
  });

  test("anyone signed in can see a picture whose address they have", async () => {
    const { as } = withPicture();
    const preview = (await as("alice").get(`/api/link-preview?url=${encodeURIComponent(link)}`)).body;
    expect((await as("bob").get(preview.image.url)).status).toBe(200);
  });

  test.each([
    `/api/link-preview/image/${"0".repeat(32)}`,
    `/api/link-preview/image/${"a".repeat(31)}`,
    `/api/link-preview/image/${"a".repeat(33)}`,
    `/api/link-preview/image/${"A".repeat(32)}`,
    "/api/link-preview/image/..%2F..%2Fetc%2Fpasswd",
    "/api/link-preview/image/x",
  ])("%s is a 404", async (url) => {
    const { as } = withPicture();
    const res = await as("alice").get(url);
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/json/);
  });

  test("an SVG is never kept, so it can never be served", async () => {
    const { as, service } = setup({
      pages: { [link]: htmlResponse(OG('<meta property="og:image" content="https://cdn.example.com/c.svg">')) },
      images: { "https://cdn.example.com/c.svg": imageResponse(svgBytes(), "image/svg+xml") },
    });
    const preview = (await as("alice").get(`/api/link-preview?url=${encodeURIComponent(link)}`)).body;
    expect(preview.image).toBeNull();
    expect(service.stats().images).toBe(0);
  });

  test("a picture answers a request from its own address only (a made-up id finds nothing)", async () => {
    const { as } = withPicture();
    await as("alice").get(`/api/link-preview?url=${encodeURIComponent(link)}`);
    expect((await as("alice").get(`/api/link-preview/image/${"b".repeat(32)}`)).status).toBe(404);
  });
});
