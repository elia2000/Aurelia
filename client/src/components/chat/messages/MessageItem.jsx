import { Suspense, lazy, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  File,
  Forward,
  Ghost,
  ImageIcon,
  Mic,
  Reply,
  Video,
} from "../../../icons/lucide.js";
import { AurelleIcon, TelegramIcon } from "../../../icons/BrandIcons.jsx";
import { hasPersian } from "../../../utils/fontUtils.js";
import { getAvatarInitials } from "../../../utils/avatarInitials.js";
import { formatCompactCount, formatDayLabel } from "../../../utils/chatFormat.js";
import ContextMenuSurface from "../../context-menu/ContextMenuSurface.jsx";
import { MessageFiles } from "../media/MessageFiles.jsx";
import { MessageMeta } from "./MessageMeta.jsx";
import CallEntry from "./CallEntry.jsx";
import UnsupportedMessage from "./UnsupportedMessage.jsx";
import { describeCall, isCallMessage } from "../../../utils/callEntry.js";
import { isUnsupportedMessage } from "../../../utils/messageKind.js";
import HeartBurst from "../reactions/HeartBurst.jsx";
import { useHeartReaction } from "../../../hooks/chat/useHeartReaction.js";
import { isMessageSelectable } from "../../../utils/batchMessages.js";

// Encrypted round video messages pull in the decryption code, so they load on demand.
const VideoNoteBubble = lazy(() => import("../videoNote/VideoNoteBubble.jsx"));
import {
  renderMarkdownBlock,
  renderMarkdownInlinePlain,
} from "../../../utils/markdown.js";
import { copyTextToClipboard } from "../../../utils/clipboard.js";
import {
  getBodyTailKind,
  getMediaAspectKey,
  getMediaBubbleWidthPx,
  getMetaSpacer,
  getTextDirection,
  MEDIA_MAX_WIDTH_PX,
  resolveMediaAspectRatio,
} from "../../../utils/messageLayout.js";
import {
  getSelectedTextWithin,
  hasActiveTextSelection,
  isDragSelectionClick,
} from "../../../utils/messageSelection.js";
import {
  extractMessageBodyText,
  FILE_SUMMARY_PATTERN,
} from "../../../utils/messageContent.js";
import { resolveMention, getCachedMention } from "../../../utils/mentions.js";
import { summarizeFiles } from "../../../utils/messagePreview.js";
import { resolveForwardedTarget } from "../../../utils/forwardOrigin.js";
import Avatar from "../../common/Avatar.jsx";
import UserRoleBadge from "../../common/UserRoleBadge.jsx";
import VerifiedBadge from "../../common/VerifiedBadge.jsx";
import Tooltip from "../../common/Tooltip.jsx";

const MAX_MESSAGE_HTML_CACHE_ENTRIES = 800;
const messageBodyHtmlCache = new Map();
const replyPreviewHtmlCache = new Map();

const readCachedHtml = (cache, key) => {
  if (!key || !cache.has(key)) return null;
  const value = cache.get(key);
  cache.delete(key);
  cache.set(key, value);
  return value;
};

const writeCachedHtml = (cache, key, value) => {
  if (!key) return value;
  cache.set(key, value);
  while (cache.size > MAX_MESSAGE_HTML_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
  return value;
};

const getMessageIdentity = (msg) =>
  String(msg?._clientId ?? msg?._serverId ?? msg?.id ?? "");

const getFileSignature = (files) =>
  (Array.isArray(files) ? files : [])
    .map((file) =>
      [
        file?.id ?? file?._localId ?? "",
        file?.url ?? file?._localUrl ?? "",
        file?.mimeType ?? "",
        file?.kind ?? "",
        file?.processing ? 1 : 0,
        Number(file?.sizeBytes || 0) || 0,
        Number(file?.width || 0) || 0,
        Number(file?.height || 0) || 0,
        Number(file?.durationSeconds || 0) || 0,
      ].join(":"),
    )
    .join("|");

const getReplySignature = (replyTarget) => {
  if (!replyTarget) return "";
  return [
    replyTarget?.id ?? "",
    replyTarget?.icon ?? "",
    replyTarget?.body ?? "",
    replyTarget?.displayName ?? "",
    replyTarget?.nickname ?? "",
    replyTarget?.username ?? "",
    replyTarget?.color ?? "",
  ].join("::");
};

const getSystemEventSignature = (systemEvent) => {
  if (!systemEvent) return "";
  return [
    systemEvent?.type ?? "",
    systemEvent?.text ?? "",
    systemEvent?.name ?? "",
    systemEvent?.suffix ?? "",
  ].join("::");
};

const getMessageRenderSignature = (msg) => {
  if (!msg) return "";
  return [
    getMessageIdentity(msg),
    msg?.body ?? "",
    msg?.edited_body ?? "",
    Number(msg?.edited || 0) || 0,
    msg?._edited ? 1 : 0,
    msg?.read_at ?? "",
    msg?.read_by_user_id ?? "",
    msg?._delivery ?? "",
    Number(msg?._uploadProgress ?? 0) || 0,
    msg?._processingPending ? 1 : 0,
    msg?.created_at ?? "",
    msg?.expiresAt ?? msg?.expires_at ?? "",
    msg?._timeLabel ?? "",
    msg?._dayKey ?? "",
    msg?._dayLabel ?? "",
    msg?.username ?? "",
    msg?.nickname ?? "",
    msg?.avatar_url ?? "",
    msg?.color ?? "",
    msg?.user_verified ?? "",
    msg?.user_role ?? "",
    msg?.forwarded_from_chat_id ?? "",
    msg?.forwarded_from_user_id ?? "",
    msg?.forwarded_from_label ?? "",
    msg?.forwarded_from_username ?? "",
    msg?.forwarded_from_avatar_url ?? "",
    msg?.forwarded_from_color ?? "",
    getReplySignature(msg?.replyTo),
    getSystemEventSignature(msg?._systemEvent),
    getFileSignature(msg?.files),
    getFileSignature(msg?._files),
    msg?.e2ee?.sig ?? "",
  ].join("~~");
};

export const MessageItem = memo(function MessageItem({
  msg,
  isRunStart = true,
  isRunEnd = true,
  leadingSlot = null,
  reactionsSlot = null,
  user,
  formatTime,
  unreadMarkerId,
  messageFilesProps,
  getMessageDayLabel,
  isDesktop,
  isMobileTouchDevice,
  isGroupChat = false,
  isChannelChat = false,
  isSavedChat = false,
  chatId = null,
  chatName = "",
  chatColor = null,
  seenCount = null,
  onOpenSenderProfile,
  onOpenMention,
  onOpenForwardOrigin,
  forwardedChat = null,
  forwardedChatStatus = null,
  forwardedUser = null,
  forwardedUserStatus = null,
  mentionRefreshToken: _mentionRefreshToken = 0,
  onReply: onReplyProp,
  onForwardMessage,
  onJumpToMessage,
  canSwipeReply: canSwipeReplyProp = true,
  onOpenContextMenu,
  visibilityRef = null,
  sseConnected = true,
  isOffline = false,
  // The other person of a direct chat: who a call entry's button calls back.
  callPeer = null,
  // Selection mode (several messages to forward, delete or copy): the whole
  // row is one checkbox, and nothing inside it acts on its own.
  selectionMode = false,
  isSelected = false,
  isSelectionTabStop = false,
  // (msg, { shiftKey, ctrlKey }) => void
  onToggleSelect = null,
}) {
  const isOwn = !isChannelChat && msg.username === user.username;
  // A call history entry is a service line: the server refuses a reply to it,
  // so it has no swipe and no double click reply.
  const isCallEntry = isCallMessage(msg);
  const isUnsupported = isUnsupportedMessage(msg);
  const onReply = isCallEntry ? null : onReplyProp;
  const canSwipeReply = canSwipeReplyProp && !isCallEntry && !selectionMode;
  const isRead = Boolean(msg.read_at) || isSavedChat;
  const isEdited = Boolean(Number(msg?.edited || 0) || msg?._edited);
  const deletedForwardOriginColor = "#94a3b8";
  const forwardedFromChatId = msg?.forwarded_from_chat_id ? String(msg.forwarded_from_chat_id).trim() : null;
  const forwardedFromUserId = msg?.forwarded_from_user_id ? String(msg.forwarded_from_user_id).trim() : null;
  const storedForwardedLabel = String(msg?.forwarded_from_label || "").trim();
  const clientRequestId = String(
    msg?.client_request_id || msg?.clientRequestId || msg?._clientId || "",
  ).trim();
  const isRemoteForwardedOrigin = Boolean(
    /^remote:/i.test(clientRequestId) &&
      isChannelChat &&
      !forwardedFromChatId &&
      !forwardedFromUserId &&
      storedForwardedLabel,
  );
  const remoteForwardedChatId =
    isRemoteForwardedOrigin
      ? String(chatId || msg?.chat_id || msg?.chatId || msg?._chatId || "").trim()
      : null;
  // Derive the provider from the client_request_id prefix
  const remoteForwardedProvider = isRemoteForwardedOrigin
    ? /^remote:tg:/i.test(clientRequestId)
      ? "telegram"
      : /^remote:sb:/i.test(clientRequestId)
        ? "songbird"
        : "unknown"
    : null;
  const forwardedFromUsername = String(msg?.forwarded_from_username || "").trim();
  const liveForwardedChatName = String(forwardedChat?.name || "").trim();
  const liveForwardedUserName = String(
    forwardedUser?.nickname || forwardedUser?.username || "",
  ).trim();
  const isDeletedForwardedChat =
    Boolean(forwardedFromChatId) &&
    forwardedChatStatus !== "ready" &&
    !forwardedChat;
  const isDeletedForwardedUser =
    Boolean(forwardedFromUserId) &&
    forwardedUserStatus !== "ready" &&
    !forwardedUser;
  const forwardedFromLabel = forwardedFromChatId
    ? isDeletedForwardedChat
      ? "Hidden"
      : liveForwardedChatName || storedForwardedLabel
    : forwardedFromUserId
      ? isDeletedForwardedUser
        ? "Hidden"
        : liveForwardedUserName || storedForwardedLabel
      : storedForwardedLabel;
  const forwardedLabelHasPersian = hasPersian(forwardedFromLabel);
  const forwardedOriginAvatarUrl = forwardedFromChatId
    ? isDeletedForwardedChat
      ? ""
      : String(forwardedChat?.group_avatar_url || "").trim()
    : forwardedFromUserId
      ? isDeletedForwardedUser
        ? ""
        : String(forwardedUser?.avatar_url || msg?.forwarded_from_avatar_url || "").trim()
      : String(msg?.forwarded_from_avatar_url || "").trim();
  const forwardedOriginColor = forwardedFromChatId
    ? isDeletedForwardedChat
      ? deletedForwardOriginColor
      : String(forwardedChat?.group_color || "#10b981").trim() || "#10b981"
    : forwardedFromUserId
      ? isDeletedForwardedUser
        ? deletedForwardOriginColor
        : String(
            forwardedUser?.color || msg?.forwarded_from_color || "#10b981",
          ).trim() || "#10b981"
      : isRemoteForwardedOrigin
        ? "#10b981"
        : String(msg?.forwarded_from_color || "#10b981").trim() || "#10b981";
  const forwardedTarget = resolveForwardedTarget({
    forwardedFromChatId,
    forwardedFromUserId,
    forwardedFromUsername,
    forwardedFromLabel,
    forwardedOriginAvatarUrl,
    forwardedOriginColor,
    remoteForwardedChatId,
    storedForwardedLabel,
    chatName,
    chatColor,
    isDeletedForwardedChat,
    isDeletedForwardedUser,
  });
  const isForwarded = forwardedFromChatId
    ? Boolean(forwardedFromLabel)
    : forwardedFromUserId
      ? Boolean(forwardedFromLabel)
      : Boolean(forwardedFromLabel);
  const messageFiles = Array.isArray(msg.files) ? msg.files : [];
  const hasFiles = messageFiles.length > 0;
  const isVideoNote = msg?.e2ee?.kind === "video_note";
  const generatedSummaryText = hasFiles
    ? summarizeFiles(messageFiles, String(msg?._uploadType || "").toLowerCase())
    : "";
  const getFileRenderType = messageFilesProps?.getFileRenderType;
  const hasMediaFiles = getFileRenderType
    ? messageFiles.some((file) => {
        const type = getFileRenderType(file);
        return type === "image" || type === "video";
      })
    : true;
  const hasUploadInProgress =
    Array.isArray(msg._files) &&
    msg._files.length > 0 &&
    Number(msg._uploadProgress ?? 100) < 100;
  const isSending =
    msg._delivery === "sending" ||
    hasUploadInProgress ||
    Boolean(msg._processingPending);
  const isFailed = msg._delivery === "failed";
  const bodyText = extractMessageBodyText(msg?.body);
  const normalizedBodyText = String(bodyText || "").trim();
  const hasMixedVoiceAndOtherFiles =
    hasFiles &&
    messageFiles.some((file) =>
      String(file?.mimeType || "").toLowerCase().startsWith("audio/"),
    ) &&
    messageFiles.some(
      (file) =>
        !String(file?.mimeType || "").toLowerCase().startsWith("audio/"),
    );
  const shouldHideGeneratedFileBody =
    hasFiles &&
    (!normalizedBodyText ||
      FILE_SUMMARY_PATTERN.test(normalizedBodyText) ||
      normalizedBodyText.startsWith("sb-enc-v1:") ||
      normalizedBodyText === generatedSummaryText ||
      (hasMixedVoiceAndOtherFiles &&
        /^Sent a voice message$/i.test(normalizedBodyText)));
  const messageBodyRef = useRef(null);
  const suppressCodeClickUntilRef = useRef(0);
  const mentionDebugEnabled =
    typeof window !== "undefined" &&
    window.localStorage?.getItem("sb-debug-mentions") === "1";
  const [mentionDebug, setMentionDebug] = useState(null);
  const onOpenMentionRef = useRef(onOpenMention);
  useEffect(() => {
    onOpenMentionRef.current = onOpenMention;
  }, [onOpenMention]);
  const messageIdentity = getMessageIdentity(msg);
  const markdownHtml = useMemo(() => {
    const cacheKey = `${messageIdentity}::${bodyText}::${Number(
      msg?.edited || 0,
    )}::${msg?._edited ? 1 : 0}`;
    const cached = readCachedHtml(messageBodyHtmlCache, cacheKey);
    if (cached !== null) return cached;
    return writeCachedHtml(messageBodyHtmlCache, cacheKey, renderMarkdownBlock(bodyText));
  }, [bodyText, messageIdentity, msg?._edited, msg?.edited]);
  const hasMarkdownCodeBlock =
    typeof markdownHtml === "string" && markdownHtml.includes("sb-code-block");

  useEffect(() => {
    const container = messageBodyRef.current;
    if (!container) return;
    const mayContainMentionSyntax = /(^|[^a-z0-9._])@[a-z0-9._]{3,}/i.test(
      bodyText,
    );
    const mayContainCopyableCode =
      typeof markdownHtml === "string" &&
      (markdownHtml.includes("sb-code-block") || markdownHtml.includes("<code"));
    const markInvalid = (el) => {
      const now = Date.now();
      const lastValid = Number(el.dataset.sbMentionValidAt || 0);
      if (lastValid && now - lastValid < 30000) {
        el.dataset.sbMentionInvalidAt = String(now);
        return;
      }
      el.classList.remove("sb-mention-active");
      el.dataset.sbMentionInvalidAt = String(now);
    };
    const markValid = (el) => {
      el.classList.add("sb-mention-active");
      el.dataset.sbMentionValidAt = String(Date.now());
      if (el.dataset.sbMentionInvalidAt) {
        delete el.dataset.sbMentionInvalidAt;
      }
    };
    const handleMentionClick = (event) => {
      const target = event?.target;
      if (!target || typeof target.closest !== "function") return;
      const mentionEl = target.closest(".sb-mention");
      if (!mentionEl || !container.contains(mentionEl)) return;
      const rawMention =
        mentionEl.dataset.mention ||
        String(mentionEl.textContent || "")
          .trim()
          .replace(/^@/, "");
      const mention = String(rawMention || "").toLowerCase();
      if (!mention) return;

      // Open the modal immediately with cached data (if available) so the
      // user sees something right away, then refresh in the background.
      const cached = getCachedMention(mention, { allowStale: true });
      if (cached?.status === "valid" && cached.data) {
        markValid(mentionEl);
        if (typeof onOpenMentionRef.current === "function") {
          onOpenMentionRef.current(cached.data);
        }
      }

      const needsLoad = !cached || cached.status !== "valid";
      if (needsLoad) {
        mentionEl.classList.add("sb-mention-loading");
      }

      resolveMention(mention, user.username, {
        fallbackToCacheOnError: true,
        // Force a fresh fetch only when there was no usable cache hit
        force: needsLoad,
      }).then((result) => {
        mentionEl.classList.remove("sb-mention-loading");
        if (!result || result.status !== "valid") {
          markInvalid(mentionEl);
          return;
        }
        markValid(mentionEl);
        // If we already opened with cached data, the modal is already visible;
        // openMentionProfile will update it with fresh data.
        if (typeof onOpenMentionRef.current === "function") {
          onOpenMentionRef.current(result.data);
        }
      });
    };
    if (mayContainMentionSyntax) {
      container.addEventListener("click", handleMentionClick);
    }
    if (mentionDebugEnabled) {
      const totalMentions = container.querySelectorAll(".sb-mention").length;
      const activeMentions =
        container.querySelectorAll(".sb-mention-active").length;
      setMentionDebug((prev) => {
        if (
          prev &&
          prev.total === totalMentions &&
          prev.active === activeMentions
        ) {
          return prev;
        }
        return {
          total: totalMentions,
          active: activeMentions,
        };
      });
    }
    if (mayContainCopyableCode) {
      const resetCodeButtonState = (button, state, label) => {
        if (!button) return;
        button.dataset.state = state;
        button.setAttribute("aria-label", label);
      };
      const enhanceCodeElements = () => {
        const blocks = container.querySelectorAll(".sb-code-block");
        blocks.forEach((block) => {
          if (block.dataset.sbEnhanced === "1") return;
          block.dataset.sbEnhanced = "1";
        });
        const inlineCodes = container.querySelectorAll("code");
        inlineCodes.forEach((codeEl) => {
          if (codeEl.closest("pre")) return;
          if (codeEl.dataset.sbEnhanced === "1") return;
          codeEl.dataset.sbEnhanced = "1";
          codeEl.tabIndex = 0;
          codeEl.setAttribute("role", "button");
          codeEl.setAttribute("aria-label", "Copy inline code");
          codeEl.classList.add("sb-inline-code-copyable");
        });
      };
      const handleCodeCopy = async ({ codeEl, button }) => {
        if (!codeEl) return;
        const copied = await copyTextToClipboard(codeEl.textContent || "");
        if (!button) return;
        if (copied) {
          resetCodeButtonState(button, "copied", "Copied");
        } else {
          resetCodeButtonState(button, "error", "Copy failed");
        }
        window.setTimeout(() => {
          resetCodeButtonState(button, "idle", "Copy code");
        }, 1200);
      };
      const handleCodeBlockClick = (event) => {
        if (Date.now() < suppressCodeClickUntilRef.current) return;
        const target = event?.target;
        if (!target || typeof target.closest !== "function") return;
        const button = target.closest(".sb-code-copy");
        const inlineCode = target.closest(".sb-inline-code-copyable");
        if (inlineCode && container.contains(inlineCode)) {
          event.preventDefault();
          void handleCodeCopy({ codeEl: inlineCode, button: null });
          return;
        }
        const block = button?.closest(".sb-code-block");
        if (!button || !block || !container.contains(block)) return;
        event.preventDefault();
        event.stopPropagation();
        void handleCodeCopy({
          codeEl: block.querySelector("pre.sb-code > code"),
          button: block.querySelector(".sb-code-copy"),
        });
      };
      const handleCodeBlockKeyDown = (event) => {
        const target = event?.target;
        if (!target || typeof target.closest !== "function") return;
        const inlineCode = target.closest(".sb-inline-code-copyable");
        if (inlineCode && container.contains(inlineCode)) {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          void handleCodeCopy({ codeEl: inlineCode, button: null });
          return;
        }
        const button = target.closest(".sb-code-copy");
        const block = button?.closest(".sb-code-block");
        if (!button || !block || !container.contains(block)) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        void handleCodeCopy({
          codeEl: block.querySelector("pre.sb-code > code"),
          button,
        });
      };
      let idleId = null;
      let timerId = null;
      if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
        idleId = window.requestIdleCallback(enhanceCodeElements, { timeout: 600 });
      } else {
        timerId = window.setTimeout(enhanceCodeElements, 40);
      }
      container.addEventListener("click", handleCodeBlockClick);
      container.addEventListener("keydown", handleCodeBlockKeyDown);
      return () => {
        if (mayContainMentionSyntax) {
          container.removeEventListener("click", handleMentionClick);
        }
        container.removeEventListener("click", handleCodeBlockClick);
        container.removeEventListener("keydown", handleCodeBlockKeyDown);
        if (
          idleId !== null &&
          typeof window !== "undefined" &&
          typeof window.cancelIdleCallback === "function"
        ) {
          window.cancelIdleCallback(idleId);
        }
        if (timerId !== null && typeof window !== "undefined") {
          window.clearTimeout(timerId);
        }
      };
    }
    return () => {
      if (mayContainMentionSyntax) {
        container.removeEventListener("click", handleMentionClick);
      }
    };
  }, [
    markdownHtml,
    user.username,
    mentionDebugEnabled,
    bodyText,
    onOpenForwardOrigin,
  ]);

  const formatSeenCount = (value) => {
    const count = Math.max(1, Number(value || 0));
    return formatCompactCount(count);
  };
  const formatExpiryBadge = () => {
    const files = Array.isArray(msg?.files) ? msg.files : [];
    const expiryCandidates = files
      .map((file) => new Date(file?.expiresAt || "").getTime())
      .filter((value) => Number.isFinite(value) && value > 0);
    const messageExpiryMs = new Date(msg?.expiresAt || "").getTime();
    if (Number.isFinite(messageExpiryMs) && messageExpiryMs > 0) {
      expiryCandidates.push(messageExpiryMs);
    }
    const expiryMs = expiryCandidates.sort((a, b) => a - b)[0];
    if (!expiryMs) return null;
    const diffMs = expiryMs - Date.now();
    if (diffMs <= 0) return null;
    const minuteMs = 60 * 1000;
    const hourMs = 60 * minuteMs;
    const dayMs = 24 * hourMs;
    if (diffMs < hourMs) {
      const minutes = Math.max(1, Math.ceil(diffMs / minuteMs));
      return { label: `${minutes}m`, danger: true };
    }
    if (diffMs < dayMs) {
      const hours = Math.max(1, Math.ceil(diffMs / hourMs));
      return { label: `${hours}h`, danger: true };
    }
    const dayDisplayBiasMs = 55 * minuteMs;
    const days = Math.max(1, Math.floor((diffMs + dayDisplayBiasMs) / dayMs));
    return { label: `${days}d`, danger: days <= 1 };
  };
  const expiryBadge = formatExpiryBadge();
  const dayLabel = getMessageDayLabel
    ? getMessageDayLabel(msg)
    : (msg?.created_at || msg?._createdAt)
      ? formatDayLabel(msg?.created_at || msg?._createdAt)
      : msg?._dayLabel || msg?._dayKey || "";
  const replyTarget = msg.replyTo || null;
  const replySignature = getReplySignature(replyTarget);
  const replyDisplayName =
    isChannelChat && replyTarget
      ? chatName || "Channel"
      : replyTarget?.displayName ||
        replyTarget?.nickname ||
        replyTarget?.username ||
        "Unknown";
  const replyColor =
    isChannelChat && replyTarget
      ? chatColor || "#10b981"
      : replyTarget?.color || "#10b981";
  const replyPreviewRaw =
    extractMessageBodyText(replyTarget?.body).trim() || "Message";
  const truncateReplyPreview = (value, maxChars = 140) => {
    const text = String(value || "");
    if (text.length <= maxChars) return text;
    return `${text.slice(0, maxChars).trimEnd()}...`;
  };
  const replyPreview = truncateReplyPreview(replyPreviewRaw);
  const replyBodyText = extractMessageBodyText(replyTarget?.body).trim();
  const isPluralMediaSummary =
    /^Sent \d+ (files|photos|videos|documents|media files)$/i.test(
      replyBodyText,
    );
  const isGenericReplyMediaText =
    /^Sent (a media file|a file|a photo|a video|a document|\d+ (files|photos|videos|documents|media files))$/i.test(
      replyBodyText,
    );
  const normalizedReplyPreview =
    replyTarget?.icon === "voice"
      ? /^Sent (a voice message|\d+ voice messages)$/i.test(replyBodyText)
        ? "Sent a voice message"
        : replyPreview
      : replyTarget?.icon === "video"
        ? isGenericReplyMediaText && !isPluralMediaSummary
          ? "Sent a video"
          : replyPreview
        : replyTarget?.icon === "image"
          ? isGenericReplyMediaText && !isPluralMediaSummary
            ? "Sent a photo"
            : replyPreview
          : replyPreview;
  const replyPreviewHtml = useMemo(
    () => {
      const cacheKey = `${messageIdentity}::reply::${replySignature}::${normalizedReplyPreview}`;
      const cached = readCachedHtml(replyPreviewHtmlCache, cacheKey);
      if (cached !== null) return cached;
      return writeCachedHtml(
        replyPreviewHtmlCache,
        cacheKey,
        renderMarkdownInlinePlain(normalizedReplyPreview),
      );
    },
    [messageIdentity, normalizedReplyPreview, replySignature],
  );
  const derivedReplyIcon = (() => {
    if (!replyTarget) return null;
    if (replyTarget.icon) return replyTarget.icon;
    if (/^Sent \d+ media files/i.test(replyPreview)) return "image";
    if (/^Sent (a voice message|\d+ voice messages)/i.test(replyPreview))
      return "voice";
    if (/^Sent (a video|\d+ videos)/i.test(replyPreview)) return "video";
    if (/^Sent (a photo|\d+ photos)/i.test(replyPreview)) return "image";
    if (/^Sent a media file/i.test(replyPreview)) return "image";
    if (/^Sent (a file|a document|\d+ documents|\d+ files)/i.test(replyPreview))
      return "document";
    return null;
  })();
  const isDeletedAuthor =
    String(msg.username || "").toLowerCase() === "deleted" ||
    String(msg.nickname || "").toLowerCase() === "deleted user";
  const senderName = isDeletedAuthor
    ? "Deleted account"
    : msg.nickname || msg.username || "Unknown";
  const senderInitials = getAvatarInitials(senderName);
  const senderColor = isDeletedAuthor ? "#94a3b8" : msg.color || "#10b981";
  const forwardedInitials = getAvatarInitials(forwardedFromLabel || "C");
  const forwardedOriginButtonLabel = forwardedFromLabel
    ? `Open forwarded origin: ${forwardedFromLabel}`
    : "Open forwarded origin";
  const canOpenForwardedOrigin = Boolean(forwardedTarget);
  const canOpenSenderProfile =
    !isDeletedAuthor && typeof onOpenSenderProfile === "function";
  const contextMenuMobileEnabled = !isDesktop && isMobileTouchDevice;
  const senderMenuMember = {
    id: msg.user_id || null,
    username: msg.username || "",
    nickname: msg.nickname || "",
    avatar_url: msg.avatar_url || "",
    color: msg.color || "#10b981",
    role: "",
  };
  const senderContextMenu = {
    disabled: !canOpenSenderProfile || !onOpenContextMenu || selectionMode,
    isMobile: contextMenuMobileEnabled,
    onOpen: ({ event, targetEl, isMobile }) =>
      onOpenContextMenu?.({
        kind: "user",
        event,
        targetEl,
        isMobile,
        data: {
          member: senderMenuMember,
          sourceChatType: isGroupChat ? "group" : "dm",
          onOpenProfile: () => onOpenSenderProfile?.(msg),
        },
      }),
  };
  // The sender's name and avatar have a menu of their own; the row's message
  // menu must not open on top of it.
  const hasSenderMenu = !senderContextMenu.disabled;
  const computedIsOffline =
    isOffline ||
    sseConnected === false ||
    (typeof navigator !== "undefined" && navigator.onLine === false);
  // Double click / double tap puts a heart on the message (or takes it off).
  const heartReaction = useHeartReaction({
    msg,
    chatId: chatId || msg?.chat_id || null,
    enabled: !computedIsOffline && !selectionMode,
  });

  // The whole message row is the context menu surface, not only the bubble, so
  // a right click on the empty space beside a bubble (or on the gutter) works.
  const messageContextMenu = {
    disabled: !onOpenContextMenu || selectionMode,
    isMobile: contextMenuMobileEnabled,
    holdDelayMs:
      contextMenuMobileEnabled && canSwipeReply ? 650 : undefined,
    moveTolerancePx:
      contextMenuMobileEnabled && canSwipeReply ? 0 : undefined,
    onOpen: ({ event, source, targetEl, isMobile }) => {
      // The sender's name and avatar open their own menu; do not replace it.
      const eventTarget = event?.target;
      if (
        eventTarget instanceof Element &&
        eventTarget.closest("[data-own-context-menu]")
      ) {
        return;
      }
      const bubble = targetEl?.querySelector?.("[data-message-bubble]") || null;
      let menuEvent = event;
      if (source === "keyboard" && bubble) {
        // No pointer position: open the menu at the bottom of the bubble.
        const rect = bubble.getBoundingClientRect();
        menuEvent = {
          clientX: rect.left + Math.min(rect.width / 2, 64),
          clientY: rect.bottom - 6,
          target: eventTarget,
        };
      }
      onOpenContextMenu?.({
        kind: "message",
        event: menuEvent,
        targetEl,
        isMobile,
        data: {
          message: msg,
          isOffline: computedIsOffline,
          selectedText: getSelectedTextWithin(bubble),
        },
      });
    },
  };
  const renderForwardedHeader = () => {
    if (!isForwarded) return null;
    return (
      <div className="mb-0.5 flex w-full min-w-0 items-center gap-1 text-[13px] leading-[1.25] text-sky-400">
        <Forward size={13} className="shrink-0" />
        <span className="shrink-0 italic">Forwarded from</span>
        <button
          type="button"
          onClick={
            canOpenForwardedOrigin
              ? () => onOpenForwardOrigin?.(forwardedTarget)
              : undefined
          }
          disabled={!canOpenForwardedOrigin}
          className={`inline-flex min-w-0 max-w-full items-center gap-1 text-left font-semibold not-italic transition ${
            canOpenForwardedOrigin ? "hover:text-sky-300" : "cursor-default"
          }`}
          aria-label={forwardedOriginButtonLabel}
        >
          <Avatar
            src={forwardedOriginAvatarUrl}
            alt={forwardedFromLabel}
            name={forwardedFromLabel}
            color={forwardedOriginColor}
            initials={
              canOpenForwardedOrigin ? forwardedInitials : ""
            }
            placeholderContent={canOpenForwardedOrigin ? null : ""}
            className="h-4 w-4 shrink-0 text-[8px]"
          />
          {remoteForwardedProvider === "telegram" ? (
            <TelegramIcon size={13} className="shrink-0" />
          ) : remoteForwardedProvider === "songbird" ? (
            <AurelleIcon size={13} />
          ) : null}
          <span className="inline-flex min-w-0 items-center gap-0.5">
            <Tooltip label={forwardedFromLabel} asChild>
              <span
                className={`min-w-0 max-w-[18rem] truncate ${
                  forwardedLabelHasPersian ? "font-fa" : ""
                }`}
                dir="auto"
                style={{ unicodeBidi: "isolate" }}
              >
                {remoteForwardedProvider === "telegram"
                  ? forwardedFromLabel.replace(/^telegram:\s*/i, "")
                  : remoteForwardedProvider === "songbird"
                    ? forwardedFromLabel.replace(/^(songbird|aurelle):\s*/i, "")
                    : forwardedFromLabel}
              </span>
            </Tooltip>
            {/* Verified badge: shown for forwarded users and verified forwarded chats */}
            {!isDeletedForwardedUser && Boolean(forwardedFromUserId) && Boolean(forwardedUser?.verified) && (
              <VerifiedBadge size={13} />
            )}
            {!isDeletedForwardedChat && Boolean(forwardedFromChatId) && Boolean(forwardedChat?.verified) && (
              <VerifiedBadge size={13} />
            )}
            {/* Role badge: only for forwarded users, not chats */}
            {!isDeletedForwardedUser && Boolean(forwardedFromUserId) && (
              <UserRoleBadge role={forwardedUser?.role} size={13} />
            )}
          </span>
        </button>
      </div>
    );
  };

  // Where the mouse went down, to tell a click from the end of a drag selection.
  const mouseDownRef = useRef(null);
  const touchStartXRef = useRef(0);
  const touchStartYRef = useRef(0);
  const touchDxRef = useRef(0);
  const touchDyRef = useRef(0);
  const trackingSwipeRef = useRef(false);
  const swipeGestureActiveRef = useRef(false);
  const activeSwipePointerIdRef = useRef(null);
  const [swipeOffset, setSwipeOffset] = useState(0);
  const [isSwiping, setIsSwiping] = useState(false);
  const swipeOffsetRef = useRef(0);
  const swipeRafRef = useRef(0);
  const swipeUserSelectRef = useRef(null);
  const swipeTouchCalloutRef = useRef(null);
  const swipeEndLockRef = useRef(false);
  const swipeProgress = Math.min(Math.abs(swipeOffset) / 90, 1);
  const showSwipeHint = !isDesktop && isMobileTouchDevice && canSwipeReply;

  const queueSwipeOffset = (value) => {
    swipeOffsetRef.current = value;
    if (swipeRafRef.current) return;
    swipeRafRef.current = window.requestAnimationFrame(() => {
      swipeRafRef.current = 0;
      setSwipeOffset(swipeOffsetRef.current);
    });
  };

  const resetSwipe = useCallback(() => {
    trackingSwipeRef.current = false;
    swipeGestureActiveRef.current = false;
    activeSwipePointerIdRef.current = null;
    setIsSwiping(false);
    swipeOffsetRef.current = 0;
    if (swipeRafRef.current) {
      window.cancelAnimationFrame(swipeRafRef.current);
      swipeRafRef.current = 0;
    }
    if (swipeUserSelectRef.current !== null) {
      document.body.style.userSelect = swipeUserSelectRef.current;
      swipeUserSelectRef.current = null;
    }
    if (swipeTouchCalloutRef.current !== null) {
      document.body.style.webkitTouchCallout = swipeTouchCalloutRef.current;
      swipeTouchCalloutRef.current = null;
    }
    setSwipeOffset(0);
  }, []);

  const handleSwipeEnd = useCallback(() => {
    if (swipeEndLockRef.current) return;
    swipeEndLockRef.current = true;
    const dx = touchDxRef.current;
    const dy = Math.abs(touchDyRef.current);
    const swipeOffset = swipeOffsetRef.current;
    const shouldReply = (swipeOffset <= -90 || dx <= -90) && dy < 90;
    resetSwipe();
    if (shouldReply) {
      onReply?.(msg);
    }
    window.setTimeout(() => {
      swipeEndLockRef.current = false;
    }, 0);
  }, [msg, onReply, resetSwipe]);

  useEffect(() => {
    return () => {
      if (swipeRafRef.current) {
        window.cancelAnimationFrame(swipeRafRef.current);
        swipeRafRef.current = 0;
      }
    };
  }, []);

  useEffect(() => {
    const handleWindowTouchEnd = () => {
      if (trackingSwipeRef.current) {
        handleSwipeEnd();
        return;
      }
      if (swipeOffsetRef.current === 0) return;
      resetSwipe();
    };
    window.addEventListener("touchend", handleWindowTouchEnd, { passive: true });
    window.addEventListener("touchcancel", handleWindowTouchEnd, {
      passive: true,
    });
    window.addEventListener("pointerup", handleWindowTouchEnd, { passive: true });
    window.addEventListener("pointercancel", handleWindowTouchEnd, {
      passive: true,
    });
    return () => {
      window.removeEventListener("touchend", handleWindowTouchEnd);
      window.removeEventListener("touchcancel", handleWindowTouchEnd);
      window.removeEventListener("pointerup", handleWindowTouchEnd);
      window.removeEventListener("pointercancel", handleWindowTouchEnd);
    };
  }, [handleSwipeEnd, resetSwipe]);

  // ---- time, edited and delivery status: drawn once, placed by MessageMeta ----
  const timeLabel = msg._timeLabel || formatTime(msg.created_at);
  const showDeliveryStatus = isOwn || isChannelChat;
  // A call entry has no ticks: it is not "sent" or "read" like a message.
  const metaStatus = !showDeliveryStatus || isCallEntry
    ? null
    : isSending
      ? "sending"
      : isFailed
        ? "failed"
        : isChannelChat
          ? "views"
          : isRead
            ? "read"
            : "sent";
  const viewsLabel = isChannelChat ? formatSeenCount(seenCount) : "";
  const showBody = !isCallEntry && !isUnsupported && !shouldHideGeneratedFileBody;
  const lastFile = messageFiles[messageFiles.length - 1];
  const lastFileIsMedia = Boolean(
    lastFile &&
      (getFileRenderType
        ? ["image", "video"].includes(getFileRenderType(lastFile))
        : true),
  );
  // Under a caption (or plain text) the time sits at the end of the last line.
  // A picture without a caption gets it as a chip over its corner; a file or
  // voice message gets its own row.
  const bodyMetaVariant = isVideoNote
    ? "overlay"
    : showBody || !hasFiles
      ? "inline"
      : hasMediaFiles && lastFileIsMedia
        ? "overlay"
        : "row";
  // A call entry (or a note about a message this app cannot show) puts the
  // time on its own line under its content.
  const metaVariant = isCallEntry || isUnsupported ? "row" : bodyMetaVariant;
  const bodyDirection = getTextDirection(bodyText);
  const metaSide = metaVariant === "inline" && bodyDirection === "rtl" ? "left" : "right";
  const metaSpacer = getMetaSpacer({
    timeLabel,
    isEdited,
    expiryLabel: expiryBadge?.label || "",
    viewsLabel,
    hasStatusIcon: Boolean(metaStatus),
  });
  const bodyTailKind = showBody ? getBodyTailKind(markdownHtml) : "inline";
  const bodyTailClass =
    metaVariant !== "inline"
      ? ""
      : bodyTailKind === "p"
        ? "sb-meta-p"
        : bodyTailKind === "block"
          ? "sb-meta-block"
          : "sb-meta-inline";

  // ---- bubble shape: Telegram-like corners, small at the tail ----
  const hasMediaBubble = hasFiles && hasMediaFiles && !isVideoNote;
  const showSenderName = !isOwn && isGroupChat && !isChannelChat && isRunStart;
  const showAvatarGutter = !isOwn && isGroupChat && !isChannelChat;
  const bubbleCorners = isOwn
    ? `rounded-tl-[16px] rounded-bl-[16px] ${
        isRunStart ? "rounded-tr-[16px]" : "rounded-tr-[5px]"
      } ${isRunEnd ? "rounded-br-[4px]" : "rounded-br-[5px]"}`
    : `rounded-tr-[16px] rounded-br-[16px] ${
        isRunStart ? "rounded-tl-[16px]" : "rounded-tl-[5px]"
      } ${isRunEnd ? "rounded-bl-[4px]" : "rounded-bl-[5px]"}`;
  const hasBubbleHeader =
    showSenderName || isForwarded || Boolean(replyTarget);
  // A round video always stands on the chat background without a bubble
  // around it; a name, forward line or quote is a chip above the circle.
  const isBareBubble = isVideoNote;
  const bubbleSurface = isBareBubble
    ? ""
    : isOwn
      ? "bg-emerald-200 text-emerald-950 shadow-xs dark:bg-emerald-800 dark:text-white"
      : "bg-white/90 text-slate-800 shadow-xs dark:bg-slate-800/75 dark:text-slate-100";
  // A single picture or video gives the bubble its shape; an album, or a
  // picture next to a file, gets the full media width.
  const soleMediaFile =
    hasMediaBubble && messageFiles.length === 1 ? messageFiles[0] : null;
  const mediaBubbleWidthPx = hasMediaBubble
    ? soleMediaFile
      ? getMediaBubbleWidthPx({
          ratio: resolveMediaAspectRatio({
            file: soleMediaFile,
            cachedRatio:
              messageFilesProps?.mediaAspectByKey?.[getMediaAspectKey(soleMediaFile)],
            isVideo: getFileRenderType?.(soleMediaFile) === "video",
          }),
          isDesktop,
        })
      : MEDIA_MAX_WIDTH_PX
    : null;
  const bubbleSize = hasMediaBubble
    ? "overflow-hidden p-0"
    : isBareBubble
      ? "w-fit p-0"
      : isCallEntry
        ? "w-fit min-w-56 px-3 pb-1.5 pt-2"
        : `w-fit px-2.5 py-1.5 ${hasMarkdownCodeBlock ? "min-w-36" : "min-w-0"}`;

  const renderSenderAvatar = () => (
    <ContextMenuSurface
      as="button"
      type="button"
      data-message-avatar
      data-own-context-menu={hasSenderMenu ? "" : undefined}
      onClick={
        canOpenSenderProfile ? () => onOpenSenderProfile?.(msg) : undefined
      }
      className={`shrink-0 ${canOpenSenderProfile ? "group" : ""}`}
      disabled={!canOpenSenderProfile}
      contextMenu={senderContextMenu}
    >
      <Avatar
        src={!isDeletedAuthor ? msg.avatar_url : ""}
        alt={senderName}
        name={senderName}
        color={senderColor}
        initials={senderInitials}
        placeholderContent={
          isDeletedAuthor ? (
            <Ghost size={14} className="text-slate-600" />
          ) : (
            senderInitials
          )
        }
        className={`h-8 w-8 shrink-0 text-xs transition ${
          canOpenSenderProfile
            ? "group-hover:ring-2 group-hover:ring-emerald-300"
            : ""
        }`}
      />
    </ContextMenuSurface>
  );

  // The sender name, forward line and quote. They sit in the bubble above its
  // content; a round video, which has no bubble, shows them as a chip over
  // its circle instead.
  const bubbleHeader = hasBubbleHeader ? (
    <>
      {showSenderName ? (
        <Tooltip label={senderName} asChild>
          <ContextMenuSurface
            as="button"
            type="button"
            onClick={
              canOpenSenderProfile
                ? () => onOpenSenderProfile?.(msg)
                : undefined
            }
            disabled={!canOpenSenderProfile}
            data-own-context-menu={hasSenderMenu ? "" : undefined}
            className={`mb-0.5 flex max-w-[60vw] items-center gap-0.5 text-[13px] font-semibold leading-[1.25] transition ${
              canOpenSenderProfile ? "hover:underline" : ""
            } sm:max-w-[40vw] md:max-w-[28vw]`}
            dir="ltr"
            style={{ color: String(senderColor) }}
            contextMenu={senderContextMenu}
          >
            <span className={`truncate ${hasPersian(senderName) ? "font-fa" : ""}`} dir="auto" style={{ unicodeBidi: "isolate" }}>{senderName}</span>
            {!isDeletedAuthor && Boolean(msg.user_verified) && (
              <VerifiedBadge size={14} />
            )}
            {!isDeletedAuthor && (
              <UserRoleBadge role={msg.user_role} size={14} />
            )}
          </ContextMenuSurface>
        </Tooltip>
      ) : null}
      {renderForwardedHeader()}
      {replyTarget ? (
        <div
          role="button"
          tabIndex={0}
          onClick={() => onJumpToMessage?.(replyTarget.id)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            onJumpToMessage?.(replyTarget.id);
          }}
          className="mb-1 flex w-full min-w-0 max-w-full cursor-pointer gap-2 overflow-hidden rounded-md border-s-2 py-0.5 pe-1.5 ps-2 text-left text-[13px] leading-[1.25] transition hover:brightness-95"
          style={{
            borderColor: String(replyColor),
            backgroundColor: `color-mix(in srgb, ${String(replyColor)} 12%, transparent)`,
          }}
          aria-label={`Reply to ${replyDisplayName}`}
        >
          <span className="min-w-0 flex-1">
            <Tooltip label={replyDisplayName} asChild>
              <span
                className="flex max-w-full items-center gap-0.5 truncate whitespace-nowrap font-semibold"
                dir="ltr"
              >
                <span
                  className={`min-w-0 truncate ${
                    hasPersian(replyDisplayName) ? "font-fa" : ""
                  }`}
                  dir="auto"
                  style={{ color: String(replyColor), unicodeBidi: "isolate" }}
                >
                  {replyDisplayName}
                </span>
                {Boolean(replyTarget?.verified) && (
                  <VerifiedBadge size={12} />
                )}
                {!isChannelChat && (
                  <UserRoleBadge role={replyTarget?.role} size={12} />
                )}
              </span>
            </Tooltip>
            <span
              className={`flex max-w-full items-start gap-1 ${
                hasPersian(normalizedReplyPreview) ? "font-fa" : ""
              }`}
              dir="ltr"
              style={{ unicodeBidi: "isolate" }}
            >
              {derivedReplyIcon === "voice" ? (
                <Mic
                  size={12}
                  className="mt-[3px] shrink-0 text-slate-500 dark:text-slate-400"
                />
              ) : derivedReplyIcon === "video" ? (
                <Video
                  size={12}
                  className="mt-[3px] shrink-0 text-slate-500 dark:text-slate-400"
                />
              ) : derivedReplyIcon === "image" ? (
                <ImageIcon
                  size={12}
                  className="mt-[3px] shrink-0 text-slate-500 dark:text-slate-400"
                />
              ) : derivedReplyIcon === "document" ? (
                <File
                  size={12}
                  className="mt-[3px] shrink-0 text-slate-500 dark:text-slate-400"
                />
              ) : null}
              <span
                className="line-clamp-2 min-w-0 break-words"
                dir="auto"
                style={{ unicodeBidi: "isolate" }}
                dangerouslySetInnerHTML={{
                  __html: String(replyPreviewHtml || ""),
                }}
              />
            </span>
          </span>
        </div>
      ) : null}
    </>
  ) : null;

  // ---- selection mode: the whole row is one checkbox ----
  const canBeSelected = selectionMode && isMessageSelectable(msg);
  const isTicked = canBeSelected && isSelected;
  const selectionDownRef = useRef(null);
  const selectionPreview = msg?._systemEvent
    ? `${msg._systemEvent.name || "A member"} ${msg._systemEvent.suffix || ""}`.trim()
    : isCallEntry
      ? describeCall(msg?.call, { outgoing: isOwn }).spoken
      : (shouldHideGeneratedFileBody
          ? generatedSummaryText || "Attachment"
          : normalizedBodyText
        ).slice(0, 120);
  const selectionLabel = [
    msg?._systemEvent ? "" : isOwn ? "You" : senderName,
    timeLabel,
    selectionPreview,
  ]
    .filter(Boolean)
    .join(", ");
  const selectionRowProps = selectionMode
    ? {
        role: "checkbox",
        "aria-checked": isTicked,
        "aria-disabled": canBeSelected ? undefined : true,
        "aria-label": selectionLabel,
        "data-selected": isTicked ? "true" : undefined,
        tabIndex: canBeSelected && isSelectionTabStop ? 0 : -1,
        // A drag that selects text is not a click, and a shift or double
        // click must not also select a range of text under the tick.
        onMouseDownCapture: (event) => {
          selectionDownRef.current =
            event.button === 0 ? { x: event.clientX, y: event.clientY } : null;
          if (event.button === 0 && (event.shiftKey || event.detail > 1)) {
            event.preventDefault();
          }
        },
        // Nothing inside the row (link, picture, name, button) acts in
        // selection mode: a click only ticks the row.
        onClickCapture: (event) => {
          event.preventDefault();
          event.stopPropagation();
          const down = selectionDownRef.current;
          selectionDownRef.current = null;
          if (!canBeSelected) return;
          if (
            isDragSelectionClick({
              down,
              clientX: event.clientX,
              clientY: event.clientY,
              selectionText:
                typeof window !== "undefined"
                  ? window.getSelection?.()?.toString() || ""
                  : "",
            })
          ) {
            return;
          }
          onToggleSelect?.(msg, {
            shiftKey: event.shiftKey,
            ctrlKey: event.ctrlKey || event.metaKey,
          });
        },
        onKeyDown: (event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key !== " " && event.key !== "Enter") return;
          event.preventDefault();
          if (canBeSelected) onToggleSelect?.(msg, { shiftKey: event.shiftKey, ctrlKey: false });
        },
        onContextMenu: (event) => event.preventDefault(),
      }
    : null;
  const selectionRowClass = selectionMode
    ? `cursor-pointer transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-400 ${
        isTicked ? "bg-emerald-500/15 dark:bg-emerald-400/15" : ""
      }`
    : "";
  // The checkbox sits over the left edge of the row and takes no room of its own.
  const leadingGutter = leadingSlot ? (
    <div
      data-slot="leading"
      className="pointer-events-none absolute inset-y-0 left-0 z-10 flex items-center"
    >
      {leadingSlot}
    </div>
  ) : null;

  return (
    <div
      id={`message-${msg.id}`}
      data-msg-day={dayLabel}
      data-msg-day-key={msg?._dayKey || ""}
      style={{ scrollMarginTop: "96px" }}
      ref={visibilityRef}
      className="w-full max-w-full overflow-x-clip"
    >
      {String(unreadMarkerId || "") === String(msg.id || "") ? (
        <div
          id={`unread-divider-${msg.id}`}
          data-no-select
          className="flex items-center gap-3 px-3 py-2"
          style={{ scrollMarginTop: "96px" }}
        >
          <span className="h-px flex-1 bg-emerald-200/70 dark:bg-emerald-500/30" />
          <span className="rounded-full border border-emerald-200/60 bg-white/90 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700 dark:border-emerald-500/30 dark:bg-slate-950 dark:text-emerald-200">
            Unread Messages
          </span>
          <span className="h-px flex-1 bg-emerald-200/70 dark:bg-emerald-500/30" />
        </div>
      ) : null}
      {msg?._systemEvent ? (
        <div
          data-no-select
          data-message-key={messageIdentity}
          className={`group/row relative flex justify-center py-1 outline-none ${
            selectionMode ? "ps-12 pe-3" : "px-3"
          } ${selectionRowClass}`}
          {...selectionRowProps}
        >
          {leadingGutter}
          <span
            className="inline-flex max-w-full items-center justify-center rounded-full border border-emerald-200/60 bg-white/90 px-2.5 py-0.5 text-center text-[11px] font-semibold text-emerald-700 dark:border-emerald-500/30 dark:bg-slate-950 dark:text-emerald-200"
            style={{ lineHeight: 1.35 }}
          >
            <span className="min-w-0 truncate">
              <span
                className={`min-w-0 truncate ${
                  hasPersian(msg?._systemEvent?.name) ? "font-fa sb-fa-baseline-fix" : ""
                }`}
                dir="auto"
                style={{ unicodeBidi: "isolate" }}
              >
                {msg?._systemEvent?.name || "A member"}
              </span>{" "}
              <span
                dir="ltr"
                style={{ unicodeBidi: "isolate" }}
              >
                {msg?._systemEvent?.suffix || ""}
              </span>
            </span>
          </span>
        </div>
      ) : null}
      {!msg?._systemEvent ? (
        <ContextMenuSurface
          as="div"
          data-message-row
          data-message-key={messageIdentity}
          tabIndex={-1}
          className={`group/row relative flex w-full max-w-full items-end gap-2 outline-none ${
            selectionMode ? "ps-12 pe-2 md:pe-4" : "px-2 md:px-4"
          } ${
            isOwn ? "justify-end" : "justify-start"
          } ${isRunStart ? "pt-[7px]" : "pt-px"} pb-px ${selectionRowClass}`}
          style={{
            touchAction: "pan-y",
            userSelect: isSwiping ? "none" : undefined,
          }}
          contextMenu={messageContextMenu}
          {...heartReaction.pointerHandlers}
          {...selectionRowProps}
          onPointerDownCapture={(event) => {
            if (isDesktop || !isMobileTouchDevice || !onReply) return;
            if (!canSwipeReply) return;
            // Swipe to reply is for fingers and pens; the mouse is never captured.
            if (event.pointerType === "mouse") return;
            const target = event.target;
            if (
              target &&
              target.closest?.(
                "input, textarea, select, label, [contenteditable='true']",
              )
            ) {
              return;
            }
            activeSwipePointerIdRef.current = event.pointerId;
            event.currentTarget.setPointerCapture?.(event.pointerId);
            trackingSwipeRef.current = true;
            setIsSwiping(false);
            touchStartXRef.current = event.clientX;
            touchStartYRef.current = event.clientY;
            touchDxRef.current = 0;
            touchDyRef.current = 0;
            swipeGestureActiveRef.current = false;
            swipeOffsetRef.current = 0;
            if (swipeUserSelectRef.current === null && typeof document !== "undefined") {
              swipeUserSelectRef.current = document.body.style.userSelect || "";
              document.body.style.userSelect = "none";
            }
            if (swipeTouchCalloutRef.current === null && typeof document !== "undefined") {
              swipeTouchCalloutRef.current =
                document.body.style.webkitTouchCallout || "";
              document.body.style.webkitTouchCallout = "none";
            }
          }}
          onPointerMoveCapture={(event) => {
            if (!trackingSwipeRef.current || !canSwipeReply) return;
            if (event.pointerType === "mouse") return;
            if (activeSwipePointerIdRef.current !== event.pointerId) return;
            const dx = event.clientX - touchStartXRef.current;
            const dy = event.clientY - touchStartYRef.current;
            touchDxRef.current = dx;
            touchDyRef.current = dy;
            const absDx = Math.abs(dx);
            const absDy = Math.abs(dy);
            if (!isSwiping && absDy > absDx * 2.4 && absDy > 28) {
              resetSwipe();
              return;
            }
            if (!isSwiping) {
              if (absDx < 3 && absDy < 3) {
                return;
              }
              const horizontalIntent = absDx > 3 && absDx > absDy * 0.15;
              if (!horizontalIntent) {
                return;
              }
              swipeGestureActiveRef.current = true;
              setIsSwiping(true);
            }
            if (event.cancelable) {
              event.preventDefault();
            }
            if (dx < 0) {
              queueSwipeOffset(Math.max(dx, -90));
            } else {
              queueSwipeOffset(0);
            }
          }}
          onPointerUpCapture={(event) => {
            if (!trackingSwipeRef.current) return;
            if (event.pointerType === "mouse") return;
            if (activeSwipePointerIdRef.current !== event.pointerId) return;
            if (swipeGestureActiveRef.current) {
              suppressCodeClickUntilRef.current = Date.now() + 320;
            }
            handleSwipeEnd();
          }}
          onPointerCancelCapture={(event) => {
            if (event.pointerType === "mouse") return;
            if (activeSwipePointerIdRef.current !== event.pointerId) return;
            if (swipeGestureActiveRef.current) {
              suppressCodeClickUntilRef.current = Date.now() + 320;
            }
            handleSwipeEnd();
          }}
        >
          {showSwipeHint ? (
            <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">
              <div
                className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-500 text-white shadow-lg shadow-emerald-500/30"
                style={{
                  opacity: swipeProgress,
                  transform: `translateX(${124 - swipeProgress * 124}px) scale(${
                    0.5 + swipeProgress * 0.7
                  })`,
                }}
              >
                <Reply size={16} />
              </div>
            </div>
          ) : null}
          {/* Leading gutter: the selection checkbox. */}
          {leadingGutter}
          {showAvatarGutter
            ? isRunEnd
              ? renderSenderAvatar()
              : <div className="h-8 w-8 shrink-0" aria-hidden="true" />
            : null}
          <div
            className={`relative flex min-w-0 max-w-[85%] flex-col md:max-w-[min(480px,78%)] ${
              isOwn ? "items-end" : "items-start"
            }`}
            style={{
              transform: swipeOffset
                ? `translateX(${swipeOffset}px)`
                : undefined,
              transition: isSwiping ? "none" : "transform 160ms ease",
              willChange: isSwiping ? "transform" : "auto",
            }}
          >
            <div
              data-message-bubble
              className={`relative max-w-full text-[15px] leading-[1.35] ${bubbleSize} ${bubbleCorners} ${bubbleSurface}`}
              style={{
                ...(mediaBubbleWidthPx ? { width: `${mediaBubbleWidthPx}px` } : null),
                ...(metaVariant === "inline"
                  ? {
                      "--sb-meta-text": `"${metaSpacer.text}"`,
                      "--sb-meta-extra": `${metaSpacer.extraPx}px`,
                    }
                  : null),
              }}
              onDoubleClick={(event) => {
                if (selectionMode) return;
                // A message that takes reactions gets a heart; the others reply.
                if (heartReaction.onDoubleClick(event)) return;
                if (!isDesktop || !onReply) return;
                // A double click on text selects a word; only a double click
                // that selected nothing (padding, a picture) replies.
                if (hasActiveTextSelection()) return;
                onReply(msg);
              }}
              onMouseDownCapture={(event) => {
                mouseDownRef.current =
                  event.button === 0
                    ? { x: event.clientX, y: event.clientY }
                    : null;
                // The time lets mouse events through to the bubble. A double or
                // triple click on it would select hidden text around it.
                if (event.button === 0 && event.detail > 1) {
                  const meta = event.currentTarget.querySelector("[data-message-meta]");
                  const box = meta?.getBoundingClientRect();
                  if (
                    box &&
                    event.clientX >= box.left &&
                    event.clientX <= box.right &&
                    event.clientY >= box.top &&
                    event.clientY <= box.bottom
                  ) {
                    event.preventDefault();
                  }
                }
              }}
              onClickCapture={(event) => {
                const down = mouseDownRef.current;
                mouseDownRef.current = null;
                if (
                  isDragSelectionClick({
                    down,
                    clientX: event.clientX,
                    clientY: event.clientY,
                    selectionText:
                      typeof window !== "undefined"
                        ? window.getSelection?.()?.toString() || ""
                        : "",
                  })
                ) {
                  // The mouse was released after selecting text: not a click on
                  // the link, inline code or quoted message under it.
                  event.preventDefault();
                  event.stopPropagation();
                }
              }}
            >
              <HeartBurst burst={heartReaction.burst} />
              {hasBubbleHeader && !isVideoNote ? (
                <div className={hasMediaBubble ? "px-2.5 pt-1.5" : undefined}>
                  {bubbleHeader}
                </div>
              ) : null}
              {isCallEntry ? (
                <CallEntry
                  msg={msg}
                  isOwn={isOwn}
                  chatId={chatId || msg?.chat_id || null}
                  peer={callPeer}
                  inert={selectionMode}
                />
              ) : null}
              {isUnsupported ? <UnsupportedMessage /> : null}
              {isVideoNote ? (
                <Suspense fallback={<div className="h-56 w-56 max-w-[62vw] animate-pulse rounded-full bg-slate-200/60 dark:bg-slate-700/40" />}>
                  <VideoNoteBubble msg={msg} user={user} header={bubbleHeader} />
                </Suspense>
              ) : (
                <MessageFiles
                  files={messageFiles}
                  docFullWidth={isGroupChat && !isOwn && !isDesktop}
                  {...messageFilesProps}
                />
              )}
              {showBody ? (
                <div
                  ref={messageBodyRef}
                  dir="auto"
                  className={`sb-markdown wrap-break-word wrap-anywhere ${
                    hasPersian(bodyText) ? "font-fa" : ""
                  } ${bodyTailClass} ${
                    hasMediaBubble
                      ? "px-2.5 pb-1.5 pt-1"
                      : hasFiles
                        ? "mt-1"
                        : ""
                  }`}
                  style={{ unicodeBidi: "plaintext", textAlign: "start" }}
                  dangerouslySetInnerHTML={{
                    __html: String(markdownHtml || ""),
                  }}
                />
              ) : null}
              {mentionDebugEnabled ? (
                <div className="sb-mention-debug" aria-hidden="true">
                  @{mentionDebug?.active ?? 0}/{mentionDebug?.total ?? 0}
                </div>
              ) : null}
              <MessageMeta
                variant={metaVariant}
                side={metaSide}
                tone={isOwn ? "own" : "other"}
                timeLabel={timeLabel}
                isEdited={isEdited}
                expiryBadge={expiryBadge}
                status={metaStatus}
                viewsLabel={viewsLabel}
              />
            </div>
            {/* Room under the bubble for reaction chips. */}
            <div data-slot="reactions" className="empty:hidden">
              {reactionsSlot}
            </div>
            {isChannelChat && typeof onForwardMessage === "function" ? (
              <button
                type="button"
                onClick={() => onForwardMessage(msg)}
                className="absolute bottom-1 -right-11 inline-flex h-9 w-9 items-center justify-center rounded-full border border-emerald-200 bg-white text-emerald-700 shadow-xs transition hover:border-emerald-300 hover:bg-emerald-50 hover:shadow-[0_0_14px_color-mix(in_srgb,var(--color-emerald-500)_20%,transparent)] dark:border-emerald-500/30 dark:bg-slate-900 dark:text-emerald-200 dark:hover:bg-emerald-500/10"
                aria-label="Forward message"
              >
                <Forward size={15} className="icon-anim-pop" />
              </button>
            ) : null}
          </div>
        </ContextMenuSurface>
      ) : null}
    </div>
  );
}, (prev, next) => {
  if (getMessageRenderSignature(prev.msg) !== getMessageRenderSignature(next.msg)) {
    return false;
  }
  if (prev.unreadMarkerId !== next.unreadMarkerId) return false;
  if (prev.isRunStart !== next.isRunStart) return false;
  if (prev.isRunEnd !== next.isRunEnd) return false;
  if (prev.leadingSlot !== next.leadingSlot) return false;
  if (prev.selectionMode !== next.selectionMode) return false;
  if (prev.isSelected !== next.isSelected) return false;
  if (prev.isSelectionTabStop !== next.isSelectionTabStop) return false;
  if (prev.onToggleSelect !== next.onToggleSelect) return false;
  if (prev.reactionsSlot !== next.reactionsSlot) return false;
  if (prev.callPeer !== next.callPeer) return false;
  if (prev.isDesktop !== next.isDesktop) return false;
  if (prev.isMobileTouchDevice !== next.isMobileTouchDevice) return false;
  if (prev.isGroupChat !== next.isGroupChat) return false;
  if (prev.isChannelChat !== next.isChannelChat) return false;
  if (prev.chatName !== next.chatName) return false;
  if (prev.chatColor !== next.chatColor) return false;
  if (prev.seenCount !== next.seenCount) return false;
  if (prev.mentionRefreshToken !== next.mentionRefreshToken) return false;
  if (prev.user?.username !== next.user?.username) return false;
  if (prev.forwardedUser !== next.forwardedUser) return false;
  if (prev.forwardedUserStatus !== next.forwardedUserStatus) return false;
  if (prev.forwardedChat !== next.forwardedChat) return false;
  if (prev.forwardedChatStatus !== next.forwardedChatStatus) return false;
  if (prev.isOffline !== next.isOffline) return false;
  if (prev.sseConnected !== next.sseConnected) return false;
  if (prev.messageFilesProps !== next.messageFilesProps) {
    const prevFiles = Array.isArray(prev.msg?.files) ? prev.msg.files : [];
    const nextFiles = Array.isArray(next.msg?.files) ? next.msg.files : [];
    if (prevFiles.length || nextFiles.length) return false;
  }
  return true;
});
