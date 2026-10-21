import { describe, test, expect, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";

const api = vi.hoisted(() => ({ reactToMessage: vi.fn(), listMessageReactors: vi.fn() }));
vi.mock("../../../src/api/reactionsApi.js", () => api);

import ReactionChips from "../../../src/components/chat/reactions/ReactionChips.jsx";
import {
  applyRealtimeReaction,
  requestShowReactors,
  resetReactionStore,
  seedReactions,
} from "../../../src/utils/reactionStore.js";

const ME = "11111111-1111-4111-a111-111111111111";
const BOB = "22222222-2222-4222-a222-222222222222";
const CHAT = "44444444-4444-4444-a444-444444444444";
const MSG = "33333333-3333-4333-a333-333333333331";
const OTHER_MSG = "33333333-3333-4333-a333-333333333332";

const UP = "\u{1F44D}";
const HEART = "❤️";
const FIRE = "\u{1F525}";

const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// The store tells React from outside of it: give the screen a moment to follow.
const flush = () => new Promise((resolve) => setTimeout(resolve, 30));
const seed = (reactions, id = MSG) => seedReactions([{ id, reactions }]);
const chips = () => [...document.querySelectorAll("[data-reaction-chip]")];
const chip = (emoji) => document.querySelector(`[data-reaction-chip="${emoji}"]`);

const renderChips = (props = {}) =>
  render(<ReactionChips chatId={CHAT} messageId={MSG} {...props} />);

beforeEach(() => {
  resetReactionStore();
  api.reactToMessage.mockReset();
  api.listMessageReactors.mockReset();
  api.reactToMessage.mockResolvedValue(reply(200, { messageId: MSG, reactions: [] }));
});

describe("ReactionChips - what is drawn", () => {
  test("draws nothing for a message with no reactions", async () => {
    renderChips();
    expect(document.querySelector('[role="group"]')).toBeNull();
    expect(chips()).toHaveLength(0);
  });

  test("a chip per emoji with its count, mine highlighted and pressed", async () => {
    seed([
      { emoji: HEART, count: 3, reacted: true },
      { emoji: UP, count: 1, reacted: false },
    ]);
    renderChips();
    await expect.element(page.getByRole("group", { name: "Reactions" })).toBeInTheDocument();
    expect(chips().map((el) => el.dataset.reactionChip)).toEqual([HEART, UP]);
    expect(chip(HEART).textContent.trim()).toBe("3");
    expect(chip(HEART).getAttribute("aria-pressed")).toBe("true");
    expect(chip(HEART).className).toContain("bg-emerald-500");
    expect(chip(UP).getAttribute("aria-pressed")).toBe("false");
    expect(chip(UP).className).not.toContain("bg-emerald-500");
  });

  test("a chip is a button named by its emoji, count and whether I reacted", async () => {
    seed([
      { emoji: HEART, count: 3, reacted: true },
      { emoji: UP, count: 1, reacted: false },
    ]);
    renderChips();
    await expect.element(page.getByRole("button", { name: `${HEART} 3 reactions, you reacted` })).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: `${UP} 1 reaction`, exact: true })).toBeInTheDocument();
  });

  test("chips are as dense as Telegram's: 22px high", async () => {
    seed([{ emoji: UP, count: 12, reacted: false }]);
    renderChips();
    await expect.element(page.getByRole("button", { name: /12 reactions/ })).toBeInTheDocument();
    // (Tailwind is not applied in these tests; the size is a class.)
    expect(chip(UP).className).toContain("h-[22px]");
  });

  test("the emoji is drawn as the Apple-style picture the app uses elsewhere", async () => {
    seed([{ emoji: HEART, count: 1, reacted: false }]);
    renderChips();
    await expect.element(page.getByRole("button", { name: /1 reaction/ })).toBeInTheDocument();
    const image = chip(HEART).querySelector("img");
    expect(image.getAttribute("src")).toBe("/emoji/apple/64/2764-fe0f.png");
    expect(image.getAttribute("alt")).toBe(HEART);
  });
});

describe("ReactionChips - taps", () => {
  test("tapping a chip puts my reaction on at once and asks the server", async () => {
    seed([{ emoji: UP, count: 2, reacted: false }]);
    renderChips();
    await expect.element(page.getByRole("button", { name: /2 reactions/ })).toBeInTheDocument();
    api.reactToMessage.mockResolvedValueOnce(
      reply(200, { messageId: MSG, reactions: [{ emoji: UP, count: 3, reacted: true }] }),
    );
    await userEvent.click(chip(UP));
    expect(chip(UP).getAttribute("aria-pressed")).toBe("true");
    expect(chip(UP).textContent.trim()).toBe("3");
    expect(api.reactToMessage).toHaveBeenCalledWith({ chatId: CHAT, messageId: MSG, emoji: UP });
  });

  test("tapping my own chip takes it off, and the chip goes at zero", async () => {
    seed([{ emoji: UP, count: 1, reacted: true }]);
    renderChips();
    await expect.element(page.getByRole("button", { name: /you reacted/ })).toBeInTheDocument();
    await userEvent.click(chip(UP));
    expect(chips()).toHaveLength(0);
    expect(api.reactToMessage).toHaveBeenCalledWith({ chatId: CHAT, messageId: MSG, emoji: UP });
  });

  test("a refused tap goes back", async () => {
    seed([{ emoji: UP, count: 1, reacted: false }]);
    renderChips();
    await expect.element(page.getByRole("button", { name: /1 reaction/ })).toBeInTheDocument();
    api.reactToMessage.mockResolvedValueOnce(reply(429, { error: "Slow down" }));
    await userEvent.click(chip(UP));
    await vi.waitFor(() => expect(chip(UP).getAttribute("aria-pressed")).toBe("false"));
    expect(chip(UP).textContent.trim()).toBe("1");
  });

  test("a chip can be reached and used with the keyboard", async () => {
    seed([{ emoji: UP, count: 1, reacted: false }]);
    renderChips();
    await expect.element(page.getByRole("button", { name: /1 reaction/ })).toBeInTheDocument();
    api.reactToMessage.mockResolvedValueOnce(
      reply(200, { messageId: MSG, reactions: [{ emoji: UP, count: 2, reacted: true }] }),
    );
    chip(UP).focus();
    await userEvent.keyboard("{Enter}");
    expect(api.reactToMessage).toHaveBeenCalledTimes(1);
    expect(chip(UP).getAttribute("aria-pressed")).toBe("true");
  });
});

describe("ReactionChips - realtime", () => {
  test("another person's reaction appears and counts up, without touching my flag", async () => {
    seed([{ emoji: UP, count: 1, reacted: true }]);
    renderChips();
    await expect.element(page.getByRole("button", { name: /you reacted/ })).toBeInTheDocument();
    applyRealtimeReaction(
      {
        messageId: MSG,
        counts: [{ emoji: UP, count: 2 }, { emoji: FIRE, count: 1 }],
        actorId: BOB,
        actorEmoji: FIRE,
        removedEmojis: [],
      },
      ME,
    );
    await flush();
    expect(chips().map((el) => el.dataset.reactionChip)).toEqual([UP, FIRE]);
    expect(chip(UP).textContent.trim()).toBe("2");
    expect(chip(UP).getAttribute("aria-pressed")).toBe("true");
    expect(chip(FIRE).getAttribute("aria-pressed")).toBe("false");
  });

  test("my reaction from another device flags the chip", async () => {
    seed([{ emoji: UP, count: 1, reacted: false }]);
    renderChips();
    await expect.element(page.getByRole("button", { name: /1 reaction/ })).toBeInTheDocument();
    applyRealtimeReaction(
      { messageId: MSG, counts: [{ emoji: UP, count: 2 }], actorId: ME, actorEmoji: UP, removedEmojis: [] },
      ME,
    );
    await flush();
    expect(chip(UP).getAttribute("aria-pressed")).toBe("true");
  });

  test("chips of other messages are not redrawn", async () => {
    seed([{ emoji: UP, count: 1, reacted: false }]);
    renderChips();
    await expect.element(page.getByRole("button", { name: /1 reaction/ })).toBeInTheDocument();
    applyRealtimeReaction(
      { messageId: OTHER_MSG, counts: [{ emoji: FIRE, count: 5 }], actorId: BOB, actorEmoji: FIRE, removedEmojis: [] },
      ME,
    );
    await flush();
    expect(chips().map((el) => el.dataset.reactionChip)).toEqual([UP]);
  });
});

describe("ReactionChips - pop animation", () => {
  test("chips that were there when the message was drawn do not pop", async () => {
    seed([{ emoji: UP, count: 1, reacted: false }]);
    renderChips();
    await expect.element(page.getByRole("button", { name: /1 reaction/ })).toBeInTheDocument();
    expect(document.querySelectorAll(".sb-reaction-pop")).toHaveLength(0);
  });

  test("a new chip, and a count that went up, pop; a count that went down does not", async () => {
    seed([{ emoji: UP, count: 2, reacted: false }]);
    renderChips();
    await expect.element(page.getByRole("button", { name: /2 reactions/ })).toBeInTheDocument();
    applyRealtimeReaction(
      { messageId: MSG, counts: [{ emoji: UP, count: 3 }, { emoji: FIRE, count: 1 }], actorId: BOB, actorEmoji: FIRE, removedEmojis: [] },
      ME,
    );
    await flush();
    expect(chip(UP).querySelector(".sb-reaction-pop")).not.toBeNull();
    expect(chip(FIRE).querySelector(".sb-reaction-pop")).not.toBeNull();
    const before = chip(UP).querySelector("span");
    applyRealtimeReaction(
      { messageId: MSG, counts: [{ emoji: UP, count: 2 }, { emoji: FIRE, count: 1 }], actorId: BOB, actorEmoji: null, removedEmojis: [UP] },
      ME,
    );
    await flush();
    // the same element: nothing was replayed
    expect(chip(UP).querySelector("span")).toBe(before);
    expect(chip(UP).textContent.trim()).toBe("2");
  });
});

describe("ReactionChips - who reacted", () => {
  const listAnswer = {
    messageId: MSG,
    reactions: [
      { emoji: HEART, count: 1, users: [{ id: ME, username: "alice", nickname: "Alice", avatarUrl: null, color: "#10b981" }] },
    ],
    truncated: false,
  };

  test("a right click on a chip opens the list instead of the message menu", async () => {
    api.listMessageReactors.mockResolvedValue(reply(200, listAnswer));
    seed([{ emoji: HEART, count: 1, reacted: false }]);
    const onRowMenu = vi.fn();
    render(
      <div onContextMenu={onRowMenu}>
        <ReactionChips chatId={CHAT} messageId={MSG} canListReactors />
      </div>,
    );
    await expect.element(page.getByRole("button", { name: /1 reaction/ })).toBeInTheDocument();
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    chip(HEART).dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(onRowMenu).not.toHaveBeenCalled();
    await expect.element(page.getByRole("dialog", { name: "Who reacted" })).toBeInTheDocument();
    await expect.element(page.getByText("Alice")).toBeInTheDocument();
    expect(api.listMessageReactors).toHaveBeenCalledWith(expect.objectContaining({ chatId: CHAT, messageId: MSG }));
  });

  test("without the right to see who reacted a right click is left to the message menu", async () => {
    seed([{ emoji: HEART, count: 1, reacted: false }]);
    const onRowMenu = vi.fn();
    render(
      <div onContextMenu={onRowMenu}>
        <ReactionChips chatId={CHAT} messageId={MSG} canListReactors={false} />
      </div>,
    );
    await expect.element(page.getByRole("button", { name: /1 reaction/ })).toBeInTheDocument();
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    chip(HEART).dispatchEvent(event);
    expect(onRowMenu).toHaveBeenCalledTimes(1);
    expect(document.querySelector("[data-reactors-popover]")).toBeNull();
    expect(api.listMessageReactors).not.toHaveBeenCalled();
  });

  test("the menu key on a focused chip opens the list too", async () => {
    api.listMessageReactors.mockResolvedValue(reply(200, listAnswer));
    seed([{ emoji: HEART, count: 1, reacted: false }]);
    renderChips({ canListReactors: true });
    await expect.element(page.getByRole("button", { name: /1 reaction/ })).toBeInTheDocument();
    chip(HEART).focus();
    await userEvent.keyboard("{Shift>}{F10}{/Shift}");
    await expect.element(page.getByRole("dialog", { name: "Who reacted" })).toBeInTheDocument();
  });

  const pointer = (type, init) =>
    new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "touch", pointerId: 7, isPrimary: true, ...init });

  test("a finger held on a chip opens the list, and lifting it does not toggle", async () => {
    api.listMessageReactors.mockResolvedValue(reply(200, listAnswer));
    seed([{ emoji: HEART, count: 1, reacted: false }]);
    renderChips({ canListReactors: true });
    await expect.element(page.getByRole("button", { name: /1 reaction/ })).toBeInTheDocument();
    chip(HEART).dispatchEvent(pointer("pointerdown", { clientX: 10, clientY: 10 }));
    await expect.element(page.getByRole("dialog", { name: "Who reacted" })).toBeInTheDocument();
    // the finger lifts: pointerup and the click that follows a long press
    chip(HEART).dispatchEvent(pointer("pointerup", { clientX: 10, clientY: 10 }));
    chip(HEART).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(api.reactToMessage).not.toHaveBeenCalled();
  });

  test("the click that ends the hold lands on the backdrop and does not close the list; a later tap does", async () => {
    api.listMessageReactors.mockResolvedValue(reply(200, listAnswer));
    seed([{ emoji: HEART, count: 1, reacted: false }]);
    renderChips({ canListReactors: true });
    await expect.element(page.getByRole("button", { name: /1 reaction/ })).toBeInTheDocument();
    chip(HEART).dispatchEvent(pointer("pointerdown", { clientX: 10, clientY: 10 }));
    await expect.element(page.getByRole("dialog", { name: "Who reacted" })).toBeInTheDocument();
    const backdrop = document.querySelector("[data-reactors-popover]").parentElement.querySelector("button");
    // the finger lifts over the sheet; the browser clicks what is under it
    backdrop.dispatchEvent(pointer("pointerup", { clientX: 10, clientY: 10 }));
    backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await flush();
    expect(document.querySelector("[data-reactors-popover]")).not.toBeNull();
    // the next tap outside is a real one
    backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await flush();
    expect(document.querySelector("[data-reactors-popover]")).toBeNull();
  });

  test("the context menu event a long press sends once the list is up does not close it", async () => {
    api.listMessageReactors.mockResolvedValue(reply(200, listAnswer));
    seed([{ emoji: HEART, count: 1, reacted: false }]);
    renderChips({ canListReactors: true });
    await expect.element(page.getByRole("button", { name: /1 reaction/ })).toBeInTheDocument();
    chip(HEART).dispatchEvent(pointer("pointerdown", { clientX: 10, clientY: 10 }));
    await expect.element(page.getByRole("dialog", { name: "Who reacted" })).toBeInTheDocument();
    const overlay = document.querySelector("[data-reactors-popover]").parentElement;
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    overlay.dispatchEvent(event);
    await flush();
    expect(event.defaultPrevented).toBe(true);
    expect(document.querySelector("[data-reactors-popover]")).not.toBeNull();
  });

  test("a short tap or a finger that moves is not a long press", async () => {
    seed([{ emoji: HEART, count: 1, reacted: false }]);
    renderChips({ canListReactors: true });
    await expect.element(page.getByRole("button", { name: /1 reaction/ })).toBeInTheDocument();
    chip(HEART).dispatchEvent(pointer("pointerdown", { clientX: 10, clientY: 10 }));
    chip(HEART).dispatchEvent(pointer("pointerup", { clientX: 10, clientY: 10 }));
    chip(HEART).dispatchEvent(pointer("pointerdown", { clientX: 10, clientY: 10 }));
    chip(HEART).dispatchEvent(pointer("pointermove", { clientX: 40, clientY: 10 }));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(document.querySelector("[data-reactors-popover]")).toBeNull();
  });

  test("the mouse never long-presses", async () => {
    seed([{ emoji: HEART, count: 1, reacted: false }]);
    renderChips({ canListReactors: true });
    await expect.element(page.getByRole("button", { name: /1 reaction/ })).toBeInTheDocument();
    chip(HEART).dispatchEvent(pointer("pointerdown", { pointerType: "mouse", clientX: 10, clientY: 10 }));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(document.querySelector("[data-reactors-popover]")).toBeNull();
  });

  test("the menu's 'Reacted by' item asks this message's chips for the list, and only this one's", async () => {
    api.listMessageReactors.mockResolvedValue(reply(200, listAnswer));
    seed([{ emoji: HEART, count: 1, reacted: false }]);
    seed([{ emoji: HEART, count: 1, reacted: false }], OTHER_MSG);
    render(
      <>
        <ReactionChips chatId={CHAT} messageId={MSG} canListReactors />
        <ReactionChips chatId={CHAT} messageId={OTHER_MSG} canListReactors />
      </>,
    );
    await expect.poll(() => chips()).toHaveLength(2);
    requestShowReactors(OTHER_MSG);
    await flush();
    await expect.element(page.getByRole("dialog", { name: "Who reacted" })).toBeInTheDocument();
    expect(document.querySelectorAll("[data-reactors-popover]")).toHaveLength(1);
    expect(api.listMessageReactors).toHaveBeenCalledTimes(1);
    expect(api.listMessageReactors).toHaveBeenCalledWith(expect.objectContaining({ messageId: OTHER_MSG }));
  });
});
