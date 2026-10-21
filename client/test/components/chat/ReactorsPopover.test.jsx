import { describe, test, expect, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";

const api = vi.hoisted(() => ({ reactToMessage: vi.fn(), listMessageReactors: vi.fn() }));
vi.mock("../../../src/api/reactionsApi.js", () => api);

import ReactorsPopover from "../../../src/components/chat/reactions/ReactorsPopover.jsx";
import {
  applyRealtimeReaction,
  resetReactionStore,
  seedReactions,
} from "../../../src/utils/reactionStore.js";

const ME = "11111111-1111-4111-a111-111111111111";
const BOB = "22222222-2222-4222-a222-222222222222";
const CHAT = "44444444-4444-4444-a444-444444444444";
const MSG = "33333333-3333-4333-a333-333333333331";

const UP = "\u{1F44D}";
const HEART = "❤️";

const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const person = (id, name, extra = {}) => ({
  id,
  username: name.toLowerCase(),
  nickname: name,
  avatarUrl: null,
  color: "#10b981",
  createdAt: "2024-01-01T00:00:00.000Z",
  ...extra,
});

const twoGroups = {
  messageId: MSG,
  reactions: [
    { emoji: HEART, count: 2, users: [person(ME, "Alice"), person(BOB, "Bob")] },
    { emoji: UP, count: 1, users: [person(ME, "Alice")] },
  ],
  truncated: false,
};

const names = () => [...document.querySelectorAll("[data-reactor-row]")].map((row) => row.textContent.replace(/^\S\s*/, "").trim());
const flush = () => new Promise((resolve) => setTimeout(resolve, 30));

const open = (props = {}) => {
  const onClose = props.onClose || vi.fn();
  render(<ReactorsPopover chatId={CHAT} messageId={MSG} onClose={onClose} {...props} />);
  return onClose;
};

beforeEach(() => {
  resetReactionStore();
  api.reactToMessage.mockReset();
  api.listMessageReactors.mockReset();
  seedReactions([
    {
      id: MSG,
      reactions: [
        { emoji: HEART, count: 2, reacted: true },
        { emoji: UP, count: 1, reacted: true },
      ],
    },
  ]);
});

describe("ReactorsPopover", () => {
  test("shows a loading state, then the people, with the emoji they used", async () => {
    let resolve;
    api.listMessageReactors.mockReturnValue(new Promise((r) => (resolve = r)));
    open();
    await expect.element(page.getByRole("dialog", { name: "Who reacted" })).toBeInTheDocument();
    await expect.poll(() => document.querySelector('[role="status"]')?.textContent).toMatch(/Loading/);
    resolve(reply(200, twoGroups));
    await expect.element(page.getByText("Bob")).toBeInTheDocument();
    expect(names()).toEqual(["Alice", "Bob"]);
    const alice = document.querySelectorAll("[data-reactor-row]")[0];
    expect([...alice.querySelectorAll("img")].map((img) => img.alt)).toEqual([HEART, UP]);
  });

  test("asks for everybody once", async () => {
    api.listMessageReactors.mockResolvedValue(reply(200, twoGroups));
    open();
    await expect.element(page.getByText("Bob")).toBeInTheDocument();
    expect(api.listMessageReactors).toHaveBeenCalledTimes(1);
    expect(api.listMessageReactors).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: CHAT, messageId: MSG }),
    );
  });

  test("a tab per emoji with its count, and All; picking one filters the list", async () => {
    api.listMessageReactors.mockResolvedValue(reply(200, twoGroups));
    open();
    await expect.element(page.getByText("Bob")).toBeInTheDocument();
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    expect(tabs.map((tab) => tab.textContent.trim())).toEqual(["All3", "2", "1"]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    await page.getByRole("tab", { name: `${UP} 1` }).click();
    expect(names()).toEqual(["Alice"]);
    await page.getByRole("tab", { name: `${HEART} 2` }).click();
    expect(names()).toEqual(["Alice", "Bob"]);
    await page.getByRole("tab", { name: /All/ }).click();
    expect(names()).toEqual(["Alice", "Bob"]);
  });

  test("opens on the tab of the chip that was pressed", async () => {
    api.listMessageReactors.mockResolvedValue(reply(200, twoGroups));
    open({ initialEmoji: UP });
    await expect.element(page.getByText("Alice")).toBeInTheDocument();
    expect(names()).toEqual(["Alice"]);
    expect(page.getByRole("tab", { name: `${UP} 1` }).element().getAttribute("aria-selected")).toBe("true");
  });

  test("with one emoji there is just its tab, no All", async () => {
    seedReactions([{ id: MSG, reactions: [] }]);
    api.listMessageReactors.mockResolvedValue(
      reply(200, { messageId: MSG, reactions: [twoGroups.reactions[1]], truncated: false }),
    );
    open();
    await expect.element(page.getByText("Alice")).toBeInTheDocument();
    expect(document.querySelectorAll('[role="tab"]')).toHaveLength(1);
  });

  test("says when only the first people are listed", async () => {
    api.listMessageReactors.mockResolvedValue(
      reply(200, { messageId: MSG, reactions: [{ emoji: HEART, count: 450, users: [person(ME, "Alice")] }], truncated: true }),
    );
    open();
    await expect.element(page.getByText("Showing the first 200 people.")).toBeInTheDocument();
    // the tab keeps the true total
    expect(document.querySelector('[role="tab"]').textContent.trim()).toBe("450");
  });

  test("a person with a Persian name is drawn with the Persian font", async () => {
    api.listMessageReactors.mockResolvedValue(
      reply(200, { messageId: MSG, reactions: [{ emoji: HEART, count: 1, users: [person(ME, "علی")] }], truncated: false }),
    );
    open();
    await expect.element(page.getByText("علی", { exact: true }).first()).toBeInTheDocument();
    expect(document.querySelector("[data-reactor-row] span[dir='auto']").className).toContain("font-fa");
  });

  test("a forbidden list says why and offers no retry", async () => {
    api.listMessageReactors.mockResolvedValue(reply(403, { error: "Only the channel owner can see who reacted." }));
    open();
    await expect.poll(() => document.querySelector('[role="alert"]')?.textContent).toMatch(/Only the channel owner can see who reacted\./);
    expect(page.getByRole("button", { name: "Try again" }).elements()).toHaveLength(0);
  });

  test("a failed request can be tried again", async () => {
    api.listMessageReactors
      .mockResolvedValueOnce(reply(500, { error: "Unable to load reactions." }))
      .mockResolvedValueOnce(reply(200, twoGroups));
    open();
    await expect.poll(() => document.querySelector('[role="alert"]')?.textContent).toMatch(/Unable to load reactions\./);
    await page.getByRole("button", { name: "Try again" }).click();
    await expect.element(page.getByText("Bob")).toBeInTheDocument();
    expect(api.listMessageReactors).toHaveBeenCalledTimes(2);
  });

  test("a lost connection shows an error with a retry", async () => {
    api.listMessageReactors.mockRejectedValue(new TypeError("Failed to fetch"));
    open();
    await expect.poll(() => document.querySelector('[role="alert"]')?.textContent).toMatch(/Check your connection/);
    await expect.element(page.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  test("the list is read again when the numbers under the message change", async () => {
    api.listMessageReactors.mockResolvedValueOnce(reply(200, twoGroups));
    open();
    await expect.element(page.getByText("Bob")).toBeInTheDocument();
    api.listMessageReactors.mockResolvedValueOnce(
      reply(200, {
        messageId: MSG,
        reactions: [{ emoji: HEART, count: 1, users: [person(ME, "Alice")] }],
        truncated: false,
      }),
    );
    applyRealtimeReaction(
      { messageId: MSG, counts: [{ emoji: HEART, count: 1 }], actorId: BOB, actorEmoji: null, removedEmojis: [HEART] },
      ME,
    );
    await vi.waitFor(() => expect(names()).toEqual(["Alice"]));
    expect(api.listMessageReactors).toHaveBeenCalledTimes(2);
  });

  test("closes itself when the last reaction is taken back", async () => {
    api.listMessageReactors.mockResolvedValue(reply(200, twoGroups));
    const onClose = open();
    await expect.element(page.getByText("Bob")).toBeInTheDocument();
    applyRealtimeReaction({ messageId: MSG, counts: [], actorId: ME, actorEmoji: null, removedEmojis: [HEART, UP] }, ME);
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  test("Escape closes it and nothing else", async () => {
    api.listMessageReactors.mockResolvedValue(reply(200, twoGroups));
    const pageListener = vi.fn();
    document.addEventListener("keydown", pageListener);
    try {
      const onClose = open();
      await expect.element(page.getByText("Bob")).toBeInTheDocument();
      await userEvent.keyboard("{Escape}");
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(pageListener).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", pageListener);
    }
  });

  test("a click outside, and the close button, close it", async () => {
    api.listMessageReactors.mockResolvedValue(reply(200, twoGroups));
    const onClose = open();
    await expect.element(page.getByText("Bob")).toBeInTheDocument();
    document.querySelector('button[aria-label="Close"][tabindex="-1"]').click();
    expect(onClose).toHaveBeenCalledTimes(1);
    await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  test("a message with no reactions at all lists nobody", async () => {
    seedReactions([{ id: MSG, reactions: [{ emoji: HEART, count: 1, reacted: false }] }]);
    api.listMessageReactors.mockResolvedValue(reply(200, { messageId: MSG, reactions: [], truncated: false }));
    open();
    await expect.element(page.getByText("No reactions yet.")).toBeInTheDocument();
    await flush();
  });

  test("on a phone-sized screen it is a sheet from the bottom", async () => {
    api.listMessageReactors.mockResolvedValue(reply(200, twoGroups));
    await page.viewport(390, 780);
    try {
      open();
      await expect.element(page.getByText("Bob")).toBeInTheDocument();
      const sheet = document.querySelector("[data-reactors-popover]");
      expect(sheet.className).toContain("bottom-0");
      expect(sheet.className).toContain("rounded-t-2xl");
    } finally {
      await page.viewport(1280, 720);
    }
  });
});
