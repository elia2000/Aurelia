/**
 * The real stylesheet on a rendered bubble: text can be selected with the mouse
 * (the page used to switch selection off for everything under #root), the time
 * and buttons cannot, and the bubble is as compact as Telegram's.
 */
import "../../../src/index.css";
import { describe, test, expect } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { MessageItem } from "../../../src/components/chat/messages/MessageItem.jsx";

const ME = { id: 1, username: "alice", nickname: "Alice", color: "#10b981" };

const makeMsg = (overrides = {}) => ({
  id: 7,
  user_id: 2,
  username: "bob",
  nickname: "Bob",
  color: "#3b82f6",
  avatar_url: null,
  body: "Hello world from Bob",
  created_at: "2024-01-01T12:00:00.000Z",
  read_at: null,
  edited: 0,
  files: [],
  replyTo: null,
  ...overrides,
});

const PROPS = {
  user: ME,
  formatTime: () => "12:00",
  unreadMarkerId: null,
  messageFilesProps: {},
  getMessageDayLabel: null,
  isDesktop: true,
  isMobileTouchDevice: false,
  isGroupChat: false,
  isChannelChat: false,
};

// The page keeps everything under #root unselectable, so the bubble is
// rendered inside one, like in the app.
const renderBubble = (msg, props = {}) =>
  render(
    <div id="root">
      <MessageItem {...PROPS} {...props} msg={msg} />
    </div>,
  );

const style = (el, pseudo) => getComputedStyle(el, pseudo);
const bubble = () => document.querySelector("[data-message-bubble]");

describe("message text can be selected with the mouse", () => {
  test("text in the bubble is selectable, the rest of the row is not", async () => {
    await renderBubble(makeMsg());
    await expect.element(page.getByText("Hello world from Bob")).toBeInTheDocument();
    expect(style(bubble().querySelector(".sb-markdown")).userSelect).toBe("text");
    expect(style(bubble()).userSelect).toBe("text");
    expect(style(document.querySelector("[data-message-row]")).userSelect).toBe("none");
  });

  test("the time and the status are not selectable", async () => {
    await renderBubble(makeMsg());
    await expect.element(page.getByText("12:00")).toBeInTheDocument();
    const meta = bubble().querySelector("[data-message-meta]");
    expect(style(meta).userSelect).toBe("none");
    expect(style(meta.firstElementChild || meta).userSelect).toBe("none");
  });

  test("buttons in the bubble are not selectable, a quoted message is", async () => {
    await renderBubble(
      makeMsg({
        replyTo: { id: 3, body: "the quoted words", displayName: "Alice", username: "alice", color: "#10b981" },
        forwarded_from_label: "Carol",
      }),
    );
    await expect.element(page.getByText("the quoted words")).toBeInTheDocument();
    const forwardButton = bubble().querySelector("button");
    expect(forwardButton).not.toBeNull();
    expect(style(forwardButton).userSelect).toBe("none");
    expect(style(bubble().querySelector('[role="button"][aria-label^="Reply to"]')).userSelect).toBe("text");
  });

  test("a drag that starts on a link selects text, and an emoji picture lets the press through", async () => {
    await renderBubble(makeMsg({ body: "See https://example.com now :)" }));
    await expect.element(page.getByText("See")).toBeInTheDocument();
    const link = bubble().querySelector(".sb-markdown a");
    expect(link).not.toBeNull();
    expect(style(link).webkitUserDrag).toBe("none");
    const emoji = document.createElement("img");
    emoji.className = "emoji";
    bubble().querySelector(".sb-markdown").appendChild(emoji);
    expect(style(emoji).pointerEvents).toBe("none");
  });
});

describe("the bubble is as compact as Telegram's", () => {
  test("15px text, 1.35 line height and a small padding", async () => {
    await renderBubble(makeMsg());
    await expect.element(page.getByText("Hello world from Bob")).toBeInTheDocument();
    const cs = style(bubble());
    expect(cs.fontSize).toBe("15px");
    expect(cs.paddingTop).toBe("6px");
    expect(cs.paddingLeft).toBe("10px");
    const body = style(bubble().querySelector(".sb-markdown"));
    expect(parseFloat(body.lineHeight)).toBeCloseTo(15 * 1.35, 1);
  });

  test("a short message is one tight line with the time at its end", async () => {
    await renderBubble(makeMsg({ body: "ok" }));
    await expect.element(page.getByText("12:00")).toBeInTheDocument();
    const box = bubble().getBoundingClientRect();
    expect(box.height).toBeLessThan(36);
    expect(box.width).toBeLessThan(110);
    const text = bubble().querySelector(".sb-markdown").getBoundingClientRect();
    const meta = bubble().querySelector("[data-message-meta]").getBoundingClientRect();
    // the time sits right of the text on the same line, not under it
    expect(meta.left).toBeGreaterThanOrEqual(text.left + 10);
    expect(meta.bottom).toBeLessThanOrEqual(box.bottom);
    expect(meta.top).toBeGreaterThan(box.top);
  });

  test("the room kept for the time is the very text it prints", async () => {
    await renderBubble(makeMsg({ body: "ok" }));
    await expect.element(page.getByText("12:00")).toBeInTheDocument();
    const after = style(bubble().querySelector(".sb-markdown"), "::after");
    expect(after.content).toBe('"12:00"');
    expect(after.visibility).toBe("hidden");
  });

  test("the sender's corner is small only on the last bubble of a run", async () => {
    await renderBubble(makeMsg(), { isRunEnd: true });
    await expect.element(page.getByText("12:00")).toBeInTheDocument();
    expect(style(bubble()).borderBottomLeftRadius).toBe("4px");
    expect(style(bubble()).borderTopLeftRadius).toBe("16px");
  });
});
