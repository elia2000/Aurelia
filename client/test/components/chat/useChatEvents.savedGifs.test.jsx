import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "vitest-browser-react";
import { useChatEvents } from "../../../src/hooks/chat/useChatEvents.js";
import { savedGifs } from "../../../src/gifs/savedGifsStore.js";

// A WebSocket that never connects: the test pushes frames into it by hand.
class FakeSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    FakeSocket.instances.push(this);
  }
  close() {}
}

const GIF = {
  id: "11111111-1111-4111-8111-111111111111",
  url: "/api/gifs/11111111-1111-4111-8111-111111111111/file",
  width: 10,
  height: 10,
  mime: "image/gif",
  size: 10,
  createdAt: "2026-01-01T00:00:00.000Z",
};

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

beforeEach(() => {
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  savedGifs.reset();
  savedGifs.bindOwner("alice");
});
afterEach(() => {
  vi.unstubAllGlobals();
  savedGifs.reset();
});

describe("useChatEvents - the person's own saved GIFs", () => {
  test("saved_gif_added reaches the store, and an eviction raises the notice", async () => {
    const params = hookParams();
    await renderHook(() => useChatEvents(params));
    expect(FakeSocket.instances).toHaveLength(1);
    frame({
      type: "saved_gif_added",
      gif: GIF,
      evicted: [{ id: "22222222-2222-4222-8222-222222222222" }],
      limit: 50,
      count: 50,
    });
    expect(savedGifs.getState().notice).toMatchObject({ removed: 1, limit: 50 });
    expect(savedGifs.getState().limit).toBe(50);
  });

  test("a save without evictions raises no notice", async () => {
    const params = hookParams();
    await renderHook(() => useChatEvents(params));
    frame({ type: "saved_gif_added", gif: GIF, evicted: [], limit: 50, count: 3 });
    expect(savedGifs.getState().notice).toBeNull();
    expect(savedGifs.getState().count).toBe(3);
  });

  test("saved_gif_removed updates the count and does not touch the chat state", async () => {
    const params = hookParams();
    await renderHook(() => useChatEvents(params));
    frame({ type: "saved_gif_removed", gifId: GIF.id, limit: 50, count: 7 });
    expect(savedGifs.getState().count).toBe(7);
    expect(params.setMessages).not.toHaveBeenCalled();
    expect(params.setChats).not.toHaveBeenCalled();
    expect(params.scheduleMessageRefreshRef.current).not.toHaveBeenCalled();
  });

  test("the same save arriving twice (this device and the event) notifies once", async () => {
    const params = hookParams();
    await renderHook(() => useChatEvents(params));
    const event = { type: "saved_gif_added", gif: GIF, evicted: [{ id: "x1" }], limit: 50, count: 50 };
    frame(event);
    frame(event);
    expect(savedGifs.getState().notice.removed).toBe(1);
  });
});
