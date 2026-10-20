/**
 * In-memory chats, messages, files and saved-GIF collections for API tests.
 *
 * The gif store mirrors what db.js does (same duplicate check, same
 * "oldest first" eviction) and the storage double keeps bytes in a Map, so the
 * routes and the service are tested without a database or a disk. The SQL is
 * covered by test/db/savedGifs.test.js and the real storage by
 * test/lib/gifStorage.test.js.
 */

import bcrypt from "bcryptjs";
import request from "supertest";
import { makeApp, makeUserStore } from "./makeApp.js";
import { generateUuid } from "../../lib/uuidUtils.js";
import { isSavedGifKeyOf } from "../../lib/savedGifs.js";

export const ALICE_ID = "a0a0a0a0-b1b1-4c2c-8d3d-e4e4e4e4e4e4";
export const BOB_ID = "b0b0b0b0-c1c1-4d2d-9e3e-f5f5f5f5f5f5";
export const CAROL_ID = "ca0ca0ca-0c1c-4c2c-8c3c-c5c5c5c5c5c5";
export const CHAT_ID = "c0c0c0c0-d1d1-4e2e-af3f-060606060606";
export const OTHER_CHAT_ID = "c1c1c1c1-d1d1-4e2e-af3f-070707070707";
export const MSG_ID = "d0d0d0d0-e1e1-4f2f-b040-171717171717";
export const MSG_ID_2 = "e0e0e0e0-f1f1-4020-c151-282828282828";
export const FOREIGN_MSG_ID = "f0f0f0f0-0101-4131-d262-393939393939";

export const PASSWORD = "secret123";

const baseUser = (id, username, nickname) => ({
  id,
  username,
  password_hash: bcrypt.hashSync(PASSWORD, 4),
  nickname,
  avatar_url: `/api/uploads/avatars/${username}.png`,
  color: "#10b981",
  status: "online",
  role: "user",
  banned: false,
});

const USERS = [
  baseUser(ALICE_ID, "alice", "Alice"),
  baseUser(BOB_ID, "bob", "Bob"),
  baseUser(CAROL_ID, "carol", "Carol"),
];

/** Mirrors db.js: per-person rows, duplicate check by bytes, oldest evicted first. */
export function makeGifStore() {
  const rows = [];
  let tick = 0;
  const calls = { insert: [], delete: [] };
  const sorted = (userId) =>
    rows
      .filter((r) => r.user_id === userId)
      .sort((a, b) => (a.created_at === b.created_at ? (a.id < b.id ? -1 : 1) : a.created_at < b.created_at ? -1 : 1));

  return {
    rows,
    calls,
    failNextInsert: false,
    listSavedGifs(userId) {
      return sorted(userId).reverse().map((r) => ({ ...r }));
    },
    countSavedGifs(userId) {
      return rows.filter((r) => r.user_id === userId).length;
    },
    findSavedGif(userId, gifId) {
      const row = rows.find((r) => r.user_id === userId && r.id === gifId);
      return row ? { ...row } : null;
    },
    findSavedGifBySource(userId, messageId, fileId) {
      const row = rows.find(
        (r) => r.user_id === userId && r.source_message_id === messageId && r.source_file_id === String(fileId),
      );
      return row ? { ...row } : null;
    },
    findSavedGifByHash(userId, sha) {
      const row = rows.find((r) => r.user_id === userId && r.sha256 === sha);
      return row ? { ...row } : null;
    },
    insertSavedGif(args) {
      calls.insert.push(args);
      if (this.failNextInsert) {
        this.failNextInsert = false;
        throw new Error("database is on fire");
      }
      const mine = sorted(args.userId);
      const duplicate = mine.find((r) => r.sha256 === args.sha256);
      if (duplicate) return { status: "existing", gif: { ...duplicate }, evicted: [], count: mine.length };
      const evicted = mine.slice(0, Math.max(0, mine.length + 1 - args.limit));
      for (const gone of evicted) rows.splice(rows.indexOf(gone), 1);
      tick += 1;
      const row = {
        id: args.id,
        user_id: args.userId,
        storage_key: args.storageKey,
        storage_driver: args.storageDriver || "local",
        mime: args.mime,
        width: args.width,
        height: args.height,
        frames: args.frames,
        size_bytes: args.sizeBytes,
        sha256: args.sha256,
        created_at: new Date(1_700_000_000_000 + tick).toISOString(),
        source_message_id: args.sourceMessageId || null,
        source_file_id: args.sourceFileId === null || args.sourceFileId === undefined ? null : String(args.sourceFileId),
      };
      rows.push(row);
      return {
        status: "created",
        gif: { ...row },
        evicted: evicted.map((r) => ({ ...r })),
        count: mine.length - evicted.length + 1,
      };
    },
    deleteSavedGif(userId, gifId) {
      calls.delete.push({ userId, gifId });
      const row = rows.find((r) => r.user_id === userId && r.id === gifId);
      if (!row) return null;
      rows.splice(rows.indexOf(row), 1);
      return { ...row };
    },
    listSavedGifsForUsers(userIds) {
      return rows.filter((r) => userIds.includes(r.user_id)).map((r) => ({ ...r }));
    },
  };
}

/** Bytes in a Map; mirrors the contract of lib/gifStorage.js. */
export function makeMemoryGifStorage() {
  const gifs = new Map(); // key -> Buffer (saved GIFs)
  const messageCopies = new Map(); // storedName -> { bytes, ... }
  const messageFiles = new Map(); // "<driver>:<storedName>" -> Buffer (files that exist in chats)
  const calls = { writeGif: [], readGif: [], removeGifs: [], writeMessageCopy: [], removeMessageCopy: [] };
  const state = { failWrite: false, failCopy: false, remote: false };

  return {
    gifs,
    messageCopies,
    messageFiles,
    calls,
    state,
    async writeGif({ key, bytes, mime }) {
      calls.writeGif.push({ key, mime, size: bytes.length });
      if (state.failWrite) throw new Error("disk full");
      if (gifs.has(key)) throw new Error("exists");
      gifs.set(key, Buffer.from(bytes));
      return { storageDriver: state.remote ? "s3" : "local" };
    },
    async readGif(row, { maxBytes } = {}) {
      calls.readGif.push({ id: row?.id });
      if (!row || !isSavedGifKeyOf(row.user_id, row.storage_key)) return null;
      const bytes = gifs.get(row.storage_key);
      if (!bytes) return null;
      if (maxBytes && bytes.length > maxBytes) return null;
      return Buffer.from(bytes);
    },
    async removeGifs(rows) {
      calls.removeGifs.push((rows || []).map((r) => r.id));
      let removed = 0;
      for (const row of rows || []) {
        if (row && isSavedGifKeyOf(row.user_id, row.storage_key)) {
          gifs.delete(row.storage_key);
          removed += 1;
        }
      }
      return { removed, failed: 0 };
    },
    async readMessageFile(row, { maxBytes } = {}) {
      const bytes = messageFiles.get(`${row.storage_driver || "local"}:${row.stored_name}`) || messageFiles.get(`*:${row.stored_name}`);
      if (!bytes) return null;
      if (maxBytes && bytes.length > maxBytes) return null;
      return Buffer.from(bytes);
    },
    async writeMessageCopy({ bytes, mime, type }) {
      calls.writeMessageCopy.push({ mime, type, size: bytes.length });
      if (state.failCopy) throw new Error("disk full");
      const storedName = `copy-${generateUuid().slice(0, 8)}.${type}`;
      const record = state.remote
        ? { storedName, storageDriver: "s3", storageKey: `uploads/messages/${storedName}`, encryptionType: "none", sizeBytes: bytes.length }
        : { storedName, storageDriver: "local", storageKey: null, encryptionType: "none", sizeBytes: bytes.length };
      messageCopies.set(storedName, { ...record, bytes: Buffer.from(bytes) });
      return record;
    },
    async removeMessageCopy(copy) {
      calls.removeMessageCopy.push(copy?.storedName);
      messageCopies.delete(copy?.storedName);
    },
    async detectStoredAnimation() {
      return null;
    },
  };
}

/**
 * A group chat with alice (owner) and bob as members, carol outside of it.
 * MSG_ID is bob's message with one file; MSG_ID_2 is alice's with two.
 * `addFile()` puts more files (and their bytes) into the world.
 */
export function makeGifApp({ chat = {}, deps = {}, settings = {}, members, asyncDb = false } = {}) {
  const gifStore = makeGifStore();
  const storage = makeMemoryGifStorage();
  const events = []; // chat events
  const userEvents = []; // per-person events
  const pushes = [];
  const created = { messages: [], files: [] };
  const hiddenFor = new Map();
  const connected = new Set();
  const muted = new Set();
  const chatRecord = { id: CHAT_ID, type: "group", name: "Friends", ...chat };
  const chatMembers = members || [
    { id: ALICE_ID, username: "alice", role: "owner" },
    { id: BOB_ID, username: "bob", role: "member" },
  ];

  const messages = new Map([
    [MSG_ID, { id: MSG_ID, chat_id: CHAT_ID, user_id: BOB_ID, body: "look at this", hidden_everyone_at: null }],
    [MSG_ID_2, { id: MSG_ID_2, chat_id: CHAT_ID, user_id: ALICE_ID, body: "two files", hidden_everyone_at: null }],
    [FOREIGN_MSG_ID, { id: FOREIGN_MSG_ID, chat_id: OTHER_CHAT_ID, user_id: CAROL_ID, body: "elsewhere", hidden_everyone_at: null }],
  ]);
  const files = []; // chat_message_files rows
  let fileSeq = 100;

  const addFile = (messageId, bytes, overrides = {}) => {
    fileSeq += 1;
    const row = {
      id: fileSeq,
      message_id: messageId,
      kind: "media",
      original_name: `anim-${fileSeq}.gif`,
      stored_name: `stored-${fileSeq}.gif`,
      mime_type: "image/gif",
      size_bytes: bytes.length,
      width_px: 4,
      height_px: 4,
      duration_seconds: null,
      expires_at: null,
      storage_driver: "local",
      storage_key: null,
      thumb_storage_key: null,
      encryption_type: "none",
      processing_status: "ready",
      is_animated: 0,
      ...overrides,
    };
    files.push(row);
    storage.messageFiles.set(`*:${row.stored_name}`, Buffer.from(bytes));
    return row;
  };

  const flags = { failFiles: false };
  const wrap = (fn) => (asyncDb ? async (...args) => fn(...args) : fn);
  const userStore = makeUserStore(USERS.map((u) => ({ ...u })));

  const built = makeApp({
    userStore,
    settings,
    deps: {
      isMember: wrap((chatId, userId) => chatId === CHAT_ID && chatMembers.some((m) => m.id === userId)),
      findChatById: wrap((chatId) => (chatId === CHAT_ID ? chatRecord : null)),
      getChatMemberRole: wrap((chatId, userId) => chatMembers.find((m) => m.id === userId)?.role || ""),
      listChatMembers: wrap(() => chatMembers),
      findMessageById: wrap((messageId) => messages.get(messageId) || null),
      isMessageHiddenForUser: wrap((messageId, userId) => Boolean(hiddenFor.get(messageId)?.has(userId))),
      listMessageFilesByMessageIds: wrap((ids) => files.filter((f) => ids.includes(f.message_id)).sort((a, b) => a.id - b.id)),
      createOrReuseMessage: wrap((chatId, userId, body, replyTo, expiresAt, clientRequestId) => {
        if (clientRequestId) {
          const existing = created.messages.find(
            (m) => m.chatId === chatId && m.userId === userId && m.clientRequestId === clientRequestId,
          );
          if (existing) return { id: existing.id, deduped: true };
        }
        const id = generateUuid();
        created.messages.push({ id, chatId, userId, body, replyTo, expiresAt, clientRequestId });
        messages.set(id, { id, chat_id: chatId, user_id: userId, body, hidden_everyone_at: null });
        return { id, deduped: false };
      }),
      findMessageIdByClientRequestId: wrap(
        (chatId, userId, clientRequestId) =>
          created.messages.find((m) => m.chatId === chatId && m.userId === userId && m.clientRequestId === clientRequestId)?.id || null,
      ),
      createMessageFiles: wrap((messageId, list) => {
        if (flags.failFiles) throw new Error("insert failed");
        const rows = list.map((file) => {
          fileSeq += 1;
          const row = {
            id: fileSeq,
            message_id: messageId,
            kind: file.kind,
            original_name: file.originalName,
            stored_name: file.storedName,
            mime_type: file.mimeType,
            size_bytes: file.sizeBytes,
            width_px: file.widthPx ?? null,
            height_px: file.heightPx ?? null,
            duration_seconds: file.durationSeconds ?? null,
            expires_at: file.expiresAt || null,
            storage_driver: file.storageDriver || "local",
            storage_key: file.storageKey || null,
            thumb_storage_key: null,
            encryption_type: file.encryptionType || "none",
            processing_status: file.processingStatus || "ready",
            is_animated: file.isAnimated ? 1 : 0,
          };
          files.push(row);
          created.files.push({ messageId, input: file, row });
          return row;
        });
        return rows;
      }),
      hideMessageForEveryone: wrap((messageId) => {
        const message = messages.get(messageId);
        if (message) message.hidden_everyone_at = "2026-01-01 00:00:00";
        created.hidden = [...(created.hidden || []), messageId];
      }),
      markMessageRead: wrap((messageId, userId) => {
        created.read = [...(created.read || []), { messageId, userId }];
      }),
      // Looked up on the store at call time, so a test can replace one.
      listSavedGifs: wrap((...a) => gifStore.listSavedGifs(...a)),
      countSavedGifs: wrap((...a) => gifStore.countSavedGifs(...a)),
      findSavedGif: wrap((...a) => gifStore.findSavedGif(...a)),
      findSavedGifBySource: wrap((...a) => gifStore.findSavedGifBySource(...a)),
      findSavedGifByHash: wrap((...a) => gifStore.findSavedGifByHash(...a)),
      insertSavedGif: wrap((...a) => gifStore.insertSavedGif(...a)),
      deleteSavedGif: wrap((...a) => gifStore.deleteSavedGif(...a)),
      listSavedGifsForUsers: wrap((...a) => gifStore.listSavedGifsForUsers(...a)),
      savedGifStorage: storage,
      emitChatEvent: (chatId, payload) => events.push({ chatId, payload }),
      emitSseEvent: (username, payload) => userEvents.push({ username, payload }),
      sendPushNotificationToUsers: async (userIds, payload) => {
        pushes.push({ userIds, payload });
      },
      isUserConnected: (username) => connected.has(username),
      listMutedUserIdsForChat: wrap(() => [...muted].map((user_id) => ({ user_id }))),
      computeExpiryIso: (createdAt, days) => {
        const n = Number(days || 0);
        if (!n) return null;
        return new Date(new Date(createdAt).getTime() + n * 86_400_000).toISOString();
      },
      MESSAGE_FILE_LIMITS: { maxFiles: 10, maxFileSizeBytes: 100 * 1024 * 1024, maxTotalBytes: 300 * 1024 * 1024 },
      ...deps,
    },
  });

  return {
    ...built,
    flags,
    gifStore,
    storage,
    events,
    userEvents,
    pushes,
    created,
    messages,
    files,
    chatRecord,
    chatMembers,
    addFile,
    hide: (messageId, userId) => {
      const set = hiddenFor.get(messageId) || new Set();
      set.add(userId);
      hiddenFor.set(messageId, set);
    },
    setConnected: (username, on = true) => (on ? connected.add(username) : connected.delete(username)),
    mute: (userId) => muted.add(userId),
    login: async (username) => {
      const res = await request(built.app).post("/api/login").send({ username, password: PASSWORD });
      return res.headers["set-cookie"];
    },
  };
}

export const flush = () => new Promise((resolve) => setImmediate(resolve));
