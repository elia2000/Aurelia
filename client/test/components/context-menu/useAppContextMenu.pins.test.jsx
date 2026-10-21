import { describe, test, expect, vi, beforeEach } from "vitest";
import { renderHook } from "vitest-browser-react";
import { act } from "react";
import { useAppContextMenu } from "../../../src/components/context-menu/useAppContextMenu.js";
import { setPinLimits } from "../../../src/utils/pinLimits.js";

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const MESSAGE_ID = id(500);

const baseProps = (overrides = {}) => ({
  activeChatId: id(1),
  chats: [],
  currentUsername: "me",
  canReplyToMessage: true,
  canEditMessage: () => false,
  canDeleteMessageForEveryone: () => false,
  ...overrides,
});

async function open(kind, data, props = {}) {
  const hook = await renderHook(() => useAppContextMenu(baseProps(props)));
  const el = document.createElement("div");
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  act(() => {
    hook.result.current.openContextMenu({
      kind,
      data,
      targetEl: el,
      event: { clientX: 10, clientY: 10, target: el },
    });
  });
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  return hook.result.current.contextMenu?.items || [];
}

const ids = (items) => items.map((item) => item.id);
const messageItems = (message, props, offline = false) =>
  open("message", { message, isOffline: offline }, props);

beforeEach(() => setPinLimits({ messages: 20, chats: 5 }));

describe("message menu - Pin / Unpin", () => {
  const message = { id: MESSAGE_ID, username: "bob", body: "hi" };

  test("offers Pin when the person may pin here and the message is not pinned", async () => {
    const onPinMessage = vi.fn();
    const items = await messageItems(message, {
      canPinMessage: () => true,
      isMessagePinned: () => false,
      onPinMessage,
      onUnpinMessage: vi.fn(),
    });
    const pin = items.find((item) => item.id === "pin");
    expect(pin).toMatchObject({ label: "Pin" });
    // before Forward
    expect(ids(items).indexOf("pin")).toBeLessThan(ids(items).indexOf("forward"));
    pin.onSelect();
    expect(onPinMessage).toHaveBeenCalledWith(message);
  });

  test("offers Unpin for a pinned message", async () => {
    const onUnpinMessage = vi.fn();
    const items = await messageItems(message, {
      canPinMessage: () => true,
      isMessagePinned: () => true,
      onPinMessage: vi.fn(),
      onUnpinMessage,
    });
    expect(ids(items)).toContain("unpin");
    expect(ids(items)).not.toContain("pin");
    items.find((item) => item.id === "unpin").onSelect();
    expect(onUnpinMessage).toHaveBeenCalledWith(message);
  });

  test("has no item where the person may not pin (a member of a group, a channel subscriber)", async () => {
    const items = await messageItems(message, {
      canPinMessage: () => false,
      isMessagePinned: () => false,
      onPinMessage: vi.fn(),
    });
    expect(ids(items)).not.toContain("pin");
    expect(ids(items)).not.toContain("unpin");
  });

  test("has no item when the page does not take pins at all", async () => {
    const items = await messageItems(message, {});
    expect(ids(items)).not.toContain("pin");
  });

  test("is shown but disabled while offline", async () => {
    const items = await messageItems(
      message,
      { canPinMessage: () => true, isMessagePinned: () => false, onPinMessage: vi.fn() },
      true,
    );
    expect(items.find((item) => item.id === "pin").disabled).toBe(true);
  });

  test("a call entry never offers it (it is only deletable or selectable)", async () => {
    const items = await messageItems(
      { id: MESSAGE_ID, username: "bob", body: "", messageType: "call", call: { kind: "audio", outcome: "missed" } },
      { canPinMessage: () => true, isMessagePinned: () => false, onPinMessage: vi.fn() },
    );
    expect(ids(items)).not.toContain("pin");
  });
});

describe("pinned bar menu", () => {
  const data = (extra = {}) => ({
    pin: { messageId: MESSAGE_ID },
    count: 3,
    canManage: true,
    onGoTo: vi.fn(),
    onUnpin: vi.fn(),
    onUnpinAll: vi.fn(),
    ...extra,
  });

  test("Go to message, Unpin message and Unpin all (with the count) for someone who may unpin", async () => {
    const d = data();
    const items = await open("pinbar", d);
    expect(ids(items)).toEqual(["go-to", "unpin-this", "unpin-all"]);
    expect(items[2].label).toBe("Unpin all 3 messages");
    items[0].onSelect();
    items[1].onSelect();
    items[2].onSelect();
    expect(d.onGoTo).toHaveBeenCalledTimes(1);
    expect(d.onUnpin).toHaveBeenCalledTimes(1);
    expect(d.onUnpinAll).toHaveBeenCalledTimes(1);
  });

  test("no 'Unpin all' for a single pin", async () => {
    const items = await open("pinbar", data({ count: 1 }));
    expect(ids(items)).toEqual(["go-to", "unpin-this"]);
  });

  test("only 'Go to message' for someone who may not unpin", async () => {
    const items = await open("pinbar", data({ canManage: false }));
    expect(ids(items)).toEqual(["go-to"]);
  });

  test("the unpin items are disabled offline", async () => {
    const items = await open("pinbar", data({ offline: true }));
    expect(items.find((i) => i.id === "unpin-this").disabled).toBe(true);
    expect(items.find((i) => i.id === "unpin-all").disabled).toBe(true);
    expect(items.find((i) => i.id === "go-to").disabled).toBeFalsy();
  });
});

describe("chat menu - Pin to top / Unpin / Move", () => {
  const chat = (n, extra = {}) => ({ id: id(n), type: "dm", unread_count: 0, ...extra });
  const pinned = (n, position) => chat(n, { pinned: true, pinPosition: position });
  const chatItems = (target, chats, props = {}) =>
    open("chat", { chat: target }, {
      chats,
      onToggleChatPin: vi.fn(),
      onMoveChatPin: vi.fn(),
      ...props,
    });

  test("a chat that is not pinned: 'Pin to top' first, no moves", async () => {
    const chats = [chat(1), chat(2)];
    const onToggleChatPin = vi.fn();
    const items = await chatItems(chats[0], chats, { onToggleChatPin });
    expect(ids(items)[0]).toBe("pin-chat");
    expect(items[0].label).toBe("Pin to top");
    expect(ids(items)).not.toContain("move-pin-up");
    expect(ids(items)).not.toContain("move-pin-down");
    items[0].onSelect();
    expect(onToggleChatPin).toHaveBeenCalledWith(chats[0]);
  });

  test("a pinned chat in the middle: Unpin, Move up, Move down", async () => {
    const chats = [pinned(1, 0), pinned(2, 1), pinned(3, 2), chat(4)];
    const onMoveChatPin = vi.fn();
    const items = await chatItems(chats[1], chats, { onMoveChatPin });
    expect(ids(items).slice(0, 3)).toEqual(["unpin-chat", "move-pin-up", "move-pin-down"]);
    expect(items[0].label).toBe("Unpin");
    items.find((i) => i.id === "move-pin-up").onSelect();
    items.find((i) => i.id === "move-pin-down").onSelect();
    expect(onMoveChatPin.mock.calls).toEqual([
      [chats[1], -1],
      [chats[1], 1],
    ]);
  });

  test("the first pinned chat cannot move up, the last cannot move down", async () => {
    const chats = [pinned(1, 0), pinned(2, 1)];
    expect(ids(await chatItems(chats[0], chats))).toEqual(
      expect.arrayContaining(["unpin-chat", "move-pin-down"]),
    );
    expect(ids(await chatItems(chats[0], chats))).not.toContain("move-pin-up");
    expect(ids(await chatItems(chats[1], chats))).not.toContain("move-pin-down");
    expect(ids(await chatItems(chats[1], chats))).toContain("move-pin-up");
  });

  test("Saved Messages can be pinned too", async () => {
    const saved = chat(9, { type: "saved" });
    const items = await chatItems(saved, [saved]);
    expect(ids(items)[0]).toBe("pin-chat");
  });

  test("the pin items are disabled offline", async () => {
    const chats = [pinned(1, 0), pinned(2, 1)];
    const items = await chatItems(chats[1], chats, { isOffline: true });
    expect(items.filter((i) => ["unpin-chat", "move-pin-up"].includes(i.id)).every((i) => i.disabled)).toBe(true);
  });

  test("without the page's handlers the menu is what it was (mute, delete)", async () => {
    const chats = [chat(1)];
    const items = await open("chat", { chat: chats[0] }, { chats });
    expect(ids(items)).toEqual(["mute", "delete"]);
  });
});
