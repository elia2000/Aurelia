import { describe, test, expect, vi } from "vitest";
import { renderHook } from "vitest-browser-react";
import { act } from "react";
import { useAppContextMenu } from "../../../src/components/context-menu/useAppContextMenu.js";

const MESSAGE_ID = "3f2c1d0e-8a4b-4c6d-9e1f-0a1b2c3d4e5f";

const baseProps = (overrides = {}) => ({
  activeChatId: "chat-1",
  chats: [],
  currentUsername: "me",
  canReplyToMessage: true,
  canEditMessage: () => false,
  canDeleteMessageForEveryone: () => false,
  ...overrides,
});

async function openFor(message, props = {}) {
  const hook = await renderHook(() => useAppContextMenu(baseProps(props)));
  const el = document.createElement("div");
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  act(() => {
    hook.result.current.openContextMenu({
      kind: "message",
      data: { message, isOffline: false },
      targetEl: el,
      event: { clientX: 10, clientY: 10, target: el },
    });
  });
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  return hook.result.current.contextMenu?.items || [];
}

const ids = (items) => items.map((item) => item.id);

describe("message menu - Select", () => {
  test("offers 'Select' when the page can start selection mode", async () => {
    const onSelectMessage = vi.fn();
    const message = { id: MESSAGE_ID, username: "bob", body: "hi" };
    const items = await openFor(message, { onSelectMessage });
    const item = items.find((entry) => entry.id === "select");
    expect(item).toBeTruthy();
    expect(item.label).toBe("Select");
    // after Forward, before Delete
    expect(ids(items).indexOf("select")).toBe(ids(items).indexOf("forward") + 1);
    expect(ids(items).indexOf("select")).toBeLessThan(ids(items).indexOf("delete"));
  });

  test("choosing it hands the message over", async () => {
    const onSelectMessage = vi.fn();
    const message = { id: MESSAGE_ID, username: "bob", body: "hi" };
    const items = await openFor(message, { onSelectMessage });
    items.find((entry) => entry.id === "select").onSelect();
    expect(onSelectMessage).toHaveBeenCalledWith(message);
  });

  test("there is no item when the page does not take selection", async () => {
    const items = await openFor({ id: MESSAGE_ID, username: "bob", body: "hi" });
    expect(ids(items)).not.toContain("select");
  });

  test("a message that is still being sent cannot be selected", async () => {
    const items = await openFor(
      { id: "temp-1", _clientId: "temp-1", _delivery: "sending", username: "me", body: "hi" },
      { onSelectMessage: vi.fn() },
    );
    expect(ids(items)).not.toContain("select");
  });

  test("a call entry offers Delete only, even when selection is available", async () => {
    const items = await openFor(
      { id: MESSAGE_ID, username: "bob", body: "", messageType: "call", call: { kind: "audio", outcome: "missed" } },
      { onSelectMessage: vi.fn() },
    );
    expect(ids(items)).toEqual(["delete"]);
  });

  test("an encrypted message can be selected too (to delete it)", async () => {
    const items = await openFor(
      { id: MESSAGE_ID, username: "bob", body: "sb-enc-v1:xyz", e2ee: { kind: "video_note" }, files: [{ id: 1 }] },
      { onSelectMessage: vi.fn() },
    );
    expect(ids(items)).toContain("select");
    expect(ids(items)).not.toContain("forward");
  });
});
