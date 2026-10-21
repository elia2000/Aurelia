import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import EmojiPicker from "../../../src/components/chat/emoji/EmojiPicker.jsx";
import { savedGifs } from "../../../src/gifs/savedGifsStore.js";
import * as gifApi from "../../../src/api/gifApi.js";

vi.mock("../../../src/api/gifApi.js", () => ({
  listSavedGifs: vi.fn(),
  saveGifFromMessage: vi.fn(),
  uploadSavedGif: vi.fn(),
  deleteSavedGif: vi.fn(),
}));

const PIXEL = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
const gif = (n) => ({
  id: `gif-${n}`,
  url: PIXEL,
  width: 10,
  height: 10,
  mime: "image/gif",
  size: 100,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
});

beforeEach(() => {
  localStorage.clear();
  savedGifs.reset();
  savedGifs.bindOwner("me");
  gifApi.listSavedGifs.mockResolvedValue({
    ok: true,
    status: 200,
    data: { gifs: [gif(2), gif(1)], limit: 50, count: 2 },
  });
});
afterEach(() => {
  savedGifs.reset();
  vi.clearAllMocks();
});

const emojiButton = (name) => page.getByRole("button", { name, exact: true });

describe("EmojiPicker - Emoji | GIFs tabs", () => {
  test("without a way to send GIFs there is no tab bar and the picker is the plain emoji picker", async () => {
    render(<EmojiPicker onSelect={() => {}} onClose={() => {}} />);
    await expect.element(emojiButton("grinning")).toBeInTheDocument();
    expect(page.getByRole("tablist", { name: "Emoji or GIFs" }).elements()).toHaveLength(0);
    expect(page.getByRole("dialog", { name: "Emoji", exact: true }).elements()).toHaveLength(1);
    expect(gifApi.listSavedGifs).not.toHaveBeenCalled();
  });

  test("with onSendGif the picker has an Emoji and a GIFs tab, Emoji first", async () => {
    render(<EmojiPicker onSelect={() => {}} onClose={() => {}} onSendGif={() => {}} />);
    await expect.element(page.getByRole("tablist", { name: "Emoji or GIFs" })).toBeInTheDocument();
    const emojiTab = page.getByRole("tab", { name: "Emoji", exact: true });
    const gifsTab = page.getByRole("tab", { name: "GIFs", exact: true });
    await expect.element(emojiTab).toHaveAttribute("aria-selected", "true");
    await expect.element(gifsTab).toHaveAttribute("aria-selected", "false");
    await expect.element(emojiButton("grinning")).toBeInTheDocument();
    // the GIF list is not asked for until the tab is opened
    expect(gifApi.listSavedGifs).not.toHaveBeenCalled();
  });

  test("each tab points at a panel that exists (aria-controls), and the shown panel is labelled by its tab", async () => {
    render(<EmojiPicker onSelect={() => {}} onClose={() => {}} onSendGif={() => {}} />);
    const emojiTab = page.getByRole("tab", { name: "Emoji", exact: true });
    await expect.element(emojiTab).toHaveAttribute("aria-selected", "true");
    const controls = (await emojiTab.element()).getAttribute("aria-controls");
    const panel = document.getElementById(controls);
    expect(panel).not.toBeNull();
    expect(panel.getAttribute("role")).toBe("tabpanel");
    expect(panel.getAttribute("aria-labelledby")).toBe("picker-tab-emoji");
    expect(panel.querySelector('[role="searchbox"]')).not.toBeNull();
    await page.getByRole("tab", { name: "GIFs", exact: true }).click();
    const gifsControls = (await page.getByRole("tab", { name: "GIFs", exact: true }).element()).getAttribute("aria-controls");
    expect(document.getElementById(gifsControls)?.getAttribute("role")).toBe("tabpanel");
  });

  test("the GIFs tab shows the saved GIFs and the counter; the emoji search and categories are gone", async () => {
    render(<EmojiPicker onSelect={() => {}} onClose={() => {}} onSendGif={() => {}} />);
    await page.getByRole("tab", { name: "GIFs", exact: true }).click();
    await expect.element(page.getByRole("button", { name: "Send GIF 1" })).toBeInTheDocument();
    await expect.element(page.getByText("2 of 50 GIFs saved")).toBeInTheDocument();
    await expect.element(page.getByRole("tab", { name: "GIFs", exact: true })).toHaveAttribute("aria-selected", "true");
    expect(page.getByRole("searchbox").elements()).toHaveLength(0);
    expect(gifApi.listSavedGifs).toHaveBeenCalledTimes(1);
    await page.getByRole("tab", { name: "Emoji", exact: true }).click();
    await expect.element(emojiButton("grinning")).toBeInTheDocument();
  });

  test("the arrow keys move between the tabs", async () => {
    render(<EmojiPicker onSelect={() => {}} onClose={() => {}} onSendGif={() => {}} />);
    const emojiTab = page.getByRole("tab", { name: "Emoji", exact: true });
    await expect.element(emojiTab).toBeInTheDocument();
    (await emojiTab.element()).focus();
    await userEvent.keyboard("{ArrowRight}");
    await expect.element(page.getByRole("tab", { name: "GIFs", exact: true })).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{ArrowLeft}");
    await expect.element(emojiTab).toHaveAttribute("aria-selected", "true");
  });

  test("the chosen tab is remembered the next time the picker opens", async () => {
    const first = await render(<EmojiPicker onSelect={() => {}} onClose={() => {}} onSendGif={() => {}} />);
    await page.getByRole("tab", { name: "GIFs", exact: true }).click();
    expect(localStorage.getItem("aurelle-picker-tab")).toBe("gifs");
    await first.unmount();
    await render(<EmojiPicker onSelect={() => {}} onClose={() => {}} onSendGif={() => {}} />);
    await expect.element(page.getByRole("tab", { name: "GIFs", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect.element(page.getByRole("button", { name: "Send GIF 1" })).toBeInTheDocument();
  });

  test("a remembered GIFs tab falls back to emoji when GIFs cannot be sent", async () => {
    localStorage.setItem("aurelle-picker-tab", "gifs");
    render(<EmojiPicker onSelect={() => {}} onClose={() => {}} />);
    await expect.element(emojiButton("grinning")).toBeInTheDocument();
  });

  test("tapping a GIF sends it and closes the picker", async () => {
    const onSendGif = vi.fn();
    const onClose = vi.fn();
    render(<EmojiPicker onSelect={() => {}} onClose={onClose} onSendGif={onSendGif} />);
    await page.getByRole("tab", { name: "GIFs", exact: true }).click();
    await page.getByRole("button", { name: "Send GIF 1" }).click();
    expect(onSendGif).toHaveBeenCalledTimes(1);
    expect(onSendGif.mock.calls[0][0]).toMatchObject({ id: "gif-2" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("Escape closes the GIF menu first, and only the next Escape closes the picker", async () => {
    const onClose = vi.fn();
    render(<EmojiPicker onSelect={() => {}} onClose={onClose} onSendGif={() => {}} />);
    await page.getByRole("tab", { name: "GIFs", exact: true }).click();
    await page.getByRole("button", { name: "Send GIF 1" }).click({ button: "right" });
    await expect.element(page.getByRole("menuitem", { name: "Remove from saved" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
