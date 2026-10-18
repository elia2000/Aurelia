import { describe, test, expect, vi } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { makeApp, makeSessionStore, makeUserStore } from "../helpers/makeApp.js";
import { makeMemoryGifStorage } from "../helpers/savedGifFixture.js";
import { buildSavedGifKey } from "../../lib/savedGifs.js";
import { buildGif } from "../helpers/imageBytes.js";

const ALICE_ID = "a0000000-0000-4000-8000-000000000001";
const BOB_ID = "b0000000-0000-4000-8000-000000000002";
const ADMIN_ID = "ad000000-0000-4000-8000-000000000003";
const GIF_1 = "91000000-0000-4000-8000-000000000001";
const GIF_2 = "91000000-0000-4000-8000-000000000002";
const GIF_BOB = "91000000-0000-4000-8000-000000000003";

/** Storage with one GIF each for Alice (two) and Bob (one), and their rows. */
function seedStorage() {
  const storage = makeMemoryGifStorage();
  const rows = [];
  for (const [id, userId] of [
    [GIF_1, ALICE_ID],
    [GIF_2, ALICE_ID],
    [GIF_BOB, BOB_ID],
  ]) {
    const key = buildSavedGifKey(userId, id, "gif");
    storage.gifs.set(key, buildGif({ frames: 2 + rows.length }));
    rows.push({ id, user_id: userId, storage_key: key, storage_driver: "local" });
  }
  return { storage, rows };
}

const rowsOf = (rows, userId) => rows.filter((r) => r.user_id === userId);

describe("deleting your own account", () => {
  test("removes the person's saved GIF files, and nobody else's", async () => {
    const { storage, rows } = seedStorage();
    const alice = {
      id: ALICE_ID,
      username: "alice",
      password_hash: bcrypt.hashSync("secret123", 4),
      nickname: "Alice",
      role: "user",
      banned: false,
    };
    const deleteUserById = vi.fn(async () => ({ storedNames: [], savedGifs: rowsOf(rows, ALICE_ID) }));
    const { app, sessionStore } = makeApp({
      userStore: makeUserStore([alice]),
      deps: {
        deleteUserById,
        listChatsForUser: () => [],
        savedGifStorage: storage,
      },
    });
    sessionStore.createSession(ALICE_ID, "alice-session");

    const res = await request(app)
      .post("/api/profile/delete")
      .set("Cookie", "sid=alice-session")
      .send({ username: "alice", password: "secret123" });

    expect(res.status).toBe(200);
    expect(deleteUserById).toHaveBeenCalledWith(ALICE_ID);
    expect(storage.calls.removeGifs).toEqual([[GIF_1, GIF_2]]);
    expect([...storage.gifs.keys()]).toEqual([buildSavedGifKey(BOB_ID, GIF_BOB, "gif")]);
  });

  test("a failing file removal does not undo the deletion", async () => {
    const { storage, rows } = seedStorage();
    storage.removeGifs = async () => {
      throw new Error("bucket unreachable");
    };
    const alice = {
      id: ALICE_ID,
      username: "alice",
      password_hash: bcrypt.hashSync("secret123", 4),
      nickname: "Alice",
      role: "user",
      banned: false,
    };
    const { app, sessionStore } = makeApp({
      userStore: makeUserStore([alice]),
      deps: {
        deleteUserById: async () => ({ storedNames: [], savedGifs: rowsOf(rows, ALICE_ID) }),
        listChatsForUser: () => [],
        savedGifStorage: storage,
      },
    });
    sessionStore.createSession(ALICE_ID, "alice-session");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await request(app)
      .post("/api/profile/delete")
      .set("Cookie", "sid=alice-session")
      .send({ username: "alice", password: "secret123" });
    spy.mockRestore();
    expect(res.status).toBe(200);
  });
});

describe("the admin panel", () => {
  function makeAdminApp(deps = {}) {
    const admin = { id: ADMIN_ID, username: "admin", nickname: "Admin", role: "admin" };
    const sessionStore = makeSessionStore();
    sessionStore.createSession(admin.id, "admin-session");
    return makeApp({
      sessionStore,
      userStore: makeUserStore([
        admin,
        { id: ALICE_ID, username: "alice", nickname: "Alice", role: "user" },
        { id: BOB_ID, username: "bob", nickname: "Bob", role: "user" },
      ]),
      deps: { isUserAdmin: (userId) => userId === admin.id, ...deps },
    });
  }

  test("deleting a user removes their saved GIF files", async () => {
    const { storage, rows } = seedStorage();
    const adminDeleteUser = vi.fn(async () => ({ storedNames: [], savedGifs: rowsOf(rows, ALICE_ID) }));
    const { app } = makeAdminApp({ adminDeleteUser, savedGifStorage: storage });
    const res = await request(app).delete(`/api/admin/users/${ALICE_ID}`).set("Cookie", "sid=admin-session");
    expect(res.status).toBe(200);
    expect(storage.calls.removeGifs).toEqual([[GIF_1, GIF_2]]);
    expect(storage.gifs.size).toBe(1);
  });

  test("resetting everything removes every saved GIF file", async () => {
    const { storage, rows } = seedStorage();
    const adminResetDatabase = vi.fn(async () => ({ storedNames: [], savedGifs: rows }));
    const { app } = makeAdminApp({ adminResetDatabase, savedGifStorage: storage });
    const res = await request(app)
      .post("/api/admin/maintenance/reset")
      .set("Cookie", "sid=admin-session")
      .send({ confirm: "reset everything" });
    expect(res.status).toBe(200);
    expect(storage.gifs.size).toBe(0);
  });
});

describe("the database tools", () => {
  const TOKEN = "gif-admin-token";

  function makeToolsApp({ storage, listSavedGifsForUsers, listAllSavedGifs, adminGetAll, adminRun, adminResetDatabase }) {
    process.env.ADMIN_API_TOKEN = TOKEN;
    const run = adminRun || vi.fn(async () => 1);
    return makeApp({
      deps: {
        isLoopbackRequest: () => true,
        adminGetRow: vi.fn(async () => null),
        adminGetAll: adminGetAll || vi.fn(async () => []),
        adminRun: run,
        adminTransaction: async (callback) => callback(run),
        adminResetDatabase: adminResetDatabase || vi.fn(async () => ({ storedNames: [] })),
        adminSave: vi.fn(),
        removeAllMessageUploads: vi.fn(),
        listSavedGifsForUsers,
        listAllSavedGifs,
        savedGifStorage: storage,
      },
    });
  }

  test("delete_users deletes the people's GIF rows with them and removes the files", async () => {
    const { storage, rows } = seedStorage();
    const adminRun = vi.fn(async () => 1);
    const listSavedGifsForUsers = vi.fn(async (ids) => rows.filter((r) => ids.includes(r.user_id)));
    const { app } = makeToolsApp({ storage, listSavedGifsForUsers, adminRun });

    const res = await request(app)
      .post("/api/admin/db-tools")
      .set("x-songbird-admin-token", TOKEN)
      .send({ action: "delete_users", payload: { selectors: [ALICE_ID] } });

    expect(res.status).toBe(200);
    const statements = adminRun.mock.calls.map((call) => String(call[0]));
    const gifDelete = statements.findIndex((sql) => /DELETE FROM user_gifs WHERE user_id IN/i.test(sql));
    const userDelete = statements.findIndex((sql) => /DELETE FROM users WHERE id IN/i.test(sql));
    expect(gifDelete).toBeGreaterThan(-1);
    expect(gifDelete).toBeLessThan(userDelete);
    expect(listSavedGifsForUsers).toHaveBeenCalledWith([ALICE_ID]);
    expect(storage.calls.removeGifs).toEqual([[GIF_1, GIF_2]]);
    expect(storage.gifs.size).toBe(1);
  });

  test("reset_db removes the saved GIF files the reset reports", async () => {
    const { storage, rows } = seedStorage();
    const adminResetDatabase = vi.fn(async () => ({ storedNames: [], savedGifs: rows }));
    const { app } = makeToolsApp({ storage, adminResetDatabase });
    const res = await request(app)
      .post("/api/admin/db-tools")
      .set("x-songbird-admin-token", TOKEN)
      .send({ action: "reset_db" });
    expect(res.status).toBe(200);
    expect(storage.gifs.size).toBe(0);
  });

  test("delete_db deletes the GIF rows and removes the files", async () => {
    const { storage, rows } = seedStorage();
    const adminRun = vi.fn(async () => 1);
    const { app } = makeToolsApp({ storage, adminRun, listAllSavedGifs: vi.fn(async () => rows) });
    const res = await request(app)
      .post("/api/admin/db-tools")
      .set("x-songbird-admin-token", TOKEN)
      .send({ action: "delete_db" });
    expect(res.status).toBe(200);
    const statements = adminRun.mock.calls.map((call) => String(call[0]));
    expect(statements.some((sql) => /DELETE FROM user_gifs/i.test(sql))).toBe(true);
    expect(statements.findIndex((sql) => /DELETE FROM user_gifs/i.test(sql))).toBeLessThan(
      statements.findIndex((sql) => /DELETE FROM users/i.test(sql)),
    );
    expect(storage.gifs.size).toBe(0);
  });
});
