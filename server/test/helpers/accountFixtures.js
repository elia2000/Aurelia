import request from "supertest";
import bcrypt from "bcryptjs";
import { makeApp, makeUserStore } from "./makeApp.js";

export const UUID_ALICE = "a0000000-0000-4000-8000-000000000001";
export const UUID_BOB = "b0000000-0000-4000-8000-000000000002";
export const UUID_ADMIN = "c0000000-0000-4000-8000-000000000003";

export const UA_FIREFOX_LINUX =
  "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0";
export const UA_CHROME_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
export const UA_SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

export const PASSWORD = "secret123";

export const userRow = (id, username, over = {}) => ({
  id,
  username,
  password_hash: bcrypt.hashSync(PASSWORD, 4), // low cost for test speed
  nickname: username,
  avatar_url: null,
  color: "#10b981",
  status: "online",
  role: "user",
  banned: false,
  ...over,
});

/** An app with alice and bob (and optionally an admin). */
export function makeAccountApp({ admin = false, deps = {}, settings } = {}) {
  const users = [userRow(UUID_ALICE, "alice"), userRow(UUID_BOB, "bob")];
  if (admin) users.push(userRow(UUID_ADMIN, "admin", { role: "admin" }));
  const userStore = makeUserStore(users);
  const ctx = makeApp({
    userStore,
    settings,
    deps: {
      ...(admin ? { isUserAdmin: (id) => id === UUID_ADMIN } : {}),
      ...deps,
    },
  });
  return ctx;
}

export const sidFrom = (res) => {
  const cookie = (res.headers["set-cookie"] ?? []).map(String).find((c) => c.startsWith("sid="));
  return cookie ? cookie.split(";")[0].slice(4) : null;
};

/** Signs in and resolves to { res, sid, cookie }. */
export async function signIn(app, username = "alice", { password = PASSWORD, ua = UA_FIREFOX_LINUX, ip } = {}) {
  let req = request(app).post("/api/login").set("User-Agent", ua);
  if (ip) req = req.set("X-Forwarded-For", ip);
  const res = await req.send({ username, password });
  const sid = sidFrom(res);
  return { res, sid, cookie: sid ? `sid=${sid}` : null };
}
