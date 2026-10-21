import { useCallback, useEffect, useMemo, useRef } from "react";
import { reorderPinnedChats, setChatPinned } from "../../api/pinsApi.js";
import {
  applyPinnedList,
  applyPinnedOrder,
  describeChatPinError,
  getPinnedChatIds,
  isChatPinned,
  moveId,
} from "../../utils/chatPins.js";
import { notePinnedChatList } from "../../utils/chatPinsTracker.js";
import { getMaxPinnedChats } from "../../utils/pinLimits.js";
import { showToast } from "../../utils/toast.js";
import { normalizeUuid } from "../../utils/uuidUtils.js";

// The pinned list of `chats` as the server's {chatId, position} entries.
const snapshotOf = (chats) =>
  getPinnedChatIds(chats).map((chatId, position) => ({ chatId, position }));

/**
 * The person's pinned chats ("Pin to top"): pin, unpin, move and reorder.
 * The state is the `pinned` / `pinPosition` pair on each chat of the list; a
 * change shows at once and is put back if the server refuses it, and the
 * server's list (the answer, or the chat_pins_changed event that follows it on
 * every device) always replaces what the list says.
 *
 * Changes run one after the other, each starting from the list as it is then,
 * so several quick moves from the menu cannot cross each other.
 */
export function useChatPins({ chats, setChats, isOffline = false }) {
  const latest = useRef({ chats, isOffline });
  useEffect(() => {
    latest.current = { chats, isOffline };
  });
  const queueRef = useRef(Promise.resolve());

  const pinnedChatIds = useMemo(() => getPinnedChatIds(chats), [chats]);

  // Every list set here is also told to the tracker, so a chat-list answer
  // that was read before it cannot put the old pins back.
  const replaceWith = useCallback(
    (list) => {
      notePinnedChatList(list);
      setChats((prev) => applyPinnedList(prev, list));
    },
    [setChats],
  );

  const run = useCallback(
    (task) => {
      const next = queueRef.current.then(task);
      queueRef.current = next.catch(() => {});
      return next;
    },
    [],
  );

  // Sends one change; `optimistic` is the list to show meanwhile.
  const change = useCallback(
    async ({ optimistic, request }) => {
      if (latest.current.isOffline) {
        showToast("You're offline. Try again when you're back online.");
        return false;
      }
      const before = snapshotOf(latest.current.chats);
      notePinnedChatList(optimistic.map((chatId, position) => ({ chatId, position })));
      setChats((prev) => applyPinnedOrder(prev, optimistic));
      try {
        const response = await request();
        const body = await response.json().catch(() => null);
        if (response.ok) {
          replaceWith(body?.pins);
          return true;
        }
        // 409 pin_set_mismatch brings the real list; anything else puts back ours.
        replaceWith(Array.isArray(body?.pins) ? body.pins : before);
        showToast(describeChatPinError({ status: response.status, body, fallbackMax: getMaxPinnedChats() }));
        return false;
      } catch {
        replaceWith(before);
        showToast("Couldn't update the pinned chats. Check your connection.");
        return false;
      }
    },
    [replaceWith, setChats],
  );

  /** Pin the chat to the top, or let it go. */
  const setPinned = useCallback(
    (chatId, pinned) => {
      const id = normalizeUuid(chatId);
      if (!id) return Promise.resolve(false);
      return run(() => {
        const ids = getPinnedChatIds(latest.current.chats);
        const chat = latest.current.chats.find((item) => normalizeUuid(item?.id) === id);
        if (!chat || isChatPinned(chat) === Boolean(pinned)) return false;
        return change({
          optimistic: pinned ? [id, ...ids] : ids.filter((other) => other !== id),
          request: () => setChatPinned(id, pinned),
        });
      });
    },
    [change, run],
  );

  /** Saves a new order: `orderedIds` must be all the pinned chats, top first. */
  const reorder = useCallback(
    (orderedIds) =>
      run(() => {
        const current = getPinnedChatIds(latest.current.chats);
        const same =
          orderedIds.length === current.length &&
          orderedIds.every((chatId, index) => chatId === current[index]);
        if (same || orderedIds.length !== current.length) return false;
        return change({
          optimistic: orderedIds,
          request: () => reorderPinnedChats(orderedIds),
        });
      }),
    [change, run],
  );

  /** Moves a pinned chat one place up (-1) or down (+1). */
  const move = useCallback(
    (chatId, delta) =>
      run(() => {
        const current = getPinnedChatIds(latest.current.chats);
        const next = moveId(current, chatId, delta);
        if (next === current) return false;
        return change({ optimistic: next, request: () => reorderPinnedChats(next) });
      }),
    [change, run],
  );

  return { pinnedChatIds, setPinned, reorder, move };
}
