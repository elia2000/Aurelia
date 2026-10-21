import { describe, test, expect, vi } from "vitest";
import { renderHook } from "vitest-browser-react";
import { act } from "react";
import { useAppContextMenu } from "../../../src/components/context-menu/useAppContextMenu.js";
import { resetReactionStore, seedReactions } from "../../../src/utils/reactionStore.js";

const CHAT_ID = "00000000-0000-4000-8000-000000000001";
const MESSAGE_ID = "00000000-0000-4000-8000-000000000500";

// Every feature of the message menu switched on at once.
const allFeatures = (overrides = {}) => ({
  activeChatId: CHAT_ID,
  chats: [{ id: CHAT_ID, type: "dm" }],
  currentUsername: "me",
  canCurrentUserEditGroup: false,
  canReplyToMessage: true,
  canEditMessage: () => true,
  canDeleteMessageForEveryone: () => true,
  canPinMessage: () => true,
  isMessagePinned: () => false,
  onPinMessage: vi.fn(),
  onUnpinMessage: vi.fn(),
  onSelectMessage: vi.fn(),
  onSaveGif: vi.fn(),
  onSaveMessageFiles: vi.fn(),
  onForwardMessage: vi.fn(),
  ...overrides,
});

async function open(message, props = {}, data = {}) {
  const hook = await renderHook(() => useAppContextMenu(allFeatures(props)));
  const el = document.createElement("div");
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  act(() => {
    hook.result.current.openContextMenu({
      kind: "message",
      data: { message, isOffline: false, ...data },
      targetEl: el,
      event: { clientX: 10, clientY: 10, target: el },
    });
  });
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  return hook.result.current.contextMenu;
}

const ids = (menu) => menu.items.map((item) => item.id);

const gif = { id: 7, name: "g.gif", mimeType: "image/gif", isAnimated: true, gif: true };

describe("message menu - order", () => {
  test("a text message: Reply, Copy, Pin, Forward, Select, Edit, Delete (the quick bar sits above)", async () => {
    const menu = await open({ id: MESSAGE_ID, username: "me", body: "hello" });
    expect(ids(menu)).toEqual(["reply", "copy", "pin", "forward", "select", "edit", "delete"]);
    expect(menu.reactions).toEqual({ chatId: CHAT_ID, messageId: MESSAGE_ID });
  });

  test("a pinned message shows Unpin in the same place", async () => {
    const menu = await open(
      { id: MESSAGE_ID, username: "me", body: "hello" },
      { isMessagePinned: () => true },
    );
    expect(ids(menu)).toEqual(["reply", "copy", "unpin", "forward", "select", "edit", "delete"]);
  });

  test("a GIF: Save GIF comes right after Select, before Edit and Delete", async () => {
    const menu = await open({ id: MESSAGE_ID, username: "me", body: "look", files: [gif] });
    const order = ids(menu);
    expect(order).toEqual(
      expect.arrayContaining(["reply", "copy", "pin", "forward", "select", "save-gif", "edit", "delete"]),
    );
    expect(order.indexOf("select") + 1).toBe(order.indexOf("save-gif"));
    expect(order.indexOf("save-gif")).toBeLessThan(order.indexOf("edit"));
    expect(order.at(-1)).toBe("delete");
  });

  test("someone else's message has no Edit; Delete stays last", async () => {
    const menu = await open(
      { id: MESSAGE_ID, username: "bob", body: "hello" },
      { canEditMessage: () => false },
    );
    expect(ids(menu)).toEqual(["reply", "copy", "pin", "forward", "select", "delete"]);
  });

  test("'Reacted by' sits just above Delete", async () => {
    seedReactions([
      { id: MESSAGE_ID, reactions: [{ emoji: "👍", count: 1, reacted: false }] },
    ]);
    try {
      const menu = await open({ id: MESSAGE_ID, username: "me", body: "hello" });
      expect(ids(menu)).toEqual([
        "reply",
        "copy",
        "pin",
        "forward",
        "select",
        "edit",
        "reacted-by",
        "delete",
      ]);
    } finally {
      resetReactionStore();
    }
  });

  test("a call entry offers Delete and nothing else, and no quick bar", async () => {
    const menu = await open({
      id: MESSAGE_ID,
      username: "bob",
      body: "",
      messageType: "call",
      call: { callId: "c-1", kind: "audio", outcome: "completed", durationSec: 4 },
    });
    expect(ids(menu)).toEqual(["delete"]);
    expect(menu.reactions).toBeNull();
  });
});
