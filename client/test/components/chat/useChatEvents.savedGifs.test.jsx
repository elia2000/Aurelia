import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "vitest-browser-react";
vi.mock("../../../src/api/gifApi.js", () => ({
  listSavedGifs: vi.fn(async () => ({ ok: true, status: 200, data: { gifs: [], limit: 50, count: 0 } })),
  saveGifFromMessage: vi.fn(),
  uploadSavedGif: vi.fn(),
  deleteSavedGif: vi.fn(),
}));

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
  open() {
    this.onopen?.();
  }
  drop() {
    this.onclose?.();
  }
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

  test("after a reconnection the collection is marked old (events sent while offline are gone)", async () => {
    await savedGifs.load();
    expect(savedGifs.getState().status).toBe("ready");
    vi.useFakeTimers();
    try {
      const params = hookParams();
      await renderHook(() => useChatEvents(params));
      FakeSocket.instances.at(-1).open();
      expect(savedGifs.getState().stale).toBe(false);
      FakeSocket.instances.at(-1).drop();
      vi.advanceTimersByTime(5000);
      expect(FakeSocket.instances).toHaveLength(2);
      FakeSocket.instances.at(-1).open();
      expect(savedGifs.getState().stale).toBe(true);
    } finally {
      vi.useRealTimers();
    }
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
