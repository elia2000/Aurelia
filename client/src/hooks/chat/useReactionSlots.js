import { createElement, useCallback, useLayoutEffect, useRef } from "react";
import ReactionChips from "../../components/chat/reactions/ReactionChips.jsx";
import { bindReactionStoreToUser, seedReactions } from "../../utils/reactionStore.js";
import {
  canListReactors,
  canReactToMessage,
  getReactionMessageId,
} from "../../utils/reactions.js";

/**
 * The reaction chips for the rows of the open chat.
 *
 * - Hands the reactions that came with the messages (the list, the cache) to
 *   the reaction store before the screen is drawn.
 * - `getReactionsSlot(msg)` gives MessageItem its `reactionsSlot`: the same
 *   element for the same message as long as nothing about it changed, so the
 *   rows (which are memoised) are not redrawn when the chat is.
 */
export function useReactionSlots({ messages, chatId, chatType, user, members, isOwn }) {
  const cache = useRef({ scope: "", elements: new Map() });

  const userId = user?.id;
  useLayoutEffect(() => {
    // (before seeding: what a person before this one knew is let go first)
    bindReactionStoreToUser(userId);
    seedReactions(messages);
  }, [messages, userId]);

  const selfId = String(user?.id ?? "").toLowerCase();
  const isOwner =
    Boolean(selfId) &&
    (Array.isArray(members) ? members : []).some(
      (member) =>
        String(member?.id ?? "").toLowerCase() === selfId &&
        String(member?.role || "").toLowerCase() === "owner",
    );
  const canList = canListReactors({ chatType, isOwner });

  return useCallback(
    (msg) => {
      if (!chatId || !canReactToMessage(msg)) return null;
      const messageId = getReactionMessageId(msg);
      const own = Boolean(isOwn?.(msg));
      const scope = `${chatId}|${canList ? 1 : 0}`;
      if (cache.current.scope !== scope) cache.current = { scope, elements: new Map() };
      const key = `${messageId}|${own ? 1 : 0}`;
      let element = cache.current.elements.get(key);
      if (!element) {
        element = createElement(ReactionChips, {
          chatId,
          messageId,
          isOwn: own,
          canListReactors: canList,
        });
        cache.current.elements.set(key, element);
      }
      return element;
    },
    [chatId, canList, isOwn],
  );
}
