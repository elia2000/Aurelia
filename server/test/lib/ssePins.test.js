import { describe, test, expect, vi } from "vitest";
import { createSseHub } from "../../lib/sse.js";

const CHAT_ID = "c0c0c0c0-d1d1-4e2e-af3f-060606060606";
const MSG_ID = "d0d0d0d0-e1e1-4f2f-b040-171717171717";
const ALICE_ID = "a0a0a0a0-b1b1-4c2c-8d3d-e4e4e4e4e4e4";
const BOB_ID = "b0b0b0b0-c1c1-4d2d-9e3e-f5f5f5f5f5f5";

function setup() {
  const members = [
    { id: ALICE_ID, username: "alice" },
    { id: BOB_ID, username: "bob" },
  ];
  const hub = createSseHub({ listChatMembers: () => members });
  const wire = { alice: [], bob: [] };
  for (const name of Object.keys(wire)) {
    hub.addSseClient(name, { write: (chunk) => wire[name].push(JSON.parse(chunk.replace(/^data: /, ""))) });
  }
  return { hub, wire };
}

const pinned = {
  type: "message_pinned",
  chatId: CHAT_ID,
  messageId: MSG_ID,
  pinnedBy: ALICE_ID,
  pinnedAt: "2025-01-01T10:00:00.000Z",
};
const unpinned = { type: "message_unpinned", chatId: CHAT_ID, messageId: MSG_ID };
const unpinnedAll = { type: "messages_unpinned_all", chatId: CHAT_ID };

describe.each([
  ["message_pinned", pinned],
  ["message_unpinned", unpinned],
  ["messages_unpinned_all", unpinnedAll],
])("%s SSE event", (_name, payload) => {
  test("reaches every member of the chat with the payload unchanged", () => {
    const { hub, wire } = setup();
    hub.emitChatEvent(CHAT_ID, payload);
    expect(wire.alice).toEqual([payload]);
    expect(wire.bob).toEqual([payload]);
  });

  test("is passed to chat event listeners (the websocket gateway)", () => {
    const { hub } = setup();
    const listener = vi.fn();
    hub.onChatEvent(listener);
    hub.emitChatEvent(CHAT_ID, payload);
    expect(listener).toHaveBeenCalledWith(CHAT_ID, payload);
  });

  test("is dropped when the chat id is not a UUID", () => {
    const { hub, wire } = setup();
    hub.emitChatEvent(CHAT_ID, { ...payload, chatId: "not-a-uuid" });
    expect(wire.alice).toEqual([]);
  });
});

describe("pin event references", () => {
  test.each([
    ["messageId", { ...pinned, messageId: "nope" }],
    ["pinnedBy", { ...pinned, pinnedBy: "someone" }],
    ["messageId of an unpin", { ...unpinned, messageId: "nope" }],
  ])("an event with a bad %s is dropped", (_field, payload) => {
    const { hub, wire } = setup();
    hub.emitChatEvent(CHAT_ID, payload);
    expect(wire.alice).toEqual([]);
    expect(wire.bob).toEqual([]);
  });

  test("a pin whose person is gone (pinnedBy null) is still delivered", () => {
    const { hub, wire } = setup();
    hub.emitChatEvent(CHAT_ID, { ...pinned, pinnedBy: null });
    expect(wire.alice).toHaveLength(1);
  });
});

describe("the pinned-message timeline entry", () => {
  test("is a chat_message whose structured form reaches the clients", () => {
    const { hub, wire } = setup();
    const payload = {
      type: "chat_message",
      chatId: CHAT_ID,
      messageId: "9a9a9a9a-b2b2-4c3c-8d4d-e5e5e5e5e5e5",
      username: "alice",
      userId: ALICE_ID,
      body: `[[system:pinned:${MSG_ID}]]`,
      service: { action: "pin", messageId: MSG_ID, actorId: ALICE_ID },
    };
    hub.emitChatEvent(CHAT_ID, payload);
    expect(wire.bob).toEqual([{ ...payload, reactions: [] }]);
  });
});
