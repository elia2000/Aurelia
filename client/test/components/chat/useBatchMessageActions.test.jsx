import { describe, test, expect, vi, beforeEach } from "vitest";
import { renderHook } from "vitest-browser-react";
import { act } from "react";

const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock("../../../src/utils/toast.js", () => toast);
const batch = vi.hoisted(() => ({ forwardMessages: vi.fn(), deleteMessages: vi.fn() }));
vi.mock("../../../src/api/batchApi.js", () => batch);
const chatApi = vi.hoisted(() => ({ getSavedMessagesChat: vi.fn() }));
vi.mock("../../../src/api/chatApi.js", () => chatApi);

import { useBatchMessageActions } from "../../../src/hooks/chat/useBatchMessageActions.js";
import { createBatchSelectionStore } from "../../../src/utils/batchSelectionStore.js";

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const msg = (n, extra = {}) => ({
  id: uuid(n),
  username: "me",
  nickname: "Me",
  body: `text ${n}`,
  created_at: new Date(2026, 9, 20, 14, n).toISOString(),
  files: [],
  ...extra,
});
const CHAT = "chat-1";
const USER = { id: "u1", username: "me" };

const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

let store;
let loadChats;
let setMessages;
let pruneCache;

const inAct = async (fn) => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    await act(async () => {
      await fn();
    });
  } finally {
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  }
};

const mount = async (props = {}) =>
  renderHook((p) => useBatchMessageActions(p), {
    initialProps: {
      user: USER,
      activeChatId: CHAT,
      chats: [
        { id: "saved-1", type: "saved" },
        { id: "chat-2", type: "dm" },
      ],
      loadChats,
      setMessages,
      pruneDeletedMessagesFromCache: pruneCache,
      canDeleteMessageForEveryone: (m) => m.username === "me",
      isOffline: false,
      store,
      ...props,
    },
  });

beforeEach(() => {
  store = createBatchSelectionStore();
  loadChats = vi.fn(async () => {});
  setMessages = vi.fn();
  pruneCache = vi.fn();
  toast.showToast.mockReset();
  batch.forwardMessages.mockReset();
  batch.deleteMessages.mockReset();
  chatApi.getSavedMessagesChat.mockReset();
});

describe("useBatchMessageActions - Select", () => {
  test("selectMessage starts selection mode in the open chat with that message ticked", async () => {
    const { result } = await mount();
    await inAct(() => result.current.selectMessage(msg(3)));
    expect(store.getSnapshot()).toMatchObject({ chatId: CHAT, active: true, keys: [uuid(3)] });
  });

  test("a message that was being sent keeps the key its row has", async () => {
    const { result } = await mount();
    await inAct(() => result.current.selectMessage(msg(3, { _clientId: "client-9" })));
    expect(store.getSnapshot().keys).toEqual(["client-9"]);
  });
});

describe("useBatchMessageActions - forward", () => {
  const messages = [msg(1), msg(2), msg(3)];

  test("forwardSelected opens the chat chooser with the Saved messages chat", async () => {
    const { result } = await mount();
    await inAct(() => result.current.forwardSelected(messages));
    const forward = result.current.modalProps.forward;
    expect(forward).toBeTruthy();
    expect(forward.savedChat).toEqual({ id: "saved-1", type: "saved" });
    expect(forward.sourceChatId).toBe(CHAT);
    expect(forward.currentUser).toBe(USER);
    expect(result.current.modalProps.remove).toBeNull();
  });

  test("without Saved messages in the list it asks the server for it", async () => {
    chatApi.getSavedMessagesChat.mockResolvedValue(reply(200, { id: "saved-9" }));
    const { result } = await mount({ chats: [] });
    await inAct(() => result.current.forwardSelected(messages));
    expect(chatApi.getSavedMessagesChat).toHaveBeenCalledWith("me");
    expect(result.current.modalProps.forward.savedChat).toMatchObject({ id: "saved-9", type: "saved" });
  });

  test("if that fails the chooser still opens", async () => {
    chatApi.getSavedMessagesChat.mockRejectedValue(new Error("offline"));
    const { result } = await mount({ chats: [] });
    await inAct(() => result.current.forwardSelected(messages));
    expect(result.current.modalProps.forward.savedChat).toBeNull();
  });

  test("closing the chooser keeps the selection", async () => {
    const { result } = await mount();
    await inAct(() => store.enter(CHAT, uuid(1)));
    await inAct(() => result.current.forwardSelected(messages));
    await inAct(() => result.current.modalProps.forward.onClose());
    expect(result.current.modalProps.forward).toBeNull();
    expect(store.getSnapshot().active).toBe(true);
  });

  test("sends the messages in one batch request, oldest first, and reports 'N messages forwarded'", async () => {
    batch.forwardMessages.mockResolvedValue(
      reply(200, {
        forwarded: messages.map((m) => ({ id: `n-${m.id}`, chatId: "chat-2", sourceMessageId: m.id })),
        failed: [],
      }),
    );
    const { result } = await mount();
    await inAct(() => store.enter(CHAT, uuid(1)));
    await inAct(() => result.current.forwardSelected(messages));
    await inAct(() => result.current.modalProps.forward.onSubmit(["chat-2"]));
    expect(batch.forwardMessages).toHaveBeenCalledTimes(1);
    expect(batch.forwardMessages).toHaveBeenCalledWith({
      username: "me",
      sourceMessageIds: [uuid(1), uuid(2), uuid(3)],
      targetChatIds: ["chat-2"],
    });
    expect(toast.showToast).toHaveBeenCalledWith("3 messages forwarded", { tone: "info" });
    // done: the chooser is closed, selection mode ended, the chat list refreshed
    expect(result.current.modalProps.forward).toBeNull();
    expect(store.getSnapshot().active).toBe(false);
    expect(loadChats).toHaveBeenCalledWith({ silent: true });
  });

  test("a large batch is split into requests the server accepts, sent one after the other", async () => {
    const many = Array.from({ length: 100 }, (_, i) => msg(i + 1));
    const order = [];
    batch.forwardMessages.mockImplementation(async (request) => {
      order.push(request);
      return reply(200, {
        forwarded: request.sourceMessageIds.flatMap((id) =>
          request.targetChatIds.map((chatId) => ({ id: `n`, chatId, sourceMessageId: id })),
        ),
        failed: [],
      });
    });
    const { result } = await mount();
    await inAct(() => result.current.forwardSelected(many));
    const targets = Array.from({ length: 10 }, (_, i) => `c${i}`);
    await inAct(() => result.current.modalProps.forward.onSubmit(targets));
    expect(order.length).toBeGreaterThan(1);
    order.forEach((r) => expect(r.sourceMessageIds.length * r.targetChatIds.length).toBeLessThanOrEqual(500));
    // the first chunk holds the oldest messages
    expect(order[0].sourceMessageIds[0]).toBe(uuid(1));
    expect(toast.showToast).toHaveBeenCalledWith("100 messages forwarded", { tone: "info" });
  });

  test("some failed: tells how many and why, and the person is done", async () => {
    batch.forwardMessages.mockResolvedValue(
      reply(200, {
        forwarded: [{ id: "n1", chatId: "chat-2", sourceMessageId: uuid(1) }],
        failed: [
          { sourceMessageId: uuid(2), code: "gone", error: "x" },
          { sourceMessageId: uuid(3), code: "gone", error: "x" },
        ],
      }),
    );
    const { result } = await mount();
    await inAct(() => store.enter(CHAT, uuid(1)));
    await inAct(() => result.current.forwardSelected(messages));
    await inAct(() => result.current.modalProps.forward.onSubmit(["chat-2"]));
    expect(toast.showToast).toHaveBeenCalledWith(
      "1 of 3 messages forwarded. Some messages were deleted or removed from your view.",
      { tone: "error" },
    );
    expect(result.current.modalProps.forward).toBeNull();
    expect(store.getSnapshot().active).toBe(false);
  });

  test("nothing forwarded: says why and keeps the chooser and the selection to try again", async () => {
    batch.forwardMessages.mockResolvedValue(
      reply(403, { error: "Cannot send to one or more selected chats." }),
    );
    const { result } = await mount();
    await inAct(() => store.enter(CHAT, uuid(1)));
    await inAct(() => result.current.forwardSelected(messages));
    await inAct(() => result.current.modalProps.forward.onSubmit(["chat-2"]));
    expect(toast.showToast).toHaveBeenCalledWith(
      "Couldn't forward the messages. Cannot send to one or more selected chats.",
      { tone: "error" },
    );
    expect(result.current.modalProps.forward).toBeTruthy();
    expect(store.getSnapshot().active).toBe(true);
    expect(loadChats).not.toHaveBeenCalled();
  });

  test("a failing connection is reported the same way", async () => {
    batch.forwardMessages.mockRejectedValue(new TypeError("Failed to fetch"));
    const { result } = await mount();
    await inAct(() => result.current.forwardSelected(messages));
    await inAct(() => result.current.modalProps.forward.onSubmit(["chat-2"]));
    expect(toast.showToast).toHaveBeenCalledWith(
      "Couldn't forward the messages. Check your connection and try again.",
      { tone: "error" },
    );
    expect(result.current.modalProps.forward).toBeTruthy();
  });

  test("the chooser is marked busy while sending", async () => {
    let finish;
    batch.forwardMessages.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const { result } = await mount();
    await inAct(() => result.current.forwardSelected(messages));
    let pending;
    await inAct(() => {
      pending = result.current.modalProps.forward.onSubmit(["chat-2"]);
    });
    expect(result.current.modalProps.forward.busy).toBe(true);
    await inAct(async () => {
      finish(reply(200, { forwarded: messages.map((m) => ({ chatId: "chat-2", sourceMessageId: m.id })), failed: [] }));
      await pending;
    });
    expect(result.current.modalProps.forward).toBeNull();
  });

  test("opening another chat closes the chooser", async () => {
    const { result, rerender } = await mount();
    await inAct(() => result.current.forwardSelected(messages));
    expect(result.current.modalProps.forward).toBeTruthy();
    await rerender({
      user: USER,
      activeChatId: "chat-9",
      chats: [],
      loadChats,
      setMessages,
      pruneDeletedMessagesFromCache: pruneCache,
      canDeleteMessageForEveryone: () => true,
      store,
    });
    expect(result.current.modalProps.forward).toBeNull();
  });
});

describe("useBatchMessageActions - delete", () => {
  const mine = [msg(1), msg(2)];
  const mixed = [msg(1), msg(2, { username: "bob" }), msg(3, { messageType: "call", call: { kind: "audio" } })];

  test("deleteSelected opens the question with how many may go for everyone", async () => {
    const { result } = await mount();
    await inAct(() => result.current.deleteSelected(mixed));
    expect(result.current.modalProps.remove).toMatchObject({ total: 3, everyoneCount: 1, offline: false });
  });

  test("hides for me: one request with scope self; the messages leave the list", async () => {
    batch.deleteMessages.mockResolvedValue(
      reply(200, { results: mine.map((m) => ({ messageId: m.id, ok: true })) }),
    );
    const { result } = await mount();
    await inAct(() => store.enter(CHAT, uuid(1)));
    await inAct(() => result.current.deleteSelected(mine));
    await inAct(() => result.current.modalProps.remove.onConfirm(false));
    expect(batch.deleteMessages).toHaveBeenCalledTimes(1);
    expect(batch.deleteMessages).toHaveBeenCalledWith({
      chatId: CHAT,
      username: "me",
      messageIds: [uuid(1), uuid(2)],
      scope: "self",
    });
    // the list: the deleted are filtered out and replies to them lose their quote
    const update = setMessages.mock.calls[0][0];
    const list = [msg(1), msg(2), msg(3), msg(4, { replyTo: { id: uuid(2) } })];
    expect(update(list).map((m) => [m.id, m.replyTo?.id ?? null])).toEqual([
      [uuid(3), null],
      [uuid(4), null],
    ]);
    expect(pruneCache).toHaveBeenCalledWith(CHAT, [uuid(1), uuid(2)]);
    expect(toast.showToast).toHaveBeenCalledWith("2 messages deleted", { tone: "info" });
    expect(result.current.modalProps.remove).toBeNull();
    expect(store.getSnapshot().active).toBe(false);
    expect(loadChats).toHaveBeenCalledWith({ silent: true });
  });

  test("for everyone: what may goes with scope everyone, the rest is hidden for me", async () => {
    batch.deleteMessages.mockImplementation(async ({ messageIds }) =>
      reply(200, { results: messageIds.map((messageId) => ({ messageId, ok: true })) }),
    );
    const { result } = await mount();
    await inAct(() => result.current.deleteSelected(mixed));
    await inAct(() => result.current.modalProps.remove.onConfirm(true));
    expect(batch.deleteMessages).toHaveBeenCalledTimes(2);
    expect(batch.deleteMessages).toHaveBeenNthCalledWith(1, {
      chatId: CHAT,
      username: "me",
      messageIds: [uuid(1)],
      scope: "everyone",
    });
    // someone else's message and a call entry can only be hidden
    expect(batch.deleteMessages).toHaveBeenNthCalledWith(2, {
      chatId: CHAT,
      username: "me",
      messageIds: [uuid(2), uuid(3)],
      scope: "self",
    });
    expect(toast.showToast).toHaveBeenCalledWith("3 messages deleted", { tone: "info" });
  });

  test("some failed: reports them from the results; those stay in the list and selected", async () => {
    batch.deleteMessages.mockResolvedValue(
      reply(200, {
        results: [
          { messageId: uuid(1), ok: true },
          { messageId: uuid(2), ok: false, code: "forbidden", error: "You cannot delete this message for everyone." },
        ],
      }),
    );
    const { result } = await mount();
    await inAct(() => store.enter(CHAT, uuid(1)));
    await inAct(() => result.current.deleteSelected(mine));
    await inAct(() => result.current.modalProps.remove.onConfirm(false));
    expect(toast.showToast).toHaveBeenCalledWith(
      "1 of 2 messages deleted. You cannot delete this message for everyone.",
      { tone: "error" },
    );
    // only the one that went is taken out of the list
    const update = setMessages.mock.calls[0][0];
    expect(update([msg(1), msg(2)]).map((m) => m.id)).toEqual([uuid(2)]);
    expect(pruneCache).toHaveBeenCalledWith(CHAT, [uuid(1)]);
    // the question is closed, and selection mode goes on so the person can try again
    expect(result.current.modalProps.remove).toBeNull();
    expect(store.getSnapshot().active).toBe(true);
  });

  test("none deleted: the list is left alone", async () => {
    batch.deleteMessages.mockResolvedValue(reply(403, { error: "Not a member of this chat." }));
    const { result } = await mount();
    await inAct(() => store.enter(CHAT, uuid(1)));
    await inAct(() => result.current.deleteSelected(mine));
    await inAct(() => result.current.modalProps.remove.onConfirm(false));
    expect(setMessages).not.toHaveBeenCalled();
    expect(pruneCache).not.toHaveBeenCalled();
    expect(toast.showToast).toHaveBeenCalledWith(
      "Couldn't delete the messages. Not a member of this chat.",
      { tone: "error" },
    );
    expect(store.getSnapshot().active).toBe(true);
  });

  test("a failing connection is reported and nothing is removed", async () => {
    batch.deleteMessages.mockRejectedValue(new TypeError("Failed to fetch"));
    const { result } = await mount();
    await inAct(() => result.current.deleteSelected(mine));
    await inAct(() => result.current.modalProps.remove.onConfirm(false));
    expect(setMessages).not.toHaveBeenCalled();
    expect(toast.showToast).toHaveBeenCalledWith(
      "Couldn't delete the messages. Check your connection and try again.",
      { tone: "error" },
    );
  });

  test("offline is passed on, so the question hides the 'for everyone' switch", async () => {
    const { result } = await mount({ isOffline: true });
    await inAct(() => result.current.deleteSelected(mine));
    expect(result.current.modalProps.remove.offline).toBe(true);
  });

  test("cancelling the question keeps the selection", async () => {
    const { result } = await mount();
    await inAct(() => store.enter(CHAT, uuid(1)));
    await inAct(() => result.current.deleteSelected(mine));
    await inAct(() => result.current.modalProps.remove.onClose());
    expect(result.current.modalProps.remove).toBeNull();
    expect(store.getSnapshot().active).toBe(true);
    expect(batch.deleteMessages).not.toHaveBeenCalled();
  });
});
