import { useCallback, useState } from "react";
import {
  Ban,
  Chat,
  CheckCheck,
  CircleCheck,
  Copy,
  Download,
  Forward,
  GifIcon,
  Pencil,
  Reply,
  Trash,
  User,
  Volume2,
  VolumeX,
} from "../../icons/lucide.js";
import { findGifFile, resolveSaveGifTarget } from "../../gifs/gifMessageActions.js";
import { buildReactionMenuParts } from "../chat/reactions/reactionMenu.js";
import { copyTextToClipboard } from "../../utils/clipboard.js";
import {
  extractMessageBodyText,
  getMessageFiles,
  hasMessageText,
} from "../../utils/messageContent.js";
import { getReactionList } from "../../utils/reactionStore.js";
import { isCallMessage } from "../../utils/callEntry.js";
import { isMessageSelectable } from "../../utils/batchMessages.js";

export function useAppContextMenu({
  activeChatId,
  chats,
  currentUsername,
  canCurrentUserEditGroup,
  canReplyToMessage,
  canEditMessage,
  canDeleteMessageForEveryone,
  onReplyToMessage,
  onEditMessage,
  onDeleteMessage,
  onForwardMessage,
  onSaveMessageFiles,
  // (message, file) -> keeps that GIF in the person's own collection. Left out
  // when the server takes no uploads, which hides the item.
  onSaveGif = null,
  // (message) -> starts selection mode with that message ticked (several
  // messages to forward, delete or copy). Left out, the item is hidden.
  onSelectMessage = null,
  onOpenOrCreateDm,
  onOpenProfile,
  onRemoveGroupMember,
  onMarkChatSeen,
  onToggleChatMute,
  onDeleteChats,
  isOffline: isOfflineProp = false,
  sseConnected = true,
}) {
  const [contextMenu, setContextMenu] = useState(null);

  const findContextMenuLinkTarget = useCallback((eventTarget, targetEl) => {
    const eventNode =
      eventTarget instanceof Element ? eventTarget : eventTarget?.parentElement || null;
    if (!eventNode || !targetEl || !targetEl.contains(eventNode)) return null;
    const anchor = eventNode.closest("a[href]");
    if (!anchor || !targetEl.contains(anchor)) return null;
    const href = String(anchor.href || anchor.getAttribute("href") || "").trim();
    if (!href) return null;
    return href;
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const findExistingDmWithUser = useCallback(
    (username) => {
      const targetUsername = String(username || "").toLowerCase();
      if (!targetUsername) return null;
      return (
        chats.find((chat) => {
          if (chat?.type !== "dm") return false;
          return (chat.members || []).some(
            (member) =>
              String(member?.username || "").toLowerCase() === targetUsername,
          );
        }) || null
      );
    },
    [chats],
  );

  const handleMarkChatSeen = useCallback(
    async (chat) => {
      const chatId = chat?.id || null;
      if (!chatId) return;
      await onMarkChatSeen?.(chat, {
        activeChatId,
      });
    },
    [activeChatId, onMarkChatSeen],
  );

  const openContextMenu = useCallback(
    ({ kind, data, targetEl, event }) => {
      const rect = targetEl?.getBoundingClientRect?.() || null;
      const point = {
        x: Number(event?.clientX || rect?.left || 0),
        y: Number(event?.clientY || rect?.bottom || rect?.top || 0),
      };
      const items = [];
      let reactionParts = null;

      if (kind === "message") {
        const message = data?.message || null;
        const offline =
          data?.isOffline ??
          (isOfflineProp ||
            sseConnected === false ||
            (typeof navigator !== "undefined" && navigator.onLine === false));
        const hasText = hasMessageText(message);
        const linkTarget = findContextMenuLinkTarget(event?.target, targetEl);
        const files = getMessageFiles(message);
        // The GIF the person pointed at (else the first one), for "Save GIF".
        const gifFile =
          onSaveGif && !message?.e2ee
            ? findGifFile(
                message,
                (event?.target instanceof Element
                  ? event.target.closest("[data-file-id]")
                  : null
                )?.getAttribute("data-file-id"),
              )
            : null;
        // Text the user selected with the mouse inside (or across) this message.
        const selectedText = String(data?.selectedText || "");
        items.push(
          ...(selectedText.trim()
            ? [
                {
                  id: "copy-selection",
                  label: "Copy selected text",
                  icon: Copy,
                  onSelect: () => copyTextToClipboard(selectedText),
                },
              ]
            : []),
          ...(canReplyToMessage
            ? [
                {
                  id: "reply",
                  label: "Reply",
                  icon: Reply,
                  onSelect: () => onReplyToMessage?.(message),
                },
              ]
            : []),
          ...(hasText
            ? [
                {
                  id: linkTarget ? "copy-link" : "copy",
                  label: linkTarget ? "Copy link" : "Copy text",
                  icon: Copy,
                  onSelect: () =>
                    copyTextToClipboard(
                      linkTarget || extractMessageBodyText(message?.body),
                    ),
                },
              ]
            : []),
          ...(hasText && canEditMessage?.(message)
            ? [
                {
                  id: "edit",
                  label: "Edit",
                  icon: Pencil,
                  disabled: Boolean(offline),
                  onSelect: () => onEditMessage?.(message),
                },
              ]
            : []),
          // An encrypted video message is one opaque file: saving it would
          // download ciphertext, and the server refuses to forward it (the key
          // is wrapped only for the devices that were in the chat).
          ...(files.length && !message?.e2ee
            ? [
                {
                  id: "save",
                  label: "Save",
                  icon: Download,
                  onSelect: () => onSaveMessageFiles?.(message),
                },
              ]
            : []),
          ...(gifFile
            ? [
                {
                  id: "save-gif",
                  label: "Save GIF",
                  icon: GifIcon,
                  // The server must know the message and the file first.
                  disabled: Boolean(offline) || !resolveSaveGifTarget(message, gifFile),
                  onSelect: () => onSaveGif?.(message, gifFile),
                },
              ]
            : []),
          ...(message?.e2ee
            ? []
            : [
                {
                  id: "forward",
                  label: "Forward",
                  icon: Forward,
                  onSelect: () => onForwardMessage?.(message),
                },
              ]),
          ...(onSelectMessage && isMessageSelectable(message)
            ? [
                {
                  id: "select",
                  label: "Select",
                  icon: CircleCheck,
                  onSelect: () => onSelectMessage(message),
                },
              ]
            : []),
          {
            id: "delete",
            label: "Delete",
            icon: Trash,
            danger: true,
            onSelect: () =>
              onDeleteMessage?.(message, {
                allowDeleteForEveryone: Boolean(
                  canDeleteMessageForEveryone?.(message),
                ),
              }),
          },
        );
        // Reactions: the quick bar above the menu and a "Reacted by" item
        // (placed before Delete).
        const reactionChatId = activeChatId || message?.chat_id || null;
        reactionParts = buildReactionMenuParts({
          message,
          chatId: reactionChatId,
          chatType: chats.find((chat) => String(chat?.id) === String(reactionChatId))?.type,
          isOwner: canCurrentUserEditGroup,
          offline,
          hasReactions: getReactionList(message?._serverId || message?.id).length > 0,
        });
        const deleteAt = items.findIndex((item) => item.id === "delete");
        items.splice(deleteAt < 0 ? items.length : deleteAt, 0, ...reactionParts.items);
        // A call entry can only be removed from the person's own view: no
        // reply, copy, forward, reaction or pin (the server refuses them). It
        // can still be selected, to be deleted together with other messages.
        if (isCallMessage(message)) {
          items.splice(
            0,
            items.length,
            ...items.filter((item) => item.id === "delete" || item.id === "select"),
          );
        }
      }

      if (kind === "user") {
        const targetUser = data?.member || data?.user || null;
        const username = String(targetUser?.username || "").toLowerCase();
        const isSelf = username === String(currentUsername || "").toLowerCase();
        const existingDm = findExistingDmWithUser(username);
        const isRemovableGroupMember =
          data?.sourceChatType === "group" &&
          canCurrentUserEditGroup &&
          !isSelf &&
          String(targetUser?.role || "").toLowerCase() !== "owner";

        items.push({
          id: "profile",
          label: "Open profile",
          icon: User,
          onSelect: () => {
            if (typeof data?.onOpenProfile === "function") {
              data.onOpenProfile(targetUser);
              return;
            }
            onOpenProfile?.(targetUser);
          },
        });

        if (!isSelf && !existingDm) {
          items.push({
            id: "chat",
            label: "Chat",
            icon: Chat,
            onSelect: () => onOpenOrCreateDm?.(targetUser),
          });
        }

        if (isRemovableGroupMember) {
          items.push({
            id: "remove",
            label: "Remove",
            icon: Ban,
            danger: true,
            onSelect: () => onRemoveGroupMember?.(targetUser),
          });
        }
      }

      if (kind === "chat") {
        const chat = data?.chat || null;
        const unreadCount = Number(chat?.unread_count || 0);
        if (unreadCount > 0) {
          items.push({
            id: "seen",
            label: "Mark as seen",
            icon: CheckCheck,
            onSelect: () => handleMarkChatSeen(chat),
          });
        }
        if (String(chat?.type || "").toLowerCase() !== "saved") {
          items.push({
            id: "mute",
            label: chat?._muted ? "Unmute" : "Mute",
            icon: chat?._muted ? Volume2 : VolumeX,
            onSelect: () => onToggleChatMute?.(chat?.id),
          });
        }
        items.push({
          id: "delete",
          label: "Delete",
          icon: Trash,
          danger: true,
          onSelect: () => onDeleteChats?.([chat?.id]),
        });
      }

      if (!items.length) return;
      const message = kind === "message" ? data?.message || null : null;
      setContextMenu({
        kind,
        point,
        items,
        reactions: reactionParts?.reactions || null,
        targetEl: targetEl || null,
        targetChatId: activeChatId || null,
        targetMessageKey: message
          ? String(message?._clientId ?? message?._serverId ?? message?.id ?? "")
          : "",
      });
    },
    [
      activeChatId,
      chats,
      canReplyToMessage,
      canCurrentUserEditGroup,
      currentUsername,
      findContextMenuLinkTarget,
      findExistingDmWithUser,
      handleMarkChatSeen,
      onDeleteChats,
      onDeleteMessage,
      onEditMessage,
      onForwardMessage,
      onSaveMessageFiles,
      onSaveGif,
      onSelectMessage,
      onOpenOrCreateDm,
      onOpenProfile,
      onRemoveGroupMember,
      onReplyToMessage,
      onToggleChatMute,
      canDeleteMessageForEveryone,
      canEditMessage,
      isOfflineProp,
      sseConnected,
    ],
  );

  return {
    contextMenu,
    closeContextMenu,
    openContextMenu,
  };
}
