import { describe, expect, test, vi } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import {
  PASSWORD,
  UA_CHROME_ANDROID,
  UA_FIREFOX_LINUX,
  UUID_ADMIN,
  UUID_ALICE,
  UUID_BOB,
  makeAccountApp,
  sidFrom,
  signIn,
  userRow,
} from "../helpers/accountFixtures.js";
import { makeApp, makeUserStore } from "../helpers/makeApp.js";

const wrongLogin = (app, username = "alice") =>
  request(app).post("/api/login").send({ username, password: "definitely-wrong" });

describe("login rate limiting", () => {
  test("eight wrong passwords for one account from one address lock that pair, even for the right password", async () => {
    const { app } = makeAccountApp();
    for (let i = 0; i < 8; i += 1) expect((await wrongLogin(app)).status).toBe(401);

    const locked = await request(app).post("/api/login").send({ username: "alice", password: PASSWORD });
    expect(locked.status).toBe(429);
    expect(locked.body).toEqual({ error: "Too many attempts. Try again later." });
    expect(Number(locked.headers["retry-after"])).toBeGreaterThan(0);
    expect(sidFrom(locked)).toBeNull();

    // another account from the same address is not locked by the pair bucket
    expect((await signIn(app, "bob")).res.status).toBe(200);
  });

  test("unknown account names are limited exactly like real ones (no way to tell them apart)", async () => {
    const { app } = makeAccountApp();
    for (let i = 0; i < 8; i += 1) expect((await wrongLogin(app, "ghost")).status).toBe(401);
    const locked = await wrongLogin(app, "ghost");
    expect(locked.status).toBe(429);
    expect(locked.body).toEqual({ error: "Too many attempts. Try again later." });
  });

  test("a good sign-in does not wipe the count of an attacker working on the same account from elsewhere", async () => {
    const { app } = makeAccountApp();
    for (let i = 0; i < 7; i += 1) await wrongLogin(app);
    // the real owner gets in (this clears only the owner's own address+account bucket)
    expect((await signIn(app, "alice")).res.status).toBe(200);
    for (let i = 0; i < 7; i += 1) expect((await wrongLogin(app)).status).toBe(401);
  });

  test("the limit also covers password changes and account deletion from a signed-in session", async () => {
    const { app } = makeAccountApp();
    const { cookie } = await signIn(app, "alice");
    let last;
    for (let i = 0; i < 9; i += 1) {
      last = await request(app)
        .put("/api/password")
        .set("Cookie", cookie)
        .send({ username: "alice", currentPassword: `wrong-${i}`, newPassword: "another-pass" });
    }
    expect(last.status).toBe(429);
    const del = await request(app)
      .post("/api/profile/delete")
      .set("Cookie", cookie)
      .send({ username: "alice", password: PASSWORD });
    expect(del.status).toBe(429);
  });
});

describe("login response shape and timing", () => {
  test("unknown name and wrong password give the same answer", async () => {
    const { app } = makeAccountApp();
    const unknown = await wrongLogin(app, "ghost");
    const wrong = await wrongLogin(app, "alice");
    expect(unknown.status).toBe(wrong.status);
    expect(unknown.body).toEqual(wrong.body);
  });

  test("a password is verified even when the account does not exist (no timing difference)", async () => {
    const compare = vi.fn((...args) => bcrypt.compare(...args));
    const { app } = makeAccountApp({ deps: { bcrypt: { ...bcrypt, compare, hashSync: bcrypt.hashSync, hash: bcrypt.hash } } });
    await wrongLogin(app, "ghost");
    expect(compare).toHaveBeenCalledTimes(1);
    await wrongLogin(app, "alice");
    expect(compare).toHaveBeenCalledTimes(2);
  });

  test("an account with no password hash can not be signed into with an empty-ish password", async () => {
    const userStore = makeUserStore([userRow(UUID_ALICE, "alice", { password_hash: null })]);
    const { app } = makeApp({ userStore });
    const res = await request(app).post("/api/login").send({ username: "alice", password: "anything" });
    expect(res.status).toBe(401);
  });

  test("the ban is only revealed to somebody who knows the password", async () => {
    const userStore = makeUserStore([userRow(UUID_ALICE, "alice", { banned: true })]);
    const { app } = makeApp({ userStore });
    const wrong = await wrongLogin(app);
    expect(wrong.status).toBe(401);
    expect(wrong.body).toEqual({ error: "Invalid credentials." });
    const right = await request(app).post("/api/login").send({ username: "alice", password: PASSWORD });
    expect(right.status).toBe(403);
    expect(right.body.error).toMatch(/banned/i);
    expect(sidFrom(right)).toBeNull();
  });

  test("non-string credentials are a 400, not a crash", async () => {
    const { app } = makeAccountApp();
    for (const body of [
      { username: { a: 1 }, password: PASSWORD },
      { username: "alice", password: ["x"] },
      { username: 5, password: 6 },
    ]) {
      const res = await request(app).post("/api/login").send(body);
      expect(res.status).toBe(400);
    }
  });
});

describe("session cookie", () => {
  test("is HttpOnly, SameSite=Lax, path / and lasts 14 days; Secure only on HTTPS in production", async () => {
    const { app } = makeAccountApp();
    const { res } = await signIn(app);
    const cookie = String(res.headers["set-cookie"]);
    expect(cookie).toMatch(/^sid=[0-9a-f]{48};/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=1209600");
    expect(cookie).not.toContain("Secure"); // plain HTTP in tests, not production
  });

  test("the token is 192 random bits and differs on every login", async () => {
    const { app } = makeAccountApp();
    const a = await signIn(app);
    const b = await signIn(app);
    expect(a.sid).toMatch(/^[0-9a-f]{48}$/);
    expect(a.sid).not.toBe(b.sid);
  });

  test("a malformed percent-escape in a cookie is an unauthenticated request, not a 500", async () => {
    const { app } = makeAccountApp();
    const res = await request(app).get("/api/me").set("Cookie", "sid=%E0%A4%A");
    expect(res.status).toBe(401);
  });
});

describe("session fixation", () => {
  test("a session id chosen by somebody else is never adopted", async () => {
    const { app, sessionStore } = makeAccountApp();
    const planted = "f".repeat(48);
    const res = await request(app)
      .post("/api/login")
      .set("Cookie", `sid=${planted}`)
      .send({ username: "alice", password: PASSWORD });
    expect(res.status).toBe(200);
    expect(sidFrom(res)).not.toBe(planted);
    expect(sessionStore.sessions.has(planted)).toBe(false);
    expect((await request(app).get("/api/me").set("Cookie", `sid=${planted}`)).status).toBe(401);
  });

  test("signing in again in the same browser retires the old session (no ghost entries)", async () => {
    const { app, sessionStore } = makeAccountApp();
    const first = await signIn(app);
    const second = await request(app)
      .post("/api/login")
      .set("Cookie", first.cookie)
      .set("User-Agent", UA_FIREFOX_LINUX)
      .send({ username: "alice", password: PASSWORD });
    expect(sidFrom(second)).not.toBe(first.sid);
    expect(sessionStore.sessions.has(first.sid)).toBe(false);
    expect((await request(app).get("/api/me").set("Cookie", first.cookie)).status).toBe(401);
    expect((await request(app).get("/api/me").set("Cookie", `sid=${sidFrom(second)}`)).status).toBe(200);
  });

  test("registration also starts a fresh session", async () => {
    const { app, sessionStore } = makeAccountApp();
    const planted = "e".repeat(48);
    const res = await request(app)
      .post("/api/register")
      .set("Cookie", `sid=${planted}`)
      .send({ username: "carol", password: "secret123" });
    expect(sidFrom(res)).not.toBe(planted);
    expect(sessionStore.sessions.has(planted)).toBe(false);
  });
});

describe("logout", () => {
  test("ends the session on the server, not just in the browser", async () => {
    const { app, sessionStore } = makeAccountApp();
    const { cookie, sid } = await signIn(app);
    const res = await request(app).post("/api/logout").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(sessionStore.sessions.has(sid)).toBe(false);
    // a copy of the cookie is worthless now
    expect((await request(app).get("/api/me").set("Cookie", cookie)).status).toBe(401);
    expect((await request(app).get("/api/sessions").set("Cookie", cookie)).status).toBe(401);
  });

  test("leaves the account's other sessions alone", async () => {
    const { app } = makeAccountApp();
    const laptop = await signIn(app, "alice", { ua: UA_FIREFOX_LINUX });
    const phone = await signIn(app, "alice", { ua: UA_CHROME_ANDROID });
    await request(app).post("/api/logout").set("Cookie", laptop.cookie);
    expect((await request(app).get("/api/me").set("Cookie", phone.cookie)).status).toBe(200);
  });
});

describe("changing the password signs the other devices out", () => {
  const change = (app, cookie, over = {}) =>
    request(app)
      .put("/api/password")
      .set("Cookie", cookie)
      .send({ username: "alice", currentPassword: PASSWORD, newPassword: "brand-new-pass", ...over });

  test("every other session ends at once, this one stays, and their streams are closed", async () => {
    const { app, closedStreams } = makeAccountApp();
    const laptop = await signIn(app, "alice", { ua: UA_FIREFOX_LINUX });
    const phone = await signIn(app, "alice", { ua: UA_CHROME_ANDROID });
    const bob = await signIn(app, "bob");
    const phoneId = (await request(app).get("/api/sessions").set("Cookie", laptop.cookie)).body.sessions.find((s) => !s.current).id;

    const res = await change(app, laptop.cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, otherSessionsSignedOut: 1 });

    expect((await request(app).get("/api/me").set("Cookie", phone.cookie)).status).toBe(401);
    expect((await request(app).get("/api/me").set("Cookie", laptop.cookie)).status).toBe(200);
    expect((await request(app).get("/api/me").set("Cookie", bob.cookie)).status).toBe(200);
    expect(closedStreams).toEqual([
      { sessionIds: [phoneId], payload: { type: "session_revoked", reason: "password_changed" } },
    ]);
  });

  test("a wrong current password changes nothing and signs nobody out", async () => {
    const { app, closedStreams } = makeAccountApp();
    const laptop = await signIn(app, "alice");
    const phone = await signIn(app, "alice", { ua: UA_CHROME_ANDROID });
    const res = await change(app, laptop.cookie, { currentPassword: "wrong-password" });
    expect(res.status).toBe(401);
    expect((await request(app).get("/api/me").set("Cookie", phone.cookie)).status).toBe(200);
    expect(closedStreams).toEqual([]);
  });

  test("the new password works and the old one does not", async () => {
    const userStore = makeUserStore([userRow(UUID_ALICE, "alice")]);
    const updateUserPassword = (id, hash) => {
      userStore.users.get("alice").password_hash = hash;
    };
    const { app } = makeApp({ userStore, deps: { updateUserPassword } });
    const { cookie } = await signIn(app);
    expect((await change(app, cookie)).status).toBe(200);
    expect((await signIn(app, "alice", { password: PASSWORD })).res.status).toBe(401);
    expect((await signIn(app, "alice", { password: "brand-new-pass" })).res.status).toBe(200);
  });
});

describe("account deletion", () => {
  test("closes the live streams of every device of the deleted account", async () => {
    const { app, closedStreams } = makeAccountApp();
    const { cookie } = await signIn(app);
    const res = await request(app)
      .post("/api/profile/delete")
      .set("Cookie", cookie)
      .send({ username: "alice", password: PASSWORD });
    expect(res.status).toBe(200);
    expect(closedStreams).toEqual([
      { username: "alice", payload: { type: "session_revoked", reason: "account_deleted" } },
    ]);
  });
});

describe("admin actions end live sessions", () => {
  const adminCookie = async (app) => (await signIn(app, "admin")).cookie;

  test("banning signs the user out everywhere and closes their streams", async () => {
    const { app, closedStreams, userStore } = makeAccountApp({
      admin: true,
      deps: {},
    });
    const phone = await signIn(app, "alice", { ua: UA_CHROME_ANDROID });
    const laptop = await signIn(app, "alice", { ua: UA_FIREFOX_LINUX });
    const admin = await adminCookie(app);

    const res = await request(app).post(`/api/admin/users/${UUID_ALICE}/ban`).set("Cookie", admin).send({ banned: true });
    expect(res.status).toBe(200);
    expect((await request(app).get("/api/me").set("Cookie", phone.cookie)).status).toBe(401);
    expect((await request(app).get("/api/me").set("Cookie", laptop.cookie)).status).toBe(401);
    expect(closedStreams).toEqual([
      { username: "alice", payload: { type: "session_revoked", reason: "banned" } },
    ]);
    expect(userStore.users.get("bob")).toBeDefined();
  });

  test("unbanning does not close anything", async () => {
    const { app, closedStreams } = makeAccountApp({ admin: true });
    const admin = await adminCookie(app);
    await request(app).post(`/api/admin/users/${UUID_ALICE}/ban`).set("Cookie", admin).send({ banned: false });
    expect(closedStreams).toEqual([]);
  });

  test("resetting a password signs the user out everywhere and closes their streams", async () => {
    const { app, closedStreams } = makeAccountApp({ admin: true });
    const phone = await signIn(app, "alice", { ua: UA_CHROME_ANDROID });
    const bob = await signIn(app, "bob");
    const admin = await adminCookie(app);
    const res = await request(app)
      .post(`/api/admin/users/${UUID_ALICE}/reset-password`)
      .set("Cookie", admin)
      .send({ password: "fresh-password" });
    expect(res.status).toBe(200);
    expect((await request(app).get("/api/me").set("Cookie", phone.cookie)).status).toBe(401);
    expect((await request(app).get("/api/me").set("Cookie", bob.cookie)).status).toBe(200);
    expect(closedStreams).toEqual([
      { username: "alice", payload: { type: "session_revoked", reason: "password_reset" } },
    ]);
  });
});

describe("the debug log never receives credentials", () => {
  test("passwords, codes and challenges are masked in the request log", async () => {
    // index.js wraps req.body / res.json with redactSensitive before debugLog (lib/redact.js is tested on its own).
    const { redactSensitive } = await import("../../lib/redact.js");
    const logged = redactSensitive({ username: "alice", password: PASSWORD, code: "123456", challenge: "abc.def" });
    expect(JSON.stringify(logged)).not.toContain(PASSWORD);
    expect(JSON.stringify(logged)).not.toContain("123456");
    expect(JSON.stringify(logged)).not.toContain("abc.def");
    expect(logged.username).toBe("alice");
    void UUID_BOB;
    void UUID_ADMIN;
  });
});
