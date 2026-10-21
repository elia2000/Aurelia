import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/api/pinsApi.js", () => ({
  listMessagePins: vi.fn(),
  pinMessage: vi.fn(),
  unpinMessage: vi.fn(),
  unpinAllMessages: vi.fn(),
}));
vi.mock("../../src/utils/toast.js", () => ({ showToast: vi.fn() }));

import {
  listMessagePins,
  pinMessage,
  unpinAllMessages,
  unpinMessage,
} from "../../src/api/pinsApi.js";
import { showToast } from "../../src/utils/toast.js";
import { getMaxPinnedMessages, setPinLimits } from "../../src/utils/pinLimits.js";
import {
  applyRealtimePinEvent,
  bindPinStoreToUser,
  forgetPinnedMessages,
  getChatPins,
  getChatPinsStatus,
  invalidateAllPins,
  isMessagePinned,
  loadChatPins,
  pinChatMessage,
  refreshPinnedMessagePreview,
  resetPinStore,
  subscribeToChatPins,
  unpinAllChatMessages,
  unpinChatMessage,
} from "../../src/utils/pinStore.js";

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CHAT = id(100);
const OTHER_CHAT = id(101);
const ME = id(900);

const rawPin = (n, text = `message ${n}`) => ({
  messageId: id(n),
  pinnedBy: ME,
  pinnedAt: `2026-03-0${n}T10:00:00.000Z`,
  message: {
    id: id(n),
    senderId: ME,
    senderName: "Ada",
    type: "text",
    text,
    hasFile: false,
    fileKind: null,
    createdAt: "2026-03-01T09:00:00.000Z",
  },
});

const reply = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const ids = (chatId = CHAT) => getChatPins(chatId).map((pin) => pin.messageId);

beforeEach(() => {
  resetPinStore();
  bindPinStoreToUser(null);
  setPinLimits({ messages: 20, chats: 5 });
  vi.mocked(listMessagePins).mockReset();
  vi.mocked(pinMessage).mockReset();
  vi.mocked(unpinMessage).mockReset();
  vi.mocked(unpinAllMessages).mockReset();
  vi.mocked(showToast).mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("loading the pins of a chat", () => {
  test("a chat nobody asked about has no pins", () => {
    expect(getChatPins(CHAT)).toEqual([]);
    expect(getChatPinsStatus(CHAT)).toBe("idle");
  });

  test("loadChatPins fills the list, newest first", async () => {
    vi.mocked(listMessagePins).mockResolvedValue(reply(200, { pins: [rawPin(1), rawPin(3), rawPin(2)] }));
    await loadChatPins(CHAT);
    expect(ids()).toEqual([id(3), id(2), id(1)]);
    expect(getChatPinsStatus(CHAT)).toBe("ready");
    expect(isMessagePinned(CHAT, id(2))).toBe(true);
    expect(isMessagePinned(CHAT, id(9))).toBe(false);
  });

  test("a list that is known is not asked for again, unless forced", async () => {
    vi.mocked(listMessagePins).mockResolvedValue(reply(200, { pins: [rawPin(1)] }));
    await loadChatPins(CHAT);
    await loadChatPins(CHAT);
    expect(listMessagePins).toHaveBeenCalledTimes(1);
    await loadChatPins(CHAT, { force: true });
    expect(listMessagePins).toHaveBeenCalledTimes(2);
  });

  test("callers that ask at the same time share one request", async () => {
    vi.mocked(listMessagePins).mockResolvedValue(reply(200, { pins: [rawPin(1)] }));
    await Promise.all([loadChatPins(CHAT), loadChatPins(CHAT), loadChatPins(CHAT)]);
    expect(listMessagePins).toHaveBeenCalledTimes(1);
  });

  test("subscribers hear about a change, and only a real one", async () => {
    const listener = vi.fn();
    subscribeToChatPins(CHAT, listener);
    vi.mocked(listMessagePins).mockResolvedValue(reply(200, { pins: [rawPin(1)] }));
    await loadChatPins(CHAT);
    const heard = listener.mock.calls.length;
    expect(heard).toBeGreaterThan(0);
    await loadChatPins(CHAT, { force: true }); // same list again
    expect(listener.mock.calls.length).toBe(heard);
  });

  test("the list array stays the same object until it changes", async () => {
    vi.mocked(listMessagePins).mockResolvedValue(reply(200, { pins: [rawPin(1)] }));
    await loadChatPins(CHAT);
    const first = getChatPins(CHAT);
    await loadChatPins(CHAT, { force: true });
    expect(getChatPins(CHAT)).toBe(first);
  });

  test("a chat we no longer belong to has no pins (403 and 404)", async () => {
    vi.mocked(listMessagePins).mockResolvedValue(reply(403, { error: "Not a member of this chat." }));
    await loadChatPins(CHAT);
    expect(getChatPins(CHAT)).toEqual([]);
    expect(getChatPinsStatus(CHAT)).toBe("ready");
  });

  test("a failed read keeps what was known and says so", async () => {
    vi.mocked(listMessagePins).mockResolvedValueOnce(reply(200, { pins: [rawPin(1)] }));
    await loadChatPins(CHAT);
    vi.mocked(listMessagePins).mockResolvedValueOnce(reply(500, { error: "boom" }));
    await loadChatPins(CHAT, { force: true });
    expect(ids()).toEqual([id(1)]);
    expect(getChatPinsStatus(CHAT)).toBe("error");
  });

  test("a network error is an error, not a crash", async () => {
    vi.mocked(listMessagePins).mockRejectedValue(new TypeError("offline"));
    await expect(loadChatPins(CHAT)).resolves.toBeUndefined();
    expect(getChatPinsStatus(CHAT)).toBe("error");
  });

  test("an event that arrives while the read travels makes it read again", async () => {
    let release;
    vi.mocked(listMessagePins)
      .mockImplementationOnce(
        () => new Promise((resolve) => { release = () => resolve(reply(200, { pins: [rawPin(1), rawPin(2)] })); }),
      )
      .mockResolvedValueOnce(reply(200, { pins: [rawPin(1)] }));
    const loading = loadChatPins(CHAT);
    // message 2 was unpinned in between: the first answer is out of date
    applyRealtimePinEvent({ type: "message_unpinned", chatId: CHAT, messageId: id(2) });
    release();
    await loading;
    expect(listMessagePins).toHaveBeenCalledTimes(2);
    expect(ids()).toEqual([id(1)]);
  });

  test("invalidateAllPins makes an old list ask again when shown", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.mocked(listMessagePins).mockResolvedValue(reply(200, { pins: [rawPin(1)] }));
    await loadChatPins(CHAT);
    vi.setSystemTime(Date.now() + 60_000);
    invalidateAllPins();
    expect(getChatPinsStatus(CHAT)).toBe("stale");
    await loadChatPins(CHAT);
    expect(listMessagePins).toHaveBeenCalledTimes(2);
    expect(getChatPinsStatus(CHAT)).toBe("ready");
  });

  test("a list that was read a moment ago is not invalidated by the connection opening", async () => {
    vi.mocked(listMessagePins).mockResolvedValue(reply(200, { pins: [rawPin(1)] }));
    await loadChatPins(CHAT);
    invalidateAllPins();
    expect(getChatPinsStatus(CHAT)).toBe("ready");
  });

  test("but one that was read a moment ago is still invalidated when the connection came back after a break", async () => {
    vi.mocked(listMessagePins).mockResolvedValue(reply(200, { pins: [rawPin(1)] }));
    await loadChatPins(CHAT);
    invalidateAllPins({ force: true });
    expect(getChatPinsStatus(CHAT)).toBe("stale");
    vi.mocked(listMessagePins).mockResolvedValue(reply(200, { pins: [rawPin(2), rawPin(1)] }));
    await loadChatPins(CHAT);
    expect(ids()).toEqual([id(2), id(1)]);
  });

  test("a list that failed to load is asked for again after a reconnect", async () => {
    vi.mocked(listMessagePins).mockRejectedValueOnce(new TypeError("offline"));
    await loadChatPins(CHAT);
    expect(getChatPinsStatus(CHAT)).toBe("error");
    invalidateAllPins();
    expect(getChatPinsStatus(CHAT)).toBe("stale");
  });
});

describe("pinning and unpinning", () => {
  beforeEach(async () => {
    vi.mocked(listMessagePins).mockResolvedValue(reply(200, { pins: [rawPin(2), rawPin(1)] }));
    await loadChatPins(CHAT);
  });

  test("pin takes the list from the answer", async () => {
    vi.mocked(pinMessage).mockResolvedValue(reply(200, { pins: [rawPin(3), rawPin(2), rawPin(1)] }));
    const result = await pinChatMessage(CHAT, id(3));
    expect(result.ok).toBe(true);
    expect(pinMessage).toHaveBeenCalledWith(CHAT, id(3));
    expect(ids()).toEqual([id(3), id(2), id(1)]);
  });

  test("unpin removes the pin at once, before the answer", async () => {
    let release;
    vi.mocked(unpinMessage).mockImplementation(
      () => new Promise((resolve) => { release = () => resolve(reply(200, { pins: [rawPin(1)] })); }),
    );
    const pending = unpinChatMessage(CHAT, id(2));
    expect(ids()).toEqual([id(1)]);
    release();
    await pending;
    expect(ids()).toEqual([id(1)]);
  });

  test("a refused unpin puts the pin back and says why", async () => {
    vi.mocked(unpinMessage).mockResolvedValue(reply(403, { error: "You are not allowed to pin messages in this chat." }));
    const result = await unpinChatMessage(CHAT, id(2));
    expect(result.ok).toBe(false);
    expect(ids()).toEqual([id(2), id(1)]);
    expect(showToast).toHaveBeenCalledWith("You can't pin messages in this chat.");
  });

  test("unpin all clears the list, and comes back if it fails", async () => {
    vi.mocked(unpinAllMessages).mockResolvedValueOnce(reply(500, { error: "boom" }));
    await unpinAllChatMessages(CHAT);
    expect(ids()).toEqual([id(2), id(1)]);
    vi.mocked(unpinAllMessages).mockResolvedValueOnce(reply(200, { pins: [] }));
    await unpinAllChatMessages(CHAT);
    expect(ids()).toEqual([]);
  });

  test("the limit shows a notice with the number from the server", async () => {
    vi.mocked(pinMessage).mockResolvedValue(
      reply(409, { code: "pin_limit", error: "A chat can have at most 2 pinned messages. Unpin one first." }),
    );
    const result = await pinChatMessage(CHAT, id(3));
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(showToast).toHaveBeenCalledWith("You can pin up to 2 messages in a chat");
    expect(ids()).toEqual([id(2), id(1)]);
  });

  test("a limit without a number uses the one from the app info", async () => {
    setPinLimits({ messages: 7 });
    expect(getMaxPinnedMessages()).toBe(7);
    vi.mocked(pinMessage).mockResolvedValue(reply(409, { code: "pin_limit" }));
    await pinChatMessage(CHAT, id(3));
    expect(showToast).toHaveBeenCalledWith("You can pin up to 7 messages in a chat");
  });

  test("a lost connection says so and changes nothing", async () => {
    vi.mocked(pinMessage).mockRejectedValue(new TypeError("offline"));
    const result = await pinChatMessage(CHAT, id(3));
    expect(result.ok).toBe(false);
    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/connection/i));
    expect(ids()).toEqual([id(2), id(1)]);
  });

  test("a double tap is one request", async () => {
    let release;
    vi.mocked(pinMessage).mockImplementation(
      () => new Promise((resolve) => { release = () => resolve(reply(200, { pins: [rawPin(3), rawPin(2), rawPin(1)] })); }),
    );
    const first = pinChatMessage(CHAT, id(3));
    const second = await pinChatMessage(CHAT, id(3));
    expect(second).toMatchObject({ ok: false, busy: true });
    release();
    await first;
    expect(pinMessage).toHaveBeenCalledTimes(1);
  });

  test("ids that are not UUIDs make no request", async () => {
    await expect(pinChatMessage("x", "y")).resolves.toEqual({ ok: false });
    await expect(unpinChatMessage(CHAT, "y")).resolves.toEqual({ ok: false });
    expect(pinMessage).not.toHaveBeenCalled();
    expect(unpinMessage).not.toHaveBeenCalled();
  });
});

describe("realtime events", () => {
  beforeEach(async () => {
    vi.mocked(listMessagePins).mockResolvedValue(reply(200, { pins: [rawPin(2), rawPin(1)] }));
    await loadChatPins(CHAT);
    vi.mocked(listMessagePins).mockClear();
  });

  test("message_unpinned removes that pin at once", () => {
    applyRealtimePinEvent({ type: "message_unpinned", chatId: CHAT, messageId: id(2) });
    expect(ids()).toEqual([id(1)]);
  });

  test("messages_unpinned_all empties the list", () => {
    applyRealtimePinEvent({ type: "messages_unpinned_all", chatId: CHAT });
    expect(ids()).toEqual([]);
    expect(getChatPinsStatus(CHAT)).toBe("ready");
  });

  test("message_pinned reads the list again (it carries no preview)", async () => {
    vi.mocked(listMessagePins).mockResolvedValue(reply(200, { pins: [rawPin(3), rawPin(2), rawPin(1)] }));
    applyRealtimePinEvent({ type: "message_pinned", chatId: CHAT, messageId: id(3), pinnedBy: ME });
    await loadChatPins(CHAT); // joins the request that is on its way
    expect(listMessagePins).toHaveBeenCalledTimes(1);
    expect(ids()).toEqual([id(3), id(2), id(1)]);
  });

  test("message_pinned for a pin we already have costs nothing", () => {
    applyRealtimePinEvent({ type: "message_pinned", chatId: CHAT, messageId: id(2) });
    expect(listMessagePins).not.toHaveBeenCalled();
  });

  test("events for a chat that was never opened here are ignored", () => {
    applyRealtimePinEvent({ type: "message_pinned", chatId: OTHER_CHAT, messageId: id(5) });
    applyRealtimePinEvent({ type: "message_unpinned", chatId: OTHER_CHAT, messageId: id(5) });
    expect(listMessagePins).not.toHaveBeenCalled();
    expect(getChatPinsStatus(OTHER_CHAT)).toBe("idle");
  });

  test("bad ids in an event are ignored", () => {
    applyRealtimePinEvent({ type: "message_unpinned", chatId: CHAT, messageId: "x" });
    applyRealtimePinEvent({ type: "message_unpinned", chatId: "x", messageId: id(2) });
    expect(ids()).toEqual([id(2), id(1)]);
  });

  test("the answer to our own unpin and its event leave the list right", async () => {
    vi.mocked(unpinMessage).mockResolvedValue(reply(200, { pins: [rawPin(1)] }));
    await unpinChatMessage(CHAT, id(2));
    applyRealtimePinEvent({ type: "message_unpinned", chatId: CHAT, messageId: id(2) });
    expect(ids()).toEqual([id(1)]);
  });

  test("an edit of a pinned message reads the previews again, once for a burst", async () => {
    vi.useFakeTimers();
    vi.mocked(listMessagePins).mockResolvedValue(reply(200, { pins: [rawPin(2, "edited"), rawPin(1)] }));
    refreshPinnedMessagePreview(CHAT, id(2));
    refreshPinnedMessagePreview(CHAT, id(2));
    expect(listMessagePins).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(listMessagePins).toHaveBeenCalledTimes(1);
    expect(getChatPins(CHAT)[0].message.text).toBe("edited");
  });

  test("an edit of a message that is not pinned costs nothing", async () => {
    vi.useFakeTimers();
    refreshPinnedMessagePreview(CHAT, id(7));
    await vi.advanceTimersByTimeAsync(1000);
    expect(listMessagePins).not.toHaveBeenCalled();
  });
});

describe("messages the person hid for themselves", () => {
  beforeEach(async () => {
    vi.mocked(listMessagePins).mockResolvedValue(reply(200, { pins: [rawPin(3), rawPin(2), rawPin(1)] }));
    await loadChatPins(CHAT);
    vi.mocked(listMessagePins).mockClear();
  });

  test("a hidden message leaves the list at once (the server sends no event for it)", () => {
    forgetPinnedMessages(CHAT, [id(2)]);
    expect(ids()).toEqual([id(3), id(1)]);
    expect(getChatPinsStatus(CHAT)).toBe("ready");
  });

  test("several at once, subscribers hear about it once", () => {
    const listener = vi.fn();
    subscribeToChatPins(CHAT, listener);
    forgetPinnedMessages(CHAT, [id(3), id(1), id(77)]);
    expect(ids()).toEqual([id(2)]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("messages that are not pinned, bad ids and unknown chats change nothing", () => {
    const listener = vi.fn();
    subscribeToChatPins(CHAT, listener);
    forgetPinnedMessages(CHAT, [id(77), "x", null]);
    forgetPinnedMessages(CHAT, []);
    forgetPinnedMessages(OTHER_CHAT, [id(1)]);
    forgetPinnedMessages("x", [id(1)]);
    expect(ids()).toEqual([id(3), id(2), id(1)]);
    expect(listener).not.toHaveBeenCalled();
    expect(getChatPinsStatus(OTHER_CHAT)).toBe("idle");
  });

  test("a read that was on its way before the hide is read again, not applied", async () => {
    let release;
    vi.mocked(listMessagePins)
      .mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }))
      .mockResolvedValueOnce(reply(200, { pins: [rawPin(3), rawPin(1)] }));
    const reading = loadChatPins(CHAT, { force: true });
    forgetPinnedMessages(CHAT, [id(2)]);
    release(reply(200, { pins: [rawPin(3), rawPin(2), rawPin(1)] }));
    await reading;
    expect(listMessagePins).toHaveBeenCalledTimes(2);
    expect(ids()).toEqual([id(3), id(1)]);
  });
});

describe("whose pins these are", () => {
  test("another person signing in finds nothing of the one before", async () => {
    bindPinStoreToUser(ME);
    vi.mocked(listMessagePins).mockResolvedValue(reply(200, { pins: [rawPin(1)] }));
    await loadChatPins(CHAT);
    expect(ids()).toEqual([id(1)]);
    bindPinStoreToUser(id(901));
    expect(ids()).toEqual([]);
    expect(getChatPinsStatus(CHAT)).toBe("idle");
  });

  test("binding the same person again keeps the lists", async () => {
    bindPinStoreToUser(ME);
    vi.mocked(listMessagePins).mockResolvedValue(reply(200, { pins: [rawPin(1)] }));
    await loadChatPins(CHAT);
    bindPinStoreToUser(ME);
    expect(ids()).toEqual([id(1)]);
  });
});
