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

describe("message_reactions SSE event", () => {
  const payload = {
    type: "message_reactions",
    chatId: CHAT_ID,
    messageId: MSG_ID,
    counts: [{ emoji: "\u{1F44D}", count: 2 }],
    actorId: ALICE_ID,
    actorEmoji: "\u{1F44D}",
    removedEmoji: null,
    removedEmojis: [],
  };

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

  test.each([
    ["chatId", { chatId: "not-a-uuid" }],
    ["messageId", { messageId: "nope" }],
    ["actorId", { actorId: "someone" }],
  ])("is dropped when %s is not a UUID", (_field, patch) => {
    const { hub, wire } = setup();
    hub.emitChatEvent(CHAT_ID, { ...payload, ...patch });
    expect(wire.alice).toEqual([]);
    expect(wire.bob).toEqual([]);
  });
});

describe("chat_message SSE event", () => {
  test("always carries a reactions array (empty for a new message)", () => {
    const { hub, wire } = setup();
    hub.emitChatEvent(CHAT_ID, {
      type: "chat_message",
      chatId: CHAT_ID,
      messageId: MSG_ID,
      username: "alice",
      userId: ALICE_ID,
      body: "hi",
    });
    expect(wire.bob[0].reactions).toEqual([]);
    expect(wire.alice[0].reactions).toEqual([]);
  });

  test("keeps reactions a caller put there", () => {
    const { hub, wire } = setup();
    const reactions = [{ emoji: "\u{1F44D}", count: 1 }];
    hub.emitChatEvent(CHAT_ID, {
      type: "chat_message",
      chatId: CHAT_ID,
      messageId: MSG_ID,
      body: "hi",
      reactions,
    });
    expect(wire.bob[0].reactions).toEqual(reactions);
  });

  test("also applies to events sent to one person (the uploader's pending video)", () => {
    const { hub, wire } = setup();
    hub.emitSseEvent("alice", {
      type: "chat_message",
      chatId: CHAT_ID,
      messageId: MSG_ID,
      body: "video",
    });
    expect(wire.alice[0].reactions).toEqual([]);
    expect(wire.bob).toEqual([]);
  });

  test("listeners receive the same normalised payload", () => {
    const { hub } = setup();
    const listener = vi.fn();
    hub.onChatEvent(listener);
    hub.emitChatEvent(CHAT_ID, {
      type: "chat_message",
      chatId: CHAT_ID,
      messageId: MSG_ID,
      body: "hi",
    });
    expect(listener.mock.calls[0][1].reactions).toEqual([]);
  });

  test("other events are left alone", () => {
    const { hub, wire } = setup();
    hub.emitChatEvent(CHAT_ID, {
      type: "chat_message_updated",
      chatId: CHAT_ID,
      messageId: MSG_ID,
      body: "edited",
    });
    expect(wire.bob[0]).not.toHaveProperty("reactions");
  });

  test("does not mutate the caller's object", () => {
    const { hub } = setup();
    const original = { type: "chat_message", chatId: CHAT_ID, messageId: MSG_ID, body: "hi" };
    hub.emitChatEvent(CHAT_ID, original);
    expect(original).not.toHaveProperty("reactions");
  });
});
