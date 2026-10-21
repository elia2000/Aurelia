import { describe, test, expect, vi } from "vitest";
import { renderHook } from "vitest-browser-react";
import { act } from "react";

import { useAppContextMenu } from "../../../src/components/context-menu/useAppContextMenu.js";

const CHAT = "44444444-4444-4444-a444-444444444444";
const MSG = "33333333-3333-4333-a333-333333333331";

const callEntry = (overrides = {}) => ({
  id: MSG,
  username: "bob",
  body: "",
  files: [],
  messageType: "call",
  call: { callId: "c-1", kind: "video", outcome: "completed", durationSec: 12 },
  ...overrides,
});

const textMessage = (overrides = {}) => ({
  id: MSG,
  username: "alice",
  body: "Hello",
  files: [],
  ...overrides,
});

const setup = async (handlers = {}) => {
  const { result } = await renderHook(() =>
    useAppContextMenu({
      activeChatId: CHAT,
      chats: [{ id: CHAT, type: "dm" }],
      currentUsername: "alice",
      canCurrentUserEditGroup: false,
      canReplyToMessage: true,
      canEditMessage: () => true,
      canDeleteMessageForEveryone: () => true,
      ...handlers,
    }),
  );
  return result;
};

const openFor = async (result, msg, extra = {}) => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    await act(async () => {
      result.current.openContextMenu({
        kind: "message",
        data: { message: msg, ...extra },
        targetEl: document.body,
        event: { clientX: 40, clientY: 40 },
      });
    });
  } finally {
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  }
  return result.current.contextMenu;
};

describe("useAppContextMenu - call entries", () => {
  test("offer nothing but Delete (no reply, copy, edit, forward, save, react)", async () => {
    const result = await setup({ onSaveGif: vi.fn() });
    for (const msg of [
      callEntry(),
      callEntry({ username: "alice", call: { callId: "c-2", kind: "audio", outcome: "missed", durationSec: null } }),
      // the server's marker alone is enough
      { id: MSG, username: "bob", body: "", type: "call" },
    ]) {
      const menu = await openFor(result, msg, { selectedText: "Outgoing call" });
      expect(menu.items.map((item) => item.id)).toEqual(["delete"]);
      expect(menu.reactions).toBeNull();
    }
  });

  test("with selection mode available it can also be selected (to be deleted with others), nothing else", async () => {
    const onSelectMessage = vi.fn();
    const result = await setup({ onSelectMessage });
    const msg = callEntry({ id: MSG });
    const menu = await openFor(result, msg);
    expect(menu.items.map((item) => item.id).sort()).toEqual(["delete", "select"]);
    menu.items.find((item) => item.id === "select").onSelect();
    expect(onSelectMessage).toHaveBeenCalledWith(msg);
  });

  test("Delete asks to remove it for me only, even when delete for everyone would be allowed", async () => {
    const onDeleteMessage = vi.fn();
    const canDeleteMessageForEveryone = vi.fn(() => false);
    const result = await setup({ onDeleteMessage, canDeleteMessageForEveryone });
    const msg = callEntry({ username: "alice" });
    const menu = await openFor(result, msg);
    menu.items[0].onSelect();
    expect(onDeleteMessage).toHaveBeenCalledWith(msg, { allowDeleteForEveryone: false });
  });

  test("a text message still gets its full menu", async () => {
    const result = await setup();
    const menu = await openFor(result, textMessage());
    const ids = menu.items.map((item) => item.id);
    expect(ids).toEqual(expect.arrayContaining(["reply", "copy", "edit", "forward", "delete"]));
    expect(menu.reactions).not.toBeNull();
  });
});
