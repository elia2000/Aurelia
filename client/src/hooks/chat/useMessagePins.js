import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { REALTIME_OPEN_EVENT } from "../../calls/callContext.js";
import {
  canManagePins,
  getMemberRole,
  isPinnableMessage,
} from "../../utils/messagePins.js";
import {
  getChatPins,
  getChatPinsStatus,
  invalidateAllPins,
  isMessagePinned,
  loadChatPins,
  pinChatMessage,
  subscribeToChatPins,
  unpinAllChatMessages,
  unpinChatMessage,
} from "../../utils/pinStore.js";
import { normalizeUuid } from "../../utils/uuidUtils.js";

const NO_PINS = Object.freeze([]);

/**
 * The pinned messages of a chat, newest first. The list is read when the chat
 * is shown (and again when the connection comes back after a break), and kept
 * current by the realtime events (see utils/pinStore.js).
 */
export function useChatMessagePins(chatId) {
  const id = normalizeUuid(chatId);
  const subscribe = useCallback((listener) => subscribeToChatPins(id, listener), [id]);
  const pins = useSyncExternalStore(
    subscribe,
    () => getChatPins(id),
    () => NO_PINS,
  );
  const status = useSyncExternalStore(
    subscribe,
    () => getChatPinsStatus(id),
    () => "idle",
  );

  useEffect(() => {
    if (id && (status === "idle" || status === "stale")) void loadChatPins(id);
  }, [id, status]);

  useEffect(() => {
    const onOpen = (event) => invalidateAllPins({ force: Boolean(event?.detail?.reconnected) });
    window.addEventListener(REALTIME_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(REALTIME_OPEN_EVENT, onOpen);
  }, []);

  return { pins, status };
}

/**
 * What the open chat's menus need to pin and unpin messages. Every function
 * is stable and reads the chat through a ref: a message row keeps the first
 * ones it was given.
 *
 * @param {{ activeChatId: string|null, activeChat: object|null, user: object|null, isOffline?: boolean }} params
 */
export function useMessagePinActions({ activeChatId, activeChat, user, isOffline = false }) {
  const role = getMemberRole(activeChat?.members, user?.id);
  const canManage = canManagePins({
    chatType: activeChat?.type,
    role,
    allowMemberPins: activeChat?.allow_member_pins,
  });

  const latest = useRef({ chatId: null, canManage: false, isOffline: false });
  useEffect(() => {
    latest.current = { chatId: normalizeUuid(activeChatId), canManage, isOffline };
  });

  /** Should the menu offer Pin / Unpin for this message? */
  const canPinMessage = useCallback(
    (message) => latest.current.canManage && isPinnableMessage(message),
    [],
  );

  const isPinned = useCallback(
    (message) =>
      isMessagePinned(latest.current.chatId, message?._serverId || message?.id),
    [],
  );

  const pin = useCallback(
    (message) =>
      pinChatMessage(latest.current.chatId, message?._serverId || message?.id),
    [],
  );

  const unpin = useCallback(
    (messageOrId) =>
      unpinChatMessage(
        latest.current.chatId,
        typeof messageOrId === "string"
          ? messageOrId
          : messageOrId?._serverId || messageOrId?.id,
      ),
    [],
  );

  const unpinAll = useCallback(() => unpinAllChatMessages(latest.current.chatId), []);

  return {
    canManagePins: canManage,
    canPinMessage,
    isMessagePinned: isPinned,
    pinMessage: pin,
    unpinMessage: unpin,
    unpinAllMessages: unpinAll,
  };
}
