import { describe, test, expect, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import GifsPanel from "../../../src/components/chat/gifs/GifsPanel.jsx";
import { createSavedGifsStore } from "../../../src/gifs/savedGifsStore.js";

// A 1x1 GIF as a data URI, so the pictures load without any request.
const PIXEL = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

const gif = (n) => ({
  id: `gif-${n}`,
  url: PIXEL,
  thumbUrl: null,
  width: 100,
  height: 80,
  mime: "image/gif",
  size: 1000 + n,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
});

const ok = (data, status = 200) => ({ ok: true, status, data });

function makeStore({ gifs = [gif(3), gif(2), gif(1)], limit = 50, apiOverrides = {} } = {}) {
  const api = {
    listSavedGifs: vi.fn(async () => ok({ gifs, limit, count: gifs.length })),
    saveGifFromMessage: vi.fn(),
    uploadSavedGif: vi.fn(async () => ok({ gif: gif(9), evicted: [], limit, count: gifs.length + 1 }, 201)),
    deleteSavedGif: vi.fn(async (id) => ok({ ok: true, id, limit, count: gifs.length - 1 })),
    ...apiOverrides,
  };
  const messages = [];
  const store = createSavedGifsStore({ api, notify: (text, tone) => messages.push({ text, tone }) });
  store.bindOwner("me");
  return { store, api, messages };
}

const tiles = () => document.querySelectorAll("[data-gif-id]");

describe("GifsPanel", () => {
  test("shows the person's GIFs newest first in a 3-column grid with the counter from the server", async () => {
    const { store } = makeStore({ limit: 50 });
    render(<GifsPanel store={store} onSend={() => {}} isTouch={false} />);
    await expect.element(page.getByRole("button", { name: "Send GIF 1" })).toBeInTheDocument();
    expect([...tiles()].map((el) => el.getAttribute("data-gif-id"))).toEqual(["gif-3", "gif-2", "gif-1"]);
    expect(document.querySelector("ul").className).toContain("grid-cols-3");
    await expect.element(page.getByText("3 of 50 GIFs saved")).toBeInTheDocument();
    expect(document.querySelector('[data-testid="gif-panel"]').textContent).toContain("3/50");
  });

  test("takes the limit from the server, not from the code", async () => {
    const { store } = makeStore({ limit: 12 });
    render(<GifsPanel store={store} onSend={() => {}} isTouch={false} />);
    await expect.element(page.getByText("3 of 12 GIFs saved")).toBeInTheDocument();
  });

  test("the pictures are lazy and are the GIFs themselves, not stills", async () => {
    const { store } = makeStore();
    render(<GifsPanel store={store} onSend={() => {}} isTouch={false} />);
    await expect.element(page.getByRole("button", { name: "Send GIF 1" })).toBeInTheDocument();
    const img = document.querySelector("[data-gif-id] img");
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.getAttribute("src")).toBe(PIXEL);
  });

  test("an empty collection explains how to add GIFs", async () => {
    const { store } = makeStore({ gifs: [], limit: 50 });
    render(<GifsPanel store={store} onSend={() => {}} isTouch={false} />);
    await expect.element(page.getByText("No saved GIFs yet")).toBeInTheDocument();
    const text = document.querySelector('[data-testid="gif-panel"]').textContent;
    expect(text).toContain("Save GIF");
    expect(text).toContain("Add GIF");
    expect(text).toContain("up to 50");
    expect(text).toContain("the oldest GIF is removed");
    expect(text).toContain("Only you can see your GIFs");
  });

  test("tapping a GIF sends it, and a quick second tap does not send it twice", async () => {
    const onSend = vi.fn();
    const { store } = makeStore();
    render(<GifsPanel store={store} onSend={onSend} isTouch={false} />);
    const first = page.getByRole("button", { name: "Send GIF 1" });
    await expect.element(first).toBeInTheDocument();
    await first.click();
    await first.click();
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][0]).toMatchObject({ id: "gif-3" });
  });

  test("a right click offers 'Remove from saved' and removing takes the GIF out of the grid", async () => {
    const onSend = vi.fn();
    const { store, api } = makeStore();
    render(<GifsPanel store={store} onSend={onSend} isTouch={false} />);
    await expect.element(page.getByRole("button", { name: "Send GIF 2" })).toBeInTheDocument();
    await page.getByRole("button", { name: "Send GIF 2" }).click({ button: "right" });
    const item = page.getByRole("menuitem", { name: "Remove from saved" });
    await expect.element(item).toBeInTheDocument();
    expect(onSend).not.toHaveBeenCalled();
    await item.click();
    await vi.waitFor(() => expect(tiles()).toHaveLength(2));
    expect(api.deleteSavedGif).toHaveBeenCalledWith("gif-2");
    expect([...tiles()].map((el) => el.getAttribute("data-gif-id"))).toEqual(["gif-3", "gif-1"]);
  });

  test("Escape closes the GIF menu first and leaves the panel alone", async () => {
    const { store } = makeStore();
    const onMenuOpenChange = vi.fn();
    render(<GifsPanel store={store} onSend={() => {}} isTouch={false} onMenuOpenChange={onMenuOpenChange} />);
    await expect.element(page.getByRole("button", { name: "Send GIF 1" })).toBeInTheDocument();
    await page.getByRole("button", { name: "Send GIF 1" }).click({ button: "right" });
    await expect.element(page.getByRole("menuitem", { name: "Remove from saved" })).toBeInTheDocument();
    expect(onMenuOpenChange).toHaveBeenLastCalledWith(true);
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());
    expect(onMenuOpenChange).toHaveBeenLastCalledWith(false);
    expect(tiles()).toHaveLength(3);
  });

  test("'Add GIF' uploads the picked file through the store", async () => {
    const { store, api } = makeStore();
    render(<GifsPanel store={store} onSend={() => {}} isTouch={false} />);
    await expect.element(page.getByRole("button", { name: "Add GIF" })).toBeInTheDocument();
    const input = document.querySelector('input[type="file"]');
    expect(input.getAttribute("accept")).toContain("image/gif");
    const file = new File([new Uint8Array([71, 73, 70])], "fun.gif", { type: "image/gif" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(api.uploadSavedGif).toHaveBeenCalledTimes(1));
    expect(api.uploadSavedGif.mock.calls[0][0].name).toBe("fun.gif");
  });

  test("without the right to add GIFs there is no 'Add GIF' button", async () => {
    const { store } = makeStore();
    render(<GifsPanel store={store} onSend={() => {}} isTouch={false} canAdd={false} />);
    await expect.element(page.getByRole("button", { name: "Send GIF 1" })).toBeInTheDocument();
    expect(document.querySelector('input[type="file"]')).toBeNull();
    expect(page.getByRole("button", { name: "Add GIF" }).elements()).toHaveLength(0);
  });

  test("a failed load says so and lets the person try again", async () => {
    let calls = 0;
    const { store } = makeStore({
      apiOverrides: {
        listSavedGifs: vi.fn(async () => {
          calls += 1;
          return calls === 1
            ? { ok: false, status: 500, data: {} }
            : ok({ gifs: [gif(1)], limit: 50, count: 1 });
        }),
      },
    });
    render(<GifsPanel store={store} onSend={() => {}} isTouch={false} />);
    await expect.element(page.getByRole("alert")).toBeInTheDocument();
    await page.getByRole("button", { name: "Try again" }).click();
    await expect.element(page.getByRole("button", { name: "Send GIF 1" })).toBeInTheDocument();
  });
});
