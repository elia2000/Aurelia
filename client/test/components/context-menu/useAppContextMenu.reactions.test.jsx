import { describe, test, expect, vi, beforeEach } from "vitest";
import { renderHook } from "vitest-browser-react";
import { act } from "react";

const api = vi.hoisted(() => ({ reactToMessage: vi.fn(), listMessageReactors: vi.fn() }));
vi.mock("../../../src/api/reactionsApi.js", () => api);

import { useAppContextMenu } from "../../../src/components/context-menu/useAppContextMenu.js";
import {
  resetReactionStore,
  seedReactions,
  subscribeToReactions,
} from "../../../src/utils/reactionStore.js";
import { SHOW_REACTORS_EVENT } from "../../../src/utils/reactions.js";

const CHAT = "44444444-4444-4444-a444-444444444444";
const MSG = "33333333-3333-4333-a333-333333333331";
const HEART = "❤️";

const message = (overrides = {}) => ({
  id: MSG,
  username: "bob",
  body: "Hello",
  files: [],
  ...overrides,
});

const setup = async ({ chatType = "dm", isOwner = false, offline = false } = {}) => {
  const { result } = await renderHook(() =>
    useAppContextMenu({
      activeChatId: CHAT,
      chats: [{ id: CHAT, type: chatType }],
      currentUsername: "alice",
      canCurrentUserEditGroup: isOwner,
      canReplyToMessage: true,
      canEditMessage: () => false,
      canDeleteMessageForEveryone: () => false,
      isOffline: offline,
      sseConnected: !offline,
    }),
  );
  return result;
};

const openFor = async (result, msg, extra = {}) => {
  // act() needs the flag; the test renderer only sets it while it renders.
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    await act(async () => {
      result.current.openContextMenu({
        kind: "message",
        data: { message: msg, ...extra },
        targetEl: document.body,
        event: { clientX: 40, clientY: 40 },
      });
    });
  } finally {
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  }
  return result.current.contextMenu;
};

beforeEach(() => {
  resetReactionStore();
  api.reactToMessage.mockReset();
});

describe("useAppContextMenu - reactions", () => {
  test("a message menu carries the chat and message the quick bar reacts to", async () => {
    const result = await setup();
    const menu = await openFor(result, message());
    expect(menu.reactions).toEqual({ chatId: CHAT, messageId: MSG });
  });

  test("a message that cannot take a reaction gets no bar", async () => {
    const result = await setup();
    for (const msg of [
      message({ _delivery: "sending" }),
      message({ id: "7" }),
      message({ call: { callId: "c", outcome: "missed" } }),
      message({ body: "[[system:joined:Bob]]" }),
    ]) {
      expect((await openFor(result, msg)).reactions).toBeNull();
    }
  });

  test("without a connection there is no bar", async () => {
    const result = await setup({ offline: true });
    expect((await openFor(result, message())).reactions).toBeNull();
  });

  test("the other kinds of menu have no bar", async () => {
    const result = await setup();
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    try {
      await act(async () => {
        result.current.openContextMenu({
          kind: "chat",
          data: { chat: { id: CHAT, type: "dm", unread_count: 1 } },
          targetEl: document.body,
          event: { clientX: 1, clientY: 1 },
        });
      });
    } finally {
      globalThis.IS_REACT_ACT_ENVIRONMENT = false;
    }
    expect(result.current.contextMenu.reactions).toBeNull();
  });

  test("a message with reactions has 'Reacted by' before Delete", async () => {
    seedReactions([{ id: MSG, reactions: [{ emoji: HEART, count: 1, reacted: false }] }]);
    const result = await setup();
    const menu = await openFor(result, message());
    const ids = menu.items.map((item) => item.id);
    expect(ids).toContain("reacted-by");
    expect(ids.indexOf("reacted-by")).toBe(ids.indexOf("delete") - 1);
  });

  test("a message with no reactions has no 'Reacted by'", async () => {
    const result = await setup();
    const menu = await openFor(result, message());
    expect(menu.items.map((item) => item.id)).not.toContain("reacted-by");
  });

  test("choosing 'Reacted by' asks the chips of that message for the list", async () => {
    seedReactions([{ id: MSG, reactions: [{ emoji: HEART, count: 1, reacted: false }] }]);
    const result = await setup();
    const menu = await openFor(result, message());
    const seen = [];
    const listener = (event) => seen.push(event.detail);
    window.addEventListener(SHOW_REACTORS_EVENT, listener);
    try {
      menu.items.find((item) => item.id === "reacted-by").onSelect();
    } finally {
      window.removeEventListener(SHOW_REACTORS_EVENT, listener);
    }
    expect(seen).toEqual([{ messageId: MSG, emoji: "" }]);
  });

  test("in a channel only its owner is offered 'Reacted by' (subscribers still get the bar)", async () => {
    seedReactions([{ id: MSG, reactions: [{ emoji: HEART, count: 1, reacted: false }] }]);
    const subscriber = await setup({ chatType: "channel", isOwner: false });
    const subscriberMenu = await openFor(subscriber, message());
    expect(subscriberMenu.items.map((item) => item.id)).not.toContain("reacted-by");
    expect(subscriberMenu.reactions).toEqual({ chatId: CHAT, messageId: MSG });

    const owner = await setup({ chatType: "channel", isOwner: true });
    expect((await openFor(owner, message())).items.map((item) => item.id)).toContain("reacted-by");
  });

  test("opening the menu does not wake any chips", async () => {
    seedReactions([{ id: MSG, reactions: [{ emoji: HEART, count: 1, reacted: false }] }]);
    const wake = vi.fn();
    const stop = subscribeToReactions(MSG, wake);
    const result = await setup();
    await openFor(result, message());
    stop();
    expect(wake).not.toHaveBeenCalled();
  });
});
