import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  MAX_PARALLEL,
  loadLinkPreview,
  normalizePreview,
  peekLinkPreview,
  resetLinkPreviewStore,
} from "../../src/utils/linkPreviewStore.js";

const originalFetch = globalThis.fetch;
const IMAGE = "/api/link-preview/image/0123456789abcdef0123456789abcdef";

const answer = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const good = (extra = {}) => ({
  url: "https://example.com/a",
  title: "A title",
  description: "A description",
  siteName: "Example",
  image: null,
  ...extra,
});

let fetchMock;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
  resetLinkPreviewStore();
  fetchMock = vi.fn(async () => answer(200, good()));
  globalThis.fetch = fetchMock;
});
afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
});

describe("asking the server", () => {
  test("a POST with the address in the body (not in the query string), with the session cookie", async () => {
    await loadLinkPreview("https://example.com/a?secret=1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/link-preview");
    expect(options.method).toBe("POST");
    expect(options.credentials).toBe("include");
    expect(JSON.parse(options.body)).toEqual({ url: "https://example.com/a?secret=1" });
  });

  test("the answer is a preview", async () => {
    const preview = await loadLinkPreview("https://example.com/a");
    expect(preview).toEqual({
      url: "https://example.com/a",
      title: "A title",
      description: "A description",
      siteName: "Example",
      image: null,
    });
  });

  test("a link asked about before is answered from memory", async () => {
    await loadLinkPreview("https://example.com/a");
    await loadLinkPreview("https://example.com/a");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(peekLinkPreview("https://example.com/a")).toMatchObject({ title: "A title" });
    expect(peekLinkPreview("https://example.com/other")).toBeUndefined();
  });

  test("ten messages with the same link at once cost one request", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => loadLinkPreview("https://example.com/a")));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new Set(results.map((r) => r.title))).toEqual(new Set(["A title"]));
  });

  test(`at most ${MAX_PARALLEL} requests run at once`, async () => {
    const releases = [];
    let running = 0;
    let peak = 0;
    fetchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          running += 1;
          peak = Math.max(peak, running);
          releases.push(() => {
            running -= 1;
            resolve(answer(200, good()));
          });
        }),
    );
    const all = Array.from({ length: 8 }, (_, i) => loadLinkPreview(`https://example.com/${i}`));
    await vi.waitFor(() => expect(releases.length).toBe(MAX_PARALLEL));
    expect(fetchMock).toHaveBeenCalledTimes(MAX_PARALLEL);
    while (releases.length) {
      releases.shift()();
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(8));
    while (releases.length) releases.shift()();
    await Promise.all(all);
    expect(peak).toBeLessThanOrEqual(MAX_PARALLEL);
  });
});

describe("remembering", () => {
  test("a found preview is kept for 30 minutes", async () => {
    await loadLinkPreview("https://example.com/a");
    vi.setSystemTime(Date.now() + 29 * 60 * 1000);
    expect(peekLinkPreview("https://example.com/a")).toBeTruthy();
    vi.setSystemTime(Date.now() + 2 * 60 * 1000);
    expect(peekLinkPreview("https://example.com/a")).toBeUndefined();
    await loadLinkPreview("https://example.com/a");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("a link with no preview (422) is remembered as nothing, for 10 minutes", async () => {
    fetchMock.mockImplementation(async () => answer(422, { code: "preview_unavailable" }));
    expect(await loadLinkPreview("https://example.com/a")).toBeNull();
    expect(peekLinkPreview("https://example.com/a")).toBeNull();
    await loadLinkPreview("https://example.com/a");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    await loadLinkPreview("https://example.com/a");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("a link the server refuses (400) is remembered as nothing", async () => {
    fetchMock.mockImplementation(async () => answer(400, { code: "invalid_url" }));
    expect(await loadLinkPreview("https://example.com/a")).toBeNull();
    expect(peekLinkPreview("https://example.com/a")).toBeNull();
  });

  test("a network error shows nothing and is tried again after a minute", async () => {
    fetchMock.mockImplementation(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await loadLinkPreview("https://example.com/a")).toBeNull();
    expect(await loadLinkPreview("https://example.com/a")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 61 * 1000);
    await loadLinkPreview("https://example.com/a");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("a server error (500) or being signed out is not remembered", async () => {
    for (const status of [500, 502, 401, 403]) {
      resetLinkPreviewStore();
      fetchMock.mockImplementation(async () => answer(status, {}));
      expect(await loadLinkPreview("https://example.com/a")).toBeNull();
      expect(peekLinkPreview("https://example.com/a")).toBeUndefined();
    }
  });

  test("an answer that is not JSON shows nothing", async () => {
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    }));
    expect(await loadLinkPreview("https://example.com/a")).toBeNull();
  });

  test("the memory is limited: the oldest links are forgotten first", async () => {
    for (let i = 0; i < 305; i += 1) await loadLinkPreview(`https://example.com/${i}`);
    expect(peekLinkPreview("https://example.com/0")).toBeUndefined();
    expect(peekLinkPreview("https://example.com/304")).toBeTruthy();
  });
});

describe("when the server says no", () => {
  test("previews turned off: nothing more is asked for 5 minutes", async () => {
    fetchMock.mockImplementation(async () => answer(404, { code: "link_previews_disabled" }));
    expect(await loadLinkPreview("https://example.com/a")).toBeNull();
    expect(await loadLinkPreview("https://example.com/b")).toBeNull();
    expect(await loadLinkPreview("https://example.com/c")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1000);
    fetchMock.mockImplementation(async () => answer(200, good()));
    expect((await loadLinkPreview("https://example.com/d")).title).toBe("A title");
  });

  test("asking too fast (429): a pause of a minute, and the link is asked again later", async () => {
    fetchMock.mockImplementation(async () => answer(429, { code: "rate_limited" }));
    expect(await loadLinkPreview("https://example.com/a")).toBeNull();
    expect(await loadLinkPreview("https://example.com/b")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(peekLinkPreview("https://example.com/a")).toBeUndefined();
    vi.setSystemTime(Date.now() + 61 * 1000);
    fetchMock.mockImplementation(async () => answer(200, good()));
    expect(await loadLinkPreview("https://example.com/a")).toBeTruthy();
  });

  test("a plain 404 (an old server without the feature) is just 'nothing'", async () => {
    fetchMock.mockImplementation(async () => answer(404, { error: "Not found" }));
    expect(await loadLinkPreview("https://example.com/a")).toBeNull();
    expect(peekLinkPreview("https://example.com/a")).toBeNull();
  });
});

describe("what gets through from the server's answer", () => {
  test("our own picture address is kept, with its size", () => {
    expect(normalizePreview(good({ image: { url: IMAGE, width: 640, height: 360 } })).image).toEqual({
      url: IMAGE,
      width: 640,
      height: 360,
    });
  });

  test.each([
    ["another site", "https://tracker.example.net/pixel.png"],
    ["a protocol-relative address", "//tracker.example.net/pixel.png"],
    ["a data: address", "data:image/png;base64,AAAA"],
    ["a javascript: address", "javascript:alert(1)"],
    ["a path elsewhere on our server", "/api/uploads/avatars/me.png"],
    ["a path with a made-up id", "/api/link-preview/image/short"],
    ["a path that continues past the id", `${IMAGE}/../../etc`],
    ["a path with a query", `${IMAGE}?x=1`],
    ["a path that starts with the wrong host", `https://evil.example.com${IMAGE}`],
    ["not a string", 42],
  ])("a picture from %s is dropped, the text stays (never hot-linked)", (_name, url) => {
    const preview = normalizePreview(good({ image: { url, width: 10, height: 10 } }));
    expect(preview.image).toBeNull();
    expect(preview.title).toBe("A title");
  });

  test("silly picture sizes are dropped", () => {
    expect(normalizePreview(good({ image: { url: IMAGE, width: -1, height: 99999 } })).image).toEqual({
      url: IMAGE,
      width: null,
      height: null,
    });
  });

  test("text is trimmed and limited, and only strings are accepted", () => {
    const preview = normalizePreview(good({ title: `  ${"t".repeat(500)}  `, siteName: 5, description: { a: 1 } }));
    expect(preview.title).toHaveLength(200);
    expect(preview.siteName).toBe("");
    expect(preview.description).toBe("");
  });

  test("an answer with no text has no preview", () => {
    expect(normalizePreview(good({ title: "", description: "" }))).toBeNull();
    expect(normalizePreview(null)).toBeNull();
    expect(normalizePreview("string")).toBeNull();
    expect(normalizePreview([])).toBeNull();
    expect(normalizePreview({})).toBeNull();
  });
});
