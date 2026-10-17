/**
 * In-memory chat + reaction fixture for API tests.
 *
 * The reaction store mirrors what db.js does (same pure planner, same
 * ordering) so route and service behaviour can be tested without a database.
 * The SQL itself is covered by test/db/messageReactions.test.js.
 */

import bcrypt from "bcryptjs";
import request from "supertest";
import { makeApp, makeUserStore } from "./makeApp.js";
import { planReactionChange } from "../../lib/reactions.js";

export const ALICE_ID = "a0a0a0a0-b1b1-4c2c-8d3d-e4e4e4e4e4e4";
export const BOB_ID = "b0b0b0b0-c1c1-4d2d-9e3e-f5f5f5f5f5f5";
export const CAROL_ID = "ca0ca0ca-0c1c-4c2c-8c3c-c5c5c5c5c5c5";
export const CHAT_ID = "c0c0c0c0-d1d1-4e2e-af3f-060606060606";
export const OTHER_CHAT_ID = "c1c1c1c1-d1d1-4e2e-af3f-070707070707";
export const MSG_ID = "d0d0d0d0-e1e1-4f2f-b040-171717171717";
export const MSG_ID_2 = "e0e0e0e0-f1f1-4020-c151-282828282828";
export const FOREIGN_MSG_ID = "f0f0f0f0-0101-4131-d262-393939393939";
export const SYSTEM_MSG_ID = "a1a1a1a1-b2b2-4c3c-8d4d-e5e5e5e5e5e5";

export const THUMBS = "\u{1F44D}";
export const HEART = "❤️";
export const FIRE = "\u{1F525}";
export const LAUGH = "\u{1F602}";

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

export function makeReactionStore() {
  const rows = []; // { message_id, user_id, emoji, created_at }
  let tick = 0;
  const calls = { toggle: [], summaries: [], users: [] };

  return {
    rows,
    calls,
    toggleMessageReaction: ({ messageId, userId, emoji = null, maxPerUser = 1 }) => {
      calls.toggle.push({ messageId, userId, emoji, maxPerUser });
      const mine = rows
        .filter((r) => r.message_id === messageId && r.user_id === userId)
        .sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
        .map((r) => r.emoji);
      const plan = planReactionChange(mine, emoji, maxPerUser);
      for (const gone of plan.remove) {
        const index = rows.findIndex(
          (r) => r.message_id === messageId && r.user_id === userId && r.emoji === gone,
        );
        if (index >= 0) rows.splice(index, 1);
      }
      if (plan.add) {
        tick += 1;
        rows.push({
          message_id: messageId,
          user_id: userId,
          emoji: plan.add,
          created_at: new Date(1_700_000_000_000 + tick).toISOString(),
        });
      }
      return { added: plan.add, removed: plan.remove };
    },
    listMessageReactionSummaries: (messageIds = [], viewerUserId = null) => {
      calls.summaries.push({ messageIds: [...messageIds], viewerUserId });
      const wanted = new Set(messageIds);
      const grouped = new Map();
      for (const r of rows) {
        if (!wanted.has(r.message_id)) continue;
        const key = `${r.message_id}\u0000${r.emoji}`;
        const entry = grouped.get(key) || {
          message_id: r.message_id,
          emoji: r.emoji,
          count: 0,
          first_at: r.created_at,
          reacted: 0,
        };
        entry.count += 1;
        if (r.created_at < entry.first_at) entry.first_at = r.created_at;
        if (r.user_id === viewerUserId) entry.reacted = 1;
        grouped.set(key, entry);
      }
      return [...grouped.values()];
    },
    listMessageReactionUsers: (messageId, { emoji = null, limit = 200 } = {}) => {
      calls.users.push({ messageId, emoji, limit });
      return rows
        .filter((r) => r.message_id === messageId && (!emoji || r.emoji === emoji))
        .sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
        .slice(0, limit)
        .map((r) => {
          const user = USERS.find((u) => u.id === r.user_id);
          return {
            emoji: r.emoji,
            created_at: r.created_at,
            id: user.id,
            username: user.username,
            nickname: user.nickname,
            avatar_url: user.avatar_url,
            color: user.color,
          };
        });
    },
  };
}

const USERS = [
  baseUser(ALICE_ID, "alice", "Alice"),
  baseUser(BOB_ID, "bob", "Bob"),
  baseUser(CAROL_ID, "carol", "Carol"),
];

/**
 * A group chat with alice (owner) and bob as members, carol outside of it, a
 * normal message by bob, a second one by alice, a service message and a message
 * that lives in another chat.
 */
export function makeReactionApp({ chat = {}, deps = {}, settings = {}, members, asyncDb = false } = {}) {
  const store = makeReactionStore();
  const events = [];
  const pushes = [];
  const hiddenFor = new Map(); // messageId -> Set(userId)
  const chatRecord = { id: CHAT_ID, type: "group", name: "Friends", ...chat };
  const chatMembers = members || [
    { id: ALICE_ID, username: "alice", role: "owner" },
    { id: BOB_ID, username: "bob", role: "member" },
  ];

  const messages = new Map([
    [MSG_ID, { id: MSG_ID, chat_id: CHAT_ID, user_id: BOB_ID, body: "hello from bob", hidden_everyone_at: null }],
    [MSG_ID_2, { id: MSG_ID_2, chat_id: CHAT_ID, user_id: ALICE_ID, body: "hi from alice", hidden_everyone_at: null }],
    [SYSTEM_MSG_ID, { id: SYSTEM_MSG_ID, chat_id: CHAT_ID, user_id: ALICE_ID, body: "[[system:member_joined]]", hidden_everyone_at: null }],
    [FOREIGN_MSG_ID, { id: FOREIGN_MSG_ID, chat_id: OTHER_CHAT_ID, user_id: CAROL_ID, body: "elsewhere", hidden_everyone_at: null }],
  ]);

  const wrap = (fn) => (asyncDb ? async (...args) => fn(...args) : fn);

  const userStore = makeUserStore(USERS.map((u) => ({ ...u })));
  const connected = new Set();
  const muted = new Set();
  const authorsRows = new Map();

  const built = makeApp({
    userStore,
    settings,
    deps: {
      isMember: wrap((chatId, userId) =>
        chatId === CHAT_ID && chatMembers.some((m) => m.id === userId),
      ),
      findChatById: wrap((chatId) => (chatId === CHAT_ID ? chatRecord : null)),
      getChatMemberRole: wrap(
        (chatId, userId) => chatMembers.find((m) => m.id === userId)?.role || "",
      ),
      listChatMembers: wrap(() => chatMembers),
      findMessageById: wrap((messageId) => messages.get(messageId) || null),
      getMessageAuthors: wrap((ids) =>
        ids
          .map((id) => messages.get(id))
          .filter(Boolean)
          .map((m) => ({
            id: m.id,
            user_id: m.user_id,
            client_request_id: authorsRows.get(m.id) || null,
          })),
      ),
      isMessageHiddenForUser: wrap((messageId, userId) =>
        Boolean(hiddenFor.get(messageId)?.has(userId)),
      ),
      toggleMessageReaction: wrap(store.toggleMessageReaction),
      listMessageReactionSummaries: wrap(store.listMessageReactionSummaries),
      listMessageReactionUsers: wrap(store.listMessageReactionUsers),
      emitChatEvent: (chatId, payload) => events.push({ chatId, payload }),
      sendPushNotificationToUsers: async (userIds, payload) => {
        pushes.push({ userIds, payload });
      },
      isUserConnected: (username) => connected.has(username),
      listMutedUserIdsForChat: wrap(() => [...muted].map((user_id) => ({ user_id }))),
      ...deps,
    },
  });

  return {
    ...built,
    store,
    events,
    pushes,
    messages,
    chatRecord,
    chatMembers,
    hide: (messageId, userId) => {
      const set = hiddenFor.get(messageId) || new Set();
      set.add(userId);
      hiddenFor.set(messageId, set);
    },
    setConnected: (username, on = true) => (on ? connected.add(username) : connected.delete(username)),
    mute: (userId) => muted.add(userId),
    markRemote: (messageId) => authorsRows.set(messageId, `remote:telegram:${messageId}`),
    login: async (username) => {
      const res = await request(built.app)
        .post("/api/login")
        .send({ username, password: PASSWORD });
      return res.headers["set-cookie"];
    },
  };
}

export const flush = () => new Promise((resolve) => setImmediate(resolve));
