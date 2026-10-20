import { describe, test, expect, vi } from "vitest";
import { createChatPinService } from "../../../lib/services/chatPinService.js";

const USER = { id: "11111111-1111-4111-a111-111111111111", username: "Alice" };
const CHAT = "22222222-2222-4222-a222-222222222222";
const OTHER = "33333333-3333-4333-a333-333333333333";

const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {});

function make(overrides = {}) {
  const emitSseEvent = vi.fn();
  const deps = {
    getSetting: () => 5,
    emitSseEvent,
    isMember: () => true,
    pinChat: () => ({ status: "pinned", position: 0 }),
    removeChatPins: () => 1,
    reorderChatPins: () => ({ status: "ok", changed: true }),
    listChatPins: () => [{ chat_id: CHAT, position: 0 }],
    listChatPinHolders: () => [],
    listChatPinsForUsers: () => [],
    ...overrides,
  };
  return { service: createChatPinService(deps), emitSseEvent, deps };
}

describe("setPinned", () => {
  test("hands the setting (clamped) to the database as the limit", async () => {
    const pinChat = vi.fn(() => ({ status: "pinned", position: 0 }));
    const { service } = make({ pinChat, getSetting: () => 99 });
    await service.setPinned({ user: USER, chatId: CHAT, pinned: true });
    expect(pinChat).toHaveBeenCalledWith({ userId: USER.id, chatId: CHAT, max: 30 });
  });

  test("works without a settings reader: the default limit", async () => {
    const pinChat = vi.fn(() => ({ status: "pinned", position: 0 }));
    const { service } = make({ pinChat, getSetting: undefined });
    await service.setPinned({ user: USER, chatId: CHAT, pinned: true });
    expect(pinChat.mock.calls[0][0].max).toBe(5);
  });

  test("the event goes to the lower-cased username", async () => {
    const { service, emitSseEvent } = make();
    await service.setPinned({ user: USER, chatId: CHAT, pinned: true });
    expect(emitSseEvent).toHaveBeenCalledWith("alice", {
      type: "chat_pins_changed",
      pinned: [{ chatId: CHAT, position: 0 }],
    });
  });

  test("a member that vanished between the check and the write is a 403", async () => {
    const { service, emitSseEvent } = make({ pinChat: () => ({ status: "not_member", position: null }) });
    const result = await service.setPinned({ user: USER, chatId: CHAT, pinned: true });
    expect(result.status).toBe(403);
    expect(emitSseEvent).not.toHaveBeenCalled();
  });

  test("a status it does not know is a 500, never a silent success", async () => {
    const { service, emitSseEvent } = make({ pinChat: () => undefined });
    const result = await service.setPinned({ user: USER, chatId: CHAT, pinned: true });
    expect(result.status).toBe(500);
    expect(result.body.error).toBeTruthy();
    expect(emitSseEvent).not.toHaveBeenCalled();
  });

  test("the position is where the chat really is, even when it was already pinned", async () => {
    const { service } = make({
      pinChat: () => ({ status: "already", position: 2 }),
      listChatPins: () => [
        { chat_id: OTHER, position: 0 },
        { chat_id: CHAT, position: 2 },
      ],
    });
    const result = await service.setPinned({ user: USER, chatId: CHAT, pinned: true });
    expect(result.body.pinPosition).toBe(2);
  });
});

describe("release", () => {
  test("removes the pins and announces the rest once", async () => {
    const { service, emitSseEvent, deps } = make({ removeChatPins: vi.fn(() => 2) });
    expect(await service.release({ user: USER, chatIds: [CHAT, OTHER] })).toBe(2);
    expect(deps.removeChatPins).toHaveBeenCalledWith(USER.id, [CHAT, OTHER]);
    expect(emitSseEvent).toHaveBeenCalledTimes(1);
  });

  test("says nothing when nothing was pinned", async () => {
    const { service, emitSseEvent } = make({ removeChatPins: () => 0 });
    expect(await service.release({ user: USER, chatIds: [CHAT] })).toBe(0);
    expect(emitSseEvent).not.toHaveBeenCalled();
  });

  test("only well-formed UUID strings are passed on", async () => {
    const removeChatPins = vi.fn(() => 0);
    const { service } = make({ removeChatPins });
    await service.release({ user: USER, chatIds: [CHAT, "nope", 7, null, {}, [CHAT]] });
    expect(removeChatPins).toHaveBeenCalledWith(USER.id, [CHAT]);
    removeChatPins.mockClear();
    await service.release({ user: USER, chatIds: ["nope", 7] });
    await service.release({ user: USER, chatIds: [] });
    await service.release({ user: USER, chatIds: undefined });
    await service.release({ user: null, chatIds: [CHAT] });
    expect(removeChatPins).not.toHaveBeenCalled();
  });

  test("never throws: the caller's own change must go ahead", async () => {
    const spy = quiet();
    const { service } = make({
      removeChatPins: () => {
        throw new Error("db down");
      },
    });
    await expect(service.release({ user: USER, chatIds: [CHAT] })).resolves.toBe(0);
    spy.mockRestore();
  });

  test("works with asynchronous database functions", async () => {
    const { service, emitSseEvent } = make({
      removeChatPins: async () => 1,
      listChatPins: async () => [],
    });
    expect(await service.release({ user: USER, chatIds: [CHAT] })).toBe(1);
    expect(emitSseEvent).toHaveBeenCalledWith("alice", { type: "chat_pins_changed", pinned: [] });
  });
});

describe("holdersOf / announceToHolders", () => {
  test("holdersOf is empty rather than an error when the lookup fails", async () => {
    const spy = quiet();
    const { service } = make({
      listChatPinHolders: () => {
        throw new Error("boom");
      },
    });
    expect(await service.holdersOf(CHAT)).toEqual([]);
    spy.mockRestore();
  });

  test("announceToHolders tells each holder their own remaining pins", async () => {
    const { service, emitSseEvent } = make({
      listChatPinsForUsers: () => [{ user_id: "u2", chat_id: OTHER, position: 0 }],
    });
    await service.announceToHolders([
      { user_id: "u1", username: "alice" },
      { user_id: "u2", username: "Bob" },
    ]);
    expect(emitSseEvent).toHaveBeenCalledWith("alice", { type: "chat_pins_changed", pinned: [] });
    expect(emitSseEvent).toHaveBeenCalledWith("bob", {
      type: "chat_pins_changed",
      pinned: [{ chatId: OTHER, position: 0 }],
    });
  });

  test("announceToHolders with nobody does not even query", async () => {
    const listChatPinsForUsers = vi.fn(() => []);
    const { service } = make({ listChatPinsForUsers });
    await service.announceToHolders([]);
    await service.announceToHolders(undefined);
    expect(listChatPinsForUsers).not.toHaveBeenCalled();
  });

  test("announceToHolders never throws", async () => {
    const spy = quiet();
    const { service } = make({
      listChatPinsForUsers: () => {
        throw new Error("boom");
      },
    });
    await expect(service.announceToHolders([{ user_id: "u1", username: "alice" }])).resolves.toBeUndefined();
    spy.mockRestore();
  });
});
