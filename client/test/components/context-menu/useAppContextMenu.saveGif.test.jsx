import { describe, test, expect, vi } from "vitest";
import { renderHook } from "vitest-browser-react";
import { act } from "react";
import { useAppContextMenu } from "../../../src/components/context-menu/useAppContextMenu.js";

const MESSAGE_ID = "3f2c1d0e-8a4b-4c6d-9e1f-0a1b2c3d4e5f";

const gifFile = (id, extra = {}) => ({ id, name: `g${id}.gif`, mimeType: "image/gif", isAnimated: true, gif: true, ...extra });
const photoFile = (id) => ({ id, name: `p${id}.jpg`, mimeType: "image/jpeg" });

const baseProps = (overrides = {}) => ({
  activeChatId: "chat-1",
  chats: [],
  currentUsername: "me",
  canReplyToMessage: true,
  canEditMessage: () => false,
  canDeleteMessageForEveryone: () => false,
  ...overrides,
});

async function openFor(message, { props = {}, target = null } = {}) {
  const hook = await renderHook(() => useAppContextMenu(baseProps(props)));
  const el = target || document.createElement("div");
  // act() needs the flag; the test renderer only sets it while it renders.
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  act(() => {
    hook.result.current.openContextMenu({
      kind: "message",
      data: { message, isOffline: props.offline ?? false },
      targetEl: el,
      event: { clientX: 10, clientY: 10, target: el },
    });
  });
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  return hook.result.current.contextMenu?.items || [];
}

const ids = (items) => items.map((item) => item.id);

describe("message menu - Save GIF", () => {
  test("a GIF message offers 'Save GIF', own or received alike", async () => {
    const onSaveGif = vi.fn();
    for (const username of ["me", "someone"]) {
      const message = { id: MESSAGE_ID, username, body: "Sent a media file", files: [gifFile(5)] };
      const items = await openFor(message, { props: { onSaveGif } });
      const item = items.find((entry) => entry.id === "save-gif");
      expect(item).toBeTruthy();
      expect(item.label).toBe("Save GIF");
      expect(item.disabled).toBe(false);
    }
  });

  test("choosing it hands the message and the GIF to the handler", async () => {
    const onSaveGif = vi.fn();
    const message = { id: MESSAGE_ID, body: "x", files: [photoFile(4), gifFile(5)] };
    const items = await openFor(message, { props: { onSaveGif } });
    items.find((entry) => entry.id === "save-gif").onSelect();
    expect(onSaveGif).toHaveBeenCalledWith(message, message.files[1]);
  });

  test("it is the GIF that was pointed at when there are several", async () => {
    const onSaveGif = vi.fn();
    const message = { id: MESSAGE_ID, body: "x", files: [gifFile(5), gifFile(6)] };
    const target = document.createElement("button");
    target.setAttribute("data-file-id", "6");
    const items = await openFor(message, { props: { onSaveGif }, target });
    items.find((entry) => entry.id === "save-gif").onSelect();
    expect(onSaveGif.mock.calls[0][1]).toBe(message.files[1]);
  });

  test("a message without a GIF has no such item", async () => {
    const onSaveGif = vi.fn();
    const items = await openFor({ id: MESSAGE_ID, body: "hi", files: [photoFile(1)] }, { props: { onSaveGif } });
    expect(ids(items)).not.toContain("save-gif");
    const plain = await openFor({ id: MESSAGE_ID, body: "hi" }, { props: { onSaveGif } });
    expect(ids(plain)).not.toContain("save-gif");
  });

  test("with no handler (uploads are off on the server) the item is hidden", async () => {
    const items = await openFor({ id: MESSAGE_ID, body: "x", files: [gifFile(5)] });
    expect(ids(items)).not.toContain("save-gif");
  });

  test("an encrypted message is never offered", async () => {
    const items = await openFor(
      { id: MESSAGE_ID, body: "x", e2ee: { v: 1 }, files: [gifFile(5)] },
      { props: { onSaveGif: vi.fn() } },
    );
    expect(ids(items)).not.toContain("save-gif");
  });

  test("it is disabled offline and while the server does not know the message or file yet", async () => {
    const onSaveGif = vi.fn();
    const offline = await openFor(
      { id: MESSAGE_ID, body: "x", files: [gifFile(5)] },
      { props: { onSaveGif, offline: true } },
    );
    expect(offline.find((entry) => entry.id === "save-gif").disabled).toBe(true);

    const pendingMessage = await openFor(
      { id: "pending-123-abc", body: "", files: [gifFile(5)] },
      { props: { onSaveGif } },
    );
    expect(pendingMessage.find((entry) => entry.id === "save-gif").disabled).toBe(true);

    const pendingFile = await openFor(
      { id: MESSAGE_ID, body: "", files: [gifFile("saved-gif-abc")] },
      { props: { onSaveGif } },
    );
    expect(pendingFile.find((entry) => entry.id === "save-gif").disabled).toBe(true);

    const sentJustNow = await openFor(
      { id: "pending-123-abc", _serverId: MESSAGE_ID, body: "", files: [gifFile(5)] },
      { props: { onSaveGif } },
    );
    expect(sentJustNow.find((entry) => entry.id === "save-gif").disabled).toBe(false);
  });
});
