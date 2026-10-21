import { describe, test, expect, vi, beforeEach } from "vitest";
import { renderHook } from "vitest-browser-react";

const api = vi.hoisted(() => ({ reactToMessage: vi.fn(), listMessageReactors: vi.fn() }));
vi.mock("../../../src/api/reactionsApi.js", () => api);

import ReactionChips from "../../../src/components/chat/reactions/ReactionChips.jsx";
import { useReactionSlots } from "../../../src/hooks/chat/useReactionSlots.js";
import { getReactionList, resetReactionStore } from "../../../src/utils/reactionStore.js";

const ME = "11111111-1111-4111-a111-111111111111";
const BOB = "22222222-2222-4222-a222-222222222222";
const CHAT = "44444444-4444-4444-a444-444444444444";
const M1 = "33333333-3333-4333-a333-333333333331";
const M2 = "33333333-3333-4333-a333-333333333332";

const UP = "\u{1F44D}";

const msg = (id, extra = {}) => ({ id, username: "bob", body: "hi", ...extra });
const isOwn = (m) => m.username === "alice";

const slots = async (props = {}) => {
  const initial = {
    messages: [msg(M1)],
    chatId: CHAT,
    chatType: "dm",
    user: { id: ME, username: "alice" },
    members: [],
    isOwn,
    ...props,
  };
  return renderHook((p) => useReactionSlots(p), { initialProps: initial });
};

beforeEach(() => {
  resetReactionStore();
  api.reactToMessage.mockReset();
});

describe("useReactionSlots", () => {
  test("gives a message the chips element for it", async () => {
    const { result } = await slots();
    const slot = result.current(msg(M1));
    expect(slot.type).toBe(ReactionChips);
    expect(slot.props).toMatchObject({ chatId: CHAT, messageId: M1, isOwn: false, canListReactors: true });
  });

  test("my own messages are marked, so the chips line up with the bubble", async () => {
    const { result } = await slots();
    expect(result.current(msg(M1, { username: "alice" })).props.isOwn).toBe(true);
  });

  test("the same message gets the very same element, so memoised rows are not redrawn", async () => {
    const { result, rerender } = await slots();
    const first = result.current(msg(M1));
    await rerender({
      messages: [msg(M1), msg(M2)],
      chatId: CHAT,
      chatType: "dm",
      user: { id: ME, username: "alice" },
      members: [],
      isOwn: (m) => m.username === "alice",
    });
    expect(result.current(msg(M1, { body: "edited" }))).toBe(first);
    expect(result.current(msg(M2))).not.toBe(first);
  });

  test("a message without a server id, a call entry or a system line has no chips", async () => {
    const { result } = await slots();
    expect(result.current(msg("pending-123"))).toBeNull();
    expect(result.current(msg(M1, { _delivery: "sending" }))).toBeNull();
    expect(result.current(msg(M1, { call: { callId: "c" } }))).toBeNull();
    expect(result.current(msg(M1, { body: "[[system:joined:Bob]]" }))).toBeNull();
    expect(result.current(msg(M1, { _systemEvent: { type: "joined" } }))).toBeNull();
  });

  test("a message that gets its server id later gets chips", async () => {
    const { result } = await slots();
    const sending = msg("pending-5", { _clientId: "pending-5" });
    expect(result.current(sending)).toBeNull();
    expect(result.current({ ...sending, _serverId: M2 }).props.messageId).toBe(M2);
  });

  test("with no chat open there is nothing to draw", async () => {
    const { result } = await slots({ chatId: null });
    expect(result.current(msg(M1))).toBeNull();
  });

  test("hands the reactions that came with the messages to the store before the screen is drawn", async () => {
    await slots({
      messages: [msg(M1, { reactions: [{ emoji: UP, count: 2, reacted: true }] }), msg(M2, { reactions: [] })],
    });
    expect(getReactionList(M1)).toEqual([{ emoji: UP, count: 2, reacted: true }]);
    expect(getReactionList(M2)).toEqual([]);
  });

  test("a new list of messages seeds the ones it adds", async () => {
    const { rerender } = await slots();
    await rerender({
      messages: [msg(M1), msg(M2, { reactions: [{ emoji: UP, count: 1, reacted: false }] })],
      chatId: CHAT,
      chatType: "dm",
      user: { id: ME },
      members: [],
      isOwn,
    });
    expect(getReactionList(M2)).toEqual([{ emoji: UP, count: 1, reacted: false }]);
  });

  test("another person signing in does not inherit the flags of the one before", async () => {
    const reactions = [{ emoji: UP, count: 1, reacted: true }];
    const { rerender } = await slots({ messages: [msg(M1, { reactions })] });
    expect(getReactionList(M1)).toEqual([{ emoji: UP, count: 1, reacted: true }]);
    await rerender({
      messages: [msg(M1, { reactions: [{ emoji: UP, count: 1, reacted: false }] })],
      chatId: CHAT,
      chatType: "dm",
      user: { id: BOB, username: "bob" },
      members: [],
      isOwn,
    });
    expect(getReactionList(M1)).toEqual([{ emoji: UP, count: 1, reacted: false }]);
  });

  describe("who may see who reacted", () => {
    const members = [
      { id: ME, role: "member" },
      { id: BOB, role: "owner" },
    ];

    test("in a channel, not a subscriber", async () => {
      const { result } = await slots({ chatType: "channel", members });
      expect(result.current(msg(M1)).props.canListReactors).toBe(false);
    });

    test("in a channel, its owner", async () => {
      const { result } = await slots({
        chatType: "channel",
        members: [{ id: ME.toUpperCase(), role: "Owner" }],
      });
      expect(result.current(msg(M1)).props.canListReactors).toBe(true);
    });

    test("in a group, every member", async () => {
      const { result } = await slots({ chatType: "group", members });
      expect(result.current(msg(M1)).props.canListReactors).toBe(true);
    });

    test("when the right changes the chips are made again", async () => {
      const { result, rerender } = await slots({ chatType: "channel", members });
      const before = result.current(msg(M1));
      await rerender({
        messages: [msg(M1)],
        chatId: CHAT,
        chatType: "channel",
        user: { id: ME, username: "alice" },
        members: [{ id: ME, role: "owner" }],
        isOwn,
      });
      const after = result.current(msg(M1));
      expect(after).not.toBe(before);
      expect(after.props.canListReactors).toBe(true);
    });

    test("another chat gets its own elements", async () => {
      const { result, rerender } = await slots();
      const before = result.current(msg(M1));
      await rerender({
        messages: [msg(M1)],
        chatId: "44444444-4444-4444-a444-444444444449",
        chatType: "dm",
        user: { id: ME },
        members: [],
        isOwn,
      });
      expect(result.current(msg(M1))).not.toBe(before);
    });
  });
});
