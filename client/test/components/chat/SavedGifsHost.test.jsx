import { describe, test, expect, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import SavedGifsHost from "../../../src/components/chat/gifs/SavedGifsHost.jsx";
import { createSavedGifsStore } from "../../../src/gifs/savedGifsStore.js";

const gif = (n) => ({
  id: `gif-${n}`,
  url: `/api/gifs/gif-${n}/file`,
  width: 10,
  height: 10,
  mime: "image/gif",
  size: 100,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
});

const makeStore = () => {
  const api = {
    listSavedGifs: vi.fn(async () => ({ ok: true, status: 200, data: { gifs: [gif(1)], limit: 50, count: 1 } })),
    saveGifFromMessage: vi.fn(),
    uploadSavedGif: vi.fn(),
    deleteSavedGif: vi.fn(),
  };
  return { store: createSavedGifsStore({ api, notify: () => {} }), api };
};

// The text of the alert, once it has changed to match.
const alertText = () => document.querySelector('[role="alert"]')?.textContent || "";

const evictionEvent = (id, evicted, limit = 50) => ({
  type: "saved_gif_added",
  gif: gif(id),
  evicted: evicted.map((n) => ({ id: `gif-${n}` })),
  limit,
  count: limit,
});

describe("SavedGifsHost", () => {
  test("shows nothing while nothing was removed", async () => {
    const { store } = makeStore();
    await render(<SavedGifsHost ownerKey="me" store={store} />);
    expect(page.getByRole("alert").elements()).toHaveLength(0);
  });

  test("an automatic removal raises a notice with the limit from the server and an OK button", async () => {
    const { store } = makeStore();
    await render(<SavedGifsHost ownerKey="me" store={store} />);
    store.handleRealtimeEvent(evictionEvent(60, [1], 50));
    const alert = page.getByRole("alert");
    await expect.element(alert).toBeInTheDocument();
    await vi.waitFor(() => expect(alertText()).toMatch(/^Your GIF collection is full \(50 GIFs\)\. The oldest GIF was removed\.\s*OK$/));
    await expect.element(page.getByRole("button", { name: "OK" })).toBeInTheDocument();
  });

  test("the limit in the text is the server's, whatever it is", async () => {
    const { store } = makeStore();
    await render(<SavedGifsHost ownerKey="me" store={store} />);
    store.handleRealtimeEvent(evictionEvent(60, [1], 20));
    await vi.waitFor(() => expect(alertText()).toMatch(/Your GIF collection is full \(20 GIFs\)\./));
  });

  test("it stays until OK is pressed, and OK dismisses it", async () => {
    const { store } = makeStore();
    await render(<SavedGifsHost ownerKey="me" store={store} />);
    store.handleRealtimeEvent(evictionEvent(60, [1]));
    await expect.element(page.getByRole("alert")).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 3500)); // longer than a toast
    await expect.element(page.getByRole("alert")).toBeInTheDocument();
    await page.getByRole("button", { name: "OK" }).click();
    await vi.waitFor(() => expect(page.getByRole("alert").elements()).toHaveLength(0));
    expect(store.getState().notice).toBeNull();
  });

  test("a second removal before OK adds up in the same notice", async () => {
    const { store } = makeStore();
    await render(<SavedGifsHost ownerKey="me" store={store} />);
    store.handleRealtimeEvent(evictionEvent(60, [1]));
    store.handleRealtimeEvent(evictionEvent(61, [2]));
    await vi.waitFor(() => expect(alertText()).toMatch(/The 2 oldest GIFs were removed\./));
  });

  test("the same save arriving twice (answer and event) shows the notice once", async () => {
    const { store } = makeStore();
    await render(<SavedGifsHost ownerKey="me" store={store} />);
    store.handleRealtimeEvent(evictionEvent(60, [1]));
    store.handleRealtimeEvent(evictionEvent(60, [1]));
    await vi.waitFor(() => expect(alertText()).toMatch(/The oldest GIF was removed\./));
  });

  test("it keeps the picker open: the notice is marked as part of it", async () => {
    const { store } = makeStore();
    await render(<SavedGifsHost ownerKey="me" store={store} />);
    store.handleRealtimeEvent(evictionEvent(60, [1]));
    await expect.element(page.getByRole("alert")).toBeInTheDocument();
    expect(document.querySelector("[data-keeps-picker-open]")).not.toBeNull();
  });

  test("another person signing in drops the previous person's GIFs and notice", async () => {
    const { store } = makeStore();
    const view = await render(<SavedGifsHost ownerKey="alice" store={store} />);
    await store.load();
    store.handleRealtimeEvent(evictionEvent(60, [1]));
    await expect.element(page.getByRole("alert")).toBeInTheDocument();
    expect(store.getState().gifs.length).toBeGreaterThan(0);
    await view.rerender(<SavedGifsHost ownerKey="bob" store={store} />);
    expect(store.getState().owner).toBe("bob");
    expect(store.getState().gifs).toEqual([]);
    expect(store.getState().status).toBe("idle");
    await vi.waitFor(() => expect(page.getByRole("alert").elements()).toHaveLength(0));
  });

  test("leaving the app (logout) forgets everything", async () => {
    const { store } = makeStore();
    const view = await render(<SavedGifsHost ownerKey="alice" store={store} />);
    await store.load();
    expect(store.getState().gifs).toHaveLength(1);
    await view.unmount();
    expect(store.getState().owner).toBeNull();
    expect(store.getState().gifs).toEqual([]);
  });
});
