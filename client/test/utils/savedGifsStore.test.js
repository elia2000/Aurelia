import { beforeEach, describe, it, expect, vi } from "vitest";
import {
  checkGifUpload,
  createSavedGifsStore,
  describeEviction,
  describeGifError,
  emptyState,
  reduceAdded,
  reduceList,
  reduceRemoved,
} from "../../src/gifs/savedGifsStore.js";

const gif = (n, extra = {}) => ({
  id: `gif-${n}`,
  url: `/api/gifs/gif-${n}/file`,
  thumbUrl: null,
  width: 100,
  height: 80,
  mime: "image/gif",
  size: 1000 + n,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
  ...extra,
});

const ready = (ids, limit = 50) =>
  reduceList(emptyState("u1"), {
    gifs: ids.map((n) => gif(n)).reverse(), // newest first, like the server
    limit,
    count: ids.length,
  });

const ok = (data, status = 200) => ({ ok: true, status, data });
const fail = (status, data = {}) => ({ ok: false, status, data });

describe("reduceList", () => {
  it("takes the list, the count and the limit from the server", () => {
    const state = reduceList(emptyState("u1"), { gifs: [gif(2), gif(1)], limit: 12, count: 2 });
    expect(state.status).toBe("ready");
    expect(state.gifs.map((g) => g.id)).toEqual(["gif-2", "gif-1"]);
    expect(state.limit).toBe(12);
    expect(state.count).toBe(2);
  });

  it("ignores broken entries and never invents a limit", () => {
    const state = reduceList(emptyState("u1"), { gifs: [null, {}, gif(1)] });
    expect(state.gifs).toHaveLength(1);
    expect(state.limit).toBeNull();
    expect(state.count).toBe(1);
  });
});

describe("reduceAdded", () => {
  it("puts a new GIF first and raises no notice while nothing is evicted", () => {
    const state = reduceAdded(ready([1, 2]), { gif: gif(3), evicted: [], limit: 50, count: 3 });
    expect(state.gifs.map((g) => g.id)).toEqual(["gif-3", "gif-2", "gif-1"]);
    expect(state.count).toBe(3);
    expect(state.notice).toBeNull();
  });

  it("removes the evicted GIFs from the list and raises the notice with the server's limit", () => {
    const start = ready([1, 2, 3], 3);
    const state = reduceAdded(start, { gif: gif(4), evicted: [{ id: "gif-1" }], limit: 3, count: 3 });
    expect(state.gifs.map((g) => g.id)).toEqual(["gif-4", "gif-3", "gif-2"]);
    expect(state.notice).toMatchObject({ removed: 1, limit: 3 });
    expect(describeEviction(state.notice)).toBe(
      "Your GIF collection is full (3 GIFs). The oldest GIF was removed.",
    );
  });

  it("counts the evictions once when the answer and the realtime event both arrive", () => {
    const payload = { gif: gif(4), evicted: [{ id: "gif-1" }], limit: 3, count: 3 };
    const once = reduceAdded(ready([1, 2, 3], 3), payload);
    const twice = reduceAdded(once, { type: "saved_gif_added", ...payload });
    expect(twice.notice.removed).toBe(1);
    expect(twice.notice.id).toBe(once.notice.id);
    expect(twice.gifs.filter((g) => g.id === "gif-4")).toHaveLength(1);
    expect(twice.gifs).toHaveLength(3);
  });

  it("adds up evictions of different saves until the notice is dismissed", () => {
    let state = ready([1, 2, 3], 3);
    state = reduceAdded(state, { gif: gif(4), evicted: [{ id: "gif-1" }], limit: 3, count: 3 });
    state = reduceAdded(state, { gif: gif(5), evicted: [{ id: "gif-2" }], limit: 3, count: 3 });
    expect(state.notice.removed).toBe(2);
    expect(describeEviction(state.notice)).toBe(
      "Your GIF collection is full (3 GIFs). The 2 oldest GIFs were removed.",
    );
    expect(state.gifs.map((g) => g.id)).toEqual(["gif-5", "gif-4", "gif-3"]);
  });

  it("does not make the list look complete when it was never loaded, but still tells about the removal", () => {
    const state = reduceAdded(emptyState("u1"), {
      gif: gif(9),
      evicted: [{ id: "gif-1" }],
      limit: 50,
      count: 50,
    });
    expect(state.status).toBe("idle");
    expect(state.gifs).toEqual([]);
    expect(state.notice).toMatchObject({ removed: 1, limit: 50 });
    expect(state.count).toBe(50);
  });

  it("leaves an existing GIF where it is", () => {
    const start = ready([1, 2, 3]);
    const state = reduceAdded(start, { gif: gif(1), evicted: [], limit: 50, count: 3 });
    expect(state.gifs.map((g) => g.id)).toEqual(["gif-3", "gif-2", "gif-1"]);
  });

  it("marks the list as out of date when a change arrives while it loads", () => {
    const loading = { ...emptyState("u1"), status: "loading", loading: true };
    const state = reduceAdded(loading, { gif: gif(1), evicted: [], limit: 50, count: 1 });
    expect(state.dirty).toBe(true);
  });
});

describe("reduceRemoved", () => {
  it("removes the GIF and takes the count from the server", () => {
    const state = reduceRemoved(ready([1, 2, 3]), { gifId: "gif-2", limit: 50, count: 2 });
    expect(state.gifs.map((g) => g.id)).toEqual(["gif-3", "gif-1"]);
    expect(state.count).toBe(2);
  });

  it("ignores an id it does not know", () => {
    const start = ready([1, 2]);
    expect(reduceRemoved(start, { gifId: "other", count: 2 }).gifs).toHaveLength(2);
  });
});

describe("messages", () => {
  it("names the limit in the notice and adapts to one GIF", () => {
    expect(describeEviction({ removed: 1, limit: 50 })).toBe(
      "Your GIF collection is full (50 GIFs). The oldest GIF was removed.",
    );
    expect(describeEviction({ removed: 1, limit: 1 })).toBe(
      "Your GIF collection is full (1 GIF). The oldest GIF was removed.",
    );
    expect(describeEviction({ removed: 1, limit: null })).toBe(
      "Your GIF collection is full. The oldest GIF was removed.",
    );
  });

  it("turns the codes of the server into sentences", () => {
    expect(describeGifError(fail(400, { code: "gif_not_animated" }), "x")).toMatch(/not animated/);
    expect(describeGifError(fail(400, { code: "gif_too_large" }), "x")).toMatch(/20 MB/);
    expect(describeGifError(fail(503, {}), "x")).toMatch(/disabled/);
    expect(describeGifError(fail(429, {}), "x")).toMatch(/slow down/);
    expect(describeGifError(fail(500, { error: "Unable to save the GIF." }), "x")).toBe("Unable to save the GIF.");
    expect(describeGifError(fail(500, {}), "fallback")).toBe("fallback");
  });

  it("checks a file before it is uploaded", () => {
    expect(checkGifUpload(new File(["x"], "a.gif", { type: "image/gif" }))).toBe("");
    expect(checkGifUpload(new File(["x"], "a.txt", { type: "text/plain" }))).toMatch(/Only animated/);
    expect(checkGifUpload({ name: "big.gif", type: "image/gif", size: 21 * 1024 * 1024 })).toMatch(/20 MB/);
    expect(checkGifUpload(null)).toMatch(/Choose/);
  });
});

describe("createSavedGifsStore", () => {
  const messages = [];
  const notify = (text, tone = "info") => messages.push({ text, tone });
  const last = () => messages[messages.length - 1];
  beforeEach(() => {
    messages.length = 0;
  });

  const makeApi = (overrides = {}) => ({
    listSavedGifs: vi.fn(async () => ok({ gifs: [gif(2), gif(1)], limit: 50, count: 2 })),
    saveGifFromMessage: vi.fn(async () => ok({ gif: gif(3), evicted: [], limit: 50, count: 3 }, 201)),
    uploadSavedGif: vi.fn(async () => ok({ gif: gif(3), evicted: [], limit: 50, count: 3 }, 201)),
    deleteSavedGif: vi.fn(async () => ok({ ok: true, id: "gif-1", limit: 50, count: 1 })),
    ...overrides,
  });

  it("loads the list once and shares a request that is under way", async () => {
    const api = makeApi();
    const store = createSavedGifsStore({ api, notify });
    store.bindOwner("u1");
    await Promise.all([store.load(), store.load()]);
    await store.load();
    expect(api.listSavedGifs).toHaveBeenCalledTimes(1);
    expect(store.getState().gifs).toHaveLength(2);
    await store.load({ force: true });
    expect(api.listSavedGifs).toHaveBeenCalledTimes(2);
  });

  it("keeps an error and lets the person ask again", async () => {
    const api = makeApi({ listSavedGifs: vi.fn(async () => fail(500, { error: "boom" })) });
    const store = createSavedGifsStore({ api, notify });
    store.bindOwner("u1");
    await store.load();
    expect(store.getState().status).toBe("error");
    expect(store.getState().error).toBe("boom");
    api.listSavedGifs.mockResolvedValueOnce(ok({ gifs: [gif(1)], limit: 50, count: 1 }));
    await store.load();
    expect(store.getState().status).toBe("ready");
  });

  it("saving from a message says 'GIF saved' and 'Already in your GIFs'", async () => {
    const api = makeApi();
    const store = createSavedGifsStore({ api, notify });
    store.bindOwner("u1");
    await store.load();
    const first = await store.saveFromMessage({ messageId: "m1", fileId: 7 });
    expect(first.ok).toBe(true);
    expect(last().text).toBe("GIF saved");
    expect(store.getState().gifs[0].id).toBe("gif-3");
    api.saveGifFromMessage.mockResolvedValueOnce(
      ok({ gif: gif(3), evicted: [], existing: true, limit: 50, count: 3 }),
    );
    await store.saveFromMessage({ messageId: "m1", fileId: 7 });
    expect(last().text).toBe("Already in your GIFs");
    expect(store.getState().gifs.filter((g) => g.id === "gif-3")).toHaveLength(1);
  });

  it("a save past the limit removes the oldest from the grid and keeps a notice until it is dismissed", async () => {
    const api = makeApi({
      listSavedGifs: vi.fn(async () => ok({ gifs: [gif(3), gif(2), gif(1)], limit: 3, count: 3 })),
      saveGifFromMessage: vi.fn(async () =>
        ok({ gif: gif(4), evicted: [{ id: "gif-1" }], limit: 3, count: 3 }, 201),
      ),
    });
    const store = createSavedGifsStore({ api, notify });
    store.bindOwner("u1");
    await store.load();
    await store.saveFromMessage({ messageId: "m1", fileId: 7 });
    let state = store.getState();
    expect(state.gifs.map((g) => g.id)).toEqual(["gif-4", "gif-3", "gif-2"]);
    expect(describeEviction(state.notice)).toBe(
      "Your GIF collection is full (3 GIFs). The oldest GIF was removed.",
    );
    // the realtime event for the same save changes nothing
    store.handleRealtimeEvent({
      type: "saved_gif_added",
      gif: gif(4),
      evicted: [{ id: "gif-1" }],
      limit: 3,
      count: 3,
    });
    expect(store.getState().notice.removed).toBe(1);
    store.dismissNotice();
    expect(store.getState().notice).toBeNull();
  });

  it("a save made on another device arrives as an event and raises the notice too", async () => {
    const store = createSavedGifsStore({ api: makeApi(), notify });
    store.bindOwner("u1");
    await store.load();
    store.handleRealtimeEvent({
      type: "saved_gif_added",
      gif: gif(9),
      evicted: [{ id: "gif-1" }],
      limit: 50,
      count: 50,
    });
    expect(store.getState().notice).toMatchObject({ removed: 1, limit: 50 });
    expect(store.getState().gifs.map((g) => g.id)).not.toContain("gif-1");
    store.handleRealtimeEvent({ type: "saved_gif_removed", gifId: "gif-9", limit: 50, count: 49 });
    expect(store.getState().gifs.map((g) => g.id)).not.toContain("gif-9");
  });

  it("an upload adds a GIF, refuses a wrong file without asking the server, and reports server errors", async () => {
    const api = makeApi();
    const store = createSavedGifsStore({ api, notify });
    store.bindOwner("u1");
    await store.load();
    const bad = await store.uploadFile(new File(["x"], "a.txt", { type: "text/plain" }));
    expect(bad.ok).toBe(false);
    expect(api.uploadSavedGif).not.toHaveBeenCalled();
    expect(last().tone).toBe("error");

    const good = await store.uploadFile(new File(["x"], "a.gif", { type: "image/gif" }));
    expect(good.ok).toBe(true);
    expect(store.getState().uploading).toBe(false);
    expect(last().text).toBe("GIF added");

    api.uploadSavedGif.mockResolvedValueOnce(fail(400, { code: "gif_not_animated", error: "x" }));
    const refused = await store.uploadFile(new File(["x"], "b.gif", { type: "image/gif" }));
    expect(refused.ok).toBe(false);
    expect(last().text).toMatch(/not animated/);
    expect(store.getState().uploading).toBe(false);
  });

  it("removing a GIF takes it out of the list, also when the server says it is gone already", async () => {
    const api = makeApi();
    const store = createSavedGifsStore({ api, notify });
    store.bindOwner("u1");
    await store.load();
    await store.remove("gif-1");
    expect(store.getState().gifs.map((g) => g.id)).toEqual(["gif-2"]);
    api.deleteSavedGif.mockResolvedValueOnce(fail(404, { error: "GIF not found." }));
    await store.remove("gif-2");
    expect(store.getState().gifs).toEqual([]);
    api.deleteSavedGif.mockResolvedValueOnce(fail(500, {}));
    await store.load({ force: true });
    const result = await store.remove("gif-1");
    expect(result.ok).toBe(false);
    expect(store.getState().gifs.map((g) => g.id)).toContain("gif-1");
  });

  it("forgets everything when another person signs in, and drops answers that were still on their way", async () => {
    let release;
    const api = makeApi({
      listSavedGifs: vi.fn(
        () =>
          new Promise((resolve) => {
            release = () => resolve(ok({ gifs: [gif(1)], limit: 50, count: 1 }));
          }),
      ),
    });
    const store = createSavedGifsStore({ api, notify });
    store.bindOwner("alice");
    const pending = store.load();
    store.bindOwner("bob");
    release();
    await pending;
    expect(store.getState().owner).toBe("bob");
    expect(store.getState().gifs).toEqual([]);
    expect(store.getState().status).toBe("idle");

    api.listSavedGifs.mockImplementation(async () => ok({ gifs: [gif(5)], limit: 50, count: 1 }));
    await store.load();
    expect(store.getState().gifs.map((g) => g.id)).toEqual(["gif-5"]);
    store.reset();
    expect(store.getState()).toMatchObject({ owner: null, gifs: [], status: "idle", notice: null });
  });

  it("asks for the list again when a change arrived while it was loading", async () => {
    const releases = [];
    const api = makeApi({
      listSavedGifs: vi.fn(
        () =>
          new Promise((resolve) => {
            releases.push(resolve);
          }),
      ),
    });
    const store = createSavedGifsStore({ api, notify });
    store.bindOwner("u1");
    const first = store.load();
    store.handleRealtimeEvent({ type: "saved_gif_added", gif: gif(7), evicted: [], limit: 50, count: 1 });
    releases[0](ok({ gifs: [], limit: 50, count: 0 }));
    await first;
    await vi.waitFor(() => expect(api.listSavedGifs).toHaveBeenCalledTimes(2));
    releases[1](ok({ gifs: [gif(7)], limit: 50, count: 1 }));
    await vi.waitFor(() => expect(store.getState().gifs.map((g) => g.id)).toEqual(["gif-7"]));
  });

  it("tells the subscribers about every change", async () => {
    const store = createSavedGifsStore({ api: makeApi(), notify });
    const seen = vi.fn();
    const off = store.subscribe(seen);
    store.bindOwner("u1");
    await store.load();
    expect(seen).toHaveBeenCalled();
    const calls = seen.mock.calls.length;
    off();
    store.dismissNotice();
    expect(seen.mock.calls.length).toBe(calls);
  });
});
