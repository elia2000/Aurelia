import { Smile } from "../../../icons/lucide.js";
import { requestShowReactors } from "../../../utils/reactionStore.js";
import {
  canListReactors,
  canReactToMessage,
  getReactionMessageId,
} from "../../../utils/reactions.js";

/**
 * What the message menu gets for reactions:
 *   reactions: { chatId, messageId } for the quick reaction bar, or null when
 *              this message cannot take a reaction right now (a call entry, a
 *              message still being sent, no connection);
 *   items:     the "Reacted by" item, when there are reactions and this person
 *              may see who they are.
 * `hasReactions` says whether the message has any (the chips on screen).
 */
export function buildReactionMenuParts({
  message,
  chatId,
  chatType,
  isOwner = false,
  offline = false,
  hasReactions = false,
}) {
  const messageId = getReactionMessageId(message);
  if (!chatId || !messageId || !canReactToMessage(message)) return { reactions: null, items: [] };
  const items =
    hasReactions && canListReactors({ chatType, isOwner })
      ? [
          {
            id: "reacted-by",
            label: "Reacted by",
            icon: Smile,
            onSelect: () => requestShowReactors(messageId),
          },
        ]
      : [];
  return {
    reactions: offline ? null : { chatId, messageId },
    items,
  };
}
