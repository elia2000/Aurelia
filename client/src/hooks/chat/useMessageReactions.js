import { useCallback, useSyncExternalStore } from "react";
import { getReactionList, subscribeToReactions } from "../../utils/reactionStore.js";

/** The reaction chips of one message: [{ emoji, count, reacted }] (the same array until something changes). */
export function useMessageReactions(messageId) {
  const subscribe = useCallback(
    (listener) => subscribeToReactions(messageId, listener),
    [messageId],
  );
  const getSnapshot = useCallback(() => getReactionList(messageId), [messageId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
