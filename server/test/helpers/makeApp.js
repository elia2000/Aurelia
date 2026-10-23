/**
 * Test app factory.
 *
 * Creates a minimal Express app wired through registerApiRoutes with fully
 * injectable stub dependencies — no real database, no file system, no WASM.
 * Each test can override individual stubs by merging into the deps object.
 */

import express from "express";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { registerApiRoutes } from "../../api/index.js";
import { createSessionHelpers } from "../../lib/sessions.js";
import { USER_COLORS } from "../../settings/colors.js";
import { createStorageProvider } from "../../lib/storage/index.js";
import { generateUuid } from "../../lib/uuidUtils.js";
import { createCallRegistry } from "../../lib/calls.js";
import { makeE2eeStore, makeEventRecorder } from "./e2eeStore.js";

// ─── Minimal in-memory session store ─────────────────────────────────────────
//
// Mirrors the session functions of db.js: a session has a public id (what the
// API shows), the browser summary and how it was created. Revoking returns
// public ids only, like the wrappers in index.js.

export function makeSessionStore() {
  const sessions = new Map();
  const now = () => new Date().toISOString().replace("T", " ").slice(0, 19);
  const publicIdsOf = (records) => records.map((record) => record.publicId);
  const drop = (records) => records.forEach((record) => sessions.delete(record.token));
  return {
    sessions,
    createSession: (userId, token, meta = {}) => {
      sessions.set(token, {
        userId,
        token,
        publicId: generateUuid(),
        userAgent: meta.userAgent ?? null,
        authMethod: meta.authMethod ?? null,
        createdAt: meta.createdAt ?? now(),
        lastSeen: now(),
      });
    },
    deleteSession: (token) => {
      sessions.delete(token);
    },
    getSession: (token) => sessions.get(token) ?? null,
    touchSession: (token) => {
      const record = sessions.get(token);
      if (record) record.lastSeen = now();
    },
    listUserSessions: (userId) =>
      [...sessions.values()]
        .filter((record) => record.userId === userId)
        .map((record) => ({
          public_id: record.publicId,
          user_agent: record.userAgent,
          auth_method: record.authMethod,
          created_at: record.createdAt,
          last_seen: record.lastSeen,
        })),
    revokeUserSession: (userId, publicId) => {
      const record = [...sessions.values()].find(
        (r) => r.userId === userId && r.publicId === publicId,
      );
      if (!record) return null;
      drop([record]);
      return { publicId: record.publicId };
    },
    revokeOtherUserSessions: (userId, keepPublicId) => {
      const records = [...sessions.values()].filter(
        (r) => r.userId === userId && r.publicId !== keepPublicId,
      );
      drop(records);
      return publicIdsOf(records);
    },
    revokeAllUserSessions: (userId) => {
      const records = [...sessions.values()].filter((r) => r.userId === userId);
      drop(records);
      return publicIdsOf(records);
    },
  };
}

// ─── Minimal in-memory two-factor store (mirrors the db.js functions) ────────

export function makeTwoFactorStore() {
  const rows = new Map(); // userId -> { secret_enc, enabled, last_used_step, enabled_at }
  const codes = new Map(); // userId -> Map(hash -> usedAt|null)
  return {
    rows,
    codes,
    getUserTwoFactor: (userId) => (rows.has(userId) ? { user_id: userId, ...rows.get(userId) } : null),
    beginTwoFactorEnrollment: (userId, secretEnc) => {
      if (rows.get(userId)?.enabled) return 0;
      rows.set(userId, { secret_enc: secretEnc, enabled: false, last_used_step: null, enabled_at: null });
      return 1;
    },
    replaceRecoveryCodes: (userId, hashes) => {
      codes.set(userId, new Map(hashes.map((hash) => [hash, null])));
      return hashes.length;
    },
    enableTwoFactor: (userId, step, hashes) => {
      const row = rows.get(userId);
      codes.set(userId, new Map(hashes.map((hash) => [hash, null])));
      if (!row || row.enabled) return false;
      Object.assign(row, { enabled: true, last_used_step: step ?? null, enabled_at: new Date().toISOString() });
      return true;
    },
    markTotpStepUsed: (userId, step) => {
      const row = rows.get(userId);
      if (!row) return false;
      if (row.last_used_step !== null && row.last_used_step >= step) return false;
      row.last_used_step = step;
      return true;
    },
    consumeRecoveryCode: (userId, hash) => {
      const own = codes.get(userId);
      if (!own || !own.has(hash) || own.get(hash) !== null) return false;
      own.set(hash, new Date().toISOString());
      return true;
    },
    countUnusedRecoveryCodes: (userId) =>
      [...(codes.get(userId)?.values() ?? [])].filter((used) => used === null).length,
    disableTwoFactor: (userId) => {
      codes.delete(userId);
      return rows.delete(userId);
    },
  };
}

// ─── Minimal in-memory user store ────────────────────────────────────────────

export function makeUserStore(initialUsers = []) {
  const users = new Map(initialUsers.map((u) => [u.username, u]));
  return {
    users,
    createUser: (username, passwordHash, nickname, avatarUrl, color) => {
      const id = generateUuid();
      users.set(username, {
        id,
        username,
        password_hash: passwordHash,
        nickname,
        avatar_url: avatarUrl,
        color,
        status: "online",
        role: "user",
        banned: false,
      });
      return id;
    },
    findUserByUsername: (username) => users.get(username) ?? null,
    findUserById: (id) => [...users.values()].find((u) => u.id === id) ?? null,
    updateLastSeen: () => {},
  };
}

// ─── App factory ─────────────────────────────────────────────────────────────

export function makeApp(overrides = {}) {
  const app = express();
  app.use(express.json());

  const sessionStore = overrides.sessionStore ?? makeSessionStore();
  const userStore = overrides.userStore ?? makeUserStore();

  const sessionHelpers = createSessionHelpers({
    getSession: sessionStore.getSession,
    touchSession: sessionStore.touchSession,
    isProduction: false,
  });

  // Build a getSessionFromRequest that also hydrates the full user row
  const getSessionFromRequest = (req) => {
    const cookies = sessionHelpers.parseCookies(req);
    if (!cookies.sid) return null;
    const record = sessionStore.getSession(cookies.sid);
    if (!record) return null;
    sessionStore.touchSession(cookies.sid);
    const user = userStore.findUserById(record.userId);
    // The row carries the public id of the session it came from (like db.getSession).
    if (!user) return null;
    return { ...user, session_public_id: record.publicId, session_created_at: record.createdAt };
  };

  const pendingUploadsStore = [];
  const e2eeStore = overrides.e2eeStore ?? makeE2eeStore();
  const eventRecorder = overrides.eventRecorder ?? makeEventRecorder();
  const twoFactorStore = overrides.twoFactorStore ?? makeTwoFactorStore();
  // Streams that were told to close because their session ended.
  const closedStreams = [];
  const defaultStorageProvider =
    overrides.storageProvider ||
    overrides.deps?.storageProvider ||
    createStorageProvider({ STORAGE_DRIVER: "local" });

  const deps = {
    // ── Settings ──────────────────────────────────────────────────────────────
    getSetting: (key) => {
      const defaults = {
        SIGN_UP: true,
        USERNAME_MAX_CHARS: 16,
        NICKNAME_MAX_CHARS: 24,
        FILE_UPLOAD: true,
        FILE_UPLOAD_TRANSCODE_VIDEOS: true,
        MESSAGE_MAX_CHARS: 4000,
        CHAT_MESSAGE_FETCH_LIMIT: 60,
        CHAT_MESSAGE_PAGE_SIZE: 60,
        CHAT_CACHE_TTL: 24,
        REMOTE_CHANNEL_UI: true,
        REMOTE_CHANNEL_MEDIA_STREAM: false,
      };
      return overrides.settings?.[key] ?? defaults[key] ?? null;
    },

    // ── Crypto / bcrypt ───────────────────────────────────────────────────────
    crypto,
    bcrypt,

    // ── Debug logging (no-op unless APP_DEBUG is set) ─────────────────────────
    debugLog: () => {},

    // ── Push notifications ────────────────────────────────────────────────────
    sendPushNotificationToUsers: async () => {},

    // ── User helpers ──────────────────────────────────────────────────────────
    USER_COLORS,
    USERNAME_REGEX: /^(?=.*[a-z0-9])[a-z0-9._]+$/,
    setUserColor: () => USER_COLORS[0],
    createUser: userStore.createUser,
    findUserByUsername: userStore.findUserByUsername,
    findUserById: userStore.findUserById,
    updateLastSeen: userStore.updateLastSeen,
    ensureAvatarExists: (_id, url) => url || null,
    findChatByGroupUsername: () => null,

    // ── Session helpers ───────────────────────────────────────────────────────
    createSession: sessionStore.createSession,
    deleteSession: sessionStore.deleteSession,
    getSession: sessionStore.getSession,
    touchSession: sessionStore.touchSession,
    listUserSessions: sessionStore.listUserSessions,
    revokeUserSession: sessionStore.revokeUserSession,
    revokeOtherUserSessions: sessionStore.revokeOtherUserSessions,
    revokeAllUserSessions: sessionStore.revokeAllUserSessions,
    closeSessionStreams: (target) => {
      closedStreams.push(target);
    },
    // Two-factor sign-in
    getUserTwoFactor: twoFactorStore.getUserTwoFactor,
    beginTwoFactorEnrollment: twoFactorStore.beginTwoFactorEnrollment,
    enableTwoFactor: twoFactorStore.enableTwoFactor,
    replaceRecoveryCodes: twoFactorStore.replaceRecoveryCodes,
    markTotpStepUsed: twoFactorStore.markTotpStepUsed,
    consumeRecoveryCode: twoFactorStore.consumeRecoveryCode,
    countUnusedRecoveryCodes: twoFactorStore.countUnusedRecoveryCodes,
    disableTwoFactor: twoFactorStore.disableTwoFactor,
    parseCookies: sessionHelpers.parseCookies,
    setSessionCookie: sessionHelpers.setSessionCookie,
    clearSessionCookie: sessionHelpers.clearSessionCookie,
    getSessionFromRequest,
    requireSession: (req, res) => {
      const session = getSessionFromRequest(req);
      if (!session) {
        res.status(401).json({ error: "Not authenticated." });
        return null;
      }
      return session;
    },
    requireSessionUsernameMatch: sessionHelpers.requireSessionUsernameMatch,

    // ── App meta (fs/path/projectRootDir) ─────────────────────────────────────
    fs: {
      readFileSync: () => "",
      existsSync: () => false,
    },
    path: { join: (...parts) => parts.join("/") },
    projectRootDir: "/test",

    // ── Remote channels ───────────────────────────────────────────────────────
    REMOTE_CHANNELS: {
      enabled: false,
      telegramConfigured: false,
      proxyConfigured: false,
    },

    // ── SSE (not used in tests, but routes expect these) ─────────────────────
    addSseClient: () => {},
    removeSseClient: () => {},
    emitSseEvent: () => {},
    emitChatEvent: () => {},
    broadcastAll: () => {},
    isUserConnected: () => false,
    connectPresence: () => {},
    disconnectPresence: () => {},
    broadcastPresence: () => {},
    isConnected: () => false,
    getConnectedUsernames: () => [],
    getOnlineCount: () => 0,

    // ── Upload stubs (multer instances — .single/.array called at route
    //    registration time, so they must return valid middleware) ───────────
    uploadAvatar: { single: () => (_req, _res, next) => next() },
    uploadFiles: { array: () => (_req, _res, next) => next() },
    uploadRootDir: "/tmp/test-uploads",
    avatarUploadRootDir: "/tmp/test-avatars",
    removeUploadedFiles: () => {},
    hasEnoughFreeDiskSpace: () => true,
    ALLOWED_AVATAR_MIME_TYPES: new Set([
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp",
      "image/bmp",
    ]),
    AVATAR_FILE_LIMITS: {
      maxFileSizeBytes: 10 * 1024 * 1024,
    },
    storeAvatarFile: async (file) => {
      const avatarUrl = `/api/uploads/avatars/${file?.filename || "avatar.png"}`;
      const provider = defaultStorageProvider;
      if (
        provider &&
        (provider.type === "remote" || provider.type === "s3") &&
        typeof provider.uploadBuffer === "function"
      ) {
        let buf = Buffer.from("avatar");
        if (file?.path && typeof fs.existsSync === "function" && fs.existsSync(file.path)) {
          buf = fs.readFileSync(file.path);
        }
        await provider.uploadBuffer(`uploads/avatars/${file?.filename || "avatar.png"}`, buf, file?.mimetype || "image/jpeg");
        if (file?.path && typeof fs.unlinkSync === "function" && fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
        return {
          avatarUrl,
          storageDriver: provider.type || "s3",
          storageKey: `uploads/avatars/${file?.filename || "avatar.png"}`,
        };
      }
      return { avatarUrl, storageDriver: "local", storageKey: null };
    },
    storageProvider: defaultStorageProvider,
    storageProcessingMode: "auto",
    webhookSecret: null,
    workerUrl: null,
    mediaWorkerUrl: null,

    removeStoredFileNames: () => {},
    removeAllMessageUploads: () => {},
    isVideoFileProcessing: () => false,
    hydrateMissingVideoMetadata: async (files) => files,
    recordPendingPresignedUpload: ({ storageKey, userId, expiresAt }) => {
      const rec = { storage_key: storageKey, user_id: userId, created_at: new Date().toISOString(), expires_at: expiresAt };
      pendingUploadsStore.push(rec);
      return rec;
    },
    removePendingPresignedUploads: (keys = []) => {
      const keySet = new Set((Array.isArray(keys) ? keys : [keys]).map((k) => (typeof k === "string" ? k : k?.storageKey || k?.storage_key)));
      for (let i = pendingUploadsStore.length - 1; i >= 0; i--) {
        if (keySet.has(pendingUploadsStore[i].storage_key)) {
          pendingUploadsStore.splice(i, 1);
        }
      }
    },
    listPendingPresignedUploads: () => pendingUploadsStore,
    pruneOrphanRemoteObjects: async (options = {}) => {
      const provider = options.storageProvider || defaultStorageProvider;
      const prunedKeys = [];
      while (pendingUploadsStore.length > 0) {
        const rec = pendingUploadsStore.pop();
        if (provider && typeof provider.deleteFile === "function") {
          await provider.deleteFile(rec.storage_key);
        }
        prunedKeys.push(rec.storage_key);
      }
      return { prunedCount: prunedKeys.length, prunedKeys };
    },
    pruneOrphanAvatarObjects: async () => ({ prunedCount: 0, prunedKeys: [] }),
    isLoopbackRequest: () => false,
    chunkArray: (arr) => [arr],
    decodeOriginalFilename: (name) => name,
    computeExpiryIso: () => null,
    cleanupMissingMessageFiles: () => [],
    buildInspectSnapshot: () => ({}),
    enqueueVideoTranscodeJob: () => {},
    ensureFfmpegAvailable: () => false,
    MESSAGE_FILE_LIMITS: { maxFiles: 10, maxSizeMb: 25, maxTotalSizeMb: 75 },
    listMessageFilesByMessageIds: () => [],
    parseUploadFileMetadata: () => [],
    getCachedMembers: () => [],
    getMessages: () => [],
    getFirstUnreadMessage: () => null,
    recordMessageReads: () => {},
    markMessagesRead: () => {},
    markMessageRead: () => {},
    createMessage: () => generateUuid(),
    createOrReuseMessage: () => ({ id: generateUuid() }),
    editMessage: () => {},
    createMessageFiles: () => [],
    hideMessageForEveryone: () => {},
    hideMessageForUser: () => {},
    setMessageExpiresAt: () => {},
    setMessageForwardOrigin: () => {},
    findMessageById: () => null,
    findMessageIdByClientRequestId: () => null,
    getMessageReadCounts: () => ({}),
    getMessageAuthors: () => [],
    getMessageReadByUser: () => false,
    isMember: () => false,
    isGroupMemberRemoved: () => false,
    listChatMembers: () => [],
    listChatMembersForChats: () => [],
    listChatsForUser: () => [],
    listUsers: () => [],
    searchUsers: () => [],
    searchPublicGroups: () => [],
    searchPublicChannels: () => [],
    createChat: () => generateUuid(),
    findChatById: () => null,
    findDmChat: () => null,
    findChatByInviteToken: () => null,
    deleteChatById: () => {},
    deleteUserById: () => {},
    addChatMember: () => {},
    addAllEligibleChatMembers: () => ({ addedUsers: [], skippedLeftCount: 0 }),
    removeChatMember: () => {},
    setChatMuted: () => {},
    setChatMemberRole: () => {},
    getChatMemberRole: () => null,
    regenerateGroupInviteToken: () => null,
    markGroupMemberRemoved: () => {},
    clearGroupMemberRemoved: () => {},
    markChatMemberLeft: () => {},
    clearChatMemberLeft: () => {},
    updateGroupChat: () => {},
    updateChannelChat: () => {},
    hideChatsForUser: () => {},
    unhideChat: () => {},
    ensureSavedChatForUser: () => {},
    removeAvatarByUrl: (url = "") => {
      const fileName = String(url || "").split("?")[0].split("/").pop();
      const provider = defaultStorageProvider;
      if (
        fileName &&
        provider &&
        (provider.type === "remote" || provider.type === "s3") &&
        typeof provider.deleteFile === "function"
      ) {
        provider.deleteFile(`uploads/avatars/${fileName}`).catch(() => {});
      }
    },
    getTotalUnreadCount: () => 0,
    listMutedUserIdsForChat: () => [],
    upsertPushSubscription: () => {},
    deletePushSubscription: () => {},
    listPushSubscriptionsByUserIds: () => [],
    getUserPresence: () => null,
    updateUserProfile: () => {},
    updateUserPassword: () => {},
    updateUserStatus: () => {},
    // Remote channel stubs
    remoteChannelManager: null,
    mirrorJobRegistry: null,
    upsertRemoteChannelSource: () => {},
    getRemoteChannelSourceByChatId: () => null,
    getRemoteChannelSourceById: () => null,
    listEnabledRemoteChannelSources: () => [],
    getRemoteChannelProviderState: () => null,
    getRemoteChannelQueueSummary: () => ({}),
    enqueueRemoteChannelQueueItem: () => {},
    skipCurrentRemoteChannelQueueItem: () => {},
    skipAllRemoteChannelQueueItems: () => {},
    getCurrentRemoteChannelQueueItemId: () => null,
    releaseStaleRemoteChannelQueueItems: () => {},
    purgeOldRemoteChannelQueueItems: () => {},
    updateRemoteChannelSourceError: () => {},
    updateRemoteChannelSourcePaused: () => {},
    updateRemoteChannelSourceSeen: () => {},
    setRemoteChannelProviderState: () => {},
    claimNextRemoteChannelQueueItem: () => null,
    markRemoteChannelQueueItemDone: () => {},
    markRemoteChannelQueueItemRetry: () => {},
    markRemoteChannelQueueItemSkipped: () => {},
    // Admin stubs
    adminGetAll: () => [],
    adminGetRow: () => null,
    adminRun: () => {},
    adminTransaction: async (callback) => callback(async () => {}),
    adminSave: () => {},
    // In-memory admin audit log store (mirrors the DB-backed API in db.js).
    // Keeps route tests off the real filesystem (logs/admin.log).
    ...(() => {
      const auditLogStore = [];
      const toEntry = (e) => ({
        ts: e.ts || new Date().toISOString(),
        actorUserId: e.actorUserId ?? null,
        actorUsername: e.actorUsername ?? null,
        action: String(e.action || ""),
        targetType: e.targetType ?? null,
        targetLabel: e.targetLabel ?? null,
        details: e.details ?? null,
        status: e.status ?? "success",
      });
      const readAuditStore = ({ limit = 200, offset = 0, search = "" } = {}) => {
        const needle = String(search || "").toLowerCase();
        const filtered = [...auditLogStore].reverse().filter((entry) => {
          if (!needle) return true;
          return [entry.actorUsername, entry.action, entry.targetLabel, entry.details]
            .filter(Boolean)
            .join(" ")
            .toLowerCase()
            .includes(needle);
        });
        const safeLimit = Math.max(1, Number(limit) || 200);
        const safeOffset = Math.max(0, Number(offset) || 0);
        return {
          entries: filtered.slice(safeOffset, safeOffset + safeLimit),
          total: filtered.length,
        };
      };
      return {
        __auditLogStore: auditLogStore,
        writeAdminAuditLog: (e = {}) => {
          auditLogStore.push(toEntry(e));
        },
        readAdminAuditLogs: ({ limit = 200, offset = 0, search = "" } = {}) =>
          readAuditStore({ limit, offset, search }),
        clearAdminAuditLogs: () => {
          auditLogStore.length = 0;
        },
      };
    })(),
    isUserAdmin: () => false,
    isUserOwner: () => false,
    getOwnerUser: () => null,
    getAdminStats: () => ({}),
    adminListUsers: () => [],
    adminListChats: () => [],
    adminCountUsers: () => 0,
    adminCountChats: () => 0,
    adminBanUser: () => {},
    adminDeleteUser: () => {},
    adminDeleteChat: () => {},
    vacuumDatabase: () => {},
    reloadDatabase: () => {},
    adminClearAllMessages: () => {},
    adminResetDatabase: () => {},
    dbConfig: { client: "sqlite3" },
    postgresMaintenance: {
      backup: async () => {},
      restore: async () => {},
      vacuum: async () => {},
      dropDatabase: async () => {},
    },
    // Avoid probing the host's service manager whenever an in-memory test app
    // registers admin routes. Production resolves this once during startup.
    getServiceControlStatus: () => ({ available: false, reason: "systemctl not available." }),
    dbGetAllSettings: () => [],
    dbGetSetting: () => null,
    dbSetSetting: () => {},
    dbDeleteSetting: () => {},
    getAllSettings: () => [],
    setSetting: () => ({ ok: true }),
    setSettings: () => ({ ok: true }),
    resetSetting: () => ({ ok: true }),
    validateSetting: () => ({ valid: true }),
    SETTING_DEFS: [],
    buildTimestampSchedule: () => [],
    setUserRole: () => {},
    VAPID_PUBLIC_KEY: "",
    PUSH_ENABLED: false,
    createPushNotification: () => {},

    // ── E2EE device directory + call signaling ───────────────────────────────
    findE2eeDevice: e2eeStore.findE2eeDevice,
    countActiveE2eeDevices: e2eeStore.countActiveE2eeDevices,
    createE2eeDevice: e2eeStore.createE2eeDevice,
    touchE2eeDevice: e2eeStore.touchE2eeDevice,
    revokeE2eeDevice: e2eeStore.revokeE2eeDevice,
    revokeStalestE2eeDevice: e2eeStore.revokeStalestE2eeDevice,
    userHasMessageInChat: () => false,
    listE2eeDevicesByUserIds: e2eeStore.listE2eeDevicesByUserIds,
    setMessageE2eeEnvelope: () => {},
    // ── Message reactions ────────────────────────────────────────────────────
    isMessageHiddenForUser: () => false,
    toggleMessageReaction: () => ({ added: null, removed: [] }),
    listMessageReactionSummaries: () => [],
    listMessageReactionUsers: () => [],
    pinMessage: () => ({ status: "pinned", pinnedAt: new Date().toISOString() }),
    unpinMessage: () => 0,
    unpinAllMessages: () => 0,
    listPinnedMessages: () => [],
    listPinnedMessageIds: () => [],
    // ── Pinned chats ─────────────────────────────────────────────────────────
    pinChat: () => ({ status: "pinned", position: 0 }),
    removeChatPins: () => 0,
    reorderChatPins: () => ({ status: "ok", changed: false }),
    listChatPins: () => [],
    listChatPinsForUsers: () => [],
    listChatPinHolders: () => [],
    // ── Saved GIFs ───────────────────────────────────────────────────────────
    listSavedGifs: () => [],
    countSavedGifs: () => 0,
    findSavedGif: () => null,
    findSavedGifBySource: () => null,
    findSavedGifByHash: () => null,
    insertSavedGif: () => {
      throw new Error("insertSavedGif is not stubbed");
    },
    deleteSavedGif: () => null,
    listSavedGifsForUsers: () => [],
    listAllSavedGifs: () => [],
    savedGifStorage: {
      writeGif: async () => ({ storageDriver: "local" }),
      readGif: async () => null,
      removeGifs: async () => ({ removed: 0, failed: 0 }),
      readMessageFile: async () => null,
      writeMessageCopy: async () => {
        throw new Error("savedGifStorage is not stubbed");
      },
      removeMessageCopy: async () => {},
      // No network in tests: a file uploaded straight to a bucket is never inspected.
      detectStoredAnimation: async () => null,
    },
    // ── Call history entries ─────────────────────────────────────────────────
    createCallMessage: (args) => ({
      id: generateUuid(),
      created: true,
      createdAt: new Date().toISOString().replace("T", " ").slice(0, 19),
      callId: args?.callId ?? null,
    }),
    callRegistry: createCallRegistry(),
    callsConfig: () => ({
      enabled: true,
      turnUrls: [],
      stunUrls: [],
      turnSecret: "",
      credentialTtlSeconds: 3600,
    }),
    callSweepIntervalMs: 0,
    emitToUser: eventRecorder.emitToUser,

    // ── Spread any remaining overrides ───────────────────────────────────────
    ...overrides.deps,
    ...overrides.dbOverrides,
  };

  registerApiRoutes(app, deps);
  return {
    app,
    sessionStore,
    userStore,
    deps,
    pendingUploadsStore,
    e2eeStore,
    eventRecorder,
    twoFactorStore,
    closedStreams,
  };
}
