import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "vitest-browser-react";

vi.mock("../../../src/api/pinsApi.js", () => ({
  listMessagePins: vi.fn(),
  pinMessage: vi.fn(),
  unpinMessage: vi.fn(),
  unpinAllMessages: vi.fn(),
}));
vi.mock("../../../src/utils/toast.js", () => ({ showToast: vi.fn() }));

import { listMessagePins, pinMessage, unpinAllMessages, unpinMessage } from "../../../src/api/pinsApi.js";
import { REALTIME_OPEN_EVENT } from "../../../src/calls/callContext.js";
import { useChatMessagePins, useMessagePinActions } from "../../../src/hooks/chat/useMessagePins.js";
import { applyRealtimePinEvent, resetPinStore } from "../../../src/utils/pinStore.js";

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CHAT = id(100);
const OTHER = id(101);
const ME = id(900);

const rawPin = (n) => ({
  messageId: id(n),
  pinnedBy: ME,
  pinnedAt: `2026-03-0${n}T10:00:00.000Z`,
  message: { id: id(n), senderId: ME, senderName: "Ada", type: "text", text: `m${n}`, hasFile: false, fileKind: null },
});
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

beforeEach(() => {
  resetPinStore();
  for (const fn of [listMessagePins, pinMessage, unpinMessage, unpinAllMessages]) vi.mocked(fn).mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("useChatMessagePins", () => {
  test("reads the pins when a chat is shown", async () => {
    vi.mocked(listMessagePins).mockResolvedValue(reply(200, { pins: [rawPin(2), rawPin(1)] }));
    const hook = await renderHook(() => useChatMessagePins(CHAT));
    await vi.waitFor(() => expect(hook.result.current.pins.map((p) => p.messageId)).toEqual([id(2), id(1)]));
    expect(hook.result.current.status).toBe("ready");
    expect(listMessagePins).toHaveBeenCalledTimes(1);
  });

  test("shows nothing, and asks nothing, without a chat", async () => {
    const hook = await renderHook(() => useChatMessagePins(null));
    expect(hook.result.current.pins).toEqual([]);
    expect(listMessagePins).not.toHaveBeenCalled();
  });

  test("follows the chat that is shown", async () => {
    vi.mocked(listMessagePins).mockImplementation(async (chatId) =>
      reply(200, { pins: chatId === CHAT ? [rawPin(1)] : [rawPin(2)] }),
    );
    const hook = await renderHook(({ chatId }) => useChatMessagePins(chatId), { initialProps: { chatId: CHAT } });
    await vi.waitFor(() => expect(hook.result.current.pins.map((p) => p.messageId)).toEqual([id(1)]));
    await hook.rerender({ chatId: OTHER });
    await vi.waitFor(() => expect(hook.result.current.pins.map((p) => p.messageId)).toEqual([id(2)]));
  });

  test("a realtime unpin updates the list on screen", async () => {
    vi.mocked(listMessagePins).mockResolvedValue(reply(200, { pins: [rawPin(2), rawPin(1)] }));
    const hook = await renderHook(() => useChatMessagePins(CHAT));
    await vi.waitFor(() => expect(hook.result.current.pins).toHaveLength(2));
    applyRealtimePinEvent({ type: "message_unpinned", chatId: CHAT, messageId: id(2) });
    await vi.waitFor(() => expect(hook.result.current.pins.map((p) => p.messageId)).toEqual([id(1)]));
  });

  test("the connection opening again reads an old list again", async () => {
    vi.mocked(listMessagePins).mockResolvedValue(reply(200, { pins: [rawPin(1)] }));
    const hook = await renderHook(() => useChatMessagePins(CHAT));
    await vi.waitFor(() => expect(hook.result.current.status).toBe("ready"));
    // a minute later: the list is old enough to be read again
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 60_000);
    vi.mocked(listMessagePins).mockResolvedValue(reply(200, { pins: [rawPin(2), rawPin(1)] }));
    window.dispatchEvent(new Event(REALTIME_OPEN_EVENT));
    await vi.waitFor(() => expect(hook.result.current.pins).toHaveLength(2));
    expect(listMessagePins).toHaveBeenCalledTimes(2);
  });

  test("stops listening for the connection when it goes away", async () => {
    vi.mocked(listMessagePins).mockResolvedValue(reply(200, { pins: [] }));
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const hook = await renderHook(() => useChatMessagePins(CHAT));
    expect(add.mock.calls.some(([type]) => type === REALTIME_OPEN_EVENT)).toBe(true);
    await hook.unmount();
    expect(remove.mock.calls.some(([type]) => type === REALTIME_OPEN_EVENT)).toBe(true);
  });
});

describe("useMessagePinActions", () => {
  const member = (role) => ({ id: ME, role });
  const run = (activeChat, extra = {}) =>
    renderHook(() =>
      useMessagePinActions({
        activeChatId: CHAT,
        activeChat,
        user: { id: ME },
        ...extra,
      }),
    );
  const sent = { id: id(5), body: "hi", username: "ada" };

  test("a direct chat and Saved Messages: always allowed", async () => {
    expect((await run({ type: "dm", members: [member("member")] })).result.current.canManagePins).toBe(true);
    expect((await run({ type: "saved", members: [member("owner")] })).result.current.canManagePins).toBe(true);
  });

  test("a group: its owner, or everyone when the owner allowed it", async () => {
    expect((await run({ type: "group", members: [member("owner")] })).result.current.canManagePins).toBe(true);
    expect((await run({ type: "group", members: [member("member")] })).result.current.canManagePins).toBe(false);
    expect(
      (await run({ type: "group", allow_member_pins: 1, members: [member("member")] })).result.current.canManagePins,
    ).toBe(true);
  });

  test("a channel: only its owner", async () => {
    expect((await run({ type: "channel", members: [member("owner")] })).result.current.canManagePins).toBe(true);
    expect(
      (await run({ type: "channel", allow_member_pins: 1, members: [member("member")] })).result.current.canManagePins,
    ).toBe(false);
  });

  test("canPinMessage needs both the permission and a pinnable message", async () => {
    const allowed = (await run({ type: "dm", members: [member("member")] })).result.current;
    await vi.waitFor(() => expect(allowed.canPinMessage(sent)).toBe(true));
    expect(allowed.canPinMessage({ id: id(5), body: "[[system:left:Bob]]" })).toBe(false);
    expect(allowed.canPinMessage({ id: "local-1", _delivery: "sending" })).toBe(false);
    const denied = (await run({ type: "group", members: [member("member")] })).result.current;
    expect(denied.canPinMessage(sent)).toBe(false);
  });

  test("pin and unpin act on the open chat", async () => {
    vi.mocked(pinMessage).mockResolvedValue(reply(200, { pins: [rawPin(5)] }));
    vi.mocked(unpinMessage).mockResolvedValue(reply(200, { pins: [] }));
    vi.mocked(unpinAllMessages).mockResolvedValue(reply(200, { pins: [] }));
    const hook = await run({ type: "dm", members: [member("member")] });
    await vi.waitFor(() => expect(hook.result.current.canPinMessage(sent)).toBe(true));
    await hook.result.current.pinMessage(sent);
    expect(pinMessage).toHaveBeenCalledWith(CHAT, id(5));
    expect(hook.result.current.isMessagePinned(sent)).toBe(true);
    await hook.result.current.unpinMessage(sent);
    expect(unpinMessage).toHaveBeenCalledWith(CHAT, id(5));
    expect(hook.result.current.isMessagePinned(sent)).toBe(false);
    await hook.result.current.unpinMessage(id(6)); // by id, from the bar
    expect(unpinMessage).toHaveBeenLastCalledWith(CHAT, id(6));
    await hook.result.current.unpinAllMessages();
    expect(unpinAllMessages).toHaveBeenCalledWith(CHAT);
  });

  test("the functions stay the same between renders (a message row keeps the first)", async () => {
    const hook = await run({ type: "dm", members: [member("member")] });
    const first = hook.result.current;
    await hook.rerender();
    const second = hook.result.current;
    for (const name of ["canPinMessage", "isMessagePinned", "pinMessage", "unpinMessage", "unpinAllMessages"]) {
      expect(second[name]).toBe(first[name]);
    }
  });
});
