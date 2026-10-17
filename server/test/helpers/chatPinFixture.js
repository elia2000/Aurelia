/**
 * In-memory chats + chat-pin fixture for API tests.
 *
 * The pin store behaves like db.js (same pure planners from lib/chatPins.js,
 * same statuses, same cleanup when someone leaves, is removed from or hides a
 * chat, and when a chat is deleted) so routes and services can be tested
 * without a database. The SQL itself is covered by test/db/chatPins.test.js.
 *
 * World: alice, bob and carol (dave is banned).
 *   G1..G7   groups owned by alice, bob is a member
 *   DM       a direct chat of alice and bob
 *   SAVED    alice's Saved Messages
 *   BOBS     a group of bob's alone, SECRET a group of carol's alone
 */

import bcrypt from "bcryptjs";
import request from "supertest";
import { makeApp, makeUserStore } from "./makeApp.js";
import { decideChatPin, planCompaction, planReorder } from "../../lib/chatPins.js";

export const PASSWORD = "secret123";

export const ALICE_ID = "a0a0a0a0-b1b1-4c2c-8d3d-e4e4e4e4e4e4";
export const BOB_ID = "b0b0b0b0-c1c1-4d2d-9e3e-f5f5f5f5f5f5";
export const CAROL_ID = "ca0ca0ca-0c1c-4c2c-8c3c-c5c5c5c5c5c5";
export const DAVE_ID = "da0da0da-0d1d-4d2d-8d3d-d5d5d5d5d5d5";

const groupId = (n) => `9a000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const G = [1, 2, 3, 4, 5, 6, 7].map(groupId);
export const DM = "d0d00000-0000-4000-8000-000000000001";
export const SAVED = "5a5a0000-0000-4000-8000-000000000001";
export const BOBS = "b0b50000-0000-4000-8000-000000000001";
export const SECRET = "5e5e0000-0000-4000-8000-000000000001";
export const MISSING = "00000000-dead-4000-8000-00000000beef";

const baseUser = (id, username, nickname, extra = {}) => ({
  id,
  username,
  password_hash: bcrypt.hashSync(PASSWORD, 4),
  nickname,
  avatar_url: `/api/uploads/avatars/${username}.png`,
  color: "#10b981",
  status: "online",
  role: "user",
  banned: false,
  ...extra,
});

const USERS = [
  baseUser(ALICE_ID, "alice", "Alice"),
  baseUser(BOB_ID, "bob", "Bob"),
  baseUser(CAROL_ID, "carol", "Carol"),
  baseUser(DAVE_ID, "dave", "Dave", { banned: true }),
];

const newWorld = () => {
  const chats = new Map();
  const members = new Map(); // chatId -> [{ id, role }]
  const add = (id, type, name, people) => {
    chats.set(id, { id, type, name, created_at: "2025-01-01 00:00:00", verified: 0 });
    members.set(id, people.map(([userId, role]) => ({ id: userId, role })));
  };
  G.forEach((id, i) =>
    add(id, "group", `Group ${i + 1}`, [
      [ALICE_ID, "owner"],
      [BOB_ID, "member"],
    ]),
  );
  add(DM, "dm", "dm", [
    [ALICE_ID, "member"],
    [BOB_ID, "member"],
  ]);
  add(SAVED, "saved", "Saved Messages", [[ALICE_ID, "owner"]]);
  add(BOBS, "group", "Bob's", [[BOB_ID, "owner"]]);
  add(SECRET, "group", "Secret", [[CAROL_ID, "owner"]]);
  return { chats, members };
};

export function makeChatPinApp({ settings = {}, asyncDb = false, deps = {} } = {}) {
  const world = newWorld();
  const userStore = makeUserStore(USERS.map((u) => ({ ...u })));
  const pins = new Map(); // userId -> [{ chat_id, position, pinned_at }]
  const hidden = new Set(); // `${userId}|${chatId}`
  const sse = []; // { username, payload } - what reached a person's own sessions
  const chatEvents = []; // { chatId, payload } - what reached a chat's members
  const calls = {
    pinChat: [],
    removeChatPins: [],
    reorderChatPins: [],
    listChatPins: [],
    listChatsForUser: [],
    listChatPinsForUsers: [],
    listChatPinHolders: [],
  };
  let tick = 0;

  const wrap = (fn) => (asyncDb ? async (...args) => fn(...args) : fn);
  const rowsOf = (userId) => pins.get(userId) || [];
  const setRows = (userId, rows) => pins.set(userId, rows);
  const isIn = (chatId, userId) => (world.members.get(chatId) || []).some((m) => m.id === userId);
  const isHidden = (chatId, userId) => hidden.has(`${userId}|${chatId}`);
  const byPosition = (a, b) => a.position - b.position || (a.chat_id < b.chat_id ? -1 : 1);

  /** Pins that still count: still a member, chat not hidden. */
  const effective = (userId) =>
    rowsOf(userId)
      .filter((r) => isIn(r.chat_id, userId) && !isHidden(r.chat_id, userId))
      .sort(byPosition);

  const dropRows = (userId, chatIds) => {
    const before = rowsOf(userId).length;
    setRows(
      userId,
      rowsOf(userId).filter((r) => !chatIds.includes(r.chat_id)),
    );
    return before - rowsOf(userId).length;
  };

  const store = {
    pinChat: ({ userId, chatId, max = 5 }) => {
      calls.pinChat.push({ userId, chatId, max });
      if (!isIn(chatId, userId)) return { status: "not_member", position: null };
      if (isHidden(chatId, userId)) return { status: "hidden", position: null };
      // Sweep what stopped counting.
      const live = new Set(effective(userId).map((r) => r.chat_id));
      setRows(userId, rowsOf(userId).filter((r) => live.has(r.chat_id)));
      const decision = decideChatPin({ rows: effective(userId), chatId, max });
      if (decision.action === "already") return { status: "already", position: decision.position };
      if (decision.action === "limit") return { status: "limit", position: null };
      tick += 1;
      setRows(userId, [
        ...rowsOf(userId).map((r) => ({ ...r, position: r.position + 1 })),
        { chat_id: chatId, position: 0, pinned_at: new Date(1_700_000_000_000 + tick).toISOString() },
      ]);
      return { status: "pinned", position: 0 };
    },
    removeChatPins: (userId, chatIds = []) => {
      calls.removeChatPins.push({ userId, chatIds: [...chatIds] });
      const removed = dropRows(userId, chatIds);
      if (removed) {
        for (const update of planCompaction(effective(userId))) {
          const row = rowsOf(userId).find((r) => r.chat_id === update.chatId);
          row.position = update.position;
        }
      }
      return removed;
    },
    reorderChatPins: (userId, chatIds = []) => {
      calls.reorderChatPins.push({ userId, chatIds: [...chatIds] });
      const plan = planReorder(effective(userId), chatIds);
      if (!plan.ok) return { status: "mismatch", changed: false };
      for (const update of plan.updates) {
        rowsOf(userId).find((r) => r.chat_id === update.chatId).position = update.position;
      }
      return { status: "ok", changed: plan.updates.length > 0 };
    },
    listChatPins: (userId) => {
      calls.listChatPins.push({ userId });
      return effective(userId).map((r) => ({ ...r }));
    },
    listChatPinsForUsers: (userIds = []) => {
      calls.listChatPinsForUsers.push({ userIds: [...userIds] });
      return userIds.flatMap((userId) => effective(userId).map((r) => ({ ...r, user_id: userId })));
    },
    listChatPinHolders: (chatId) => {
      calls.listChatPinHolders.push({ chatId });
      return [...pins.entries()]
        .filter(([, rows]) => rows.some((r) => r.chat_id === chatId))
        .map(([userId]) => ({ user_id: userId, username: USERS.find((u) => u.id === userId)?.username }));
    },
  };

  const userRow = (id) => USERS.find((u) => u.id === id);
  const memberRows = (chatId) =>
    (world.members.get(chatId) || []).map((m) => {
      const user = userRow(m.id);
      return {
        id: m.id,
        username: user.username,
        nickname: user.nickname,
        avatar_url: user.avatar_url,
        color: user.color,
        status: "online",
        role: m.role,
      };
    });

  const built = makeApp({
    userStore,
    settings,
    deps: {
      // ── membership / chat data ──────────────────────────────────────────
      isMember: wrap((chatId, userId) => isIn(chatId, userId)),
      findChatById: wrap((chatId) => world.chats.get(chatId) || null),
      getChatMemberRole: wrap(
        (chatId, userId) => (world.members.get(chatId) || []).find((m) => m.id === userId)?.role || "",
      ),
      listChatMembers: wrap((chatId) => memberRows(chatId)),
      listChatMembersForChats: wrap((chatIds = []) => new Map(chatIds.map((id) => [id, memberRows(id)]))),
      listChatsForUser: wrap((userId) => {
        calls.listChatsForUser.push({ userId });
        const live = effective(userId);
        const positionOf = new Map(live.map((r) => [r.chat_id, r.position]));
        const mine = [...world.chats.values()]
          .filter((chat) => isIn(chat.id, userId) && !isHidden(chat.id, userId))
          .map((chat) => ({
            ...chat,
            muted: 0,
            unread_count: 0,
            last_message_id: null,
            pin_position: positionOf.has(chat.id) ? positionOf.get(chat.id) : null,
          }));
        // Pinned first by position, then the (stand-in) usual order.
        return mine.sort((a, b) => {
          if (a.pin_position === null && b.pin_position === null) return 0;
          if (a.pin_position === null) return 1;
          if (b.pin_position === null) return -1;
          return a.pin_position - b.pin_position;
        });
      }),
      removeChatMember: wrap((chatId, userId) => {
        // db.js: whoever leaves loses their pin of the chat with it.
        dropRows(userId, [chatId]);
        const list = world.members.get(chatId) || [];
        world.members.set(
          chatId,
          list.filter((m) => m.id !== userId),
        );
      }),
      setChatMemberRole: wrap((chatId, userId, role) => {
        const m = (world.members.get(chatId) || []).find((x) => x.id === userId);
        if (m) m.role = role;
      }),
      hideChatsForUser: wrap((userId, chatIds = []) => {
        dropRows(userId, chatIds);
        chatIds.forEach((chatId) => hidden.add(`${userId}|${chatId}`));
      }),
      unhideChat: wrap((userId, chatId) => hidden.delete(`${userId}|${chatId}`)),
      deleteChatById: wrap((chatId) => {
        for (const [userId] of pins) dropRows(userId, [chatId]);
        world.chats.delete(chatId);
        world.members.delete(chatId);
        return { storedNames: [] };
      }),
      createMessage: wrap(() => "5e5e5e5e-0000-4000-8000-000000000001"),

      // ── pinned chats ────────────────────────────────────────────────────
      pinChat: wrap(store.pinChat),
      removeChatPins: wrap(store.removeChatPins),
      reorderChatPins: wrap(store.reorderChatPins),
      listChatPins: wrap(store.listChatPins),
      listChatPinsForUsers: wrap(store.listChatPinsForUsers),
      listChatPinHolders: wrap(store.listChatPinHolders),

      // ── realtime ────────────────────────────────────────────────────────
      emitSseEvent: (username, payload) => sse.push({ username, payload }),
      emitChatEvent: (chatId, payload) => chatEvents.push({ chatId, payload }),
      ...deps,
    },
  });

  const logins = new Map();
  return {
    ...built,
    world,
    store,
    pins,
    sse,
    chatEvents,
    calls,
    hidden,
    /** Pin events (type chat_pins_changed) a person's sessions received. */
    pinEventsFor: (username) =>
      sse.filter((e) => e.username === username && e.payload.type === "chat_pins_changed").map((e) => e.payload),
    login: async (username) => {
      if (logins.has(username)) return logins.get(username);
      const res = await request(built.app).post("/api/login").send({ username, password: PASSWORD });
      logins.set(username, res.headers["set-cookie"]);
      return res.headers["set-cookie"];
    },
  };
}

/** Signed-in request helpers: `await pinAs(ctx, "alice", G[0], true)`. */
export async function pinAs(ctx, username, chatId, pinned = true, extra = {}) {
  const cookie = await ctx.login(username);
  return request(ctx.app)
    .put(`/api/chats/${chatId}/pin`)
    .set("Cookie", cookie)
    .send({ pinned, ...extra });
}

export async function orderAs(ctx, username, chatIds, extra = {}) {
  const cookie = await ctx.login(username);
  return request(ctx.app)
    .put("/api/chats/pins/order")
    .set("Cookie", cookie)
    .send({ chatIds, ...extra });
}

export async function listAs(ctx, username) {
  const cookie = await ctx.login(username);
  return request(ctx.app).get(`/api/chats?username=${username}`).set("Cookie", cookie);
}

export const idsOf = (res) => res.body.pins.map((p) => p.chatId);
