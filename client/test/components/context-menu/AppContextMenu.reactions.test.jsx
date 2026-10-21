import { describe, test, expect, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";

const api = vi.hoisted(() => ({ reactToMessage: vi.fn(), listMessageReactors: vi.fn() }));
vi.mock("../../../src/api/reactionsApi.js", () => api);

import AppContextMenu from "../../../src/components/context-menu/AppContextMenu.jsx";
import {
  getReactionEntry,
  resetReactionStore,
  seedReactions,
} from "../../../src/utils/reactionStore.js";

const CHAT = "44444444-4444-4444-a444-444444444444";
const MSG = "33333333-3333-4333-a333-333333333331";

const UP = "\u{1F44D}";
const HEART = "❤️";
const FIRE = "\u{1F525}";

const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

const makeMenu = (overrides = {}) => ({
  kind: "message",
  point: { x: 120, y: 260 },
  targetEl: null,
  reactions: { chatId: CHAT, messageId: MSG },
  items: [
    { id: "reply", label: "Reply", onSelect: vi.fn() },
    { id: "copy", label: "Copy text", onSelect: vi.fn() },
  ],
  ...overrides,
});

const bar = () => document.querySelector("[data-reaction-bar]");
const quick = (emoji) => document.querySelector(`[data-quick-reaction="${emoji}"]`);
const activeQuick = () => document.activeElement?.getAttribute("data-quick-reaction");

beforeEach(() => {
  resetReactionStore();
  api.reactToMessage.mockReset();
  api.reactToMessage.mockResolvedValue(reply(200, { messageId: MSG, reactions: [] }));
  localStorage.clear();
});

describe("AppContextMenu - quick reaction bar", () => {
  test("a message menu shows seven quick emoji and a plus above the items", async () => {
    render(<AppContextMenu menu={makeMenu()} onClose={vi.fn()} />);
    await expect.element(page.getByRole("toolbar", { name: "Quick reactions" })).toBeInTheDocument();
    const buttons = [...bar().querySelectorAll("button")];
    expect(buttons).toHaveLength(8);
    expect(buttons.slice(0, 7).map((b) => b.dataset.quickReaction)).toEqual([
      UP,
      HEART,
      FIRE,
      "\u{1F970}",
      "\u{1F44F}",
      "\u{1F601}",
      "\u{1F914}",
    ]);
    expect(buttons[7].getAttribute("aria-label")).toBe("More reactions");
    await expect.element(page.getByRole("button", { name: `React with ${UP}` })).toBeInTheDocument();
  });

  test("it stays hidden until it has been placed on the menu card, then shows (also when the menu opens at the same spot again)", async () => {
    const first = makeMenu();
    const view = await render(<AppContextMenu menu={first} onClose={vi.fn()} />);
    await expect.element(page.getByRole("toolbar", { name: "Quick reactions" })).toBeInTheDocument();
    await vi.waitFor(() => expect(bar().style.visibility).toBe("visible"));
    // (Tailwind is not applied in these tests, so where it sits is checked in a real browser.)
    expect(Number.isFinite(parseFloat(bar().style.top))).toBe(true);
    await view.rerender(<AppContextMenu menu={null} onClose={vi.fn()} />);
    await vi.waitFor(() => expect(bar()).toBeNull());
    await view.rerender(<AppContextMenu menu={makeMenu()} onClose={vi.fn()} />);
    await vi.waitFor(() => expect(bar()?.style.visibility).toBe("visible"));
  });

  test("a menu with no reactions to offer has no bar", async () => {
    render(<AppContextMenu menu={makeMenu({ reactions: null })} onClose={vi.fn()} />);
    await expect.element(page.getByRole("menu")).toBeInTheDocument();
    expect(bar()).toBeNull();
  });

  test("my current reactions are highlighted", async () => {
    seedReactions([{ id: MSG, reactions: [{ emoji: HEART, count: 2, reacted: true }, { emoji: UP, count: 1, reacted: false }] }]);
    render(<AppContextMenu menu={makeMenu()} onClose={vi.fn()} />);
    await expect.element(page.getByRole("toolbar", { name: "Quick reactions" })).toBeInTheDocument();
    expect(quick(HEART).getAttribute("aria-pressed")).toBe("true");
    expect(quick(UP).getAttribute("aria-pressed")).toBe("false");
    expect(quick(FIRE).getAttribute("aria-pressed")).toBe("false");
  });

  test("choosing one reacts at once and closes the menu", async () => {
    api.reactToMessage.mockResolvedValueOnce(
      reply(200, { messageId: MSG, reactions: [{ emoji: FIRE, count: 1, reacted: true }] }),
    );
    const onClose = vi.fn();
    render(<AppContextMenu menu={makeMenu()} onClose={onClose} />);
    await expect.element(page.getByRole("toolbar", { name: "Quick reactions" })).toBeInTheDocument();
    await vi.waitFor(() => expect(bar().style.visibility).toBe("visible"));
    await userEvent.click(quick(FIRE));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(getReactionEntry(MSG).mine).toEqual([FIRE]);
    await vi.waitFor(() =>
      expect(api.reactToMessage).toHaveBeenCalledWith({ chatId: CHAT, messageId: MSG, emoji: FIRE }),
    );
  });

  test("choosing the one I already have takes it off", async () => {
    seedReactions([{ id: MSG, reactions: [{ emoji: HEART, count: 1, reacted: true }] }]);
    render(<AppContextMenu menu={makeMenu()} onClose={vi.fn()} />);
    await expect.element(page.getByRole("toolbar", { name: "Quick reactions" })).toBeInTheDocument();
    await vi.waitFor(() => expect(bar().style.visibility).toBe("visible"));
    await userEvent.click(quick(HEART));
    expect(getReactionEntry(MSG).items).toEqual([]);
    await vi.waitFor(() => expect(api.reactToMessage).toHaveBeenCalledTimes(1));
  });

  test("the plus opens the emoji picker; any emoji from it is a reaction", async () => {
    api.reactToMessage.mockResolvedValueOnce(
      reply(200, { messageId: MSG, reactions: [{ emoji: "\u{1F600}", count: 1, reacted: true }] }),
    );
    const onClose = vi.fn();
    render(<AppContextMenu menu={makeMenu()} onClose={onClose} />);
    await expect.element(page.getByRole("toolbar", { name: "Quick reactions" })).toBeInTheDocument();
    await vi.waitFor(() => expect(bar().style.visibility).toBe("visible"));
    await page.getByRole("button", { name: "More reactions" }).click();
    await expect.element(page.getByRole("dialog", { name: "Emoji" })).toBeInTheDocument();
    // the menu itself steps aside behind the picker
    expect(document.querySelector('[role="menu"]').style.visibility).toBe("hidden");
    await page.getByRole("button", { name: "grinning", exact: true }).click();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(getReactionEntry(MSG).mine).toEqual(["\u{1F600}"]);
    await vi.waitFor(() =>
      expect(api.reactToMessage).toHaveBeenCalledWith({ chatId: CHAT, messageId: MSG, emoji: "\u{1F600}" }),
    );
  });

  test("a menu opened after the picker was used is not hidden, and starts on its first item", async () => {
    const view = await render(<AppContextMenu menu={makeMenu()} onClose={vi.fn()} />);
    await vi.waitFor(() => expect(bar().style.visibility).toBe("visible"));
    await page.getByRole("button", { name: "More reactions" }).click();
    await expect.element(page.getByRole("dialog", { name: "Emoji" })).toBeInTheDocument();
    expect(document.querySelector('[role="menu"]').style.visibility).toBe("hidden");
    // Escape closes the whole menu (the page sets it to null) with the picker still open
    await view.rerender(<AppContextMenu menu={null} onClose={vi.fn()} />);
    await view.rerender(<AppContextMenu menu={makeMenu()} onClose={vi.fn()} />);
    await expect.element(page.getByRole("menu")).toBeInTheDocument();
    expect(document.querySelector('[role="menu"]').style.visibility).not.toBe("hidden");
    await vi.waitFor(() => expect(document.activeElement?.textContent).toContain("Reply"));
    // so Up reaches the quick bar, as documented, and not the last item
    await userEvent.keyboard("{ArrowUp}");
    expect(activeQuick()).toBe(UP);
  });

  test("a right click on the bar does not close and reopen the menu", async () => {
    const onClose = vi.fn();
    render(<AppContextMenu menu={makeMenu()} onClose={onClose} />);
    await expect.element(page.getByRole("toolbar", { name: "Quick reactions" })).toBeInTheDocument();
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    quick(UP).dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("AppContextMenu - quick reaction bar, keyboard", () => {
  test("up from the first item reaches the bar; the arrows move along it; down returns to the menu", async () => {
    render(<AppContextMenu menu={makeMenu()} onClose={vi.fn()} />);
    await expect.element(page.getByRole("menuitem", { name: "Reply" })).toHaveAttribute("tabindex", "0");
    await vi.waitFor(() => expect(document.activeElement?.getAttribute("role")).toBe("menuitem"));
    await userEvent.keyboard("{ArrowUp}");
    expect(activeQuick()).toBe(UP);
    await userEvent.keyboard("{ArrowRight}");
    expect(activeQuick()).toBe(HEART);
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
    // wraps to the plus button at the end
    expect(document.activeElement.hasAttribute("data-quick-reaction-more")).toBe(true);
    await userEvent.keyboard("{Home}");
    expect(activeQuick()).toBe(UP);
    await userEvent.keyboard("{End}");
    expect(document.activeElement.hasAttribute("data-quick-reaction-more")).toBe(true);
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement.getAttribute("role")).toBe("menuitem");
    expect(document.activeElement.textContent).toContain("Reply");
  });

  test("up from the bar goes to the last menu item", async () => {
    render(<AppContextMenu menu={makeMenu()} onClose={vi.fn()} />);
    await vi.waitFor(() => expect(document.activeElement?.getAttribute("role")).toBe("menuitem"));
    await userEvent.keyboard("{ArrowUp}");
    expect(activeQuick()).toBe(UP);
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement.textContent).toContain("Copy text");
  });

  test("Enter on a focused emoji reacts and closes", async () => {
    api.reactToMessage.mockResolvedValueOnce(
      reply(200, { messageId: MSG, reactions: [{ emoji: HEART, count: 1, reacted: true }] }),
    );
    const onClose = vi.fn();
    render(<AppContextMenu menu={makeMenu()} onClose={onClose} />);
    await vi.waitFor(() => expect(document.activeElement?.getAttribute("role")).toBe("menuitem"));
    await userEvent.keyboard("{ArrowUp}{ArrowRight}{Enter}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(getReactionEntry(MSG).mine).toEqual([HEART]);
  });

  test("Escape in the bar closes the menu", async () => {
    const onClose = vi.fn();
    render(<AppContextMenu menu={makeMenu()} onClose={onClose} />);
    await vi.waitFor(() => expect(document.activeElement?.getAttribute("role")).toBe("menuitem"));
    await userEvent.keyboard("{ArrowUp}{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(api.reactToMessage).not.toHaveBeenCalled();
  });

  test("a menu without the bar still wraps from the first item to the last", async () => {
    render(<AppContextMenu menu={makeMenu({ reactions: null })} onClose={vi.fn()} />);
    await vi.waitFor(() => expect(document.activeElement?.getAttribute("role")).toBe("menuitem"));
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement.textContent).toContain("Copy text");
  });
});
