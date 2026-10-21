import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "vitest-browser-react";

import { useChatEvents } from "../../../src/hooks/chat/useChatEvents.js";
import {
  getReactionEntry,
  getReactionList,
  resetReactionStore,
  seedReactions,
} from "../../../src/utils/reactionStore.js";

const ME = "11111111-1111-4111-a111-111111111111";
const BOB = "22222222-2222-4222-a222-222222222222";
const CHAT = "44444444-4444-4444-a444-444444444444";
const OTHER_CHAT = "44444444-4444-4444-a444-444444444445";
const MSG = "33333333-3333-4333-a333-333333333331";
const OTHER_MSG = "33333333-3333-4333-a333-333333333332";

const UP = "\u{1F44D}";
const HEART = "❤️";
const FIRE = "\u{1F525}";

class FakeSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.closed = false;
    FakeSocket.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  send() {}
  open() {
    this.onopen?.();
  }
  emit(payload) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
  drop() {
    this.onclose?.();
  }
}

let messages;
let setMessages;
let refresh;
let params;

const reactionEvent = (overrides = {}) => ({
  type: "message_reactions",
  chatId: CHAT,
  messageId: MSG,
  counts: [{ emoji: UP, count: 1 }],
  actorId: BOB,
  actorEmoji: UP,
  removedEmoji: null,
  removedEmojis: [],
  ...overrides,
});

const start = async (overrides = {}) => {
  params = {
    username: "alice",
    userId: ME,
    getSseStreamUrl: () => "/events",
    sseReconnectDelayMs: 100,
    setSseConnected: vi.fn(),
    loadChatsRef: { current: vi.fn() },
    scheduleMessageRefreshRef: { current: refresh },
    activeChatIdRef: { current: CHAT },
    usernameRef: { current: "alice" },
    userScrolledUpRef: { current: false },
    isAtBottomRef: { current: true },
    pendingScrollToBottomRef: { current: false },
    unreadMarkerIdRef: { current: null },
    unreadAnchorLockUntilRef: { current: 0 },
    pendingScrollToUnreadRef: { current: null },
    setUnreadInChat: vi.fn(),
    setMessages,
    setChats: vi.fn(),
    sseReconnectRef: { current: null },
    canMarkReadInCurrentView: false,
    markMessagesRead: vi.fn(() => Promise.resolve()),
    markMessageRead: vi.fn(() => Promise.resolve()),
    isMarkingReadRef: { current: false },
    ...overrides,
  };
  const view = await renderHook(() => useChatEvents(params));
  return view;
};

const socket = () => FakeSocket.instances[FakeSocket.instances.length - 1];

beforeEach(() => {
  resetReactionStore();
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  refresh = vi.fn();
  messages = [
    { id: MSG, body: "one", reactions: [] },
    { id: OTHER_MSG, body: "two", reactions: [] },
  ];
  setMessages = vi.fn((updater) => {
    messages = typeof updater === "function" ? updater(messages) : updater;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useChatEvents - message_reactions", () => {
  test("changes the numbers of a message the screen is not showing", async () => {
    await start({ activeChatIdRef: { current: OTHER_CHAT } });
    socket().open();
    socket().emit(reactionEvent({ counts: [{ emoji: UP, count: 2 }, { emoji: FIRE, count: 1 }] }));
    expect(getReactionList(MSG)).toEqual([
      { emoji: UP, count: 2, reacted: false },
      { emoji: FIRE, count: 1, reacted: false },
    ]);
    // a message of another chat is not touched on the screen
    expect(setMessages).not.toHaveBeenCalled();
  });

  test("knows which reactions are mine from actorId, actorEmoji and removedEmojis", async () => {
    await start();
    socket().open();
    socket().emit(reactionEvent({ actorId: ME, actorEmoji: UP, counts: [{ emoji: UP, count: 1 }] }));
    expect(getReactionEntry(MSG).mine).toEqual([UP]);
    // replaced by a heart from my other device
    socket().emit(
      reactionEvent({ actorId: ME, actorEmoji: HEART, removedEmojis: [UP], counts: [{ emoji: HEART, count: 1 }] }),
    );
    expect(getReactionEntry(MSG).mine).toEqual([HEART]);
    expect(getReactionList(MSG)).toEqual([{ emoji: HEART, count: 1, reacted: true }]);
  });

  test("another person's reaction leaves my flag alone", async () => {
    seedReactions([{ id: MSG, reactions: [{ emoji: UP, count: 1, reacted: true }] }]);
    await start();
    socket().open();
    socket().emit(reactionEvent({ counts: [{ emoji: UP, count: 2 }], actorId: BOB, actorEmoji: UP }));
    expect(getReactionList(MSG)).toEqual([{ emoji: UP, count: 2, reacted: true }]);
  });

  test("a channel event without actor fields changes the numbers only", async () => {
    await start();
    socket().open();
    socket().emit({ type: "message_reactions", chatId: CHAT, messageId: MSG, counts: [{ emoji: UP, count: 3 }] });
    expect(getReactionList(MSG)).toEqual([{ emoji: UP, count: 3, reacted: false }]);
  });

  test("the open chat's message keeps its reactions in step (for the cache) once we know which are mine", async () => {
    seedReactions([{ id: MSG, reactions: [{ emoji: UP, count: 1, reacted: true }] }]);
    await start();
    socket().open();
    socket().emit(reactionEvent({ counts: [{ emoji: UP, count: 2 }] }));
    expect(messages[0].reactions).toEqual([{ emoji: UP, count: 2, reacted: true }]);
    expect(messages[1].reactions).toEqual([]);
  });

  test("a message whose flags are not known yet keeps the list it came with", async () => {
    await start();
    socket().open();
    socket().emit(reactionEvent());
    // an event alone cannot say which reactions are mine
    expect(messages[0].reactions).toEqual([]);
  });

  test("is not a reason to read the messages or the chat list again", async () => {
    const view = await start();
    socket().open();
    socket().emit(reactionEvent());
    expect(refresh).not.toHaveBeenCalled();
    expect(params.loadChatsRef.current).not.toHaveBeenCalled();
    expect(params.setChats).not.toHaveBeenCalled();
    view.unmount();
  });

  test("the realtime event is still passed on to anyone listening", async () => {
    const listener = vi.fn();
    window.addEventListener("songbird:realtime-event", listener);
    try {
      await start();
      socket().open();
      socket().emit(reactionEvent());
    } finally {
      window.removeEventListener("songbird:realtime-event", listener);
    }
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].detail.type).toBe("message_reactions");
  });

  test("an event with no counts, or no message, is ignored", async () => {
    await start();
    socket().open();
    socket().emit({ type: "message_reactions", chatId: CHAT, messageId: MSG });
    socket().emit({ type: "message_reactions", chatId: CHAT, counts: [{ emoji: UP, count: 1 }] });
    expect(getReactionList(MSG)).toEqual([]);
  });
});

describe("useChatEvents - after a reconnect", () => {
  test("the first connection reads nothing again; a reconnection reads the open chat to catch up", async () => {
    vi.useFakeTimers();
    await start();
    socket().open();
    expect(refresh).not.toHaveBeenCalled();
    socket().drop();
    vi.advanceTimersByTime(5000);
    expect(FakeSocket.instances).toHaveLength(2);
    socket().open();
    vi.advanceTimersByTime(500);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith(CHAT, expect.objectContaining({ preserveHistory: true }));
  });

  test("with no chat open there is nothing to read", async () => {
    vi.useFakeTimers();
    await start({ activeChatIdRef: { current: null } });
    socket().open();
    socket().drop();
    vi.advanceTimersByTime(5000);
    socket().open();
    expect(refresh).not.toHaveBeenCalled();
  });
});
