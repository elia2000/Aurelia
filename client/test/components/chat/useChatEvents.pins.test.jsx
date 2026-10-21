import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "vitest-browser-react";

vi.mock("../../../src/api/pinsApi.js", () => ({
  listMessagePins: vi.fn(),
  pinMessage: vi.fn(),
  unpinMessage: vi.fn(),
  unpinAllMessages: vi.fn(),
}));

import { listMessagePins } from "../../../src/api/pinsApi.js";
import { useChatEvents } from "../../../src/hooks/chat/useChatEvents.js";
import { getChatPins, loadChatPins, resetPinStore } from "../../../src/utils/pinStore.js";

// A WebSocket that never connects: the test pushes frames into it by hand.
class FakeSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    FakeSocket.instances.push(this);
  }
  close() {}
}

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CHAT_A = id(1);
const CHAT_B = id(2);
const CHAT_C = id(3);
const MSG = id(10);

const hookParams = () => ({
  username: "alice",
  getSseStreamUrl: () => "/api/events",
  sseReconnectDelayMs: 50,
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
  pendingScrollToUnreadRef: { current: false },
  setUnreadInChat: vi.fn(),
  setMessages: vi.fn(),
  setChats: vi.fn(),
  sseReconnectRef: { current: null },
  canMarkReadInCurrentView: false,
  markMessagesRead: vi.fn(),
  markMessageRead: vi.fn(),
  isMarkingReadRef: { current: false },
});

const frame = (payload) => FakeSocket.instances.at(-1).onmessage({ data: JSON.stringify(payload) });

// What setChats(fn) does to a list of chats.
const applyUpdater = (setChats, chats, call = 0) => setChats.mock.calls[call][0](chats);

const rawPin = (n) => ({
  messageId: id(n),
  pinnedBy: id(900),
  pinnedAt: `2026-03-0${n}T10:00:00.000Z`,
  message: { id: id(n), senderId: id(900), senderName: "Ada", type: "text", text: `m${n}`, hasFile: false, fileKind: null },
});

beforeEach(() => {
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  resetPinStore();
  vi.mocked(listMessagePins).mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetPinStore();
});

describe("useChatEvents - the person's pinned chats", () => {
  test("chat_pins_changed replaces the pinned state of the chat list", async () => {
    const params = hookParams();
    await renderHook(() => useChatEvents(params));
    frame({
      type: "chat_pins_changed",
      pinned: [
        { chatId: CHAT_B, position: 0 },
        { chatId: CHAT_A, position: 1 },
      ],
    });
    expect(params.setChats).toHaveBeenCalledTimes(1);
    const next = applyUpdater(params.setChats, [
      { id: CHAT_A, pinned: true, pinPosition: 0 },
      { id: CHAT_B },
      { id: CHAT_C, pinned: true, pinPosition: 1 },
    ]);
    expect(next.map((chat) => [chat.id, chat.pinned, chat.pinPosition])).toEqual([
      [CHAT_A, true, 1],
      [CHAT_B, true, 0],
      [CHAT_C, false, null],
    ]);
  });

  test("an empty list unpins everything", async () => {
    const params = hookParams();
    await renderHook(() => useChatEvents(params));
    frame({ type: "chat_pins_changed", pinned: [] });
    const next = applyUpdater(params.setChats, [{ id: CHAT_A, pinned: true, pinPosition: 0 }]);
    expect(next[0]).toMatchObject({ pinned: false, pinPosition: null });
  });

  test("a broken event (no list) changes nothing", async () => {
    const params = hookParams();
    await renderHook(() => useChatEvents(params));
    frame({ type: "chat_pins_changed" });
    frame({ type: "chat_pins_changed", pinned: "all" });
    expect(params.setChats).not.toHaveBeenCalled();
  });

  test("it does not touch messages or schedule a refresh", async () => {
    const params = hookParams();
    await renderHook(() => useChatEvents(params));
    frame({ type: "chat_pins_changed", pinned: [{ chatId: CHAT_A, position: 0 }] });
    expect(params.setMessages).not.toHaveBeenCalled();
    expect(params.scheduleMessageRefreshRef.current).not.toHaveBeenCalled();
    expect(params.loadChatsRef.current).not.toHaveBeenCalled();
  });
});

describe("useChatEvents - pinned messages", () => {
  test("message_unpinned and messages_unpinned_all update the bar's list", async () => {
    vi.mocked(listMessagePins).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ pins: [rawPin(2), rawPin(1)] }),
    });
    await loadChatPins(CHAT_A);
    const params = hookParams();
    await renderHook(() => useChatEvents(params));
    frame({ type: "message_unpinned", chatId: CHAT_A, messageId: id(2) });
    expect(getChatPins(CHAT_A).map((pin) => pin.messageId)).toEqual([id(1)]);
    frame({ type: "messages_unpinned_all", chatId: CHAT_A });
    expect(getChatPins(CHAT_A)).toEqual([]);
  });

  test("message_pinned reads the list again", async () => {
    vi.mocked(listMessagePins).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ pins: [rawPin(1)] }),
    });
    await loadChatPins(CHAT_A);
    vi.mocked(listMessagePins).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ pins: [rawPin(2), rawPin(1)] }),
    });
    const params = hookParams();
    await renderHook(() => useChatEvents(params));
    frame({ type: "message_pinned", chatId: CHAT_A, messageId: id(2), pinnedBy: id(900) });
    await loadChatPins(CHAT_A); // shares the read the event started
    expect(getChatPins(CHAT_A).map((pin) => pin.messageId)).toEqual([id(2), id(1)]);
  });

  test("pin events do not touch the message list or the chat list", async () => {
    const params = hookParams();
    await renderHook(() => useChatEvents(params));
    frame({ type: "message_pinned", chatId: CHAT_A, messageId: id(2) });
    frame({ type: "message_unpinned", chatId: CHAT_A, messageId: id(2) });
    frame({ type: "messages_unpinned_all", chatId: CHAT_A });
    expect(params.setMessages).not.toHaveBeenCalled();
    expect(params.setChats).not.toHaveBeenCalled();
    expect(params.scheduleMessageRefreshRef.current).not.toHaveBeenCalled();
  });
});

describe("useChatEvents - the 'X pinned a message' line", () => {
  const pinLine = (overrides = {}) => ({
    type: "chat_message",
    chatId: CHAT_A,
    messageId: id(50),
    username: "bob",
    body: `[[system:pinned:${MSG}]]`,
    service: { action: "pin", messageId: MSG, actorId: id(901) },
    reactions: [],
    ...overrides,
  });

  test("is not the chat's new last message and adds no unread", async () => {
    const params = hookParams();
    await renderHook(() => useChatEvents(params));
    frame(pinLine());
    expect(params.setChats).not.toHaveBeenCalled();
  });

  test("in the open chat it is loaded into the timeline like any message", async () => {
    const params = hookParams();
    params.activeChatIdRef.current = CHAT_A;
    await renderHook(() => useChatEvents(params));
    frame(pinLine());
    expect(params.scheduleMessageRefreshRef.current).toHaveBeenCalledWith(
      CHAT_A,
      expect.objectContaining({ tailDelta: true }),
    );
  });

  // A reader who scrolled up in the open chat sees a counter for new messages.
  const scrolledUpReader = async () => {
    const params = hookParams();
    params.activeChatIdRef.current = CHAT_A;
    params.userScrolledUpRef.current = true;
    params.isAtBottomRef.current = false;
    params.canMarkReadInCurrentView = true;
    await renderHook(() => useChatEvents(params));
    return params;
  };

  test("a scrolled-up reader does not get an unread count for it", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const params = await scrolledUpReader();
    frame(pinLine());
    const updater = params.setUnreadInChat.mock.calls[0]?.[0];
    expect(updater).toBeTypeOf("function");
    expect(updater(3)).toBe(3);
    vi.restoreAllMocks();
  });

  test("while an ordinary message does (so the check above is real)", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const params = await scrolledUpReader();
    frame({ type: "chat_message", chatId: CHAT_A, messageId: id(51), username: "bob", body: "hello", reactions: [] });
    const updater = params.setUnreadInChat.mock.calls[0]?.[0];
    expect(updater).toBeTypeOf("function");
    expect(updater(3)).toBe(4);
    vi.restoreAllMocks();
  });

  test("an ordinary message in the same chat still updates the list", async () => {
    const params = hookParams();
    await renderHook(() => useChatEvents(params));
    frame({
      type: "chat_message",
      chatId: CHAT_A,
      messageId: id(51),
      username: "bob",
      body: "hello",
      reactions: [],
    });
    expect(params.setChats).toHaveBeenCalledTimes(1);
  });
});
