import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";

const api = vi.hoisted(() => ({ reactToMessage: vi.fn(), listMessageReactors: vi.fn() }));
vi.mock("../../../src/api/reactionsApi.js", () => api);

import { MessageItem } from "../../../src/components/chat/messages/MessageItem.jsx";
import {
  getReactionEntry,
  resetReactionStore,
  seedReactions,
} from "../../../src/utils/reactionStore.js";

const ME = { id: "11111111-1111-4111-a111-111111111111", username: "alice", nickname: "Alice", color: "#10b981" };
const BOB = { id: "22222222-2222-4222-a222-222222222222", username: "bob", nickname: "Bob", color: "#3b82f6" };
const CHAT = "44444444-4444-4444-a444-444444444444";
const MSG = "33333333-3333-4333-a333-333333333331";

const HEART = "❤️";

const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

const makeMsg = (overrides = {}) => ({
  id: MSG,
  user_id: BOB.id,
  username: BOB.username,
  nickname: BOB.nickname,
  color: BOB.color,
  avatar_url: null,
  body: "Hello world from Bob",
  created_at: "2024-01-01T12:00:00.000Z",
  read_at: null,
  edited: 0,
  files: [],
  replyTo: null,
  ...overrides,
});

const BASE_PROPS = {
  user: ME,
  chatId: CHAT,
  formatTime: () => "12:00",
  unreadMarkerId: null,
  messageFilesProps: {},
  getMessageDayLabel: null,
  isDesktop: true,
  isMobileTouchDevice: false,
  isGroupChat: false,
  isChannelChat: false,
  onJumpToMessage: vi.fn(),
};

const bubbleEl = () => document.querySelector("[data-message-bubble]");
const rowEl = () => document.querySelector("[data-message-row]");
const burst = () => document.querySelector("[data-heart-burst]");

const fire = (el, type, init = {}) => {
  const Ctor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
  const event = new Ctor(type, { bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(event);
  return event;
};

const touch = (type, el, init = {}) =>
  fire(el, type, { pointerType: "touch", pointerId: 5, isPrimary: true, clientX: 50, clientY: 50, ...init });
const tap = (down, up, init = {}) => {
  touch("pointerdown", down, init);
  touch("pointerup", up, init);
};

const selectText = (node, from, to) => {
  const range = document.createRange();
  range.setStart(node, from);
  range.setEnd(node, to);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  resetReactionStore();
  api.reactToMessage.mockReset();
  api.reactToMessage.mockResolvedValue(
    reply(200, { messageId: MSG, reactions: [{ emoji: HEART, count: 1, reacted: true }] }),
  );
});

afterEach(() => {
  window.getSelection().removeAllRanges();
});

describe("MessageItem - double click puts a heart on the message (mouse)", () => {
  test("a double click reacts with a heart instead of replying", async () => {
    const onReply = vi.fn();
    render(<MessageItem {...BASE_PROPS} onReply={onReply} msg={makeMsg()} />);
    await expect.element(page.getByText("Hello world from Bob")).toBeInTheDocument();
    fire(bubbleEl(), "dblclick");
    await vi.waitFor(() =>
      expect(api.reactToMessage).toHaveBeenCalledWith({ chatId: CHAT, messageId: MSG, emoji: HEART }),
    );
    expect(onReply).not.toHaveBeenCalled();
    expect(getReactionEntry(MSG).mine).toEqual([HEART]);
  });

  test("a heart rises over the bubble, once, when it is put on", async () => {
    render(<MessageItem {...BASE_PROPS} onReply={vi.fn()} msg={makeMsg()} />);
    await expect.element(page.getByText("Hello world from Bob")).toBeInTheDocument();
    expect(burst()).toBeNull();
    fire(bubbleEl(), "dblclick");
    await vi.waitFor(() => expect(burst()).not.toBeNull());
    expect(burst().getAttribute("aria-hidden")).toBe("true");
    expect(burst().querySelector("img").alt).toBe(HEART);
    await vi.waitFor(() => expect(burst()).toBeNull(), { timeout: 2000 });
  });

  test("a second double click takes my heart off, with no heart rising", async () => {
    render(<MessageItem {...BASE_PROPS} onReply={vi.fn()} msg={makeMsg()} />);
    await expect.element(page.getByText("Hello world from Bob")).toBeInTheDocument();
    fire(bubbleEl(), "dblclick");
    await vi.waitFor(() => expect(burst()).not.toBeNull());
    await vi.waitFor(() => expect(burst()).toBeNull(), { timeout: 2000 });
    api.reactToMessage.mockResolvedValueOnce(reply(200, { messageId: MSG, reactions: [] }));
    fire(bubbleEl(), "dblclick");
    await vi.waitFor(() => expect(api.reactToMessage).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(getReactionEntry(MSG)?.mine || []).toEqual([]));
    expect(burst()).toBeNull();
  });

  test("the word the double click selected is let go: the reaction is what was meant", async () => {
    render(<MessageItem {...BASE_PROPS} onReply={vi.fn()} msg={makeMsg()} />);
    await expect.element(page.getByText("Hello world from Bob")).toBeInTheDocument();
    selectText(bubbleEl().querySelector(".sb-markdown").firstChild, 0, 5);
    fire(bubbleEl(), "dblclick");
    await vi.waitFor(() => expect(api.reactToMessage).toHaveBeenCalledTimes(1));
    expect(String(window.getSelection())).toBe("");
  });

  test("a double click on a link is not a reaction", async () => {
    render(
      <MessageItem {...BASE_PROPS} onReply={vi.fn()} msg={makeMsg({ body: "see https://example.com now" })} />,
    );
    await expect.element(page.getByRole("link")).toBeInTheDocument();
    fire(document.querySelector("a[href]"), "dblclick");
    await wait(30);
    expect(api.reactToMessage).not.toHaveBeenCalled();
  });

  test("a message that cannot take a reaction keeps the old behaviour: it replies", async () => {
    const onReply = vi.fn();
    render(<MessageItem {...BASE_PROPS} onReply={onReply} msg={makeMsg({ id: "7" })} />);
    await expect.element(page.getByText("Hello world from Bob")).toBeInTheDocument();
    fire(bubbleEl(), "dblclick");
    expect(api.reactToMessage).not.toHaveBeenCalled();
    expect(onReply).toHaveBeenCalledTimes(1);
  });

  test("a message still being sent, and a call entry, take no reaction", async () => {
    const onReply = vi.fn();
    const { rerender } = await render(
      <MessageItem {...BASE_PROPS} onReply={onReply} msg={makeMsg({ _delivery: "sending" })} />,
    );
    await expect.element(page.getByText("Hello world from Bob")).toBeInTheDocument();
    fire(bubbleEl(), "dblclick");
    rerender(<MessageItem {...BASE_PROPS} onReply={onReply} msg={makeMsg({ call: { callId: "c1", outcome: "missed" } })} />);
    fire(bubbleEl(), "dblclick");
    expect(api.reactToMessage).not.toHaveBeenCalled();
  });

  test("without a connection nothing is sent (it replies, as before)", async () => {
    const onReply = vi.fn();
    render(<MessageItem {...BASE_PROPS} isOffline onReply={onReply} msg={makeMsg()} />);
    await expect.element(page.getByText("Hello world from Bob")).toBeInTheDocument();
    fire(bubbleEl(), "dblclick");
    expect(api.reactToMessage).not.toHaveBeenCalled();
    expect(onReply).toHaveBeenCalledTimes(1);
  });

  test("a message that already has reactions keeps its flag when it is hearted", async () => {
    seedReactions([{ id: MSG, reactions: [{ emoji: "\u{1F44D}", count: 2, reacted: true }] }]);
    api.reactToMessage.mockResolvedValue(
      reply(200, { messageId: MSG, reactions: [{ emoji: HEART, count: 1, reacted: true }, { emoji: "\u{1F44D}", count: 1, reacted: false }] }),
    );
    render(<MessageItem {...BASE_PROPS} onReply={vi.fn()} msg={makeMsg()} />);
    await expect.element(page.getByText("Hello world from Bob")).toBeInTheDocument();
    fire(bubbleEl(), "dblclick");
    // with the usual limit of one, the heart replaces my thumbs up at once
    expect(getReactionEntry(MSG).mine).toEqual([HEART]);
    expect(getReactionEntry(MSG).items).toEqual([
      { emoji: "\u{1F44D}", count: 1 },
      { emoji: HEART, count: 1 },
    ]);
  });
});

describe("MessageItem - double tap puts a heart on the message (finger)", () => {
  // (The swipe-to-reply capture of a real finger is checked in a real browser;
  // a synthetic pointer id cannot be captured.)
  const phone = {};

  test("two quick taps on the bubble react with a heart", async () => {
    render(<MessageItem {...BASE_PROPS} {...phone} onReply={vi.fn()} msg={makeMsg()} />);
    await expect.element(page.getByText("Hello world from Bob")).toBeInTheDocument();
    const text = bubbleEl().querySelector(".sb-markdown");
    tap(text, rowEl());
    await wait(30);
    expect(api.reactToMessage).not.toHaveBeenCalled();
    tap(text, rowEl());
    await vi.waitFor(() =>
      expect(api.reactToMessage).toHaveBeenCalledWith({ chatId: CHAT, messageId: MSG, emoji: HEART }),
    );
    await expect.element(page.getByText("Hello world from Bob")).toBeInTheDocument();
    expect(burst()).not.toBeNull();
  });

  test("a third tap starts over: it is not another double tap", async () => {
    render(<MessageItem {...BASE_PROPS} {...phone} onReply={vi.fn()} msg={makeMsg()} />);
    await expect.element(page.getByText("Hello world from Bob")).toBeInTheDocument();
    const text = bubbleEl().querySelector(".sb-markdown");
    tap(text, rowEl());
    tap(text, rowEl());
    tap(text, rowEl());
    await wait(60);
    expect(api.reactToMessage).toHaveBeenCalledTimes(1);
  });

  test("two taps too far apart in time are two single taps", async () => {
    render(<MessageItem {...BASE_PROPS} {...phone} onReply={vi.fn()} msg={makeMsg()} />);
    await expect.element(page.getByText("Hello world from Bob")).toBeInTheDocument();
    const text = bubbleEl().querySelector(".sb-markdown");
    tap(text, rowEl());
    await wait(450);
    tap(text, rowEl());
    expect(api.reactToMessage).not.toHaveBeenCalled();
  });

  test("two taps far apart on the screen are not a double tap", async () => {
    render(<MessageItem {...BASE_PROPS} {...phone} onReply={vi.fn()} msg={makeMsg()} />);
    await expect.element(page.getByText("Hello world from Bob")).toBeInTheDocument();
    const text = bubbleEl().querySelector(".sb-markdown");
    tap(text, rowEl(), { clientX: 20, clientY: 20 });
    tap(text, rowEl(), { clientX: 120, clientY: 20 });
    expect(api.reactToMessage).not.toHaveBeenCalled();
  });

  test("a finger that moved (a scroll or a swipe) is not a tap", async () => {
    render(<MessageItem {...BASE_PROPS} {...phone} onReply={vi.fn()} msg={makeMsg()} />);
    await expect.element(page.getByText("Hello world from Bob")).toBeInTheDocument();
    const text = bubbleEl().querySelector(".sb-markdown");
    for (let i = 0; i < 2; i += 1) {
      touch("pointerdown", text, { clientX: 50, clientY: 50 });
      touch("pointerup", rowEl(), { clientX: 50, clientY: 90 });
    }
    expect(api.reactToMessage).not.toHaveBeenCalled();
  });

  test("a cancelled touch (the browser took it for a scroll) forgets the first tap", async () => {
    render(<MessageItem {...BASE_PROPS} {...phone} onReply={vi.fn()} msg={makeMsg()} />);
    await expect.element(page.getByText("Hello world from Bob")).toBeInTheDocument();
    const text = bubbleEl().querySelector(".sb-markdown");
    tap(text, rowEl());
    touch("pointerdown", text);
    touch("pointercancel", rowEl());
    tap(text, rowEl());
    expect(api.reactToMessage).not.toHaveBeenCalled();
  });

  test("taps beside the bubble, or on a link, do not count", async () => {
    render(
      <MessageItem {...BASE_PROPS} {...phone} onReply={vi.fn()} msg={makeMsg({ body: "open https://example.com" })} />,
    );
    await expect.element(page.getByRole("link")).toBeInTheDocument();
    tap(rowEl(), rowEl());
    tap(rowEl(), rowEl());
    const link = document.querySelector("a[href]");
    tap(link, rowEl());
    tap(link, rowEl());
    expect(api.reactToMessage).not.toHaveBeenCalled();
  });

  test("the mouse is not a finger", async () => {
    render(<MessageItem {...BASE_PROPS} {...phone} onReply={vi.fn()} msg={makeMsg()} />);
    await expect.element(page.getByText("Hello world from Bob")).toBeInTheDocument();
    const text = bubbleEl().querySelector(".sb-markdown");
    tap(text, rowEl(), { pointerType: "mouse" });
    tap(text, rowEl(), { pointerType: "mouse" });
    expect(api.reactToMessage).not.toHaveBeenCalled();
  });

  test("the double click some touch screens add after a double tap does not undo it", async () => {
    render(<MessageItem {...BASE_PROPS} onReply={vi.fn()} msg={makeMsg()} />);
    await expect.element(page.getByText("Hello world from Bob")).toBeInTheDocument();
    const text = bubbleEl().querySelector(".sb-markdown");
    tap(text, rowEl());
    tap(text, rowEl());
    fire(bubbleEl(), "dblclick");
    await wait(60);
    expect(api.reactToMessage).toHaveBeenCalledTimes(1);
  });

  test("a message that cannot take a reaction ignores double taps", async () => {
    render(<MessageItem {...BASE_PROPS} {...phone} onReply={vi.fn()} msg={makeMsg({ id: "7" })} />);
    await expect.element(page.getByText("Hello world from Bob")).toBeInTheDocument();
    const text = bubbleEl().querySelector(".sb-markdown");
    tap(text, rowEl());
    tap(text, rowEl());
    expect(api.reactToMessage).not.toHaveBeenCalled();
  });
});

describe("MessageItem - reactions slot", () => {
  test("the chips are drawn under the bubble", async () => {
    render(
      <MessageItem
        {...BASE_PROPS}
        msg={makeMsg()}
        reactionsSlot={<div data-testid="chips">chips here</div>}
      />,
    );
    await expect.element(page.getByTestId("chips")).toBeInTheDocument();
    const slot = document.querySelector('[data-slot="reactions"]');
    expect(slot.contains(document.querySelector('[data-testid="chips"]'))).toBe(true);
    expect(bubbleEl().contains(slot)).toBe(false);
    expect(bubbleEl().compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
