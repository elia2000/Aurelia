import { useCallback, useEffect, useRef } from "react";
import { getMessageElement, jumpToLoadedMessage } from "../../utils/messageJump.js";
import { serverIdOfMessage as serverIdOf } from "../../utils/messageIds.js";
import { normalizeUuid } from "../../utils/uuidUtils.js";
import { showToast } from "../../utils/toast.js";

// Older pages are asked for in growing steps, so a pin from months ago costs a
// few requests and not hundreds. The window is always the latest messages plus
// everything older up to the one we look for, with no gap.
const GROWTH = 3;
const MAX_PAGE = 1000;
const MAX_ROUNDS = 6;
const SETTLE_MS = 600;

const nextFrame = () =>
  new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 16);
  });

/**
 * Returns `jumpToMessage(messageId)`: scrolls the open chat to that message and
 * flashes it, first loading older messages when it is not in the loaded
 * window. Resolves true when the person was taken there, false (with a notice)
 * when the message is gone.
 *
 * The returned function never changes, and reads the chat through refs: a
 * message row keeps the first one it was given.
 */
export function useJumpToMessage({
  activeChatIdRef,
  messages,
  hasOlderMessages,
  loadMessages,
  chatScrollRef,
  pageSize,
  onJump = null,
}) {
  const latest = useRef({ messages, hasOlderMessages, loadMessages, pageSize, onJump });
  useEffect(() => {
    latest.current = { messages, hasOlderMessages, loadMessages, pageSize, onJump };
  });
  const tokenRef = useRef(0);
  useEffect(() => () => { tokenRef.current += 1; }, []);

  return useCallback(
    async (messageId) => {
      const id = normalizeUuid(messageId);
      if (!id) return false;
      const chatId = activeChatIdRef.current;
      const token = (tokenRef.current += 1);
      const stale = () => token !== tokenRef.current || activeChatIdRef.current !== chatId;

      const isOnPage = () =>
        latest.current.messages.some((msg) => serverIdOf(msg) === id) &&
        Boolean(getMessageElement(id));

      // After a load, wait until the new messages are in the state and drawn.
      const settle = async (previous) => {
        const startedAt = Date.now();
        while (Date.now() - startedAt < SETTLE_MS) {
          await nextFrame();
          if (isOnPage()) return;
          if (latest.current.messages !== previous) {
            await nextFrame();
            return;
          }
        }
      };

      if (!isOnPage()) {
        let size = Math.max(20, Number(latest.current.pageSize) || 60);
        for (let round = 0; round < MAX_ROUNDS && !isOnPage(); round += 1) {
          const { messages: loaded, hasOlderMessages: hasOlder, loadMessages: load } = latest.current;
          const oldest = loaded.find((msg) => serverIdOf(msg));
          if (!oldest || !hasOlder || typeof load !== "function") break;
          await load(chatId, {
            silent: true,
            prepend: true,
            beforeId: oldest._serverId || oldest.id,
            beforeCreatedAt: oldest.created_at,
            limit: size,
          });
          if (stale()) return false;
          await settle(loaded);
          if (stale()) return false;
          size = Math.min(MAX_PAGE, size * GROWTH);
        }
      }
      if (stale()) return false;

      if (!isOnPage()) {
        // The rounds run out before the history does: the message may well
        // still exist, so do not say it is gone.
        showToast(
          latest.current.hasOlderMessages
            ? "That message is too far back to jump to."
            : "That message is no longer available.",
          { tone: "error" },
        );
        return false;
      }
      latest.current.onJump?.();
      return jumpToLoadedMessage(id, chatScrollRef?.current || null);
    },
    [activeChatIdRef, chatScrollRef],
  );
}
