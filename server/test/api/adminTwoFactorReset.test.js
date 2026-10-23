import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import { totp } from "../../lib/totp.js";
import {
  PASSWORD,
  UA_CHROME_ANDROID,
  UUID_ALICE,
  UUID_BOB,
  makeAccountApp,
  sidFrom,
  signIn,
} from "../helpers/accountFixtures.js";

let originalKey;
beforeAll(() => {
  originalKey = process.env.STORAGE_ENCRYPTION_KEY;
  process.env.STORAGE_ENCRYPTION_KEY = "admin-test-storage-key";
});
afterAll(() => {
  if (originalKey === undefined) delete process.env.STORAGE_ENCRYPTION_KEY;
  else process.env.STORAGE_ENCRYPTION_KEY = originalKey;
});

async function enableFor(app, username = "alice") {
  const { cookie } = await signIn(app, username);
  const setup = await request(app).post("/api/2fa/setup").set("Cookie", cookie).send({ password: PASSWORD });
  const enable = await request(app)
    .post("/api/2fa/enable")
    .set("Cookie", cookie)
    .send({ code: totp(setup.body.secret) });
  expect(enable.status).toBe(200);
  return { cookie, secret: setup.body.secret };
}

describe("POST /api/admin/users/:id/reset-2fa", () => {
  test("removes the second factor, ends the user's sessions, closes their streams and is audit logged", async () => {
    const ctx = makeAccountApp({ admin: true });
    const { app, closedStreams, twoFactorStore, __auditLogStore } = { ...ctx, __auditLogStore: ctx.deps.__auditLogStore };
    const { cookie: aliceCookie } = await enableFor(app);
    const phone = await signIn(app, "alice", { ua: UA_CHROME_ANDROID }); // password-only sign-in is refused now, so this is a challenge
    expect(phone.cookie).toBeNull();
    const admin = (await signIn(app, "admin")).cookie;

    const res = await request(app).post(`/api/admin/users/${UUID_ALICE}/reset-2fa`).set("Cookie", admin).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    expect(twoFactorStore.rows.has(UUID_ALICE)).toBe(false);
    expect(twoFactorStore.codes.has(UUID_ALICE)).toBe(false);
    expect((await request(app).get("/api/me").set("Cookie", aliceCookie)).status).toBe(401);
    expect(closedStreams).toEqual([
      { username: "alice", payload: { type: "session_revoked", reason: "two_factor_reset" } },
    ]);
    const entry = __auditLogStore.find((e) => e.action === "user.reset_2fa");
    expect(entry).toMatchObject({ actorUsername: "admin", targetType: "user", targetLabel: "@alice", status: "success" });

    // the user is back to password-only sign-in and can set 2FA up again
    const login = await signIn(app, "alice");
    expect(login.res.body.twoFactorRequired).toBeUndefined();
    expect(login.cookie).not.toBeNull();
  });

  test("the user's password still has to be right: a reset is not a way in", async () => {
    const { app } = makeAccountApp({ admin: true });
    await enableFor(app);
    const admin = (await signIn(app, "admin")).cookie;
    await request(app).post(`/api/admin/users/${UUID_ALICE}/reset-2fa`).set("Cookie", admin).send({});
    const wrong = await signIn(app, "alice", { password: "not-the-password" });
    expect(wrong.res.status).toBe(401);
  });

  test("only admins", async () => {
    const { app, twoFactorStore } = makeAccountApp({ admin: true });
    const { cookie: aliceCookie } = await enableFor(app);
    const bob = (await signIn(app, "bob")).cookie;
    const asUser = await request(app).post(`/api/admin/users/${UUID_ALICE}/reset-2fa`).set("Cookie", bob).send({});
    expect(asUser.status).toBe(403);
    const asSelf = await request(app).post(`/api/admin/users/${UUID_ALICE}/reset-2fa`).set("Cookie", aliceCookie).send({});
    expect(asSelf.status).toBe(403);
    const anonymous = await request(app).post(`/api/admin/users/${UUID_ALICE}/reset-2fa`).send({});
    expect(anonymous.status).toBe(401);
    expect(twoFactorStore.rows.get(UUID_ALICE).enabled).toBe(true);
  });

  test("unknown user is 404, a user without 2FA is 400 and nothing is revoked", async () => {
    const { app, closedStreams } = makeAccountApp({ admin: true });
    const admin = (await signIn(app, "admin")).cookie;
    const bob = await signIn(app, "bob");
    expect((await request(app).post("/api/admin/users/d0000000-0000-4000-8000-0000000000aa/reset-2fa").set("Cookie", admin).send({})).status).toBe(404);
    expect((await request(app).post("/api/admin/users/not-a-uuid/reset-2fa").set("Cookie", admin).send({})).status).toBe(400);
    const none = await request(app).post(`/api/admin/users/${UUID_BOB}/reset-2fa`).set("Cookie", admin).send({});
    expect(none.status).toBe(400);
    expect((await request(app).get("/api/me").set("Cookie", bob.cookie)).status).toBe(200);
    expect(closedStreams).toEqual([]);
  });

  test("an admin cannot reset the owner's two-factor; the owner can", async () => {
    const { app, userStore } = makeAccountApp({
      admin: true,
      deps: { isUserOwner: (id) => id === UUID_ALICE },
    });
    userStore.users.get("alice").role = "owner";
    await enableFor(app, "alice");
    const admin = (await signIn(app, "admin")).cookie;
    const res = await request(app).post(`/api/admin/users/${UUID_ALICE}/reset-2fa`).set("Cookie", admin).send({});
    expect(res.status).toBe(403);
    expect(sidFrom(res)).toBeNull();
  });
});
