/**
 * In-memory chat + pin fixture for API tests.
 *
 * Builds on the reaction fixture (a group chat "Friends" with alice as owner
 * and bob as member, four messages, hidden-message and mute bookkeeping) and
 * adds a pin store that behaves like db.js: atomic limit, idempotent pin,
 * newest pin first, messages deleted for everyone or hidden for the viewer are
 * left out. The SQL itself is covered by test/db/messagePins.test.js.
 */

import request from "supertest";
import {
  ALICE_ID,
  BOB_ID,
  CAROL_ID,
  CHAT_ID,
  FOREIGN_MSG_ID,
  MSG_ID,
  MSG_ID_2,
  SYSTEM_MSG_ID,
  flush,
  makeReactionApp,
} from "./reactionFixture.js";

export {
  ALICE_ID,
  BOB_ID,
  CAROL_ID,
  CHAT_ID,
  FOREIGN_MSG_ID,
  MSG_ID,
  MSG_ID_2,
  SYSTEM_MSG_ID,
  flush,
};

export const NEW_MSG_ID = "9a9a9a9a-b2b2-4c3c-8d4d-e5e5e5e5e5e5";
const CREATED_ID_PREFIX = "5e5e5e5e-0000-4000-8000-";

export function makePinStore(getContext) {
  const rows = []; // { chat_id, message_id, pinned_by, pinned_at }
  const calls = { pin: [], unpin: [], unpinAll: [], list: [], ids: [] };
  let tick = 0;

  const nextTimestamp = () => {
    tick += 1;
    return new Date(1_700_000_000_000 + tick * 1000).toISOString();
  };

  return {
    rows,
    calls,
    pinMessage: ({ chatId, messageId, userId = null, max = 20 }) => {
      calls.pin.push({ chatId, messageId, userId, max });
      const existing = rows.find((r) => r.chat_id === chatId && r.message_id === messageId);
      if (existing) return { status: "already", pinnedAt: existing.pinned_at };
      if (rows.filter((r) => r.chat_id === chatId).length >= max) {
        return { status: "limit", pinnedAt: null };
      }
      const pinnedAt = nextTimestamp();
      rows.push({ chat_id: chatId, message_id: messageId, pinned_by: userId, pinned_at: pinnedAt });
      return { status: "pinned", pinnedAt };
    },
    unpinMessage: (chatId, messageId) => {
      calls.unpin.push({ chatId, messageId });
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (rows[i].chat_id === chatId && rows[i].message_id === messageId) rows.splice(i, 1);
      }
      return before - rows.length;
    },
    unpinAllMessages: (chatId) => {
      calls.unpinAll.push({ chatId });
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (rows[i].chat_id === chatId) rows.splice(i, 1);
      }
      return before - rows.length;
    },
    listPinnedMessages: (chatId, viewerUserId, { limit = 100 } = {}) => {
      calls.list.push({ chatId, viewerUserId, limit });
      const ctx = getContext();
      return rows
        .filter((r) => r.chat_id === chatId)
        .filter((r) => {
          const message = ctx.messages.get(r.message_id);
          if (!message || message.chat_id !== chatId || message.hidden_everyone_at) return false;
          return !ctx.isHiddenFor(r.message_id, viewerUserId);
        })
        .sort((a, b) => (a.pinned_at < b.pinned_at ? 1 : a.pinned_at > b.pinned_at ? -1 : 0))
        .slice(0, limit)
        .map((r) => {
          const message = ctx.messages.get(r.message_id);
          const sender = ctx.userById(message.user_id);
          const files = message.files || [];
          return {
            message_id: r.message_id,
            pinned_by: r.pinned_by,
            pinned_at: r.pinned_at,
            chat_id: r.chat_id,
            sender_id: message.user_id,
            body: message.body,
            edited_body: message.edited_body ?? null,
            message_created_at: message.created_at || "2025-01-01 10:00:00",
            e2ee_envelope: message.e2ee_envelope || null,
            sender_username: sender?.username ?? null,
            sender_nickname: sender?.nickname ?? null,
            file_count: files.length,
            first_file_mime: files[0]?.mime_type ?? null,
            first_file_kind: files[0]?.kind ?? null,
          };
        });
    },
    listPinnedMessageIds: (chatId, messageIds = []) => {
      calls.ids.push({ chatId, messageIds: [...messageIds] });
      const wanted = new Set(messageIds);
      return rows
        .filter((r) => r.chat_id === chatId && wanted.has(r.message_id))
        .map((r) => ({ message_id: r.message_id }));
    },
  };
}

/**
 * The reaction fixture's group chat with the pin dependencies wired in.
 *
 * `chat`, `members` and `settings` are the reaction fixture's options. Extra
 * returned helpers: `pins` (the pin store), `created` (service messages the
 * server wrote), `isHiddenFor`, `addMessage`.
 */
export function makePinApp({ chat, members, settings, asyncDb = false, deps = {} } = {}) {
  let context;
  const store = makePinStore(() => context);
  const created = [];
  const wrap = (fn) => (asyncDb ? async (...args) => fn(...args) : fn);
  const hidden = new Map();

  const built = makeReactionApp({
    chat,
    members,
    settings,
    asyncDb,
    deps: {
      pinMessage: wrap(store.pinMessage),
      unpinMessage: wrap(store.unpinMessage),
      unpinAllMessages: wrap(store.unpinAllMessages),
      listPinnedMessages: wrap(store.listPinnedMessages),
      listPinnedMessageIds: wrap(store.listPinnedMessageIds),
      createMessage: wrap((chatId, userId, body, replyTo, expiresAt, clientRequestId, options) => {
        const id = `${CREATED_ID_PREFIX}${String(created.length + 1).padStart(12, "0")}`;
        const record = {
          id,
          chatId,
          userId,
          body,
          replyTo,
          expiresAt,
          clientRequestId,
          options,
        };
        created.push(record);
        context?.messages.set(id, {
          id,
          chat_id: chatId,
          user_id: userId,
          body,
          hidden_everyone_at: null,
        });
        return id;
      }),
      ...deps,
    },
  });

  // The reaction fixture keeps the "hidden for me" sets private; mirror them.
  const hide = built.hide;
  built.hide = (messageId, userId) => {
    const set = hidden.get(messageId) || new Set();
    set.add(userId);
    hidden.set(messageId, set);
    hide(messageId, userId);
  };

  context = {
    ...built,
    pins: store,
    created,
    isHiddenFor: (messageId, userId) => Boolean(hidden.get(messageId)?.has(userId)),
    userById: (id) => built.userStore.findUserById(id),
    addMessage: (message) => {
      built.messages.set(message.id, {
        chat_id: CHAT_ID,
        user_id: BOB_ID,
        body: "text",
        hidden_everyone_at: null,
        ...message,
      });
      return message.id;
    },
  };
  return context;
}

export const pinsUrl = (chatId = CHAT_ID) => `/api/chats/${chatId}/pins`;

/** A signed-in request helper: `as(ctx, "alice").post(url).send(...)`. */
export async function signIn(ctx, username) {
  return ctx.login(username);
}

export async function pinAs(ctx, username, messageId, chatId = CHAT_ID) {
  const cookie = await ctx.login(username);
  return request(ctx.app).post(pinsUrl(chatId)).set("Cookie", cookie).send({ messageId });
}

export async function unpinAs(ctx, username, messageId, chatId = CHAT_ID) {
  const cookie = await ctx.login(username);
  return request(ctx.app).delete(`${pinsUrl(chatId)}/${messageId}`).set("Cookie", cookie);
}

export async function unpinAllAs(ctx, username, chatId = CHAT_ID) {
  const cookie = await ctx.login(username);
  return request(ctx.app).delete(pinsUrl(chatId)).set("Cookie", cookie);
}

export async function listAs(ctx, username, chatId = CHAT_ID) {
  const cookie = await ctx.login(username);
  return request(ctx.app).get(pinsUrl(chatId)).set("Cookie", cookie);
}
