import { describe, expect, test } from "vitest";
import request from "supertest";
import {
  UA_CHROME_ANDROID,
  UA_FIREFOX_LINUX,
  UA_SAFARI_IPHONE,
  UUID_ALICE,
  makeAccountApp,
  signIn,
} from "../helpers/accountFixtures.js";

const list = async (app, cookie) => request(app).get("/api/sessions").set("Cookie", cookie);

describe("GET /api/sessions", () => {
  test("requires a session", async () => {
    const { app } = makeAccountApp();
    expect((await request(app).get("/api/sessions")).status).toBe(401);
  });

  test("lists this device first, with browser and OS only, and marks it current", async () => {
    const { app } = makeAccountApp();
    const phone = await signIn(app, "alice", { ua: UA_CHROME_ANDROID });
    const laptop = await signIn(app, "alice", { ua: UA_FIREFOX_LINUX });

    const res = await list(app, laptop.cookie);
    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(2);
    expect(res.body.sessions[0]).toMatchObject({
      current: true,
      device: "Firefox on Linux",
      browser: "Firefox",
      os: "Linux",
      method: "password",
      viaPassword: true,
    });
    expect(res.body.sessions[1]).toMatchObject({ current: false, device: "Chrome on Android" });
    expect(Date.parse(res.body.sessions[0].createdAt)).not.toBeNaN();
    expect(Date.parse(res.body.sessions[0].lastSeenAt)).not.toBeNaN();

    // from the phone the order flips
    const fromPhone = await list(app, phone.cookie);
    expect(fromPhone.body.sessions[0]).toMatchObject({ current: true, device: "Chrome on Android" });
  });

  test("never exposes tokens, row ids or IP addresses", async () => {
    const { app } = makeAccountApp();
    const a = await signIn(app, "alice", { ip: "203.0.113.9" });
    const body = JSON.stringify((await list(app, a.cookie)).body);
    expect(body).not.toContain(a.sid);
    expect(body).not.toContain("203.0.113.9");
    expect(body).not.toMatch(/token|ip"|"ip/i);
    for (const session of (await list(app, a.cookie)).body.sessions) {
      expect(Object.keys(session).sort()).toEqual(
        ["browser", "createdAt", "current", "device", "id", "lastSeenAt", "method", "os", "viaPassword"].sort(),
      );
    }
  });

  test("only the caller's own sessions", async () => {
    const { app } = makeAccountApp();
    const alice = await signIn(app, "alice");
    const bob = await signIn(app, "bob", { ua: UA_SAFARI_IPHONE });
    const aliceIds = (await list(app, alice.cookie)).body.sessions.map((s) => s.id);
    const bobIds = (await list(app, bob.cookie)).body.sessions.map((s) => s.id);
    expect(aliceIds).toHaveLength(1);
    expect(bobIds).toHaveLength(1);
    expect(aliceIds[0]).not.toBe(bobIds[0]);
  });

  test("a session created by registration says so", async () => {
    const { app } = makeAccountApp();
    const reg = await request(app).post("/api/register").send({ username: "carol", password: "secret123" });
    const res = await list(app, `sid=${reg.headers["set-cookie"][0].split(";")[0].slice(4)}`);
    expect(res.body.sessions[0]).toMatchObject({ method: "registration", viaPassword: false });
  });
});

describe("DELETE /api/sessions/:id", () => {
  test("signs the other device out: its cookie stops working and its streams are closed", async () => {
    const { app, closedStreams } = makeAccountApp();
    const laptop = await signIn(app, "alice", { ua: UA_FIREFOX_LINUX });
    const phone = await signIn(app, "alice", { ua: UA_CHROME_ANDROID });
    const phoneId = (await list(app, laptop.cookie)).body.sessions.find((s) => !s.current).id;

    expect((await request(app).get("/api/me").set("Cookie", phone.cookie)).status).toBe(200);
    const res = await request(app).delete(`/api/sessions/${phoneId}`).set("Cookie", laptop.cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    // every API call of the revoked browser answers 401 at once
    expect((await request(app).get("/api/me").set("Cookie", phone.cookie)).status).toBe(401);
    expect((await request(app).get("/api/sessions").set("Cookie", phone.cookie)).status).toBe(401);
    // the caller is untouched and the list shrank
    expect((await list(app, laptop.cookie)).body.sessions).toHaveLength(1);
    // its realtime streams were told and closed
    expect(closedStreams).toEqual([
      { sessionIds: [phoneId], payload: { type: "session_revoked", reason: "signed_out" } },
    ]);
  });

  test("another person's session id is a 404, and nothing happens to it", async () => {
    const { app, closedStreams } = makeAccountApp();
    const alice = await signIn(app, "alice");
    const bob = await signIn(app, "bob", { ua: UA_SAFARI_IPHONE });
    const bobId = (await list(app, bob.cookie)).body.sessions[0].id;

    const res = await request(app).delete(`/api/sessions/${bobId}`).set("Cookie", alice.cookie);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Session not found." });
    expect((await request(app).get("/api/me").set("Cookie", bob.cookie)).status).toBe(200);
    expect(closedStreams).toEqual([]);
  });

  test("an unknown or malformed id is the same 404", async () => {
    const { app } = makeAccountApp();
    const alice = await signIn(app, "alice");
    for (const id of ["a0000000-0000-4000-8000-0000000000ff", "1", "not-an-id", "%20"]) {
      const res = await request(app).delete(`/api/sessions/${id}`).set("Cookie", alice.cookie);
      expect(res.status).toBe(404);
    }
  });

  test("needs a session", async () => {
    const { app } = makeAccountApp();
    const res = await request(app).delete("/api/sessions/a0000000-0000-4000-8000-0000000000ff");
    expect(res.status).toBe(401);
  });

  test("deleting the current session is a sign-out of this device", async () => {
    const { app } = makeAccountApp();
    const laptop = await signIn(app, "alice");
    const phone = await signIn(app, "alice", { ua: UA_CHROME_ANDROID });
    const currentId = (await list(app, laptop.cookie)).body.sessions.find((s) => s.current).id;

    const res = await request(app).delete(`/api/sessions/${currentId}`).set("Cookie", laptop.cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, current: true });
    expect(String(res.headers["set-cookie"])).toMatch(/sid=;.*Max-Age=0/);
    expect((await request(app).get("/api/me").set("Cookie", laptop.cookie)).status).toBe(401);
    expect((await request(app).get("/api/me").set("Cookie", phone.cookie)).status).toBe(200);
  });
});

describe("POST /api/sessions/revoke-others", () => {
  test("keeps the current session and ends the rest, closing their streams", async () => {
    const { app, closedStreams } = makeAccountApp();
    const laptop = await signIn(app, "alice", { ua: UA_FIREFOX_LINUX });
    const phone = await signIn(app, "alice", { ua: UA_CHROME_ANDROID });
    const tablet = await signIn(app, "alice", { ua: UA_SAFARI_IPHONE });
    const bob = await signIn(app, "bob");
    const others = (await list(app, laptop.cookie)).body.sessions.filter((s) => !s.current).map((s) => s.id);
    expect(others).toHaveLength(2);

    const res = await request(app).post("/api/sessions/revoke-others").set("Cookie", laptop.cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, revoked: 2 });

    expect((await request(app).get("/api/me").set("Cookie", laptop.cookie)).status).toBe(200);
    expect((await request(app).get("/api/me").set("Cookie", phone.cookie)).status).toBe(401);
    expect((await request(app).get("/api/me").set("Cookie", tablet.cookie)).status).toBe(401);
    // another account is never touched
    expect((await request(app).get("/api/me").set("Cookie", bob.cookie)).status).toBe(200);

    expect(closedStreams).toHaveLength(1);
    expect([...closedStreams[0].sessionIds].sort()).toEqual([...others].sort());
    expect(closedStreams[0].payload).toEqual({ type: "session_revoked", reason: "signed_out" });
  });

  test("with only one session it revokes nothing and closes nothing", async () => {
    const { app, closedStreams } = makeAccountApp();
    const laptop = await signIn(app, "alice");
    const res = await request(app).post("/api/sessions/revoke-others").set("Cookie", laptop.cookie);
    expect(res.body).toEqual({ ok: true, revoked: 0 });
    expect(closedStreams).toEqual([]);
  });

  test("needs a session", async () => {
    const { app } = makeAccountApp();
    expect((await request(app).post("/api/sessions/revoke-others")).status).toBe(401);
  });
});

describe("sessions are created fresh on every sign-in", () => {
  test("the stored record keeps the browser summary and how it was created, not the raw header", async () => {
    const { app, sessionStore } = makeAccountApp();
    await signIn(app, "alice", { ua: UA_FIREFOX_LINUX, ip: "198.51.100.7" });
    const [record] = [...sessionStore.sessions.values()];
    expect(record.userId).toBe(UUID_ALICE);
    expect(record.userAgent).toBe("Firefox on Linux");
    expect(record.authMethod).toBe("password");
    expect(JSON.stringify(record)).not.toContain("Mozilla");
    expect(JSON.stringify(record)).not.toContain("198.51.100.7");
  });
});
