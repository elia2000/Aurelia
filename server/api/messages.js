import rateLimit from "express-rate-limit";
import { validateUuidParams, validateUuidBody } from "../lib/uuidMiddleware.js";
import { createMessagePublicationService } from "../lib/services/messagePublicationService.js";
import { dispatchMediaWorkerJob } from "../lib/mediaWorker.js";
import { resolveWebhookCallbackUrl } from "../lib/webhookUrl.js";
import { markEncryptedFileRecord } from "../lib/storageEncryption.js";
import { resolveThumbUrl } from "../lib/thumbUrl.js";
import { readEnvBool } from "../settings/env.js";
import {
  parseVideoNoteEnvelope,
  safeParseStoredEnvelope,
} from "../lib/e2eeEnvelope.js";
import { summarizeReactionRows } from "../lib/reactions.js";
import { isServiceMessageBody, parsePinServiceBody } from "../lib/serviceMessages.js";
import { emitUnpinnedMessages } from "../lib/pins.js";
import { isCallMessage, serializeCall } from "../lib/callMessages.js";
import { createThrottle } from "../lib/throttle.js";
import {
  ANIMATION_REQUEST_SCAN_BUDGET_BYTES,
  animationFlags,
  detectAnimatedFile,
  isAnimationCandidate,
} from "../lib/animatedImage.js";
import { createSavedGifService } from "../lib/services/savedGifService.js";
import { createMessageForwardService } from "../lib/services/messageForwardService.js";
import { createMessageDeleteService } from "../lib/services/messageDeleteService.js";
import {
  FORWARD_MAX_CREATED_MESSAGES,
  FORWARD_MAX_TARGET_CHATS,
  FORWARD_MESSAGES_PER_MINUTE,
  commonFailureStatus,
  parseMessageIdList,
} from "../lib/batchMessages.js";
import { isValidUuid } from "../lib/uuidUtils.js";

function registerMessageRoutes(app, deps) {
  const {
    MESSAGE_FILE_LIMITS,
    getSetting,
    cleanupMissingMessageFiles,
    computeExpiryIso,
    crypto,
    createOrReuseMessage,
    createMessageFiles,
    editMessage,
    debugLog,
    decodeOriginalFilename,
    emitChatEvent,
    emitSseEvent,
    ensureAvatarExists,
    ensureFfmpegAvailable,
    fs,
    findChatById,
    findMessageIdByClientRequestId,
    findMessageById,
    findUserByUsername,
    getMessages,
    getFirstUnreadMessage,
    getMessageReadCounts,
    getMessageAuthors,
    getMessageReadByUser,
    getUploadKind,
    hasEnoughFreeDiskSpace,
    hydrateMissingVideoMetadata,
    inferMimeFromFilename,
    isDangerousUploadFile,
    isMember,
    isVideoFileProcessing,
    getChatMemberRole,
    listChatMembers,
    listMutedUserIdsForChat,
    sendPushNotificationToUsers,
    isUserConnected,
    listMessageFilesByMessageIds,
    parseUploadFileMetadata,
    path,
    probeVideoMetadata,
    removeUploadedFiles,
    removePendingPresignedUploads,
    requireSession,
    requireSessionUsernameMatch,
    sanitizeDurationSeconds,
    sanitizePositiveInt,
    setMessageExpiresAt,
    setMessageForwardOrigin,
    storageEncryption,
    uploadFiles,
    uploadRootDir,
    enqueueVideoTranscodeJob,
    markMessagesRead,
    markMessageRead,
    findE2eeDevice,
    setMessageE2eeEnvelope,
    listMessageReactionSummaries,
    listPinnedMessageIds,
  } = deps;

  const safeBasename = (p) => {
    if (path && typeof path.basename === "function") return path.basename(p);
    return String(p || "").split("/").pop().split("\\").pop();
  };
  const safeInferMime =
    typeof inferMimeFromFilename === "function"
      ? inferMimeFromFilename
      : () => null;
  const safeDecodeFilename =
    typeof decodeOriginalFilename === "function"
      ? decodeOriginalFilename
      : (n) => n;
  const safeIsDangerousUploadFile =
    typeof isDangerousUploadFile === "function"
      ? isDangerousUploadFile
      : () => false;
  const safeGetUploadKind =
    typeof getUploadKind === "function"
      ? getUploadKind
      : (_uploadType, mimeType) => {
          const m = String(mimeType || "").toLowerCase();
          if (m.startsWith("image/")) return "image";
          if (m.startsWith("video/")) return "video";
          if (m.startsWith("audio/")) return "audio";
          return "document";
        };
  const safeSanitizePositiveInt =
    typeof sanitizePositiveInt === "function"
      ? sanitizePositiveInt
      : (val) => {
          const num = Number(val);
          return Number.isFinite(num) && num > 0 ? Math.round(num) : null;
        };
  const safeSanitizeDurationSeconds =
    typeof sanitizeDurationSeconds === "function"
      ? sanitizeDurationSeconds
      : (val) => {
          const num = Number(val);
          return Number.isFinite(num) && num >= 0 ? num : null;
        };

  const messagePubService = createMessagePublicationService({
    createOrReuseMessage,
    createMessageFiles,
    editMessage,
    findChatById,
    findMessageById,
    listChatMembers,
    listMutedUserIdsForChat,
    markMessageRead,
    setMessageExpiresAt,
    setMessageForwardOrigin,
  });

  const resolveMaybePromise = async (value) =>
    value && typeof value.then === "function" ? await value : value;

  // Sending a saved GIF copies up to 20 MB, so it is limited per person.
  const savedGifService = createSavedGifService(deps);
  const savedGifSendThrottle = createThrottle({ windowMs: 60 * 1000, max: 30 });

  const computeTextExpiryIso = (createdAt) => {
    const textRetentionDays = Number(getSetting("MESSAGE_TEXT_RETENTION") || 0);
    if (textRetentionDays <= 0) return null;
    const base = new Date(createdAt || Date.now());
    const baseMs = base.getTime();
    if (!Number.isFinite(baseMs)) return null;
    return new Date(
      baseMs + textRetentionDays * 24 * 60 * 60 * 1000,
    ).toISOString();
  };

  // Forwarding and deleting, one message or many: the same code judges and
  // handles each message whichever way it was asked for (lib/services).
  const forwardService = createMessageForwardService(deps, { computeTextExpiryIso });
  const deleteService = createMessageDeleteService(deps);
  // Limits are per signed-in person (see lib/throttle.js). Deleting costs a
  // token per request: it can only hide or delete what the person may already
  // delete. Forwarding also costs a token per request, and in addition the
  // messages it creates count against a budget, because every one of them is
  // delivered to every member of the target chat.
  const forwardThrottle = createThrottle({ windowMs: 60 * 1000, max: 30 });
  const forwardBudget = createThrottle({ windowMs: 60 * 1000, max: FORWARD_MESSAGES_PER_MINUTE });
  const deleteThrottle = createThrottle({ windowMs: 60 * 1000, max: 120 });

  const canUserPostInChat = async (chatId, userId, chat = null) => {
    const rawChat = chat || findChatById(chatId);
    const resolvedChat = rawChat && typeof rawChat.then === "function" ? await rawChat : rawChat;
    if (!resolvedChat) return false;
    if (resolvedChat.type !== "channel") return true;
    const rawRole = getChatMemberRole(chatId, userId);
    const role = String(rawRole && typeof rawRole.then === "function" ? await rawRole : rawRole).toLowerCase();
    return role === "owner";
  };

  const messageRateLimitHandler = (_req, res) =>
    res.status(429).json({
      error: "Too many message requests. Please try again later.",
    });

  const messageUploadLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    handler: messageRateLimitHandler,
  });

  const messageEditLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    handler: messageRateLimitHandler,
  });

  const isRemoteChannelMessage = (message) =>
    /^remote:/i.test(
      String(message?.client_request_id || message?.clientRequestId || "").trim(),
    );

  const isMessageAuthoredByUser = (message, userId) =>
    String(message?.user_id || "") === String(userId) &&
    !isRemoteChannelMessage(message);

  app.get("/api/messages", async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) return;

    const chatId = req.query.chatId?.toString() || "";
    const username = req.query.username?.toString();
    const beforeId = req.query.beforeId?.toString() || "";
    const beforeCreatedAt = req.query.beforeCreatedAt?.toString() || "";
    const afterId = req.query.afterId?.toString() || "";
    const afterCreatedAt = req.query.afterCreatedAt?.toString() || "";
    const limitRaw = Number(req.query.limit || 50);
    const limit = Number.isFinite(limitRaw)
      ? Math.max(1, Math.min(10000, limitRaw))
      : 50;

    if (!chatId || !username) {
      return res.status(400).json({ error: "Chat and username are required." });
    }
    if (!requireSessionUsernameMatch(res, session, username)) return;

    const rawUser = findUserByUsername(username.toLowerCase());
    const user = rawUser && typeof rawUser.then === "function" ? await rawUser : rawUser;
    if (!user) {
      return res.status(404).json({ error: "User not found." });
    }

    const rawIsMember = isMember(chatId, user.id);
    const memberCheck = rawIsMember && typeof rawIsMember.then === "function" ? await rawIsMember : rawIsMember;
    if (!memberCheck) {
      return res.status(403).json({ error: "Not a member of this chat." });
    }

    const rawMsgData = getMessages(chatId, {
      beforeId: beforeId || null,
      beforeCreatedAt: beforeCreatedAt || null,
      afterId: afterId || null,
      afterCreatedAt: afterCreatedAt || null,
      limit,
      viewerUserId: user.id,
    });
    let { messages, hasMore } = (rawMsgData && typeof rawMsgData.then === "function" ? await rawMsgData : rawMsgData) || { messages: [], hasMore: false };

    // Run the missing-file cleanup in the background so it doesn't block the
    // response. If files are found missing the next fetch will reflect the
    // deletion via the SSE chat_message_deleted event emitted by the cleanup.
    setImmediate(() => {
      try {
        const cleanup = cleanupMissingMessageFiles(
          messages.map((message) => message.id).filter(Boolean),
        );
        if (cleanup.changed && cleanup.deletedByChat?.size) {
          cleanup.deletedByChat.forEach((messageIds, deletedChatId) => {
            emitChatEvent(deletedChatId, {
              type: "chat_message_deleted",
              chatId: deletedChatId,
              messageIds,
            });
          });
          // Pins go with their messages.
          emitUnpinnedMessages(emitChatEvent, cleanup.unpinned);
        }
      } catch (_) {
        // best-effort background cleanup — never crash the server
      }
    });

    const normalizedMessages = messages.map((message) => ({
      ...message,
      avatar_url: ensureAvatarExists(message.user_id, message.avatar_url),
      replyTo:
        message?.reply_id
          ? {
              id: message.reply_id,
              body: message.reply_body || "",
              created_at: message.reply_created_at || null,
              username: message.reply_username || "",
              nickname: message.reply_nickname || "",
              color: message.reply_user_color || null,
              verified: Boolean(message.reply_user_verified),
              role: message.reply_user_role || "user",
              avatar_url: ensureAvatarExists(
                message.reply_user_id || null,
                message.reply_avatar_url,
              ),
            }
          : null,
    }));

    const messageIds = normalizedMessages
      .map((message) => message.id)
      .filter(Boolean);
    const rawReadRows = getMessageReadByUser(messageIds, user.id);
    const readRows = (rawReadRows && typeof rawReadRows.then === "function" ? await rawReadRows : rawReadRows) || [];
    const readByMe = new Set(
      readRows.map((row) => row?.message_id).filter(Boolean),
    );
    // Reactions for the whole page in one query. They are secondary to the
    // messages themselves, so a failure here must not hide the conversation.
    let reactionsByMessageId = new Map();
    if (typeof listMessageReactionSummaries === "function" && messageIds.length) {
      try {
        const rawReactionRows = listMessageReactionSummaries(messageIds, user.id);
        reactionsByMessageId = summarizeReactionRows(
          rawReactionRows && typeof rawReactionRows.then === "function"
            ? await rawReactionRows
            : rawReactionRows,
        );
      } catch (error) {
        console.error("GET /api/messages reactions ERROR:", error);
      }
    }
    // Which messages of the page are pinned: one query for the whole page. A
    // failure here must not hide the conversation either.
    let pinnedMessageIds = new Set();
    if (typeof listPinnedMessageIds === "function" && messageIds.length) {
      try {
        const rawPinnedRows = listPinnedMessageIds(chatId, messageIds);
        const pinnedRows =
          (rawPinnedRows && typeof rawPinnedRows.then === "function"
            ? await rawPinnedRows
            : rawPinnedRows) || [];
        pinnedMessageIds = new Set(pinnedRows.map((row) => row?.message_id).filter(Boolean));
      } catch (error) {
        console.error("GET /api/messages pins ERROR:", error);
      }
    }
    const rawFiles = listMessageFilesByMessageIds(messageIds);
    const resolvedFiles = (rawFiles && typeof rawFiles.then === "function" ? await rawFiles : rawFiles) || [];
    const files = await hydrateMissingVideoMetadata(resolvedFiles);

    const filesByMessageId = {};
    for (const file of files) {
      const messageId = file.message_id;
      if (!filesByMessageId[messageId]) filesByMessageId[messageId] = [];

      let fileUrl = `/api/uploads/messages/${file.stored_name}`;
      let thumbUrl = null;
      const driver = file.storage_driver;
      const storageKey = file.storage_key;
      const thumbKey = file.thumb_storage_key || file.thumbStorageKey;
      thumbUrl = await resolveThumbUrl({
        storageProvider: deps.storageProvider,
        file,
        thumbKey,
        fileId: file.id,
      });
      if (
        (driver === "remote" || driver === "s3") &&
        deps.storageProvider &&
        typeof deps.storageProvider.getDownloadUrl === "function"
      ) {
        if (storageKey) {
          try {
            fileUrl = await deps.storageProvider.getDownloadUrl(storageKey);
          } catch (_) {}
        }
      }

      filesByMessageId[messageId].push({
        id: file.id,
        kind: file.kind,
        name: file.original_name,
        mimeType: file.mime_type,
        processing: isVideoFileProcessing(file),
        sizeBytes: Number(file.size_bytes || 0),
        width: Number.isFinite(Number(file.width_px))
          ? Number(file.width_px)
          : null,
        height: Number.isFinite(Number(file.height_px))
          ? Number(file.height_px)
          : null,
        durationSeconds: Number.isFinite(Number(file.duration_seconds))
          ? Number(file.duration_seconds)
          : null,
        expiresAt: file.expires_at || null,
        thumbStorageKey: thumbKey || null,
        thumbUrl: thumbUrl || null,
        url: fileUrl,
        ...animationFlags(file),
      });
    }

    const enriched = normalizedMessages
      .map((message) => ({
        ...message,
        clientRequestId: message.client_request_id || null,
        read_by_me:
          isMessageAuthoredByUser(message, user.id) ||
          readByMe.has(message.id),
        files: filesByMessageId[message.id] || [],
        reactions: reactionsByMessageId.get(message.id) || [],
        pinned: pinnedMessageIds.has(message.id),
        // "X pinned a message" entries carry their structured form; every
        // other message (and every other service message) has none.
        service: parsePinServiceBody(message.body, message.user_id),
        // Call history entries ("Outgoing call 0:23", "Missed call") are
        // messages with an empty body and a structured call; `messageType`
        // is also on realtime events, where `type` is the event's own name.
        call: serializeCall(message),
        messageType: isCallMessage(message) ? "call" : "text",
        ...(isCallMessage(message) ? { type: "call" } : {}),
        e2ee: safeParseStoredEnvelope(message.e2ee_envelope),
        // The sender of an encrypted message signed the chat it belongs to;
        // the recipient must know it to verify (message rows carry no chat id).
        ...(message.e2ee_envelope ? { chat_id: chatId } : {}),
        expiresAt: null,
      }))
      .map(
        ({
          e2ee_envelope: _envelope,
          // The call is sent structured (`call`), not as raw columns.
          call_id: _callId,
          call_kind: _callKind,
          call_outcome: _callOutcome,
          call_duration_sec: _callDurationSec,
          ...message
        }) => message,
      )
      .map((message) => ({
        ...message,
        expiresAt:
          Array.isArray(message.files) && message.files.length === 0
            ? message.expires_at || null
            : null,
      }))
      .filter((message) => {
        const isFromOther = !isMessageAuthoredByUser(message, user.id);
        if (!isFromOther) return true;

        const hasPendingVideo = (message.files || []).some(
          (file) =>
            String(file?.mimeType || "")
              .toLowerCase()
              .startsWith("video/") && Boolean(file?.processing),
        );

        return !hasPendingVideo;
      });

    if (getSetting("APP_DEBUG")) {
      const processingRows = [];

      enriched.forEach((message) => {
        const files = Array.isArray(message?.files) ? message.files : [];

        files.forEach((file) => {
          processingRows.push({
            messageId: message?.id || null,
            fileId: file?.id || null,
            mimeType: String(file?.mimeType || ""),
            url: String(file?.url || ""),
            processing: Boolean(file?.processing),
          });
        });
      });

      debugLog("api:messages:files", {
        chatId,
        username: user.username,
        files: processingRows,
      });
    }

    const rawChat = findChatById(chatId);
    const chat = rawChat && typeof rawChat.then === "function" ? await rawChat : rawChat;
    if (chat?.type === "channel" && messageIds.length) {
      const rawCountRows = getMessageReadCounts(messageIds);
      const countRows = (rawCountRows && typeof rawCountRows.then === "function" ? await rawCountRows : rawCountRows) || [];
      const counts = countRows.reduce((acc, row) => {
        const id = row?.message_id;
        if (!id) return acc;
        acc[id] = Number(row?.count || 0);
        return acc;
      }, {});
      
      // For regular messages (not remote), add +1 for the author
      // For remote messages, don't add the author count (starts at 0)
      enriched.forEach((msg) => {
        const id = msg?.id;
        if (!id) return;
        const isRemote = isRemoteChannelMessage(msg);
        if (!isRemote) {
          counts[id] = Number(counts[id] || 0) + 1;
        }
      });
      
      enriched.forEach((msg) => {
        const id = msg?.id;
        if (!id) return;
        // Remote messages start at 0 views, regular messages start at 1
        const isRemote = isRemoteChannelMessage(msg);
        const defaultCount = isRemote ? 0 : 1;
        msg.seenCount = Number(counts[id] || defaultCount);
      });
    }

    debugLog("api:messages", {
      chatId,
      username: user.username,
      messageCount: enriched.length,
      fileCount: files.length,
      hasMore,
    });

    res.json({ chatId, messages: enriched, hasMore });
  });

  app.get("/api/messages/first-unread", async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) return;

    const chatId = req.query.chatId?.toString() || "";
    const username = req.query.username?.toString();

    if (!chatId || !username) {
      return res.status(400).json({ error: "Chat and username are required." });
    }
    if (!requireSessionUsernameMatch(res, session, username)) return;

    const rawUser = findUserByUsername(username.toLowerCase());
    const user = rawUser && typeof rawUser.then === "function" ? await rawUser : rawUser;
    if (!user) {
      return res.status(404).json({ error: "User not found." });
    }

    const rawIsMem = isMember(chatId, user.id);
    const memberCheck = rawIsMem && typeof rawIsMem.then === "function" ? await rawIsMem : rawIsMem;
    if (!memberCheck) {
      return res.status(403).json({ error: "Not a member of this chat." });
    }

    const rawFirstUnread = getFirstUnreadMessage(chatId, user.id);
    const firstUnread = rawFirstUnread && typeof rawFirstUnread.then === "function" ? await rawFirstUnread : rawFirstUnread;
    res.json({ firstUnread: firstUnread || null });
  });

  app.post("/api/messages/read", validateUuidBody([{ field: "chatId", required: true }]), async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) return;

    const { chatId, username } = req.body || {};
    if (!chatId || !username) {
      return res.status(400).json({ error: "Chat and username are required." });
    }

    if (!requireSessionUsernameMatch(res, session, username)) return;

    const rawUser = findUserByUsername(username.toLowerCase());
    const user = rawUser && typeof rawUser.then === "function" ? await rawUser : rawUser;
    if (!user) {
      return res.status(404).json({ error: "User not found." });
    }

    const rawIsMem = isMember(chatId, user.id);
    const memberCheck = rawIsMem && typeof rawIsMem.then === "function" ? await rawIsMem : rawIsMem;
    if (!memberCheck) {
      return res.status(403).json({ error: "Not a member of this chat." });
    }

    const m = markMessagesRead(chatId, user.id);
    if (m && typeof m.then === "function") await m;

    emitChatEvent(chatId, {
      type: "chat_read",
      chatId,
      username: user.username,
    });

    res.json({ ok: true });
  });

  app.post("/api/messages/read-one", validateUuidBody([{ field: "chatId", required: true }, { field: "messageId", required: true }]), async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) return;

    const { chatId, username, messageId } = req.body || {};
    if (!chatId || !username || !messageId) {
      return res.status(400).json({
        error: "Chat id, username, and messageId are required.",
      });
    }

    if (!requireSessionUsernameMatch(res, session, username)) return;

    const rawUser = findUserByUsername(username.toLowerCase());
    const user = rawUser && typeof rawUser.then === "function" ? await rawUser : rawUser;
    if (!user) {
      return res.status(404).json({ error: "User not found." });
    }

    const rawIsMem = isMember(chatId, user.id);
    const memberCheck = rawIsMem && typeof rawIsMem.then === "function" ? await rawIsMem : rawIsMem;
    if (!memberCheck) {
      return res.status(403).json({ error: "Not a member of this chat." });
    }

    const rawMessage = findMessageById(messageId);
    const message = rawMessage && typeof rawMessage.then === "function" ? await rawMessage : rawMessage;
    if (!message || message.chat_id !== chatId) {
      return res.status(404).json({ error: "Message not found in this chat." });
    }

    const m = markMessageRead(messageId, user.id);
    if (m && typeof m.then === "function") await m;

    emitChatEvent(chatId, {
      type: "chat_read",
      chatId,
      messageId,
      username: user.username,
    });

    res.json({ ok: true });
  });

  app.post("/api/messages/read-counts", validateUuidBody([{ field: "chatId", required: true }]), async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) return;

    const { chatId, username, messageIds = [] } = req.body || {};
    if (!chatId || !username || !Array.isArray(messageIds)) {
      return res.status(400).json({
        error: "Chat id, username, and messageIds are required.",
      });
    }
    if (!requireSessionUsernameMatch(res, session, username)) return;

    const rawUser = findUserByUsername(username.toLowerCase());
    const user = rawUser && typeof rawUser.then === "function" ? await rawUser : rawUser;
    if (!user) {
      return res.status(404).json({ error: "User not found." });
    }
    const rawIsMem = isMember(chatId, user.id);
    const memberCheck = rawIsMem && typeof rawIsMem.then === "function" ? await rawIsMem : rawIsMem;
    if (!memberCheck) {
      return res.status(403).json({ error: "Not a member of this chat." });
    }

    const rawAuthors = getMessageAuthors(messageIds);
    const authors = (rawAuthors && typeof rawAuthors.then === "function" ? await rawAuthors : rawAuthors) || [];
    const messages = authors.reduce((acc, row) => {
      const id = row?.id;
      if (!id) return acc;
      acc[id] = row;
      return acc;
    }, {});
    
    const rawRows = getMessageReadCounts(messageIds);
    const rows = (rawRows && typeof rawRows.then === "function" ? await rawRows : rawRows) || [];
    const counts = rows.reduce((acc, row) => {
      const id = row?.message_id;
      if (!id) return acc;
      acc[id] = Number(row?.count || 0);
      return acc;
    }, {});
    
    // For regular messages (not remote), add +1 for the author
    // For remote messages, don't add the author count (starts at 0)
    Object.keys(messages).forEach((key) => {
      const id = key;
      if (!id) return;
      const msg = messages[id];
      const isRemote = isRemoteChannelMessage(msg);
      if (!isRemote) {
        counts[id] = Number(counts[id] || 0) + 1;
      }
    });

    res.json({ ok: true, counts });
  });

  app.post("/api/messages/typing", validateUuidBody([{ field: "chatId", required: true }]), async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) return;

    const { chatId, username, isTyping } = req.body || {};
    if (!chatId || !username || typeof isTyping !== "boolean") {
      return res.status(400).json({
        error: "Chat id, username, and isTyping are required.",
      });
    }
    if (!requireSessionUsernameMatch(res, session, username)) return;

    const rawUser = findUserByUsername(String(username || "").toLowerCase());
    const user = rawUser && typeof rawUser.then === "function" ? await rawUser : rawUser;
    if (!user) {
      return res.status(404).json({ error: "User not found." });
    }
    const rawMember = isMember(chatId, user.id);
    const isMem = rawMember && typeof rawMember.then === "function" ? await rawMember : rawMember;
    if (!isMem) {
      return res.status(403).json({ error: "Not a member of this chat." });
    }

    const rawChat = findChatById(chatId);
    const chat = rawChat && typeof rawChat.then === "function" ? await rawChat : rawChat;
    if (!chat) {
      return res.status(404).json({ error: "Chat not found." });
    }
    if (String(chat.type || "").toLowerCase() === "channel") {
      return res.json({ ok: true, skipped: true });
    }

    // Invisible users should not broadcast typing start state.
    if (
      Boolean(isTyping) &&
      String(user.status || "").toLowerCase() === "invisible"
    ) {
      return res.json({ ok: true, skipped: true });
    }

    emitChatEvent(chatId, {
      type: "chat_typing",
      chatId,
      username: user.username,
      nickname: user.nickname || user.username,
      isTyping: Boolean(isTyping),
      createdAt: new Date().toISOString(),
    });

    return res.json({ ok: true });
  });

  app.post(
    "/api/messages/upload",
    messageUploadLimiter,
    uploadFiles.array("files", MESSAGE_FILE_LIMITS.maxFiles),
    async (req, res) => {
      const session = await requireSession(req, res);
      if (!session) {
        removeUploadedFiles(req.files || []);
        return;
      }

      const uploadedFiles = Array.isArray(req.files) ? req.files : [];

      try {
        if (!getSetting("FILE_UPLOAD")) {
          removeUploadedFiles(uploadedFiles);
          return res
            .status(503)
            .json({ error: "File uploads are disabled on this server." });
        }

        const chatId = req.body?.chatId?.toString() || "";
        const username = req.body?.username?.toString();
        const uploadType = req.body?.uploadType?.toString();
        const fileMeta = parseUploadFileMetadata(req.body?.fileMeta);

        let rawStorageKeys =
          req.body?.storageKeys ??
          req.body?.storageKey ??
          req.body?.presignedFiles;
        let presignedFiles = [];

        if (rawStorageKeys !== undefined && rawStorageKeys !== null) {
          if (typeof rawStorageKeys === "string") {
            const trimmed = rawStorageKeys.trim();
            if (trimmed) {
              try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) {
                  presignedFiles = parsed;
                } else if (parsed && typeof parsed === "object") {
                  presignedFiles = [parsed];
                } else if (typeof parsed === "string" && parsed.trim()) {
                  presignedFiles = [parsed.trim()];
                }
              } catch (_) {
                presignedFiles = [trimmed];
              }
            }
          } else if (Array.isArray(rawStorageKeys)) {
            presignedFiles = rawStorageKeys;
          } else if (typeof rawStorageKeys === "object") {
            presignedFiles = [rawStorageKeys];
          }
        }

        const body = req.body?.body?.toString() || "";
        const trimmedBody = body.trim();
        const replyToMessageId = req.body?.replyToMessageId?.toString() || null;
        const editMessageId = req.body?.editMessageId?.toString() || null;
        const clientRequestIdRaw = String(
          req.body?.clientRequestId || "",
        ).trim();
        const clientRequestId = clientRequestIdRaw
          ? clientRequestIdRaw.slice(0, 120)
          : null;
        const maxMessageChars = Math.max(1, Number(getSetting("MESSAGE_MAX_CHARS") || 4000));
        if (body.length > maxMessageChars) {
          removeUploadedFiles(uploadedFiles);
          return res.status(400).json({
            error: `Message must be at most ${maxMessageChars} characters.`,
          });
        }
        if (isServiceMessageBody(body)) {
          removeUploadedFiles(uploadedFiles);
          return res.status(400).json({ error: "Invalid message body." });
        }

        let e2eeEnvelope = null;
        let e2eeEnvelopeJson = null;
        if (req.body?.e2eeEnvelope) {
          const parsedEnvelope = parseVideoNoteEnvelope(req.body.e2eeEnvelope);
          if (!parsedEnvelope.ok) {
            removeUploadedFiles(uploadedFiles);
            return res.status(400).json({ error: parsedEnvelope.error });
          }
          e2eeEnvelope = parsedEnvelope.envelope;
          e2eeEnvelopeJson = parsedEnvelope.json;
        }

        if (!chatId || !username) {
          removeUploadedFiles(uploadedFiles);

          return res
            .status(400)
            .json({ error: "Chat and username are required." });
        }

        if (!requireSessionUsernameMatch(res, session, username)) {
          removeUploadedFiles(uploadedFiles);
          return;
        }

        const totalFilesCount = uploadedFiles.length + presignedFiles.length;

        if (!totalFilesCount) {
          return res
            .status(400)
            .json({ error: "At least one file is required." });
        }

        if (totalFilesCount > MESSAGE_FILE_LIMITS.maxFiles) {
          removeUploadedFiles(uploadedFiles);

          return res.status(400).json({
            error: `Maximum ${MESSAGE_FILE_LIMITS.maxFiles} files per message.`,
          });
        }

        const rawUser = findUserByUsername(username.toLowerCase());
        const user = rawUser && typeof rawUser.then === "function" ? await rawUser : rawUser;

        if (!user) {
          removeUploadedFiles(uploadedFiles);

          return res.status(404).json({ error: "User not found." });
        }

        const rawIsMember = isMember(chatId, user.id);
        const memberCheck = rawIsMember && typeof rawIsMember.then === "function" ? await rawIsMember : rawIsMember;
        if (!memberCheck) {
          removeUploadedFiles(uploadedFiles);

          return res.status(403).json({ error: "Not a member of this chat." });
        }
        const rawChat = findChatById(chatId);
        const chat = rawChat && typeof rawChat.then === "function" ? await rawChat : rawChat;
        if (!chat) {
          removeUploadedFiles(uploadedFiles);
          return res.status(404).json({ error: "Chat not found." });
        }
        if (chat.type === "channel") {
          const rawRole = getChatMemberRole(chatId, user.id);
          const role = String(rawRole && typeof rawRole.then === "function" ? await rawRole : rawRole).toLowerCase();
          if (role !== "owner") {
            removeUploadedFiles(uploadedFiles);
            return res
              .status(403)
              .json({ error: "Only channel owner can send messages." });
          }
        }
        if (e2eeEnvelope) {
          // Encrypted video messages: one opaque blob, no edits, never in
          // broadcast channels, and the sender device must be the caller's.
          // The client request id is part of what the sender signs (it ties
          // the envelope to this message), so it must be present and must
          // reach the recipients unchanged.
          if (!clientRequestId || clientRequestId !== clientRequestIdRaw) {
            removeUploadedFiles(uploadedFiles);
            return res.status(400).json({
              error: "Encrypted video messages need a request id.",
            });
          }
          if (
            editMessageId ||
            totalFilesCount !== 1 ||
            !["dm", "group", "saved"].includes(chat.type)
          ) {
            removeUploadedFiles(uploadedFiles);
            return res.status(400).json({
              error: "Encrypted video messages are not supported here.",
            });
          }
          const senderDevice = await resolveMaybePromise(
            typeof findE2eeDevice === "function"
              ? findE2eeDevice(user.id, e2eeEnvelope.senderDeviceId)
              : null,
          );
          if (!senderDevice || senderDevice.revoked_at) {
            removeUploadedFiles(uploadedFiles);
            return res.status(400).json({ error: "Unknown or revoked sender device." });
          }
        }
        if (replyToMessageId && editMessageId) {
          removeUploadedFiles(uploadedFiles);
          return res.status(400).json({
            error: "A message cannot be edited and replied to at the same time.",
          });
        }
        if (replyToMessageId) {
          const replyTarget = await resolveMaybePromise(findMessageById(replyToMessageId));
          if (!replyTarget || replyTarget.chat_id !== chatId || isCallMessage(replyTarget)) {
            removeUploadedFiles(uploadedFiles);
            return res
              .status(400)
              .json({ error: "Reply target is not available in this chat." });
          }
        }
        let editTarget = null;
        if (editMessageId) {
          editTarget = await resolveMaybePromise(findMessageById(editMessageId));
          if (!editTarget || editTarget.chat_id !== chatId) {
            removeUploadedFiles(uploadedFiles);
            return res.status(400).json({
              error: "Edit target is not available in this chat.",
            });
          }
          if (!isMessageAuthoredByUser(editTarget, user.id)) {
            removeUploadedFiles(uploadedFiles);
            return res.status(403).json({
              error: "Only the message author can edit this message.",
            });
          }
          // Call history and "X pinned a message" entries are server records:
          // like POST /api/messages/edit, this route may not change them (an
          // empty caption would leave the service body in place and only add
          // files and clear the expiry).
          if (isCallMessage(editTarget) || isServiceMessageBody(editTarget.body)) {
            removeUploadedFiles(uploadedFiles);
            return res.status(400).json({ error: "This message cannot be edited." });
          }
        }

        const localBytes = uploadedFiles.reduce(
          (sum, file) => sum + Number(file.size || 0),
          0,
        );

        const presignedBytes = presignedFiles.reduce((sum, item, index) => {
          const meta =
            fileMeta[uploadedFiles.length + index] || fileMeta[index] || {};
          const sz = Number(
            (typeof item === "object" && item !== null
              ? (item.sizeBytes ??
                item.size_bytes ??
                item.fileSize ??
                item.file_size ??
                item.size)
              : null) ??
              meta.sizeBytes ??
              meta.size_bytes ??
              meta.fileSize ??
              meta.file_size ??
              meta.size ??
              0,
          );
          return sum + (Number.isFinite(sz) && sz > 0 ? sz : 0);
        }, 0);

        const totalBytes = localBytes + presignedBytes;

        if (totalBytes > MESSAGE_FILE_LIMITS.maxTotalBytes) {
          removeUploadedFiles(uploadedFiles);

          return res.status(400).json({
            error: `Total upload size cannot exceed ${Math.round(MESSAGE_FILE_LIMITS.maxTotalBytes / (1024 * 1024))} MB.`,
          });
        }

        if (localBytes > 0 && !hasEnoughFreeDiskSpace(localBytes)) {
          removeUploadedFiles(uploadedFiles);

          return res.status(400).json({
            error: "Not enough free storage space on server.",
          });
        }

        if (!editMessageId && clientRequestId) {
          const rawExistingId = findMessageIdByClientRequestId(
            chatId,
            user.id,
            clientRequestId,
          );
          const existingId = rawExistingId && typeof rawExistingId.then === "function" ? await rawExistingId : rawExistingId;
          if (existingId) {
            removeUploadedFiles(uploadedFiles);
            return res.json({ id: existingId, deduped: true });
          }
        }

        const createdAtIso = new Date().toISOString();
        const expiresAtIso = computeExpiryIso(
          createdAtIso,
          getSetting("MESSAGE_FILE_RETENTION"),
        );

        const normalizedLocalFiles = uploadedFiles.map((file, index) => {
          const originalName = decodeOriginalFilename(
            file.originalname || "file",
          );
          const inferredMime = inferMimeFromFilename(originalName);
          const mimeType = (
            file.mimetype ||
            inferredMime ||
            "application/octet-stream"
          ).toLowerCase();

          if (isDangerousUploadFile(originalName, mimeType)) {
            throw new Error(
              "This file type is not allowed for security reasons.",
            );
          }

          const isVideo = mimeType.startsWith("video/") || (inferredMime && String(inferredMime).toLowerCase().startsWith("video/"));
          const kind = isVideo ? "media" : getUploadKind(uploadType, mimeType);
          if (!kind) {
            throw new Error("Invalid file type for selected upload option.");
          }

          const meta = fileMeta[index] || {};

          return {
            kind,
            originalName,
            storedName: safeBasename(file.filename),
            mimeType,
            sizeBytes: Number(file.size || 0),
            widthPx: sanitizePositiveInt(meta.width),
            heightPx: sanitizePositiveInt(meta.height),
            durationSeconds: sanitizeDurationSeconds(meta.durationSeconds),
            expiresAt: expiresAtIso,
            storageDriver: "local",
          };
        });

        const normalizedPresignedFiles = presignedFiles.map((item, index) => {
          const meta =
            fileMeta[uploadedFiles.length + index] || fileMeta[index] || {};
          const key =
            typeof item === "string"
              ? item
              : (item?.storageKey || item?.storage_key || item?.key || "");
          if (!key) {
            throw new Error("Invalid storage key for file.");
          }

          const rawName =
            (typeof item === "object" && item !== null
              ? (item.originalName || item.original_name || item.name || item.filename)
              : null) ||
            meta.originalName ||
            meta.original_name ||
            meta.name ||
            meta.filename ||
            safeBasename(key) ||
            "file";
          const originalName = safeDecodeFilename(rawName);
          const inferredMime = safeInferMime(originalName);

          const rawMime =
            (typeof item === "object" && item !== null
              ? (item.mimeType || item.mime_type || item.contentType || item.content_type || item.type)
              : null) ||
            meta.mimeType ||
            meta.mime_type ||
            meta.contentType ||
            meta.content_type ||
            meta.type ||
            inferredMime ||
            "application/octet-stream";
          const mimeType = String(rawMime).toLowerCase();

          if (safeIsDangerousUploadFile(originalName, mimeType)) {
            throw new Error(
              "This file type is not allowed for security reasons.",
            );
          }

          const kind = safeGetUploadKind(uploadType, mimeType);
          if (!kind) {
            throw new Error("Invalid file type for selected upload option.");
          }

          const sizeBytes = Number(
            (typeof item === "object" && item !== null
              ? (item.sizeBytes ?? item.size_bytes ?? item.fileSize ?? item.file_size ?? item.size)
              : null) ??
              meta.sizeBytes ??
              meta.size_bytes ??
              meta.fileSize ??
              meta.file_size ??
              meta.size ??
              0,
          );

          const widthPx = safeSanitizePositiveInt(
            (typeof item === "object" && item !== null
              ? (item.widthPx ?? item.width_px ?? item.width)
              : null) ??
              meta.widthPx ??
              meta.width_px ??
              meta.width,
          );

          const heightPx = safeSanitizePositiveInt(
            (typeof item === "object" && item !== null
              ? (item.heightPx ?? item.height_px ?? item.height)
              : null) ??
              meta.heightPx ??
              meta.height_px ??
              meta.height,
          );

          const durationSeconds = safeSanitizeDurationSeconds(
            (typeof item === "object" && item !== null
              ? (item.durationSeconds ?? item.duration_seconds ?? item.duration)
              : null) ??
              meta.durationSeconds ??
              meta.duration_seconds ??
              meta.duration,
          );

          const blurhash =
            (typeof item === "object" && item !== null ? item.blurhash : null) ||
            meta.blurhash ||
            null;

          const rawWaveform =
            (typeof item === "object" && item !== null ? item.waveform : null) ||
            meta.waveform ||
            null;
          const waveform = rawWaveform
            ? typeof rawWaveform === "string"
              ? rawWaveform
              : JSON.stringify(rawWaveform)
            : null;

          const thumbStorageKey =
            (typeof item === "object" && item !== null
              ? (item.thumbStorageKey || item.thumb_storage_key)
              : null) ||
            meta.thumbStorageKey ||
            meta.thumb_storage_key ||
            null;

          const storageDriver =
            (typeof item === "object" && item !== null
              ? (item.storageDriver || item.storage_driver)
              : null) ||
            meta.storageDriver ||
            meta.storage_driver ||
            (deps.storageProvider?.type || "remote");

          const encryptionType =
            (typeof item === "object" && item !== null
              ? (item.encryptionType || item.encryption_type)
              : null) ||
            meta.encryptionType ||
            meta.encryption_type ||
            "none";

          const storageProcessingMode = String(
            deps.storageProcessingMode || process.env.STORAGE_PROCESSING_MODE || "auto",
          ).toLowerCase();
          const transcodeVideosSetting = getSetting
            ? Boolean(getSetting("FILE_UPLOAD_TRANSCODE_VIDEOS"))
            : readEnvBool("FILE_UPLOAD_TRANSCODE_VIDEOS", true);
          const isVideo =
            mimeType.startsWith("video/") ||
            (inferredMime && String(inferredMime).toLowerCase().startsWith("video/"));
          const isAlreadyTranscoded = safeBasename(key).toLowerCase().includes("-h264-");
          const shouldTranscodeThisFile =
            isVideo &&
            !isAlreadyTranscoded &&
            transcodeVideosSetting;

          let rawItemStatus =
            typeof item === "object" && item !== null
              ? (item.processingStatus || item.processing_status)
              : null;
          if (isVideo && !transcodeVideosSetting) {
            rawItemStatus = "ready";
          }

          const effectiveKind = isVideo ? "media" : kind;
          const effectiveMime = isVideo && !mimeType.startsWith("video/") && inferredMime ? inferredMime : mimeType;

          return {
            kind: effectiveKind,
            originalName,
            storedName: safeBasename(key),
            mimeType: effectiveMime,
            sizeBytes,
            widthPx,
            heightPx,
            durationSeconds,
            expiresAt: expiresAtIso,
            storageDriver,
            storageKey: key,
            processingStatus:
              rawItemStatus || (shouldTranscodeThisFile ? "pending" : "ready"),
            blurhash,
            waveform,
            thumbStorageKey,
            encryptionType,
          };
        });

        const normalizedFiles = [
          ...normalizedLocalFiles,
          ...normalizedPresignedFiles,
        ];

        // Is a picture an animated one (GIF, animated WebP, APNG)? The server
        // decides, from the file's own bytes: nothing the client says counts.
        // Photos, videos and documents are not even opened; a file that cannot
        // be read for the check is simply not marked, and the message goes out.
        // The file itself is never re-encoded, so the animation stays intact.
        // One file at a time, so the memory used is that of one prefix.
        //
        // Objects in a bucket are whatever their sender put there, so what the
        // check may read from it is limited per request: the same object named
        // twice is looked at once, and all of them together spend one budget.
        const bucketAnimationByKey = new Map();
        const bucketScanBudget = { remaining: ANIMATION_REQUEST_SCAN_BUDGET_BYTES };
        for (let index = 0; index < normalizedFiles.length; index += 1) {
          const file = normalizedFiles[index];
          file.isAnimated = false;
          if (!isAnimationCandidate({ mimeType: file.mimeType, name: file.originalName })) continue;
          try {
            let animated = null;
            if (index < uploadedFiles.length) {
              animated = await detectAnimatedFile({ fs, filePath: uploadedFiles[index].path });
            } else if (typeof deps.savedGifStorage?.detectStoredAnimation === "function") {
              // Uploaded straight to the bucket: only the start of it is read.
              const objectKey = `${file.storageDriver}:${file.storageKey}`;
              if (bucketAnimationByKey.has(objectKey)) {
                animated = bucketAnimationByKey.get(objectKey);
              } else {
                animated = await deps.savedGifStorage.detectStoredAnimation({
                  storageKey: file.storageKey,
                  storageDriver: file.storageDriver,
                  mimeType: file.mimeType,
                  name: file.originalName,
                  budget: bucketScanBudget,
                });
                bucketAnimationByKey.set(objectKey, animated);
              }
            }
            file.isAnimated = animated === true;
          } catch {
            file.isAnimated = false;
          }
        }

        const storageProcessingMode = String(
          deps.storageProcessingMode || process.env.STORAGE_PROCESSING_MODE || "auto",
        ).toLowerCase();
        const hasVideoFiles = normalizedFiles.some((file) => {
          const m = String(file.mimeType || "").toLowerCase();
          const s = String(file.storedName || "").toLowerCase();
          return (m.startsWith("video/") || file.kind === "media") && !s.includes("-h264-");
        });
        const transcodeVideosEnabled = getSetting
          ? Boolean(getSetting("FILE_UPLOAD_TRANSCODE_VIDEOS"))
          : readEnvBool("FILE_UPLOAD_TRANSCODE_VIDEOS", true);
        const shouldTranscodeVideos = transcodeVideosEnabled && hasVideoFiles;

        debugLog("api:messages/upload:start", {
          chatId,
          username: String(username || "").toLowerCase(),
          fileCount: normalizedFiles.length,
          hasVideoFiles,
          transcodeEnabled: transcodeVideosEnabled,
          uploadType,
        });

        if (shouldTranscodeVideos && typeof ensureFfmpegAvailable === "function") {
          await ensureFfmpegAvailable();
        }

        if (hasVideoFiles && String(uploadType || "").toLowerCase() === "media") {
          await Promise.all(
            normalizedFiles.map(async (file) => {
              const mimeType = String(file?.mimeType || "").toLowerCase();
              if (!mimeType.startsWith("video/")) return;
              if (file.widthPx && file.heightPx && file.durationSeconds !== null)
                return;

              const storedName = safeBasename(
                String(file?.storedName || "").trim(),
              );
              if (!storedName) return;

              const inputPath = path.join(uploadRootDir, storedName);
              if (fs.existsSync && fs.existsSync(inputPath)) {
                const metadata = await probeVideoMetadata(inputPath);

                if (!file.widthPx && metadata.widthPx) {
                  file.widthPx = metadata.widthPx;
                }
                if (!file.heightPx && metadata.heightPx) {
                  file.heightPx = metadata.heightPx;
                }
                if (
                  file.durationSeconds === null &&
                  metadata.durationSeconds !== null
                ) {
                  file.durationSeconds = metadata.durationSeconds;
                }
              }
            }),
          );
        }

          normalizedFiles.forEach((file) => {
            if (file.storageKey) return;
            const storedName = safeBasename(String(file?.storedName || "").trim());
          if (!storedName) return;

          const inputPath = path.join(uploadRootDir, storedName);
          if (fs.existsSync && fs.existsSync(inputPath)) {
            if (
              storageEncryption &&
              typeof storageEncryption.encryptFileInPlace === "function"
            ) {
              storageEncryption.encryptFileInPlace(inputPath);
            }
            // The DB record must reflect the bytes on disk.
            markEncryptedFileRecord(storageEncryption, inputPath, file);
          }
        });

        const summarizeFiles = (files) => {
          if (!Array.isArray(files) || files.length === 0) return "";
          const videoCount = files.filter((file) =>
            String(file.mimeType || "").toLowerCase().startsWith("video/"),
          ).length;
          const imageCount = files.filter((file) =>
            String(file.mimeType || "").toLowerCase().startsWith("image/"),
          ).length;
          const audioCount = files.filter((file) =>
            String(file.mimeType || "").toLowerCase().startsWith("audio/"),
          ).length;
          const docCount = Math.max(0, files.length - videoCount - imageCount - audioCount);
          const gifCount = files.filter((file) => file.isAnimated).length;
          if (gifCount > 0 && gifCount === files.length) {
            return gifCount === 1 ? "Sent a GIF" : `Sent ${gifCount} GIFs`;
          }
          if (files.length === 1) {
            if (videoCount === 1) return "Sent a video";
            if (imageCount === 1) return "Sent a photo";
            if (audioCount === 1) return "Sent a voice message";
            return "Sent a document";
          }
          if (audioCount > 0 && videoCount === 0 && imageCount === 0 && docCount === 0) {
            return `Sent ${audioCount} voice message${audioCount > 1 ? "s" : ""}`;
          }
          if (videoCount > 0 && imageCount === 0 && docCount === 0) {
            return `Sent ${videoCount} video${videoCount > 1 ? "s" : ""}`;
          }
          if (imageCount > 0 && videoCount === 0 && docCount === 0) {
            return `Sent ${imageCount} photo${imageCount > 1 ? "s" : ""}`;
          }
          if (docCount > 0 && imageCount === 0 && videoCount === 0) {
            return `Sent ${docCount} document${docCount > 1 ? "s" : ""}`;
          }
          return `Sent ${files.length} files`;
        };

        const fileSummaryText = e2eeEnvelope
          ? "Sent a video message"
          : summarizeFiles(normalizedFiles);
        const fallbackBody =
          (e2eeEnvelope ? fileSummaryText : "") ||
          trimmedBody ||
          (normalizedFiles.length === 1
            ? `Sent ${normalizedFiles[0].kind === "media" ? "a media file" : "a document"}`
            : `Sent ${normalizedFiles.length} files`);

        if (
          deps.storageProvider &&
          (deps.storageProvider.type === "remote" ||
            deps.storageProvider.type === "s3") &&
          typeof deps.storageProvider.uploadBuffer === "function"
        ) {
          await Promise.all(
            uploadedFiles.map(async (file, index) => {
              const norm = normalizedFiles[index];
              if (!norm) return;

              const isVideo = String(norm.mimeType || "").toLowerCase().startsWith("video/");
              const isQueuedForLocalTranscode =
                isVideo &&
                shouldTranscodeVideos &&
                !String(norm.storedName || "").toLowerCase().includes("-h264-");

              if (isQueuedForLocalTranscode) {
                norm.storageDriver = "local";
                return;
              }

              const fileKey = `uploads/messages/${file.filename}`;
              const fileBuf = await fs.promises.readFile(file.path);
              const uploadBuf = storageEncryption.decryptBuffer(fileBuf);
              await deps.storageProvider.uploadBuffer(
                fileKey,
                uploadBuf,
                norm.mimeType || "application/octet-stream",
              );
              norm.storageDriver = deps.storageProvider.type || "s3";
              norm.storageKey = fileKey;
              norm.encryptionType = "none";
              norm.encryption_type = "none";
              await fs.promises.unlink(file.path).catch(() => {});
            }),
          );
        }

        let messageId = editMessageId || null;
        let dedupedMessage = false;
        if (editTarget) {
          const editBody =
            trimmedBody ||
            editTarget.edited_body ||
            editTarget.body ||
            fallbackBody;
          editMessage(messageId, editBody);
          setMessageExpiresAt(messageId, null);
          const rawCreate = createMessageFiles(messageId, normalizedFiles);
          if (rawCreate && typeof rawCreate.then === "function") await rawCreate;
        } else {
          const rawCreated = createOrReuseMessage(
            chatId,
            user.id,
            fallbackBody,
            replyToMessageId,
            null,
            clientRequestId,
          );
          const created = rawCreated && typeof rawCreated.then === "function" ? await rawCreated : rawCreated;
          messageId = created?.id || null;
          dedupedMessage = Boolean(created?.deduped);
          if (!messageId) {
            throw new Error("Unable to create message.");
          }
          if (dedupedMessage) {
            removeUploadedFiles(uploadedFiles);
            return res.json({ id: messageId, deduped: true });
          }
          const rawCreate = createMessageFiles(messageId, normalizedFiles);
          if (rawCreate && typeof rawCreate.then === "function") await rawCreate;
          if (e2eeEnvelopeJson && typeof setMessageE2eeEnvelope === "function") {
            await resolveMaybePromise(
              setMessageE2eeEnvelope(messageId, e2eeEnvelopeJson),
            );
          }
          if (chat.type === "saved") {
            markMessageRead(messageId, user.id);
          }
        }

        const usedStorageKeys = (normalizedFiles || [])
          .map((f) => f.storageKey || f.storage_key)
          .filter(Boolean);
        if (usedStorageKeys.length > 0) {
          if (typeof removePendingPresignedUploads === "function") {
            removePendingPresignedUploads(usedStorageKeys);
          }
        }

        let transcodeJobsQueued = 0;

        if (transcodeVideosEnabled && hasVideoFiles) {
          const rawInsertedRows = listMessageFilesByMessageIds([messageId]);
          const insertedRows = (rawInsertedRows && typeof rawInsertedRows.then === "function" ? await rawInsertedRows : rawInsertedRows) || [];
          const insertedByStoredName = new Map();

          insertedRows.forEach((row) => {
            const nameKey = safeBasename(String(row?.stored_name || row?.storedName || "").trim());
            const storageKey = String(row?.storage_key || row?.storageKey || "").trim();
            if (nameKey) insertedByStoredName.set(nameKey, row.id);
            if (storageKey) insertedByStoredName.set(storageKey, row.id);
          });

          normalizedFiles.forEach((file) => {
            const mimeType = String(file?.mimeType || "").toLowerCase();
            if (!mimeType.startsWith("video/")) return;

            const storedName = safeBasename(
              String(file?.storedName || "").trim(),
            );

            const fileId =
              insertedByStoredName.get(file.storageKey || file.storage_key) ||
              insertedByStoredName.get(storedName) ||
              file?.id;
            if (!fileId) return;

            if (typeof deps.enqueueVideoTranscodeJob === "function") {
              deps.enqueueVideoTranscodeJob({
                fileId,
                storedName: storedName || file.storageKey || file.storage_key,
                storageKey: file.storageKey || file.storage_key || storedName,
                storageDriver: file.storageDriver || file.storage_driver,
                chatId,
                messageId,
                username: user.username,
                storageProcessingMode,
              });
              transcodeJobsQueued += 1;
            } else {
              dispatchMediaWorkerJob({
                workerUrl:
                  (typeof getSetting === "function" && getSetting("WORKER_URL")) ||
                  deps.workerUrl ||
                  deps.mediaWorkerUrl ||
                  process.env.WORKER_URL ||
                  process.env.MEDIA_WORKER_URL ||
                  null,
                mediaWorkerUrl:
                  (typeof getSetting === "function" && getSetting("WORKER_URL")) ||
                  deps.workerUrl ||
                  deps.mediaWorkerUrl ||
                  process.env.WORKER_URL ||
                  process.env.MEDIA_WORKER_URL ||
                  null,
                storageProcessingMode,
                storageProcessingTimeoutMs:
                  (typeof getSetting === "function" && Number(getSetting("STORAGE_PROCESSING_TIMEOUT_MS"))) ||
                  deps.storageProcessingTimeoutMs ||
                  (process.env.STORAGE_PROCESSING_TIMEOUT_MS ? Number(process.env.STORAGE_PROCESSING_TIMEOUT_MS) : undefined),
                workerPort: deps.workerPort || process.env.WORKER_PORT || "8080",
                webhookSecret:
                  deps.webhookSecret !== undefined
                    ? deps.webhookSecret
                    : process.env.WEBHOOK_SECRET || null,
                callbackUrl:
                  deps.webhookCallbackUrl || resolveWebhookCallbackUrl(),
                fileId,
                storageKey: file.storageKey || file.storage_key || storedName,
                storedName: storedName || file.storageKey || file.storage_key,
                mimeType,
                encryptionType:
                  file.encryptionType ||
                  file.encryption_type ||
                  (Boolean(deps.storageEncryption?.hasKey?.())
                    ? "local"
                    : "none"),
                fetchImpl: deps.fetchImpl || globalThis.fetch,
              })
                .then((ok) => {
                  if (ok) {
                    console.log(
                      `[messages] Dispatched transcode job for file ${fileId} (mode=${storageProcessingMode})`,
                    );
                  } else {
                    console.warn(
                      `[messages] Failed to dispatch transcode job for file ${fileId} (mode=${storageProcessingMode})`,
                    );
                  }
                })
                .catch((err) => {
                  console.error(
                    `[messages] Error dispatching transcode job for file ${fileId}:`,
                    err,
                  );
                });
              transcodeJobsQueued += 1;
            }
          });
        }

        const rawInsertedFiles = listMessageFilesByMessageIds([messageId]);
        const insertedFiles = (rawInsertedFiles && typeof rawInsertedFiles.then === "function" ? await rawInsertedFiles : rawInsertedFiles) || [];
        const hydratedFiles = typeof hydrateMissingVideoMetadata === "function"
          ? await hydrateMissingVideoMetadata(insertedFiles)
          : insertedFiles;
        const sourceFilesForResponse = hydratedFiles.length ? hydratedFiles : normalizedFiles;

        const resolveFileUrl = async (file) => {
          const storedName = file.stored_name || file.storedName || "";
          const driver = file.storage_driver || file.storageDriver;
          const storageKey = file.storage_key || file.storageKey;
          if (
            (driver === "remote" || driver === "s3") &&
            storageKey &&
            deps.storageProvider &&
            typeof deps.storageProvider.getDownloadUrl === "function"
          ) {
            try {
              return await deps.storageProvider.getDownloadUrl(storageKey);
            } catch (_) {}
          }
          return storedName ? `/api/uploads/messages/${storedName}` : null;
        };

        const resolveFileThumbUrl = async (file) =>
          resolveThumbUrl({
            storageProvider: deps.storageProvider,
            file,
            fileId: file?.id,
          });

        const responseFiles = await Promise.all(
          sourceFilesForResponse.map(async (file, idx) => {
            const storedName = file.stored_name || file.storedName || "";
            const expiresAtVal = file.expires_at || file.expiresAt || expiresAtIso || null;
            const resolvedUrl = await resolveFileUrl(file);
            const resolvedThumbUrl = await resolveFileThumbUrl(file);
            const thumbKey = file.thumb_storage_key || file.thumbStorageKey || null;
            return {
              id: file.id || (idx + 1),
              kind: file.kind,
              name: file.original_name || file.originalName || "",
              mimeType: file.mime_type || file.mimeType || "",
              processing:
                (file.storage_driver === "remote" || file.storage_driver === "s3" || file.storageDriver === "remote" || file.storageDriver === "s3")
                  ? (file.processing_status || file.processingStatus) === "pending"
                  : (typeof isVideoFileProcessing === "function" ? isVideoFileProcessing(file) : false),
              sizeBytes: Number(file.size_bytes || file.sizeBytes || 0),
              width: Number.isFinite(Number(file.width_px ?? file.widthPx))
                ? Number(file.width_px ?? file.widthPx)
                : null,
              height: Number.isFinite(Number(file.height_px ?? file.heightPx))
                ? Number(file.height_px ?? file.heightPx)
                : null,
              durationSeconds: Number.isFinite(Number(file.duration_seconds ?? file.durationSeconds))
                ? Number(file.duration_seconds ?? file.durationSeconds)
                : null,
              expiresAt: expiresAtVal,
              expires_at: expiresAtVal,
              thumbStorageKey: thumbKey,
              thumbUrl: resolvedThumbUrl,
              url: resolvedUrl,
              ...animationFlags(file),
            };
          }),
        );
        const fileExpiresAt = responseFiles.find((f) => f.expiresAt)?.expiresAt || null;

        if (editTarget) {
          emitChatEvent(chatId, {
            type: "chat_message_updated",
            chatId,
            messageId,
            username: user.username,
            files: responseFiles,
            expiresAt: fileExpiresAt,
            expires_at: fileExpiresAt,
          });
        } else if (shouldTranscodeVideos && hasVideoFiles && transcodeJobsQueued > 0) {
          // Only show pending-conversion videos to the uploader.
          emitSseEvent(user.username, {
            type: "chat_message",
            chatId,
            messageId,
            username: user.username,
            userId: user.id,
            body: fallbackBody,
            summaryText: fileSummaryText,
            replyToMessageId,
            ...(e2eeEnvelope ? { e2ee: e2eeEnvelope } : {}),
            files: responseFiles,
            expiresAt: fileExpiresAt,
            expires_at: fileExpiresAt,
            ...(chat.type === "saved"
              ? {
                  read_at: new Date().toISOString(),
                  read_by_user_id: user.id,
                }
              : {}),
          });
        } else {
          emitChatEvent(chatId, {
            type: "chat_message",
            chatId,
            messageId,
            username: user.username,
            userId: user.id,
            body: fallbackBody,
            summaryText: fileSummaryText,
            replyToMessageId,
            ...(e2eeEnvelope ? { e2ee: e2eeEnvelope } : {}),
            files: responseFiles,
            expiresAt: fileExpiresAt,
            expires_at: fileExpiresAt,
            ...(chat.type === "saved"
              ? {
                  read_at: new Date().toISOString(),
                  read_by_user_id: user.id,
                }
              : {}),
          });
        }

        debugLog("api:messages/upload:done", {
          chatId,
          messageId,
          fileCount: normalizedFiles.length,
        });

        res.json({
          id: messageId,
          deduped: dedupedMessage,
          expiresAt: fileExpiresAt,
          files: responseFiles,
          ...(e2eeEnvelope ? { e2ee: e2eeEnvelope } : {}),
        });

        if (!editTarget) {
          void (async () => {
            try {
              const rawMembers = listChatMembers(chatId);
              const members = (rawMembers && typeof rawMembers.then === "function" ? await rawMembers : rawMembers) || [];
              const rawMuted = listMutedUserIdsForChat(chatId);
              const mutedRows = (rawMuted && typeof rawMuted.then === "function" ? await rawMuted : rawMuted) || [];
              const mutedIds = new Set(
                mutedRows.map((row) => row?.user_id || row).filter(Boolean),
              );
              const recipientIds = members
                .filter((member) => member.id !== user.id)
                .filter((member) => !isUserConnected(member.username))
                .map((member) => member.id)
                .filter(
                  (memberId) =>
                    memberId && !mutedIds.has(memberId),
                );
              if (recipientIds.length) {
                const title =
                  chat.type === "dm"
                    ? user.nickname || user.username
                    : chat.name || (chat.type === "channel" ? "Channel" : "Group");
                const notifyBody =
                  trimmedBody || fileSummaryText || "New message";
                await sendPushNotificationToUsers(recipientIds, {
                  title,
                  body: notifyBody,
                  data: { url: "/", chatId },
                });
              }
            } catch {
              // ignore push failures
            }
          })();
        }

        return;
      } catch (error) {
        console.error("POST /api/messages ERROR:", error);
        removeUploadedFiles(uploadedFiles);

        debugLog("api:messages/upload:error", {
          error: String(error?.message || error),
        });

        return res
          .status(400)
          .json({ error: error.message || "Unable to upload files." });
      }
    },
  );

  app.post("/api/messages", validateUuidBody([{ field: "chatId", required: true }, { field: "replyToMessageId", required: false }, { field: "savedGifId", required: false }]), async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) return;

    const { chatId, username, body, replyToMessageId, savedGifId } = req.body || {};
    const clientRequestIdRaw = String(req.body?.clientRequestId || "").trim();
    const clientRequestId = clientRequestIdRaw
      ? clientRequestIdRaw.slice(0, 120)
      : null;
    // A saved GIF from the person's own collection, sent as a picture; the
    // text, if any, is its caption.
    const hasSavedGif = savedGifId !== undefined && savedGifId !== null && savedGifId !== "";
    if (hasSavedGif && (typeof savedGifId !== "string" || savedGifId !== savedGifId.trim())) {
      return res.status(400).json({ error: "Field 'savedGifId' is not a valid UUID." });
    }
    if (!chatId || !username || (!body && !hasSavedGif)) {
      return res.status(400).json({
        error: "Chat, username, and message body are required.",
      });
    }
    const bodyText = String(body || "");
    if (bodyText === "[object Object]" || isServiceMessageBody(bodyText)) {
      // Service entries ("X joined", "X pinned a message") are written by the
      // server only; a person cannot make their own look like one.
      return res.status(400).json({
        error: "Invalid message body.",
      });
    }
    const maxMessageChars = Math.max(1, Number(getSetting("MESSAGE_MAX_CHARS") || 4000));
    if (bodyText.length > maxMessageChars) {
      return res.status(400).json({
        error: `Message must be at most ${maxMessageChars} characters.`,
      });
    }

    if (!requireSessionUsernameMatch(res, session, username)) return;

    const rawUser = findUserByUsername(username.toLowerCase());
    const user = rawUser && typeof rawUser.then === "function" ? await rawUser : rawUser;
    if (!user) {
      return res.status(404).json({ error: "User not found." });
    }

    const rawIsMem = isMember(chatId, user.id);
    const memberCheck = rawIsMem && typeof rawIsMem.then === "function" ? await rawIsMem : rawIsMem;
    if (!memberCheck) {
      return res.status(403).json({ error: "Not a member of this chat." });
    }

    const rawChat = findChatById(chatId);
    const chat = rawChat && typeof rawChat.then === "function" ? await rawChat : rawChat;
    if (!chat) {
      return res.status(404).json({ error: "Chat not found." });
    }
    if (chat.type === "channel") {
      const rawRole = getChatMemberRole(chatId, user.id);
      const role = String(rawRole && typeof rawRole.then === "function" ? await rawRole : rawRole).toLowerCase();
      if (role !== "owner") {
        return res
          .status(403)
          .json({ error: "Only channel owner can send messages." });
      }
    }

    if (replyToMessageId) {
      const rawReplyTarget = findMessageById(replyToMessageId);
      const replyTarget = rawReplyTarget && typeof rawReplyTarget.then === "function" ? await rawReplyTarget : rawReplyTarget;
      // A call history entry has no text to quote.
      if (!replyTarget || replyTarget.chat_id !== chatId || isCallMessage(replyTarget)) {
        return res
          .status(400)
          .json({ error: "Reply target is not available in this chat." });
      }
    }

    if (hasSavedGif) {
      if (Number(user.banned)) {
        return res.status(403).json({ error: "Account is banned." });
      }
      if (!savedGifSendThrottle.take(String(user.id))) {
        return res.status(429).json({ error: "Too many GIFs sent. Please slow down." });
      }
      try {
        const sent = await savedGifService.sendAsMessage({
          user,
          chat,
          savedGifId,
          caption: bodyText,
          replyToMessageId,
          clientRequestId,
        });
        return res.status(sent.status).json(sent.body);
      } catch (error) {
        console.error("POST /api/messages (saved GIF) ERROR:", error);
        return res.status(500).json({ error: "Unable to send the GIF." });
      }
    }

    const createdAtIso = new Date().toISOString();
    const expiresAt = computeTextExpiryIso(createdAtIso);
    
    const rawResult = messagePubService.publishTextMessage({
      chatId,
      userId: user.id,
      body: bodyText,
      replyToMessageId,
      expiresAt,
      clientRequestId,
      username: user.username,
      isUserConnectedFn: isUserConnected,
    });
    const result = rawResult && typeof rawResult.then === "function" ? await rawResult : rawResult;

    const id = result.messageId;

    debugLog("api:messages/send", {
      chatId,
      username: user.username,
      messageId: id,
      bodyLength: String(body || "").length,
    });

    res.json({
      id,
      expiresAt,
      deduped: result.deduped,
    });

    result.sseEvents.forEach((ev) => {
      emitChatEvent(ev.chatId, ev.payload);
    });

    if (result.deduped) {
      return;
    }

    if (result.pushRecipients.length) {
      void (async () => {
        try {
          const title =
            chat.type === "dm"
              ? user.nickname || user.username
              : chat.name || (chat.type === "channel" ? "Channel" : "Group");
          const trimmedBody = String(body || "").trim();
          const notifyBody = trimmedBody || "New message";
          await sendPushNotificationToUsers(result.pushRecipients, {
            title,
            body: notifyBody,
            data: { chatId },
          });
        } catch (_) {}
      })();
    }
  });

  app.post("/api/messages/edit", messageEditLimiter, validateUuidBody([{ field: "chatId", required: true }, { field: "messageId", required: true }]), async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) return;

    const { chatId, username, messageId, body } = req.body || {};
    if (!chatId || !username || !messageId) {
      return res.status(400).json({
        error: "Chat, username, and message id are required.",
      });
    }
    if (!requireSessionUsernameMatch(res, session, username)) return;

    const bodyText = String(body || "");
    if (bodyText === "[object Object]" || isServiceMessageBody(bodyText)) {
      return res.status(400).json({ error: "Invalid message body." });
    }
    const trimmedBody = bodyText.trim();
    if (!trimmedBody) {
      return res.status(400).json({ error: "Edited message cannot be empty." });
    }
    const maxMessageChars = Math.max(1, Number(getSetting("MESSAGE_MAX_CHARS") || 4000));
    if (bodyText.length > maxMessageChars) {
      return res.status(400).json({
        error: `Message must be at most ${maxMessageChars} characters.`,
      });
    }

    const rawUser = findUserByUsername(String(username || "").toLowerCase());
    const user = rawUser && typeof rawUser.then === "function" ? await rawUser : rawUser;
    if (!user) {
      return res.status(404).json({ error: "User not found." });
    }
    const rawIsMem = isMember(chatId, user.id);
    const memberCheck = rawIsMem && typeof rawIsMem.then === "function" ? await rawIsMem : rawIsMem;
    if (!memberCheck) {
      return res.status(403).json({ error: "Not a member of this chat." });
    }
    const rawMessage = findMessageById(messageId);
    const message = rawMessage && typeof rawMessage.then === "function" ? await rawMessage : rawMessage;
    if (!message || message.chat_id !== chatId) {
      return res.status(404).json({ error: "Message not found." });
    }
    const rawChat = findChatById(chatId);
    const chat = rawChat && typeof rawChat.then === "function" ? await rawChat : rawChat;
    if (!chat) {
      return res.status(404).json({ error: "Chat not found." });
    }
    const rawCanPost = canUserPostInChat(chatId, user.id, chat);
    const canPost = rawCanPost && typeof rawCanPost.then === "function" ? await rawCanPost : rawCanPost;
    if (!canPost) {
      return res
        .status(403)
        .json({ error: "Only channel owner can send messages." });
    }
    if (!isMessageAuthoredByUser(message, user.id)) {
      return res.status(403).json({ error: "Only the author can edit this message." });
    }
    if (isServiceMessageBody(message.body) || isCallMessage(message)) {
      return res.status(400).json({ error: "This message cannot be edited." });
    }

    const editRes = editMessage(messageId, trimmedBody);
    if (editRes && typeof editRes.then === "function") await editRes;

    emitChatEvent(chatId, {
      type: "chat_message_updated",
      chatId,
      messageId,
      username: user.username,
      body: trimmedBody,
      summaryText: trimmedBody,
    });

    res.json({ ok: true, id: messageId });
  });

  // ── Delete and forward: one message or many ──────────────────────────────
  //
  // A multi-select request names `messageIds` / `sourceMessageIds` (1 to
  // BATCH_MESSAGE_LIMIT); the older single request names one `messageId` /
  // `sourceMessageId` and keeps its answers exactly. Both are handled by the
  // services in lib/services, so every message gets the same checks.

  const hasValue = (value) => value !== undefined && value !== null && value !== "";
  const publicFailure = ({ sourceMessageId, targetChatId, code, error }) => ({
    sourceMessageId,
    ...(targetChatId ? { targetChatId } : {}),
    code,
    error,
  });

  const validateDeleteChatOnly = validateUuidBody([{ field: "chatId", required: true }]);
  const validateDeleteSingle = validateUuidBody([
    { field: "chatId", required: true },
    { field: "messageId", required: true },
  ]);
  const validateDeleteRequest = (req, res, next) =>
    (hasValue(req.body?.messageIds) ? validateDeleteChatOnly : validateDeleteSingle)(req, res, next);

  app.post("/api/messages/delete", validateDeleteRequest, async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) return;

    const { chatId, username, messageId, messageIds, scope } = req.body || {};
    const isBatch = hasValue(messageIds);
    if (!chatId || !username || (!isBatch && !messageId)) {
      return res.status(400).json({
        error: isBatch
          ? "Chat, username, and message ids are required."
          : "Chat, username, and message id are required.",
      });
    }
    if (isBatch && hasValue(messageId)) {
      return res.status(400).json({
        error: "Send either 'messageId' or 'messageIds', not both.",
      });
    }
    if (!requireSessionUsernameMatch(res, session, username)) return;

    let ids = [messageId];
    if (isBatch) {
      const parsed = parseMessageIdList(messageIds, "messageIds");
      if (!parsed.ok) return res.status(400).json({ error: parsed.error });
      ids = parsed.ids;
    }

    try {
      const rawUser = findUserByUsername(String(username || "").toLowerCase());
      const user = rawUser && typeof rawUser.then === "function" ? await rawUser : rawUser;
      if (!user) {
        return res.status(404).json({ error: "User not found." });
      }
      // Banning ends a person's sessions, but a request already in flight must
      // not get through. (Postgres returns BIGINT as a string.)
      if (Number(user.banned)) {
        return res.status(403).json({ error: "Account is banned." });
      }
      if (!deleteThrottle.take(String(user.id))) {
        return res.status(429).json({ error: "Too many delete requests. Please slow down." });
      }

      const outcome = await deleteService.deleteMessages({
        user,
        chatId,
        messageIds: ids,
        scope,
      });
      if (!outcome.ok) {
        return res.status(outcome.status).json({ error: outcome.error });
      }

      if (!isBatch) {
        const [result] = outcome.results;
        if (!result.ok) {
          // The one answer the single request has always carried a code for.
          return res.status(result.status).json({
            error: result.error,
            ...(result.code === "call_message_self_only" ? { code: result.code } : {}),
          });
        }
        return res.json({ ok: true, scope: outcome.scope, id: messageId });
      }

      const results = outcome.results.map((result) =>
        result.ok
          ? { messageId: result.messageId, ok: true }
          : { messageId: result.messageId, ok: false, code: result.code, error: result.error },
      );
      if (results.every((result) => !result.ok)) {
        // Nothing could be deleted: an error, with the reasons attached.
        const status = commonFailureStatus(outcome.results.map((result) => result.status));
        return res.status(status).json({ error: results[0].error, results });
      }
      return res.json({ results });
    } catch (error) {
      console.error("POST /api/messages/delete ERROR:", error);
      return res.status(500).json({ error: "Unable to delete message." });
    }
  });

  const validateForwardSingleId = validateUuidBody([
    { field: "sourceMessageId", required: true },
  ]);
  const validateForwardRequest = (req, res, next) =>
    hasValue(req.body?.sourceMessageIds)
      ? next()
      : validateForwardSingleId(req, res, next);

  app.post("/api/messages/forward", validateForwardRequest, async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) return;

    const {
      username,
      sourceMessageId,
      sourceMessageIds,
      targetChatIds = [],
    } = req.body || {};
    // A `body` in the request is ignored: a forward always carries the text
    // of the message it names (see messageForwardService).
    const isBatch = hasValue(sourceMessageIds);
    if (!username || !Array.isArray(targetChatIds) || !targetChatIds.length) {
      return res.status(400).json({
        error: "Username, source message, and target chats are required.",
      });
    }
    if (isBatch && hasValue(sourceMessageId)) {
      return res.status(400).json({
        error: "Send either 'sourceMessageId' or 'sourceMessageIds', not both.",
      });
    }
    if (!requireSessionUsernameMatch(res, session, username)) return;

    let sourceIds = [sourceMessageId];
    if (isBatch) {
      const parsed = parseMessageIdList(sourceMessageIds, "sourceMessageIds");
      if (!parsed.ok) return res.status(400).json({ error: parsed.error });
      sourceIds = parsed.ids;
    }

    if (targetChatIds.some((id) => typeof id !== "string" || !isValidUuid(id))) {
      return res.status(400).json({ error: "Field 'targetChatIds' contains an invalid UUID." });
    }
    const uniqueTargetChatIds = Array.from(
      new Set(targetChatIds.map((id) => id.trim()).filter(Boolean)),
    );
    if (!uniqueTargetChatIds.length) {
      return res.status(400).json({ error: "Choose at least one target chat." });
    }
    if (uniqueTargetChatIds.length > FORWARD_MAX_TARGET_CHATS) {
      return res.status(400).json({
        error: `You can forward to at most ${FORWARD_MAX_TARGET_CHATS} chats at once.`,
      });
    }
    if (sourceIds.length * uniqueTargetChatIds.length > FORWARD_MAX_CREATED_MESSAGES) {
      return res.status(400).json({
        error: `A single request can create at most ${FORWARD_MAX_CREATED_MESSAGES} forwarded messages. Forward fewer messages or to fewer chats.`,
      });
    }

    try {
      const rawUser = findUserByUsername(String(username || "").toLowerCase());
      const user = rawUser && typeof rawUser.then === "function" ? await rawUser : rawUser;
      if (!user) {
        return res.status(404).json({ error: "User not found." });
      }
      if (Number(user.banned)) {
        return res.status(403).json({ error: "Account is banned." });
      }
      if (!forwardThrottle.take(String(user.id))) {
        return res.status(429).json({ error: "Too many forward requests. Please slow down." });
      }
      if (!forwardBudget.take(String(user.id), sourceIds.length * uniqueTargetChatIds.length)) {
        return res.status(429).json({
          error: "Too many messages forwarded in a short time. Please wait a moment.",
        });
      }

      const outcome = await forwardService.forward({
        user,
        sourceMessageIds: sourceIds,
        targetChatIds: uniqueTargetChatIds,
      });
      if (!outcome.ok) {
        return res.status(outcome.status).json({ error: outcome.error });
      }
      const { forwarded, failed } = outcome;

      if (!isBatch) {
        if (failed.length) {
          return res.status(failed[0].status).json({ error: failed[0].error });
        }
        return res.json({ ok: true, ids: forwarded.map((message) => message.id) });
      }

      if (!forwarded.length) {
        // Nothing could be forwarded: an error, with the reasons attached.
        return res.status(commonFailureStatus(failed.map((entry) => entry.status))).json({
          error: failed[0]?.error || "Unable to forward message.",
          forwarded: [],
          failed: failed.map(publicFailure),
        });
      }
      return res.json({ forwarded, failed: failed.map(publicFailure) });
    } catch (error) {
      console.error("POST /api/messages/forward ERROR:", error);
      return res.status(500).json({ error: "Unable to forward message." });
    }
  });
}

export { registerMessageRoutes };
