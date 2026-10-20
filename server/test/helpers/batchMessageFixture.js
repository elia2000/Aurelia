/**
 * In-memory chats and messages for the multi-select forward and delete tests.
 *
 * Built straight on makeApp. Everything db.js would answer is a plain Map, so
 * the tests can count how often each lookup ran (one query per request, not
 * one per message) and which messages were written, in which order. The SQL
 * itself is covered by test/db/messageBatchLookup.test.js and the whole thing
 * on the real server by test/serverMessageBatch.test.js.
 *
 * Chats
 *   GROUP          alice (owner), bob (member)         the usual source chat
 *   TARGET_GROUP   alice (owner), bob (member)
 *   DM             alice, bob
 *   MY_CHANNEL     alice (owner), bob (subscriber)
 *   BOBS_CHANNEL   bob (owner), alice (subscriber)
 *   SAVED          alice only (type "saved")
 *   CAROLS_GROUP   carol only; alice is not a member
 *
 * Messages of GROUP, oldest first (created_at in brackets). Their ids are
 * deliberately NOT in creation order, so a test that passes by sorting ids
 * would fail:
 *   M1 bob "first" [10:00:00]   M2 alice "second" [10:00:01]
 *   M3 bob "third" [10:00:02]   M4 alice "fourth" [10:00:02]  (same second as M3)
 *   M5 bob "fifth" [10:00:03]   with a file
 */

import { makeApp, makeSessionStore, makeUserStore } from "./makeApp.js";

export const uid = (n) => `00000000-0000-4000-8000-${Number(n).toString(16).padStart(12, "0")}`;

export const ALICE_ID = uid(0xa1);
export const BOB_ID = uid(0xb0);
export const CAROL_ID = uid(0xc0);

export const GROUP = uid(0x1001);
export const TARGET_GROUP = uid(0x1002);
export const DM = uid(0x1003);
export const MY_CHANNEL = uid(0x1004);
export const BOBS_CHANNEL = uid(0x1005);
export const SAVED = uid(0x1006);
export const CAROLS_GROUP = uid(0x1007);
export const MISSING_CHAT = uid(0x10ff);

// Ids in the opposite order of creation on purpose.
export const M1 = uid(0x2005);
export const M2 = uid(0x2004);
export const M3 = uid(0x2002);
export const M4 = uid(0x2003);
export const M5 = uid(0x2001);
export const SERVICE_MSG = uid(0x2010);
export const CALL_MSG = uid(0x2011);
export const E2EE_MSG = uid(0x2012);
export const DELETED_MSG = uid(0x2013);
export const HIDDEN_MSG = uid(0x2014);
export const CAROL_MSG = uid(0x2015);
export const CHANNEL_POST = uid(0x2016);
export const DM_MSG = uid(0x2017);
export const MISSING_MSG = uid(0x20ff);

export const CREATED_PREFIX = "5e5e5e5e-0000-4000-8000-";

const user = (id, username, nickname) => ({
  id,
  username,
  password_hash: "x",
  nickname,
  avatar_url: `/api/uploads/avatars/${username}.png`,
  color: "#10b981",
  status: "online",
  role: "user",
  banned: false,
});

const row = (id, chatId, userId, body, createdAt, extra = {}) => ({
  id,
  chat_id: chatId,
  user_id: userId,
  body,
  edited: 0,
  edited_body: null,
  hidden_everyone_at: null,
  created_at: createdAt,
  expires_at: null,
  e2ee_envelope: null,
  call_id: null,
  call_kind: null,
  call_outcome: null,
  call_duration_sec: null,
  ...extra,
});

export function makeBatchApp({
  asyncDb = false,
  bulk = true,
  deps = {},
  settings = {},
  failCreateFor = [],
} = {}) {
  const wrap = (fn) => (asyncDb ? async (...args) => fn(...args) : fn);

  const chats = new Map([
    [GROUP, { id: GROUP, type: "group", name: "Friends", members: { [ALICE_ID]: "owner", [BOB_ID]: "member" } }],
    [TARGET_GROUP, { id: TARGET_GROUP, type: "group", name: "Target", members: { [ALICE_ID]: "owner", [BOB_ID]: "member" } }],
    [DM, { id: DM, type: "dm", name: "alice & bob", members: { [ALICE_ID]: "member", [BOB_ID]: "member" } }],
    [MY_CHANNEL, { id: MY_CHANNEL, type: "channel", name: "News", members: { [ALICE_ID]: "owner", [BOB_ID]: "member" } }],
    [BOBS_CHANNEL, { id: BOBS_CHANNEL, type: "channel", name: "Bob's news", members: { [BOB_ID]: "owner", [ALICE_ID]: "member" } }],
    [SAVED, { id: SAVED, type: "saved", name: "Saved", members: { [ALICE_ID]: "owner" } }],
    [CAROLS_GROUP, { id: CAROLS_GROUP, type: "group", name: "Carol's", members: { [CAROL_ID]: "owner" } }],
  ]);

  const messages = new Map(
    [
      row(M1, GROUP, BOB_ID, "first", "2025-01-01 10:00:00"),
      row(M2, GROUP, ALICE_ID, "second", "2025-01-01 10:00:01"),
      row(M3, GROUP, BOB_ID, "third", "2025-01-01 10:00:02"),
      row(M4, GROUP, ALICE_ID, "fourth", "2025-01-01 10:00:02"),
      row(M5, GROUP, BOB_ID, "fifth", "2025-01-01 10:00:03"),
      row(SERVICE_MSG, GROUP, ALICE_ID, "[[system:member_joined]]", "2025-01-01 09:00:00"),
      row(CALL_MSG, DM, ALICE_ID, "", "2025-01-01 09:30:00", {
        call_id: uid(0x3001),
        call_kind: "audio",
        call_outcome: "completed",
        call_duration_sec: 12,
      }),
      row(E2EE_MSG, GROUP, BOB_ID, "Sent a video message", "2025-01-01 09:10:00", {
        e2ee_envelope: '{"kind":"video_note"}',
      }),
      row(DELETED_MSG, GROUP, BOB_ID, "gone", "2025-01-01 09:20:00", {
        hidden_everyone_at: "2025-01-01 09:21:00",
      }),
      row(HIDDEN_MSG, GROUP, BOB_ID, "removed from my view", "2025-01-01 09:25:00"),
      row(CAROL_MSG, CAROLS_GROUP, CAROL_ID, "carol's secret", "2025-01-01 08:00:00"),
      row(CHANNEL_POST, BOBS_CHANNEL, BOB_ID, "channel post", "2025-01-01 08:30:00"),
      row(DM_MSG, DM, BOB_ID, "dm text", "2025-01-01 08:40:00"),
    ].map((m) => [m.id, m]),
  );
  // M2 was edited: the text people see is edited_body.
  messages.get(M2).edited = 1;
  messages.get(M2).edited_body = "second (edited)";

  const files = new Map([
    [
      M5,
      [
        {
          message_id: M5,
          kind: "media",
          original_name: "photo.png",
          stored_name: "stored-photo.png",
          mime_type: "image/png",
          size_bytes: 1234,
          width_px: 10,
          height_px: 20,
          duration_seconds: null,
          expires_at: null,
        },
      ],
    ],
  ]);

  const hiddenFor = new Map([[HIDDEN_MSG, new Set([ALICE_ID])]]);
  const pinned = new Set();
  const diskFiles = new Set(["stored-photo.png"]);

  const events = [];
  const created = []; // every createMessage call, in order
  const origins = []; // setMessageForwardOrigin calls
  const createdFiles = []; // createMessageFiles calls
  const calls = {
    findMessageById: 0,
    findMessagesByIds: [],
    listHidden: [],
    isMember: [],
    findChatById: [],
    getChatMemberRole: [],
    findUserById: [],
    listFiles: [],
    hideEveryone: [],
    hideSelf: [],
    unpin: [],
    markRead: [],
    unhide: [],
  };
  let createdCounter = 0;

  const userStore = makeUserStore([
    user(ALICE_ID, "alice", "Alice"),
    user(BOB_ID, "bob", "Bob"),
    user(CAROL_ID, "carol", "Carol"),
  ]);
  const sessionStore = makeSessionStore();
  sessionStore.createSession(ALICE_ID, "tok-alice");
  sessionStore.createSession(BOB_ID, "tok-bob");
  sessionStore.createSession(CAROL_ID, "tok-carol");

  const bulkDeps = bulk
    ? {
        findMessagesByIds: wrap((ids) => {
          calls.findMessagesByIds.push([...ids]);
          return ids.map((id) => messages.get(id)).filter(Boolean).map((m) => ({ ...m }));
        }),
        listMessageIdsHiddenForUser: wrap((ids, userId) => {
          calls.listHidden.push({ ids: [...ids], userId });
          return ids
            .filter((id) => hiddenFor.get(id)?.has(userId))
            .map((id) => ({ message_id: id }));
        }),
      }
    : {};

  const built = makeApp({
    userStore,
    sessionStore,
    settings,
    deps: {
      fs: { existsSync: (p) => diskFiles.has(String(p).split("/").pop()), readFileSync: () => "" },
      path: {
        join: (...parts) => parts.join("/"),
        basename: (p) => String(p).split("/").pop(),
      },
      uploadRootDir: "/uploads",
      isMember: wrap((chatId, userId) => {
        calls.isMember.push(chatId);
        return Boolean(chats.get(chatId)?.members[userId]);
      }),
      findChatById: wrap((chatId) => {
        calls.findChatById.push(chatId);
        const chat = chats.get(chatId);
        return chat ? { id: chat.id, type: chat.type, name: chat.name } : null;
      }),
      getChatMemberRole: wrap((chatId, userId) => {
        calls.getChatMemberRole.push(chatId);
        return chats.get(chatId)?.members[userId] || "";
      }),
      findUserById: wrap((id) => {
        calls.findUserById.push(id);
        return userStore.findUserById(id);
      }),
      findMessageById: wrap((id) => {
        calls.findMessageById += 1;
        const message = messages.get(id);
        return message ? { ...message } : null;
      }),
      ...bulkDeps,
      isMessageHiddenForUser: wrap((id, userId) => Boolean(hiddenFor.get(id)?.has(userId))),
      listMessageFilesByMessageIds: wrap((ids) => {
        calls.listFiles.push([...ids]);
        return ids.flatMap((id) => files.get(id) || []);
      }),
      createMessage: wrap((chatId, userId, body, replyTo, expiresAt, clientRequestId, options) => {
        const requestedId = options?.id ?? null;
        const n = createdCounter + 1;
        if (failCreateFor.includes(n)) {
          createdCounter = n;
          throw new Error(`createMessage #${n} failed`);
        }
        createdCounter = n;
        const id = requestedId || `${CREATED_PREFIX}${String(n).padStart(12, "0")}`;
        created.push({ id, chatId, userId, body, replyTo, expiresAt, clientRequestId, options, args: [chatId, userId, body, replyTo, expiresAt, clientRequestId, options] });
        messages.set(id, row(id, chatId, userId, body, "2025-02-01 00:00:00", { expires_at: expiresAt }));
        return id;
      }),
      setMessageForwardOrigin: wrap((id, payload) => {
        origins.push({ id, ...payload });
      }),
      createMessageFiles: wrap((id, list) => {
        createdFiles.push({ id, files: list });
        return list;
      }),
      markMessageRead: wrap((id, userId) => {
        calls.markRead.push({ id, userId });
      }),
      unhideChat: wrap((userId, chatId) => {
        calls.unhide.push({ userId, chatId });
      }),
      hideMessageForEveryone: wrap((id) => {
        calls.hideEveryone.push(id);
        const message = messages.get(id);
        if (message) message.hidden_everyone_at = "2025-03-01 00:00:00";
      }),
      hideMessageForUser: wrap((id, userId) => {
        calls.hideSelf.push({ id, userId });
        const set = hiddenFor.get(id) || new Set();
        set.add(userId);
        hiddenFor.set(id, set);
      }),
      unpinMessage: wrap((chatId, id) => {
        calls.unpin.push({ chatId, id });
        const key = `${chatId}:${id}`;
        const was = pinned.has(key);
        pinned.delete(key);
        return was ? 1 : 0;
      }),
      emitChatEvent: (chatId, payload) => events.push({ chatId, payload }),
      ...deps,
    },
  });

  return {
    ...built,
    chats,
    messages,
    files,
    events,
    created,
    origins,
    createdFiles,
    calls,
    pin: (chatId, id) => pinned.add(`${chatId}:${id}`),
    isPinned: (chatId, id) => pinned.has(`${chatId}:${id}`),
    isHiddenFor: (id, userId) => Boolean(hiddenFor.get(id)?.has(userId)),
    eventsOfType: (type) => events.filter((e) => e.payload.type === type),
    /** Adds `count` filler messages to GROUP, oldest first; returns their ids. */
    addFillers: (count, authorId = BOB_ID) => {
      const ids = [];
      for (let i = 0; i < count; i += 1) {
        const id = uid(0x5000 + i);
        messages.set(
          id,
          row(id, GROUP, authorId, `filler ${i}`, `2024-01-01 00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`),
        );
        ids.push(id);
      }
      return ids;
    },
  };
}
