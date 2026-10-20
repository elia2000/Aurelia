import { describe, test, expect, vi } from "vitest";
import request from "supertest";
import { makeApp, makeSessionStore, makeUserStore } from "../helpers/makeApp.js";

const ADMIN_ID = "a0000000-0000-4000-8000-000000000001";
const BOB_ID = "b0000000-0000-4000-8000-000000000002";
const CAROL_ID = "c0000000-0000-4000-8000-000000000003";
const CHAT_ID = "d0000000-0000-4000-8000-000000000009";
const OTHER_CHAT_ID = "d0000000-0000-4000-8000-000000000010";

function makeAdminApp(deps = {}) {
  const admin = { id: ADMIN_ID, username: "admin", nickname: "Admin", role: "admin" };
  const sessionStore = makeSessionStore();
  sessionStore.createSession(admin.id, "admin-session");
  const sse = [];
  const built = makeApp({
    sessionStore,
    userStore: makeUserStore([
      admin,
      { id: BOB_ID, username: "bob", nickname: "Bob", role: "user" },
      { id: CAROL_ID, username: "carol", nickname: "Carol", role: "user" },
    ]),
    deps: {
      isUserAdmin: (userId) => userId === admin.id,
      findChatById: () => ({ id: CHAT_ID, name: "Test Group", type: "group" }),
      emitSseEvent: (username, payload) => sse.push({ username, payload }),
      ...deps,
    },
  });
  return { ...built, sse };
}

const pinEvents = (sse, username) =>
  sse.filter((e) => e.username === username && e.payload.type === "chat_pins_changed").map((e) => e.payload);

describe("DELETE /api/admin/chats/:id/members/:userId", () => {
  test("takes the removed person's pin of the chat away and tells their sessions", async () => {
    const removeChatPins = vi.fn(() => 1);
    const removeChatMember = vi.fn();
    const { app, sse } = makeAdminApp({
      removeChatPins,
      removeChatMember,
      listChatPins: () => [{ chat_id: OTHER_CHAT_ID, position: 0 }],
    });

    const res = await request(app)
      .delete(`/api/admin/chats/${CHAT_ID}/members/${BOB_ID}`)
      .set("Cookie", "sid=admin-session");

    expect(res.status).toBe(200);
    expect(removeChatPins).toHaveBeenCalledWith(BOB_ID, [CHAT_ID]);
    // The pin goes before the membership does.
    expect(removeChatPins.mock.invocationCallOrder[0]).toBeLessThan(removeChatMember.mock.invocationCallOrder[0]);
    expect(pinEvents(sse, "bob")).toEqual([
      { type: "chat_pins_changed", pinned: [{ chatId: OTHER_CHAT_ID, position: 0 }] },
    ]);
    // Nobody else hears about it, the admin included.
    expect(pinEvents(sse, "admin")).toEqual([]);
    expect(pinEvents(sse, "carol")).toEqual([]);
  });

  test("no event when the person had not pinned it", async () => {
    const { app, sse } = makeAdminApp({ removeChatPins: () => 0 });
    const res = await request(app)
      .delete(`/api/admin/chats/${CHAT_ID}/members/${BOB_ID}`)
      .set("Cookie", "sid=admin-session");
    expect(res.status).toBe(200);
    expect(pinEvents(sse, "bob")).toEqual([]);
  });

  test("a failing pin cleanup does not stop the removal", async () => {
    const removeChatMember = vi.fn();
    const { app } = makeAdminApp({
      removeChatMember,
      removeChatPins: () => {
        throw new Error("boom");
      },
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await request(app)
      .delete(`/api/admin/chats/${CHAT_ID}/members/${BOB_ID}`)
      .set("Cookie", "sid=admin-session");
    spy.mockRestore();
    expect(res.status).toBe(200);
    expect(removeChatMember).toHaveBeenCalledWith(CHAT_ID, BOB_ID);
  });
});

describe("DELETE /api/admin/chats/:id", () => {
  test("tells everybody who had the chat pinned what they still have pinned", async () => {
    const order = [];
    const { app, sse } = makeAdminApp({
      listChatPinHolders: vi.fn(() => {
        order.push("holders");
        return [
          { user_id: BOB_ID, username: "bob" },
          { user_id: CAROL_ID, username: "carol" },
        ];
      }),
      adminDeleteChat: vi.fn(() => {
        order.push("delete");
        return { storedNames: [] };
      }),
      listChatPinsForUsers: vi.fn(() => {
        order.push("remaining");
        return [{ user_id: BOB_ID, chat_id: OTHER_CHAT_ID, position: 0 }];
      }),
    });

    const res = await request(app).delete(`/api/admin/chats/${CHAT_ID}`).set("Cookie", "sid=admin-session");

    expect(res.status).toBe(200);
    // Who held it is read before it is deleted, what is left after.
    expect(order).toEqual(["holders", "delete", "remaining"]);
    expect(pinEvents(sse, "bob")).toEqual([
      { type: "chat_pins_changed", pinned: [{ chatId: OTHER_CHAT_ID, position: 0 }] },
    ]);
    expect(pinEvents(sse, "carol")).toEqual([{ type: "chat_pins_changed", pinned: [] }]);
    expect(pinEvents(sse, "admin")).toEqual([]);
  });

  test("a chat nobody pinned sends no pin events", async () => {
    const { app, sse } = makeAdminApp({ listChatPinHolders: () => [] });
    const res = await request(app).delete(`/api/admin/chats/${CHAT_ID}`).set("Cookie", "sid=admin-session");
    expect(res.status).toBe(200);
    expect(sse.filter((e) => e.payload.type === "chat_pins_changed")).toEqual([]);
  });

  test("the deletion succeeds even when the pin lookups fail", async () => {
    const adminDeleteChat = vi.fn(() => ({ storedNames: [] }));
    const { app } = makeAdminApp({
      adminDeleteChat,
      listChatPinHolders: () => {
        throw new Error("boom");
      },
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await request(app).delete(`/api/admin/chats/${CHAT_ID}`).set("Cookie", "sid=admin-session");
    spy.mockRestore();
    expect(res.status).toBe(200);
    expect(adminDeleteChat).toHaveBeenCalledWith(CHAT_ID);
  });
});
