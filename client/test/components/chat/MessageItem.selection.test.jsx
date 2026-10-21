import { describe, test, expect, vi } from "vitest";
import { render } from "vitest-browser-react";
import { MessageItem } from "../../../src/components/chat/messages/MessageItem.jsx";

const ME = { id: "11111111-1111-4111-a111-111111111111", username: "alice", nickname: "Alice", color: "#10b981" };
const BOB = { id: "22222222-2222-4222-a222-222222222222", username: "bob", nickname: "Bob", color: "#3b82f6" };
const CHAT = "44444444-4444-4444-a444-444444444444";
const MSG = "33333333-3333-4333-a333-333333333331";

const makeMsg = (overrides = {}) => ({
  id: MSG,
  user_id: BOB.id,
  username: BOB.username,
  nickname: BOB.nickname,
  color: BOB.color,
  avatar_url: null,
  body: "Hello from Bob",
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

const rowEl = () => document.querySelector("[data-message-row]");
const bubbleEl = () => document.querySelector("[data-message-bubble]");

const fire = (el, type, init = {}) => {
  const Ctor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
  const event = new Ctor(type, { bubbles: true, cancelable: true, button: 0, ...init });
  el.dispatchEvent(event);
  return event;
};

const renderSelecting = (props = {}) =>
  render(<MessageItem {...BASE_PROPS} msg={makeMsg()} selectionMode onToggleSelect={vi.fn()} {...props} />);

describe("MessageItem - selection mode", () => {
  test("outside selection mode the row is not a checkbox and a click does nothing", async () => {
    const onToggleSelect = vi.fn();
    await render(<MessageItem {...BASE_PROPS} msg={makeMsg()} onToggleSelect={onToggleSelect} />);
    expect(rowEl().getAttribute("role")).toBeNull();
    rowEl().click();
    expect(onToggleSelect).not.toHaveBeenCalled();
  });

  test("in selection mode the row is a checkbox that says whether it is ticked", async () => {
    await renderSelecting({ isSelected: false });
    expect(rowEl().getAttribute("role")).toBe("checkbox");
    expect(rowEl().getAttribute("aria-checked")).toBe("false");
    expect(rowEl().getAttribute("aria-label")).toBe("Bob, 12:00, Hello from Bob");
  });

  test("a ticked row says so and is highlighted", async () => {
    await renderSelecting({ isSelected: true });
    expect(rowEl().getAttribute("aria-checked")).toBe("true");
    expect(rowEl().getAttribute("data-selected")).toBe("true");
    expect(rowEl().className).toContain("bg-emerald-500/15");
  });

  test("my own message is labelled 'You'", async () => {
    await renderSelecting({ msg: makeMsg({ username: ME.username, nickname: ME.nickname }) });
    expect(rowEl().getAttribute("aria-label")).toBe("You, 12:00, Hello from Bob");
  });

  test("a click anywhere on the row ticks it, with the modifier keys", async () => {
    const onToggleSelect = vi.fn();
    const msg = makeMsg();
    await renderSelecting({ msg, onToggleSelect });
    rowEl().click();
    expect(onToggleSelect).toHaveBeenLastCalledWith(msg, { shiftKey: false, ctrlKey: false });
    fire(rowEl(), "click", { shiftKey: true });
    expect(onToggleSelect).toHaveBeenLastCalledWith(msg, { shiftKey: true, ctrlKey: false });
    fire(rowEl(), "click", { ctrlKey: true });
    expect(onToggleSelect).toHaveBeenLastCalledWith(msg, { shiftKey: false, ctrlKey: true });
    fire(rowEl(), "click", { metaKey: true });
    expect(onToggleSelect).toHaveBeenLastCalledWith(msg, { shiftKey: false, ctrlKey: true });
    // a click on the bubble itself counts as a click on the row
    bubbleEl().click();
    expect(onToggleSelect).toHaveBeenCalledTimes(5);
  });

  test("a link inside the message is not followed: the click only ticks the row", async () => {
    const onToggleSelect = vi.fn();
    await renderSelecting({ msg: makeMsg({ body: "see https://example.com/page now" }), onToggleSelect });
    const link = document.querySelector("a[href]");
    expect(link).toBeTruthy();
    const event = fire(link, "click");
    expect(event.defaultPrevented).toBe(true);
    expect(onToggleSelect).toHaveBeenCalledTimes(1);
  });

  test("the sender's name and avatar do not open a profile in selection mode", async () => {
    const onOpenSenderProfile = vi.fn();
    const onToggleSelect = vi.fn();
    await renderSelecting({
      isGroupChat: true,
      onOpenSenderProfile,
      onToggleSelect,
    });
    const avatar = document.querySelector("[data-message-avatar]");
    expect(avatar).toBeTruthy();
    avatar.click();
    expect(onOpenSenderProfile).not.toHaveBeenCalled();
    expect(onToggleSelect).toHaveBeenCalledTimes(1);
  });

  test("a mouse drag that selects text is not a click on the row", async () => {
    const onToggleSelect = vi.fn();
    await renderSelecting({ onToggleSelect });
    const text = document.querySelector(".sb-markdown");
    const rect = text.getBoundingClientRect();
    fire(text, "mousedown", { clientX: rect.left + 2, clientY: rect.top + 4 });
    const range = document.createRange();
    range.selectNodeContents(text);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    fire(text, "click", { clientX: rect.left + 60, clientY: rect.top + 4 });
    expect(onToggleSelect).not.toHaveBeenCalled();
    window.getSelection().removeAllRanges();
    // the next plain click ticks it
    fire(text, "mousedown", { clientX: rect.left + 5, clientY: rect.top + 4 });
    fire(text, "click", { clientX: rect.left + 5, clientY: rect.top + 4 });
    expect(onToggleSelect).toHaveBeenCalledTimes(1);
  });

  test("a shift or double press does not start a text range under the tick", async () => {
    await renderSelecting();
    expect(fire(rowEl(), "mousedown", { shiftKey: true }).defaultPrevented).toBe(true);
    expect(fire(rowEl(), "mousedown", { detail: 2 }).defaultPrevented).toBe(true);
    expect(fire(rowEl(), "mousedown", {}).defaultPrevented).toBe(false);
  });

  test("Space and Enter on the focused row tick it", async () => {
    const onToggleSelect = vi.fn();
    await renderSelecting({ onToggleSelect, isSelectionTabStop: true });
    expect(rowEl().tabIndex).toBe(0);
    rowEl().focus();
    for (const key of [" ", "Enter"]) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      rowEl().dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
    expect(onToggleSelect).toHaveBeenCalledTimes(2);
  });

  test("only the tab stop row is in the tab order", async () => {
    await renderSelecting({ isSelectionTabStop: false });
    expect(rowEl().tabIndex).toBe(-1);
  });

  test("a message that is still being sent cannot be ticked", async () => {
    const onToggleSelect = vi.fn();
    await renderSelecting({
      msg: makeMsg({ id: "temp-1", _clientId: "temp-1", _delivery: "sending", username: ME.username }),
      onToggleSelect,
    });
    expect(rowEl().getAttribute("aria-disabled")).toBe("true");
    expect(rowEl().getAttribute("aria-checked")).toBe("false");
    rowEl().click();
    expect(onToggleSelect).not.toHaveBeenCalled();
  });

  test("no message menu opens in selection mode, and the browser's does not either", async () => {
    const onOpenContextMenu = vi.fn();
    await renderSelecting({ onOpenContextMenu });
    const event = fire(rowEl(), "contextmenu", { button: 2 });
    expect(event.defaultPrevented).toBe(true);
    expect(onOpenContextMenu).not.toHaveBeenCalled();
  });

  test("the menu still opens when nothing is being selected", async () => {
    const onOpenContextMenu = vi.fn();
    await render(
      <MessageItem {...BASE_PROPS} msg={makeMsg()} onOpenContextMenu={onOpenContextMenu} />,
    );
    fire(rowEl(), "contextmenu", { button: 2, clientX: 5, clientY: 5 });
    expect(onOpenContextMenu).toHaveBeenCalledTimes(1);
  });

  test("a double click does not reply in selection mode", async () => {
    const onReply = vi.fn();
    await renderSelecting({ onReply });
    fire(bubbleEl(), "dblclick");
    expect(onReply).not.toHaveBeenCalled();
  });

  test("a phone's swipe to reply is off in selection mode", async () => {
    const phoneProps = { ...BASE_PROPS, isDesktop: false, isMobileTouchDevice: true, onReply: vi.fn() };
    const { rerender } = await render(<MessageItem {...phoneProps} msg={makeMsg()} />);
    // (the round reply arrow that slides in while swiping)
    expect(document.querySelector(".shadow-emerald-500\\/30")).toBeTruthy();
    await rerender(<MessageItem {...phoneProps} msg={makeMsg()} selectionMode />);
    expect(document.querySelector(".shadow-emerald-500\\/30")).toBeNull();
  });

  test("a service line is a checkbox row of its own", async () => {
    const onToggleSelect = vi.fn();
    const msg = makeMsg({
      body: "[[system:joined:Carol]]",
      _systemEvent: { type: "joined", text: "Carol joined the group", name: "Carol", suffix: "joined the group" },
    });
    await render(<MessageItem {...BASE_PROPS} msg={msg} selectionMode isSelected onToggleSelect={onToggleSelect} />);
    const line = document.querySelector("[data-message-key]");
    expect(line.getAttribute("role")).toBe("checkbox");
    expect(line.getAttribute("aria-checked")).toBe("true");
    expect(line.getAttribute("aria-label")).toContain("Carol joined the group");
    line.click();
    expect(onToggleSelect).toHaveBeenCalledWith(msg, { shiftKey: false, ctrlKey: false });
  });

  test("the leading slot is drawn inside the row, over its left edge", async () => {
    await render(
      <MessageItem
        {...BASE_PROPS}
        msg={makeMsg()}
        leadingSlot={<span data-testid="tick">tick</span>}
      />,
    );
    const gutter = rowEl().querySelector("[data-slot='leading']");
    expect(gutter.querySelector("[data-testid='tick']")).toBeTruthy();
    expect(gutter.className).toContain("absolute");
  });

  test("a row without a leading slot has no gutter", async () => {
    await render(<MessageItem {...BASE_PROPS} msg={makeMsg()} />);
    expect(rowEl().querySelector("[data-slot='leading']")).toBeNull();
  });

  test("the row makes room for the tick in selection mode only", async () => {
    const { rerender } = await render(<MessageItem {...BASE_PROPS} msg={makeMsg()} />);
    expect(rowEl().className).toContain("px-2");
    await rerender(<MessageItem {...BASE_PROPS} msg={makeMsg()} selectionMode />);
    expect(rowEl().className).toContain("ps-12");
  });

  test("ticking or leaving selection mode redraws the row (the row is memoised)", async () => {
    const msg = makeMsg();
    const { rerender } = await render(<MessageItem {...BASE_PROPS} msg={msg} selectionMode isSelected={false} onToggleSelect={vi.fn} />);
    expect(rowEl().getAttribute("aria-checked")).toBe("false");
    await rerender(<MessageItem {...BASE_PROPS} msg={msg} selectionMode isSelected onToggleSelect={vi.fn} />);
    expect(rowEl().getAttribute("aria-checked")).toBe("true");
    await rerender(<MessageItem {...BASE_PROPS} msg={msg} />);
    expect(rowEl().getAttribute("role")).toBeNull();
  });

  test("the reaction chips do nothing in selection mode (no list on a right click or a hold), and work again outside it", async () => {
    const slot = <button type="button" data-testid="chip">chip</button>;
    const { rerender } = await render(
      <MessageItem {...BASE_PROPS} msg={makeMsg()} reactionsSlot={slot} selectionMode onToggleSelect={vi.fn()} />,
    );
    expect(document.querySelector("[data-slot='reactions']").inert).toBe(true);
    await rerender(<MessageItem {...BASE_PROPS} msg={makeMsg()} reactionsSlot={slot} />);
    expect(document.querySelector("[data-slot='reactions']").inert).toBe(false);
  });
});
