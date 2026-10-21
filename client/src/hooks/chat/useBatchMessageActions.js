import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { deleteMessages, forwardMessages } from "../../api/batchApi.js";
import { getSavedMessagesChat } from "../../api/chatApi.js";
import {
  getServerMessageId,
  interpretDeleteResponse,
  interpretForwardResponse,
  planDelete,
  planForwardRequests,
  summarizeDelete,
  summarizeForward,
} from "../../utils/batchMessages.js";
import { getMessageKey } from "../../utils/batchSelection.js";
import { batchSelectionStore } from "../../utils/batchSelectionStore.js";
import { forgetPinnedMessages } from "../../utils/pinStore.js";
import { showToast } from "../../utils/toast.js";
import { normalizeUuid } from "../../utils/uuidUtils.js";

const readJson = async (res) => {
  try {
    return await res.json();
  } catch {
    return null;
  }
};

const NETWORK_ERROR = "Check your connection and try again.";

/**
 * Forward and delete for the messages ticked in selection mode, for the chat
 * page: what the selection bar's buttons and the message menu's "Select" call,
 * and the props of the two questions they open (<BatchActionModals />).
 *
 * Forward goes through the batch endpoint, split into requests the server
 * accepts, and the answer is read per message. Delete asks first (for
 * everyone where the person may, otherwise only out of their own view) and
 * then takes the messages that went out of the list; the ones that failed
 * stay ticked so the person can try again.
 */
export function useBatchMessageActions({
  user,
  activeChatId,
  chats,
  loadChats,
  setMessages,
  pruneDeletedMessagesFromCache,
  canDeleteMessageForEveryone,
  isOffline = false,
  store = batchSelectionStore,
}) {
  const [forwardState, setForwardState] = useState(null);
  const [forwardBusy, setForwardBusy] = useState(false);
  const [deleteState, setDeleteState] = useState(null);

  // The handlers read the latest values from here, so they keep their identity.
  const latest = useRef({});
  useLayoutEffect(() => {
    latest.current = {
      user,
      activeChatId,
      chats,
      loadChats,
      setMessages,
      pruneDeletedMessagesFromCache,
      canDeleteMessageForEveryone,
      isOffline,
      forwardState,
      deleteState,
    };
  });

  // The questions belong to the chat they were asked in.
  useEffect(() => {
    setForwardState(null);
    setDeleteState(null);
  }, [activeChatId]);

  // "Select" in the message menu.
  const selectMessage = useCallback(
    (message) => {
      const chatId = latest.current.activeChatId;
      const key = getMessageKey(message);
      if (chatId && key) store.enter(chatId, key);
    },
    [store],
  );

  // ---- forward ---------------------------------------------------------------
  const forwardSelected = useCallback(async (messages) => {
    const { chats: allChats, user: me } = latest.current;
    if (!Array.isArray(messages) || !messages.length) return;
    // The "Saved messages" chat is a chat like the others, kept apart from the list.
    let savedChat = (allChats || []).find(
      (chat) => String(chat?.type || "").toLowerCase() === "saved",
    );
    if (!savedChat && me?.username) {
      try {
        const res = await getSavedMessagesChat(me.username);
        const data = await readJson(res);
        if (res.ok && data?.id) {
          savedChat = {
            id: data.id,
            type: "saved",
            name: "Saved messages",
            members: [],
            group_color: "#10b981",
            group_avatar_url: "",
            last_outgoing_time: null,
            last_time: null,
          };
        }
      } catch {
        // The chooser just has no Saved messages entry.
      }
    }
    setForwardState({ messages, savedChat: savedChat || null });
  }, []);

  const closeForward = useCallback(() => setForwardState(null), []);

  const submitForward = useCallback(
    async (targetChatIds) => {
      const { forwardState: state, user: me, loadChats: reload } = latest.current;
      if (!state || !me?.username || !targetChatIds?.length) return;
      const sourceIds = state.messages.map(getServerMessageId).filter(Boolean);
      const forwarded = [];
      const failed = [];
      setForwardBusy(true);
      try {
        // One after the other: within a chat the messages must arrive oldest first.
        for (const request of planForwardRequests(sourceIds, targetChatIds)) {
          try {
            const res = await forwardMessages({ username: me.username, ...request });
            const data = await readJson(res);
            const part = interpretForwardResponse({ ok: res.ok, data }, request);
            forwarded.push(...part.forwarded);
            failed.push(...part.failed);
          } catch {
            request.sourceMessageIds.forEach((sourceMessageId) =>
              failed.push({
                sourceMessageId,
                targetChatId: null,
                code: "network",
                error: NETWORK_ERROR,
              }),
            );
          }
        }
      } finally {
        setForwardBusy(false);
      }
      const summary = summarizeForward({ sourceIds, forwarded, failed });
      showToast(summary.text, { tone: summary.tone });
      if (!summary.forwardedCount) return; // nothing went: keep the chooser and the ticks to try again
      setForwardState(null);
      store.exit();
      void reload?.({ silent: true });
    },
    [store],
  );

  // ---- delete ----------------------------------------------------------------
  const deleteSelected = useCallback((messages) => {
    if (!Array.isArray(messages) || !messages.length) return;
    setDeleteState({ messages });
  }, []);

  const closeDelete = useCallback(() => setDeleteState(null), []);

  const confirmDelete = useCallback(
    async (deleteForEveryone) => {
      const {
        deleteState: state,
        user: me,
        activeChatId: chatId,
        canDeleteMessageForEveryone: canEveryone,
        setMessages: updateMessages,
        pruneDeletedMessagesFromCache: pruneCache,
        loadChats: reload,
      } = latest.current;
      if (!state || !me?.username || !chatId) return;
      const plan = planDelete(state.messages, { canDeleteForEveryone: canEveryone });
      const groups = deleteForEveryone
        ? [
            { scope: "everyone", ids: plan.everyoneIds },
            { scope: "self", ids: plan.selfOnlyIds },
          ]
        : [{ scope: "self", ids: plan.ids }];

      const okIds = [];
      const failed = [];
      for (const { scope, ids } of groups) {
        if (!ids.length) continue;
        try {
          const res = await deleteMessages({
            chatId,
            username: me.username,
            messageIds: ids,
            scope,
          });
          const data = await readJson(res);
          const part = interpretDeleteResponse({ ok: res.ok, data }, ids);
          okIds.push(...part.okIds);
          failed.push(...part.failed);
        } catch {
          ids.forEach((messageId) =>
            failed.push({ messageId, code: "network", error: NETWORK_ERROR }),
          );
        }
      }

      if (okIds.length) {
        // Hiding a message for the person sends no event, and the event of a
        // delete for everyone may be late: take them out of the list here.
        const gone = new Set(okIds);
        updateMessages?.((prev) =>
          prev
            .filter((msg) => !gone.has(normalizeUuid(msg?._serverId || msg?.id)))
            .map((msg) => {
              const replyId = normalizeUuid(msg?.replyTo?.id);
              return replyId && gone.has(replyId) ? { ...msg, replyTo: null } : msg;
            }),
        );
        pruneCache?.(chatId, okIds);
        // A message hidden for the person is gone from their pins as well, and
        // the server says nothing about it.
        forgetPinnedMessages(chatId, okIds);
        void reload?.({ silent: true });
      }
      const summary = summarizeDelete({
        total: plan.ids.length,
        okCount: okIds.length,
        failed,
      });
      showToast(summary.text, { tone: summary.tone });
      setDeleteState(null);
      if (!failed.length) store.exit();
      // (The messages that failed stay ticked; the ones that went are forgotten
      // by the selection when they leave the list.)
    },
    [store],
  );

  const deletePlan = deleteState
    ? planDelete(deleteState.messages, { canDeleteForEveryone: canDeleteMessageForEveryone })
    : null;

  return {
    selectMessage,
    forwardSelected,
    deleteSelected,
    modalProps: {
      forward: forwardState
        ? {
            chats,
            savedChat: forwardState.savedChat,
            currentUser: user,
            sourceChatId: activeChatId,
            busy: forwardBusy,
            onClose: closeForward,
            onSubmit: submitForward,
          }
        : null,
      remove: deleteState
        ? {
            total: deletePlan.ids.length,
            everyoneCount: deletePlan.everyoneIds.length,
            offline: isOffline,
            onClose: closeDelete,
            onConfirm: confirmDelete,
          }
        : null,
    },
  };
}
