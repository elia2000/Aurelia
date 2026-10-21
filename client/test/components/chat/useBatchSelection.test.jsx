import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "vitest-browser-react";
import { act } from "react";

const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock("../../../src/utils/toast.js", () => toast);
const clip = vi.hoisted(() => ({ copyTextToClipboard: vi.fn(async () => true) }));
vi.mock("../../../src/utils/clipboard.js", () => clip);

import SelectionCheckbox from "../../../src/components/chat/selection/SelectionCheckbox.jsx";
import { useBatchSelection } from "../../../src/hooks/chat/useBatchSelection.js";
import { createBatchSelectionStore } from "../../../src/utils/batchSelectionStore.js";

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const msg = (n, extra = {}) => ({
  id: uuid(n),
  username: "bob",
  nickname: "Bob",
  body: `text ${n}`,
  created_at: new Date(2026, 9, 20, 14, n).toISOString(),
  files: [],
  ...extra,
});
const CHAT = "chat-1";
const key = (n) => uuid(n);

let store;
let hookRef;

// React wants act() around changes that happen outside a render.
const inAct = (fn) => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    act(fn);
  } finally {
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  }
};

const mount = async (props = {}) => {
  const initialProps = {
    chatId: CHAT,
    messages: [msg(1), msg(2), msg(3), msg(4), msg(5)],
    store,
    ...props,
  };
  hookRef = await renderHook((p) => useBatchSelection(p), { initialProps });
  return hookRef;
};

const press = (keyName, init = {}, target = document.body) => {
  const event = new KeyboardEvent("keydown", { key: keyName, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
};

beforeEach(() => {
  store = createBatchSelectionStore();
  toast.showToast.mockReset();
  clip.copyTextToClipboard.mockReset();
  clip.copyTextToClipboard.mockResolvedValue(true);
});

afterEach(() => {
  inAct(() => store.exit());
});

describe("useBatchSelection - state", () => {
  test("starts idle", async () => {
    const { result } = await mount();
    expect(result.current.active).toBe(false);
    expect(result.current.count).toBe(0);
    expect(result.current.tabStopKey).toBeNull();
    expect(result.current.isSelected(key(1))).toBe(false);
  });

  test("starting selection in this chat makes it active with that message ticked", async () => {
    const { result } = await mount();
    inAct(() => store.enter(CHAT, key(2)));
    expect(result.current.active).toBe(true);
    expect(result.current.count).toBe(1);
    expect(result.current.isSelected(key(2))).toBe(true);
    expect(result.current.isSelected(key(3))).toBe(false);
    expect(result.current.tabStopKey).toBe(key(2));
  });

  test("toggle ticks and unticks; the count follows", async () => {
    const { result } = await mount();
    inAct(() => store.enter(CHAT, key(1)));
    inAct(() => result.current.toggle(msg(3)));
    expect(result.current.count).toBe(2);
    inAct(() => result.current.toggle(msg(1)));
    expect(result.current.count).toBe(1);
    expect(result.current.isSelected(key(3))).toBe(true);
  });

  test("shift range ticks every message between the last one and this one", async () => {
    const { result } = await mount();
    inAct(() => store.enter(CHAT, key(1)));
    inAct(() => result.current.toggle(msg(4), { shiftKey: true }));
    expect(result.current.count).toBe(4);
    [1, 2, 3, 4].forEach((n) => expect(result.current.isSelected(key(n))).toBe(true));
  });

  test("a range skips messages that cannot be selected (still being sent)", async () => {
    const pending = msg(3, { id: "temp-3", _clientId: "temp-3", _delivery: "sending" });
    const { result } = await mount({ messages: [msg(1), msg(2), pending, msg(4)] });
    inAct(() => store.enter(CHAT, key(1)));
    inAct(() => result.current.toggle(msg(4), { shiftKey: true }));
    expect(result.current.count).toBe(3);
    expect(result.current.isSelected("temp-3")).toBe(false);
  });

  test("ticking past 100 is refused with a hint", async () => {
    const many = Array.from({ length: 105 }, (_, i) => msg(i + 1));
    const { result } = await mount({ messages: many });
    inAct(() => store.enter(CHAT, key(1)));
    many.slice(1, 100).forEach((m) => inAct(() => result.current.toggle(m)));
    expect(result.current.count).toBe(100);
    expect(toast.showToast).not.toHaveBeenCalled();
    inAct(() => result.current.toggle(many[100]));
    expect(result.current.count).toBe(100);
    expect(toast.showToast).toHaveBeenCalledWith("You can select up to 100 messages at once.", { tone: "error" });
  });

  test("a shift range over 100 stops at 100 and says so", async () => {
    const many = Array.from({ length: 150 }, (_, i) => msg(i + 1));
    const { result } = await mount({ messages: many });
    inAct(() => store.enter(CHAT, key(1)));
    inAct(() => result.current.toggle(many[149], { shiftKey: true }));
    expect(result.current.count).toBe(100);
    expect(toast.showToast).toHaveBeenCalledWith("You can select up to 100 messages at once.", { tone: "error" });
  });

  test("a selection of another chat is not this chat's, and ends when this chat opens", async () => {
    inAct(() => store.enter("chat-2", "x1"));
    const { result } = await mount();
    expect(result.current.active).toBe(false);
    expect(store.getSnapshot().active).toBe(false);
  });

  test("opening another chat ends selection mode", async () => {
    const { result, rerender } = await mount();
    inAct(() => store.enter(CHAT, key(1)));
    expect(result.current.active).toBe(true);
    await rerender({ chatId: "chat-2", messages: [msg(9)], store });
    expect(result.current.active).toBe(false);
    expect(store.getSnapshot().active).toBe(false);
  });

  test("leaving the chat (none open) ends selection mode", async () => {
    const { rerender } = await mount();
    inAct(() => store.enter(CHAT, key(1)));
    await rerender({ chatId: null, messages: [], store });
    expect(store.getSnapshot().active).toBe(false);
  });

  test("selection survives new messages arriving and the list being rebuilt", async () => {
    const { result, rerender } = await mount();
    inAct(() => store.enter(CHAT, key(2)));
    // a new message, and every message is a new object (a refresh from the server)
    await rerender({ chatId: CHAT, messages: [1, 2, 3, 4, 5, 6].map((n) => msg(n, { body: "edited" })), store });
    expect(result.current.count).toBe(1);
    expect(result.current.isSelected(key(2))).toBe(true);
  });

  test("selection survives older messages being loaded in front of the list", async () => {
    const { result, rerender } = await mount();
    inAct(() => store.enter(CHAT, key(4)));
    await rerender({ chatId: CHAT, messages: [msg(-1 + 100), msg(101), msg(1), msg(2), msg(3), msg(4), msg(5)], store });
    expect(result.current.count).toBe(1);
    expect(result.current.isSelected(key(4))).toBe(true);
  });

  test("a message that is deleted leaves the selection; none left ends selection mode", async () => {
    const { result, rerender } = await mount();
    inAct(() => store.enter(CHAT, key(1)));
    inAct(() => result.current.toggle(msg(2)));
    await rerender({ chatId: CHAT, messages: [msg(2), msg(3)], store });
    expect(result.current.count).toBe(1);
    expect(result.current.isSelected(key(1))).toBe(false);
    await rerender({ chatId: CHAT, messages: [msg(3)], store });
    expect(result.current.active).toBe(false);
  });

  test("nothing is forgotten while the messages are loading", async () => {
    const { result, rerender } = await mount();
    inAct(() => store.enter(CHAT, key(1)));
    await rerender({ chatId: CHAT, messages: [], loadingMessages: true, store });
    expect(result.current.active).toBe(true);
  });

  test("exit ends selection mode", async () => {
    const { result } = await mount();
    inAct(() => store.enter(CHAT, key(1)));
    inAct(() => result.current.exit());
    expect(result.current.active).toBe(false);
  });
});

describe("useBatchSelection - the tick of each row", () => {
  test("idle with no mouse: no tick at all", async () => {
    const { result } = await mount({ hoverable: false });
    expect(result.current.getLeadingSlot(msg(1))).toBeNull();
  });

  test("idle with a mouse: a tick that starts selection with its message", async () => {
    const { result } = await mount({ hoverable: true });
    const slot = result.current.getLeadingSlot(msg(2));
    expect(slot.type).toBe(SelectionCheckbox);
    expect(slot.props).toMatchObject({ messageKey: key(2), active: false, selected: false });
    inAct(() => slot.props.onEnter(slot.props.messageKey));
    expect(result.current.active).toBe(true);
    expect(result.current.isSelected(key(2))).toBe(true);
  });

  test("a message still being sent has no tick", async () => {
    const { result } = await mount({ hoverable: true });
    expect(result.current.getLeadingSlot(msg(1, { _delivery: "sending" }))).toBeNull();
  });

  test("in selection mode every selectable row has a tick that shows its state", async () => {
    const { result } = await mount({ hoverable: false });
    inAct(() => store.enter(CHAT, key(2)));
    expect(result.current.getLeadingSlot(msg(1)).props).toMatchObject({ active: true, selected: false });
    expect(result.current.getLeadingSlot(msg(2)).props).toMatchObject({ active: true, selected: true });
  });

  test("the same row in the same state gets the very same element (rows are memoised)", async () => {
    const { result } = await mount({ hoverable: true });
    inAct(() => store.enter(CHAT, key(2)));
    const first = result.current.getLeadingSlot(msg(1));
    inAct(() => result.current.toggle(msg(3)));
    expect(result.current.getLeadingSlot(msg(1))).toBe(first);
    expect(result.current.getLeadingSlot(msg(3))).not.toBe(first);
  });
});

describe("useBatchSelection - keys", () => {
  test("Escape ends selection mode and is not passed on to the page", async () => {
    const pageEscape = vi.fn();
    document.addEventListener("keydown", pageEscape);
    const { result } = await mount();
    inAct(() => store.enter(CHAT, key(1)));
    let event;
    inAct(() => {
      event = press("Escape");
    });
    document.removeEventListener("keydown", pageEscape);
    expect(result.current.active).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(pageEscape).not.toHaveBeenCalled();
  });

  test("Escape does nothing to the selection while a dialog is open", async () => {
    const { result } = await mount();
    inAct(() => store.enter(CHAT, key(1)));
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.appendChild(dialog);
    inAct(() => press("Escape"));
    dialog.remove();
    expect(result.current.active).toBe(true);
  });

  test("Escape is left alone when nothing is selected", async () => {
    await mount();
    expect(press("Escape").defaultPrevented).toBe(false);
  });

  test("Delete asks to delete the selected messages, oldest first", async () => {
    const onDelete = vi.fn();
    const { result } = await mount({ onDelete });
    inAct(() => store.enter(CHAT, key(4)));
    inAct(() => result.current.toggle(msg(2)));
    inAct(() => {
      press("Delete");
    });
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete.mock.calls[0][0].map((m) => m.id)).toEqual([key(2), key(4)]);
  });

  test("Delete typed in a text field is the field's", async () => {
    const onDelete = vi.fn();
    const { result } = await mount({ onDelete });
    inAct(() => store.enter(CHAT, key(1)));
    const input = document.createElement("input");
    document.body.appendChild(input);
    inAct(() => {
      press("Delete", {}, input);
    });
    input.remove();
    expect(onDelete).not.toHaveBeenCalled();
    expect(result.current.active).toBe(true);
  });

  test("Ctrl+C copies the selected messages (not when text is selected)", async () => {
    const { result } = await mount();
    inAct(() => store.enter(CHAT, key(1)));
    inAct(() => result.current.toggle(msg(2)));
    let event;
    await act(async () => {
      event = press("c", { ctrlKey: true });
    });
    expect(event.defaultPrevented).toBe(true);
    expect(clip.copyTextToClipboard).toHaveBeenCalledTimes(1);
    expect(clip.copyTextToClipboard.mock.calls[0][0]).toMatch(/^Bob, \[.*\]\ntext 1\n\nBob, \[.*\]\ntext 2$/);
  });

  test("Ctrl+C leaves a text selection to the browser", async () => {
    const { result } = await mount();
    inAct(() => store.enter(CHAT, key(1)));
    const holder = document.createElement("p");
    holder.textContent = "some words";
    document.body.appendChild(holder);
    const range = document.createRange();
    range.selectNodeContents(holder);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    const event = press("c", { ctrlKey: true });
    window.getSelection().removeAllRanges();
    holder.remove();
    expect(event.defaultPrevented).toBe(false);
    expect(clip.copyTextToClipboard).not.toHaveBeenCalled();
    expect(result.current.active).toBe(true);
  });

  test("Up and Down move focus from row to row", async () => {
    const root = document.createElement("div");
    root.innerHTML = [1, 2, 3]
      .map((n) => `<div data-message-key="${key(n)}" role="checkbox" tabindex="-1"></div>`)
      .join("");
    document.body.appendChild(root);
    const rows = Array.from(root.children);
    const { result } = await mount({ scrollRef: { current: root } });
    inAct(() => store.enter(CHAT, key(1)));
    rows[0].focus();
    const down = press("ArrowDown", {}, rows[0]);
    expect(down.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(rows[1]);
    press("ArrowUp", {}, rows[1]);
    expect(document.activeElement).toBe(rows[0]);
    // nothing above the first row
    expect(press("ArrowUp", {}, rows[0]).defaultPrevented).toBe(false);
    root.remove();
    expect(result.current.active).toBe(true);
  });
});

describe("useBatchSelection - actions", () => {
  test("copy puts the text on the clipboard and ends selection mode", async () => {
    const { result } = await mount();
    inAct(() => store.enter(CHAT, key(3)));
    let copied;
    await act(async () => {
      copied = await result.current.copy();
    });
    expect(copied).toBe(true);
    expect(clip.copyTextToClipboard).toHaveBeenCalledWith("text 3");
    expect(result.current.active).toBe(false);
  });

  test("copy skips what has no text and says so", async () => {
    const { result } = await mount({
      messages: [msg(1), msg(2, { body: "Sent a photo", files: [{ id: 1 }] })],
    });
    inAct(() => store.enter(CHAT, key(1)));
    inAct(() => result.current.toggle(msg(2, { body: "Sent a photo", files: [{ id: 1 }] })));
    await act(async () => {
      await result.current.copy();
    });
    expect(clip.copyTextToClipboard).toHaveBeenCalledWith("text 1");
    expect(toast.showToast).toHaveBeenCalledWith("1 message without text was skipped.", { tone: "info" });
  });

  test("copy with nothing to copy says so and keeps the selection", async () => {
    const photo = msg(1, { body: "Sent a photo", files: [{ id: 1 }] });
    const { result } = await mount({ messages: [photo] });
    inAct(() => store.enter(CHAT, key(1)));
    let copied;
    await act(async () => {
      copied = await result.current.copy();
    });
    expect(copied).toBe(false);
    expect(clip.copyTextToClipboard).not.toHaveBeenCalled();
    expect(toast.showToast).toHaveBeenCalledWith(expect.stringMatching(/Nothing to copy/), { tone: "error" });
    expect(result.current.active).toBe(true);
  });

  test("a clipboard that refuses is reported and the selection is kept", async () => {
    clip.copyTextToClipboard.mockResolvedValue(false);
    const { result } = await mount();
    inAct(() => store.enter(CHAT, key(1)));
    await act(async () => {
      await result.current.copy();
    });
    expect(toast.showToast).toHaveBeenCalledWith("Couldn't copy to the clipboard.", { tone: "error" });
    expect(result.current.active).toBe(true);
  });

  test("forward hands over the forwardable messages, oldest first", async () => {
    const onForward = vi.fn();
    const { result } = await mount({ onForward });
    inAct(() => store.enter(CHAT, key(3)));
    inAct(() => result.current.toggle(msg(1)));
    inAct(() => result.current.forward());
    expect(onForward.mock.calls[0][0].map((m) => m.id)).toEqual([key(1), key(3)]);
    expect(toast.showToast).not.toHaveBeenCalled();
  });

  test("forward leaves out calls, service lines and encrypted messages, with a hint", async () => {
    const onForward = vi.fn();
    const call = msg(2, { messageType: "call", call: { kind: "audio" } });
    const service = msg(3, { _systemEvent: { type: "joined" } });
    const video = msg(4, { e2ee: { kind: "video_note" } });
    const { result } = await mount({ onForward, messages: [msg(1), call, service, video] });
    inAct(() => store.enter(CHAT, key(1)));
    [call, service, video].forEach((m) => inAct(() => result.current.toggle(m)));
    expect(result.current.count).toBe(4);
    expect(result.current.forwardableCount).toBe(1);
    inAct(() => result.current.forward());
    expect(onForward.mock.calls[0][0].map((m) => m.id)).toEqual([key(1)]);
    expect(toast.showToast).toHaveBeenCalledWith(
      "3 messages can't be forwarded (calls, service and encrypted messages) and were skipped.",
      { tone: "info" },
    );
  });

  test("forward with only such messages says so and does not open anything", async () => {
    const onForward = vi.fn();
    const call = msg(1, { messageType: "call", call: { kind: "audio" } });
    const { result } = await mount({ onForward, messages: [call] });
    inAct(() => store.enter(CHAT, key(1)));
    expect(result.current.forwardableCount).toBe(0);
    inAct(() => result.current.forward());
    expect(onForward).not.toHaveBeenCalled();
    expect(toast.showToast).toHaveBeenCalledWith(expect.stringMatching(/can't be forwarded/), { tone: "error" });
  });

  test("delete hands over every selected message, calls and service lines included", async () => {
    const onDelete = vi.fn();
    const call = msg(2, { messageType: "call", call: { kind: "audio" } });
    const { result } = await mount({ onDelete, messages: [msg(1), call] });
    inAct(() => store.enter(CHAT, key(1)));
    inAct(() => result.current.toggle(call));
    inAct(() => result.current.remove());
    expect(onDelete.mock.calls[0][0].map((m) => m.id)).toEqual([key(1), key(2)]);
  });

  test("offline: forward and delete are refused with a reason", async () => {
    const onForward = vi.fn();
    const onDelete = vi.fn();
    const { result } = await mount({ offline: true, onForward, onDelete });
    inAct(() => store.enter(CHAT, key(1)));
    inAct(() => result.current.forward());
    inAct(() => result.current.remove());
    expect(onForward).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
    expect(toast.showToast).toHaveBeenCalledTimes(2);
    expect(toast.showToast.mock.calls[0][0]).toMatch(/offline/i);
  });

  test("the handlers keep their identity while the list changes", async () => {
    const { result, rerender } = await mount();
    const { toggle, copy, forward, remove, exit } = result.current;
    await rerender({ chatId: CHAT, messages: [msg(1), msg(2)], onForward: vi.fn(), store });
    expect(result.current.toggle).toBe(toggle);
    expect(result.current.copy).toBe(copy);
    expect(result.current.forward).toBe(forward);
    expect(result.current.remove).toBe(remove);
    expect(result.current.exit).toBe(exit);
  });
});

describe("useBatchSelection - focus", () => {
  test("a tick on a row moves focus into the list when the focus was lost", async () => {
    const root = document.createElement("div");
    root.innerHTML = [1, 2]
      .map((n) => `<div data-message-key="${key(n)}" role="checkbox" tabindex="-1"></div>`)
      .join("");
    document.body.appendChild(root);
    await mount({ scrollRef: { current: root } });
    document.activeElement?.blur?.();
    inAct(() => store.enter(CHAT, key(2)));
    await vi.waitFor(() => expect(document.activeElement).toBe(root.children[1]));
    root.remove();
  });

  test("when selection ends, focus goes back to where it was", async () => {
    const button = document.createElement("button");
    document.body.appendChild(button);
    button.focus();
    const { result } = await mount();
    inAct(() => store.enter(CHAT, key(1)));
    // the focus was lost (the bar's button went away)
    document.activeElement?.blur?.();
    inAct(() => result.current.exit());
    await vi.waitFor(() => expect(document.activeElement).toBe(button));
    button.remove();
  });
});
