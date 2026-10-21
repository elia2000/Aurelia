import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "vitest-browser-react";

import { useChatEvents } from "../../../src/hooks/chat/useChatEvents.js";

const CHAT = "44444444-4444-4444-a444-444444444444";
const MSG = "33333333-3333-4333-a333-333333333331";
const MSG_2 = "33333333-3333-4333-a333-333333333332";

class FakeSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    FakeSocket.instances.push(this);
  }
  close() {}
  send() {}
  open() {
    this.onopen?.();
  }
  emit(payload) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

let chats;
let params;
let onIncomingMessage;

const chatRow = (overrides = {}) => ({
  id: CHAT,
  type: "dm",
  unread_count: 0,
  last_message: "Earlier text",
  last_message_id: "33333333-3333-4333-a333-333333333300",
  last_message_type: "message",
  last_call: null,
  last_sender_username: "alice",
  ...overrides,
});

const callEvent = ({ from = "bob", outcome = "completed", kind = "audio", durationSec = 12, countsAsUnread, messageId = MSG } = {}) => ({
  type: "chat_message",
  chatId: CHAT,
  messageId,
  username: from,
  body: "",
  summaryText: "Call",
  messageType: "call",
  call: { callId: "c-1", kind, outcome, durationSec },
  countsAsUnread: countsAsUnread ?? outcome === "missed",
  created_at: "2024-01-01 12:00:00",
});

const start = async (overrides = {}) => {
  params = {
    username: "alice",
    userId: "u-alice",
    getSseStreamUrl: () => "/events",
    sseReconnectDelayMs: 100,
    setSseConnected: vi.fn(),
    loadChatsRef: { current: vi.fn() },
    scheduleMessageRefreshRef: { current: vi.fn() },
    activeChatIdRef: { current: null },
    usernameRef: { current: "alice" },
    userScrolledUpRef: { current: false },
    isAtBottomRef: { current: true },
    pendingScrollToBottomRef: { current: false },
    unreadMarkerIdRef: { current: null },
    unreadAnchorLockUntilRef: { current: 0 },
    pendingScrollToUnreadRef: { current: null },
    setUnreadInChat: vi.fn(),
    setMessages: vi.fn(),
    setChats: vi.fn((updater) => {
      chats = typeof updater === "function" ? updater(chats) : updater;
    }),
    sseReconnectRef: { current: null },
    canMarkReadInCurrentView: false,
    markMessagesRead: vi.fn(() => Promise.resolve()),
    markMessageRead: vi.fn(() => Promise.resolve()),
    isMarkingReadRef: { current: false },
    onIncomingMessage,
    ...overrides,
  };
  return renderHook(() => useChatEvents(params));
};

const socket = () => FakeSocket.instances[FakeSocket.instances.length - 1];

beforeEach(() => {
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  chats = [chatRow()];
  onIncomingMessage = vi.fn();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useChatEvents - call entries", () => {
  test("a missed call adds one unread and sets the line the callee sees", async () => {
    await start();
    socket().open();
    socket().emit(callEvent({ outcome: "missed", durationSec: null }));
    expect(chats[0]).toMatchObject({
      unread_count: 1,
      last_message: "Missed call",
      last_message_id: MSG,
      last_message_type: "call",
      last_call: { callId: "c-1", kind: "audio", outcome: "missed", durationSec: null },
      last_sender_username: "bob",
    });
  });

  test("a call that was answered adds nothing to the unread count", async () => {
    await start();
    socket().open();
    socket().emit(callEvent({ outcome: "completed", kind: "video", durationSec: 61 }));
    expect(chats[0].unread_count).toBe(0);
    expect(chats[0]).toMatchObject({
      last_message: "Incoming video call",
      last_message_type: "call",
    });
  });

  test("declined, cancelled, busy and failed do not add unread either", async () => {
    await start();
    socket().open();
    for (const [index, outcome] of ["declined", "cancelled", "busy", "failed"].entries()) {
      socket().emit(callEvent({ outcome, durationSec: null, messageId: `33333333-3333-4333-a333-33333333330${index + 3}` }));
    }
    expect(chats[0].unread_count).toBe(0);
    expect(chats[0].last_message).toBe("Call failed");
  });

  test("my own call (the other side's server event) reads as outgoing and never counts", async () => {
    await start();
    socket().open();
    socket().emit(callEvent({ from: "alice", outcome: "completed" }));
    expect(chats[0]).toMatchObject({ unread_count: 0, last_message: "Outgoing call", last_sender_username: "alice" });
    socket().emit(callEvent({ from: "alice", outcome: "missed", durationSec: null, messageId: MSG_2 }));
    expect(chats[0]).toMatchObject({ unread_count: 0, last_message: "No answer" });
  });

  test("the same event twice does not count twice", async () => {
    await start();
    socket().open();
    socket().emit(callEvent({ outcome: "missed", durationSec: null }));
    socket().emit(callEvent({ outcome: "missed", durationSec: null }));
    expect(chats[0].unread_count).toBe(1);
  });

  test("a text message after a call clears the call fields and counts as unread", async () => {
    await start();
    socket().open();
    socket().emit(callEvent({ outcome: "completed" }));
    socket().emit({ type: "chat_message", chatId: CHAT, messageId: MSG_2, username: "bob", body: "Thanks!" });
    expect(chats[0]).toMatchObject({
      unread_count: 1,
      last_message: "Thanks!",
      last_message_type: "message",
      last_call: null,
    });
  });

  test("the message list of the open chat is refreshed to show the entry", async () => {
    await start({ activeChatIdRef: { current: CHAT } });
    socket().open();
    socket().emit(callEvent({ outcome: "completed" }));
    expect(params.scheduleMessageRefreshRef.current).toHaveBeenCalledWith(
      CHAT,
      expect.objectContaining({ tailDelta: true }),
    );
  });

  test("scrolled up in the open chat, only a missed call raises the 'new messages' count", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    await start({
      activeChatIdRef: { current: CHAT },
      canMarkReadInCurrentView: true,
      userScrolledUpRef: { current: true },
      isAtBottomRef: { current: false },
    });
    socket().open();
    socket().emit(callEvent({ outcome: "completed" }));
    expect(params.setUnreadInChat).toHaveBeenCalledTimes(1);
    const bump = params.setUnreadInChat.mock.calls[0][0];
    expect(bump(4)).toBe(4);
    socket().emit(callEvent({ outcome: "missed", durationSec: null, messageId: MSG_2 }));
    const bumpMissed = params.setUnreadInChat.mock.calls[1][0];
    expect(bumpMissed(4)).toBe(5);
  });

  test("the app is told about it like any incoming message (it decides not to notify)", async () => {
    await start();
    socket().open();
    socket().emit(callEvent({ outcome: "missed", durationSec: null }));
    expect(onIncomingMessage).toHaveBeenCalledTimes(1);
    expect(onIncomingMessage.mock.calls[0][0]).toMatchObject({ messageType: "call" });
  });
});
