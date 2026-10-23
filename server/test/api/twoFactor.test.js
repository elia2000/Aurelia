import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import request from "supertest";
import { totp } from "../../lib/totp.js";
import {
  PASSWORD,
  UUID_ALICE,
  makeAccountApp,
  sidFrom,
  signIn,
} from "../helpers/accountFixtures.js";

const STEP_MS = 30_000;
// A fixed moment, 5 s into a 30 s step, so the tests do not depend on the wall clock.
const T0 = Math.floor(1_800_000_000_000 / STEP_MS) * STEP_MS + 5_000;

let originalKey;
beforeAll(() => {
  originalKey = process.env.STORAGE_ENCRYPTION_KEY;
  process.env.STORAGE_ENCRYPTION_KEY = "api-test-storage-key";
});
afterAll(() => {
  if (originalKey === undefined) delete process.env.STORAGE_ENCRYPTION_KEY;
  else process.env.STORAGE_ENCRYPTION_KEY = originalKey;
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

const codeAt = (secret, stepOffset = 0) => totp(secret, Date.now() + stepOffset * STEP_MS);
const advanceSteps = (n) => vi.setSystemTime(Date.now() + n * STEP_MS);

const post = (app, url, cookie, body) => {
  const req = request(app).post(url);
  if (cookie) req.set("Cookie", cookie);
  return req.send(body);
};

/** Signs alice in and turns 2FA on. Resolves to the secret, the recovery codes and the session cookie. */
async function enableFor(app, username = "alice") {
  const { cookie } = await signIn(app, username);
  const setup = await post(app, "/api/2fa/setup", cookie, { password: PASSWORD });
  expect(setup.status).toBe(200);
  const enable = await post(app, "/api/2fa/enable", cookie, { code: codeAt(setup.body.secret) });
  expect(enable.status).toBe(200);
  return { secret: setup.body.secret, recoveryCodes: enable.body.recoveryCodes, cookie };
}

/** Password step of a 2FA sign-in. */
async function passwordStep(app, username = "alice", password = PASSWORD) {
  return request(app).post("/api/login").send({ username, password });
}

describe("GET /api/2fa", () => {
  test("needs a session", async () => {
    const { app } = makeAccountApp();
    expect((await request(app).get("/api/2fa")).status).toBe(401);
  });

  test("is off by default", async () => {
    const { app } = makeAccountApp();
    const { cookie } = await signIn(app);
    const res = await request(app).get("/api/2fa").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ available: true, enabled: false, recoveryCodesRemaining: 0 });
  });

  test("reports that the server cannot offer it without a server secret", async () => {
    const { app } = makeAccountApp();
    const { cookie } = await signIn(app);
    delete process.env.STORAGE_ENCRYPTION_KEY;
    try {
      const status = await request(app).get("/api/2fa").set("Cookie", cookie);
      expect(status.body.available).toBe(false);
      const setup = await post(app, "/api/2fa/setup", cookie, { password: PASSWORD });
      expect(setup.status).toBe(503);
    } finally {
      process.env.STORAGE_ENCRYPTION_KEY = "api-test-storage-key";
    }
  });
});

describe("POST /api/2fa/setup", () => {
  test("asks for the password again", async () => {
    const { app, twoFactorStore } = makeAccountApp();
    const { cookie } = await signIn(app);
    expect((await post(app, "/api/2fa/setup", cookie, {})).status).toBe(401);
    const wrong = await post(app, "/api/2fa/setup", cookie, { password: "nope-nope" });
    expect(wrong.status).toBe(401);
    expect(wrong.body).toEqual({ error: "Invalid credentials." });
    expect(twoFactorStore.rows.size).toBe(0);
  });

  test("needs a session", async () => {
    const { app } = makeAccountApp();
    expect((await post(app, "/api/2fa/setup", null, { password: PASSWORD })).status).toBe(401);
  });

  test("hands out a 160-bit secret and the otpauth URI, and stores it encrypted but not active", async () => {
    const { app, twoFactorStore } = makeAccountApp();
    const { cookie } = await signIn(app);
    const res = await post(app, "/api/2fa/setup", cookie, { password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(res.body).toMatchObject({ issuer: "Aurelle", account: "alice", digits: 6, period: 30 });
    const uri = new URL(res.body.otpauthUri);
    expect(uri.protocol).toBe("otpauth:");
    expect(uri.searchParams.get("secret")).toBe(res.body.secret);
    expect(uri.pathname).toContain("alice");

    const row = twoFactorStore.rows.get(UUID_ALICE);
    expect(row.enabled).toBe(false);
    expect(row.secret_enc.startsWith("tfa1:")).toBe(true);
    expect(JSON.stringify([...twoFactorStore.rows.values()])).not.toContain(res.body.secret);

    // set up but not confirmed: signing in still needs only the password
    const login = await passwordStep(app);
    expect(login.body.twoFactorRequired).toBeUndefined();
    expect(sidFrom(login)).not.toBeNull();
  });

  test("starting again replaces the unconfirmed secret", async () => {
    const { app } = makeAccountApp();
    const { cookie } = await signIn(app);
    const a = await post(app, "/api/2fa/setup", cookie, { password: PASSWORD });
    const b = await post(app, "/api/2fa/setup", cookie, { password: PASSWORD });
    expect(a.body.secret).not.toBe(b.body.secret);
    // only the newest secret can confirm
    expect((await post(app, "/api/2fa/enable", cookie, { code: codeAt(a.body.secret) })).status).toBe(400);
    expect((await post(app, "/api/2fa/enable", cookie, { code: codeAt(b.body.secret) })).status).toBe(200);
  });

  test("is refused once 2FA is on (the secret is never shown again)", async () => {
    const { app } = makeAccountApp();
    const { cookie } = await enableFor(app);
    const res = await post(app, "/api/2fa/setup", cookie, { password: PASSWORD });
    expect(res.status).toBe(409);
    expect(res.body.secret).toBeUndefined();
  });
});

describe("POST /api/2fa/enable", () => {
  test("needs the setup first", async () => {
    const { app } = makeAccountApp();
    const { cookie } = await signIn(app);
    const res = await post(app, "/api/2fa/enable", cookie, { code: "123456" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/setup/i);
  });

  test("a wrong code does not turn it on", async () => {
    const { app, twoFactorStore } = makeAccountApp();
    const { cookie } = await signIn(app);
    const setup = await post(app, "/api/2fa/setup", cookie, { password: PASSWORD });
    const wrong = codeAt(setup.body.secret) === "000000" ? "000001" : "000000";
    for (const code of [wrong, "", "12", undefined, 123456]) {
      const res = await post(app, "/api/2fa/enable", cookie, { code });
      expect(res.status).toBe(400);
    }
    expect(twoFactorStore.rows.get(UUID_ALICE).enabled).toBe(false);
  });

  test("one valid code turns it on and shows ten recovery codes once; only hashes are stored", async () => {
    const { app, twoFactorStore } = makeAccountApp();
    const { cookie } = await signIn(app);
    const setup = await post(app, "/api/2fa/setup", cookie, { password: PASSWORD });
    const res = await post(app, "/api/2fa/enable", cookie, { code: codeAt(setup.body.secret) });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.recoveryCodes).toHaveLength(10);
    for (const code of res.body.recoveryCodes) expect(code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);

    const stored = [...twoFactorStore.codes.get(UUID_ALICE).keys()];
    expect(stored).toHaveLength(10);
    for (const hash of stored) expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(res.body.recoveryCodes[0]);

    const status = await request(app).get("/api/2fa").set("Cookie", cookie);
    expect(status.body).toMatchObject({ enabled: true, recoveryCodesRemaining: 10 });
    expect(status.body.recoveryCodes).toBeUndefined();
  });

  test("a second confirmation is refused and does not reroll the codes", async () => {
    const { app } = makeAccountApp();
    const { secret, cookie } = await enableFor(app);
    const again = await post(app, "/api/2fa/enable", cookie, { code: codeAt(secret, 1) });
    expect(again.status).toBe(409);
    expect(again.body.recoveryCodes).toBeUndefined();
  });

  test("wrong codes are limited per account", async () => {
    const { app } = makeAccountApp();
    const { cookie } = await signIn(app);
    const setup = await post(app, "/api/2fa/setup", cookie, { password: PASSWORD });
    const wrong = codeAt(setup.body.secret) === "000000" ? "000001" : "000000";
    let last;
    for (let i = 0; i < 12; i += 1) last = await post(app, "/api/2fa/enable", cookie, { code: wrong });
    expect(last.status).toBe(429);
    expect(last.headers["retry-after"]).toBeDefined();
    // even the right code is refused while limited
    expect((await post(app, "/api/2fa/enable", cookie, { code: codeAt(setup.body.secret) })).status).toBe(429);
  });
});

describe("signing in with 2FA", () => {
  test("the password alone gets a short-lived challenge and no session", async () => {
    const { app, sessionStore } = makeAccountApp();
    await enableFor(app);
    const before = sessionStore.sessions.size;

    const res = await passwordStep(app);
    expect(res.status).toBe(200);
    expect(res.body.twoFactorRequired).toBe(true);
    expect(res.body.challenge).toMatch(/^[\w-]+\.[\w-]+$/);
    expect(res.body.expiresInSeconds).toBeGreaterThan(290);
    expect(res.body.expiresInSeconds).toBeLessThanOrEqual(300);
    expect(sidFrom(res)).toBeNull();
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(res.body.id).toBeUndefined();
    expect(sessionStore.sessions.size).toBe(before);
  });

  test("a wrong password never gets a challenge (same answer as without 2FA)", async () => {
    const { app } = makeAccountApp();
    await enableFor(app);
    const res = await passwordStep(app, "alice", "wrong-password");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Invalid credentials." });
  });

  test("the challenge is useless on any other endpoint", async () => {
    const { app } = makeAccountApp();
    await enableFor(app);
    const { body } = await passwordStep(app);
    for (const url of ["/api/me", "/api/sessions", "/api/2fa"]) {
      const res = await request(app).get(url).set("Cookie", `sid=${body.challenge}`);
      expect(res.status).toBe(401);
    }
    const asBearer = await request(app).get("/api/me").set("Authorization", `Bearer ${body.challenge}`);
    expect(asBearer.status).toBe(401);
  });

  test("password plus a valid code creates the session", async () => {
    const { app, sessionStore } = makeAccountApp();
    const { secret } = await enableFor(app);
    const { body } = await passwordStep(app);
    advanceSteps(1); // the enabling code's step is spent: use the next one
    const res = await post(app, "/api/login/2fa", null, { challenge: body.challenge, code: codeAt(secret) });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: UUID_ALICE, username: "alice" });
    const sid = sidFrom(res);
    expect(sid).not.toBeNull();
    expect(String(res.headers["set-cookie"])).toMatch(/HttpOnly/);
    expect((await request(app).get("/api/me").set("Cookie", `sid=${sid}`)).status).toBe(200);
    const record = [...sessionStore.sessions.values()].find((r) => r.token === sid);
    expect(record.authMethod).toBe("password_2fa");
    expect(res.body.usedRecoveryCode).toBeUndefined();
  });

  test("the code of a step that was already used is refused (replay), even within the window", async () => {
    const { app } = makeAccountApp();
    const { secret } = await enableFor(app);
    advanceSteps(1);
    const first = await passwordStep(app);
    const code = codeAt(secret);
    expect((await post(app, "/api/login/2fa", null, { challenge: first.body.challenge, code })).status).toBe(200);

    const second = await passwordStep(app);
    const replay = await post(app, "/api/login/2fa", null, { challenge: second.body.challenge, code });
    expect(replay.status).toBe(401);
    expect(replay.body.error).toBe("Invalid code.");
    expect(sidFrom(replay)).toBeNull();

    // the previous step's code is inside the +-1 window but older than the last used step
    expect((await post(app, "/api/login/2fa", null, { challenge: second.body.challenge, code: codeAt(secret, -1) })).status).toBe(401);
    // the next step works
    advanceSteps(1);
    expect((await post(app, "/api/login/2fa", null, { challenge: second.body.challenge, code: codeAt(secret) })).status).toBe(200);
  });

  test("accepts a code one step early or late (clock drift)", async () => {
    const { app } = makeAccountApp();
    const { secret } = await enableFor(app);
    const { body } = await passwordStep(app);
    // two steps ahead of the enabling code, one ahead of 'now': still in the window
    const res = await post(app, "/api/login/2fa", null, { challenge: body.challenge, code: codeAt(secret, 1) });
    expect(res.status).toBe(200);
  });

  test("a code from outside the window is refused", async () => {
    const { app } = makeAccountApp();
    const { secret } = await enableFor(app);
    const { body } = await passwordStep(app);
    const res = await post(app, "/api/login/2fa", null, { challenge: body.challenge, code: codeAt(secret, 3) });
    expect(res.status).toBe(401);
  });

  test("a challenge is single use", async () => {
    const { app } = makeAccountApp();
    const { secret } = await enableFor(app);
    const { body } = await passwordStep(app);
    expect((await post(app, "/api/login/2fa", null, { challenge: body.challenge, code: codeAt(secret, 1) })).status).toBe(200);
    advanceSteps(2);
    const again = await post(app, "/api/login/2fa", null, { challenge: body.challenge, code: codeAt(secret) });
    expect(again.status).toBe(401);
    expect(again.body.restart).toBe(true);
  });

  test("a challenge expires after five minutes", async () => {
    const { app } = makeAccountApp();
    const { secret } = await enableFor(app);
    const { body } = await passwordStep(app);
    vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1000);
    const res = await post(app, "/api/login/2fa", null, { challenge: body.challenge, code: codeAt(secret) });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ restart: true });
    expect(sidFrom(res)).toBeNull();
  });

  test("the challenge locks after five wrong codes, even for the right code afterwards", async () => {
    const { app } = makeAccountApp();
    const { secret } = await enableFor(app);
    const { body } = await passwordStep(app);
    const wrong = codeAt(secret, 1) === "000000" ? "000001" : "000000";

    const answers = [];
    for (let i = 0; i < 5; i += 1) {
      answers.push(await post(app, "/api/login/2fa", null, { challenge: body.challenge, code: wrong }));
    }
    expect(answers.slice(0, 4).map((r) => r.status)).toEqual([401, 401, 401, 401]);
    expect(answers.slice(0, 4).map((r) => r.body.attemptsLeft)).toEqual([4, 3, 2, 1]);
    expect(answers[4].status).toBe(429);
    expect(answers[4].body.restart).toBe(true);

    const right = await post(app, "/api/login/2fa", null, { challenge: body.challenge, code: codeAt(secret, 1) });
    expect(right.status).toBe(429);
    expect(sidFrom(right)).toBeNull();

    // a new password step gives a fresh challenge that works
    const fresh = await passwordStep(app);
    expect((await post(app, "/api/login/2fa", null, { challenge: fresh.body.challenge, code: codeAt(secret, 1) })).status).toBe(200);
  });

  test("wrong codes add up across challenges: starting over does not reset the limit", async () => {
    const { app } = makeAccountApp();
    const { secret } = await enableFor(app);
    const wrong = codeAt(secret, 1) === "000000" ? "000001" : "000000";
    let blockedAt = null;
    for (let i = 0; i < 12 && blockedAt === null; i += 1) {
      const step = await passwordStep(app);
      if (step.status === 429) {
        blockedAt = i;
        break;
      }
      const res = await post(app, "/api/login/2fa", null, { challenge: step.body.challenge, code: wrong });
      if (res.status === 429 && !res.body.restart) blockedAt = i;
    }
    // eight wrong codes from one address for one account, however many challenges
    expect(blockedAt).not.toBeNull();
    expect(blockedAt).toBeLessThanOrEqual(9);
    // from then on even the correct password gets nothing
    const next = await passwordStep(app);
    expect(next.status).toBe(429);
    expect(next.headers["retry-after"]).toBeDefined();
    expect(sidFrom(next)).toBeNull();
  });

  test("garbage in the challenge field gets the same generic answer", async () => {
    const { app } = makeAccountApp();
    for (const challenge of [undefined, "", "abc", "a.b", 42, { x: 1 }, "x".repeat(5000)]) {
      const res = await post(app, "/api/login/2fa", null, { challenge, code: "123456" });
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/expired/i);
      expect(sidFrom(res)).toBeNull();
    }
  });

  test("a missing or malformed code counts as a wrong code", async () => {
    const { app } = makeAccountApp();
    await enableFor(app);
    for (const code of [undefined, "", "abcdef", 123456, ["123456"]]) {
      const { body } = await passwordStep(app);
      const res = await post(app, "/api/login/2fa", null, { challenge: body.challenge, code });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Invalid code.");
    }
  });

  test("an account banned between the two steps does not get a session", async () => {
    const { app, userStore } = makeAccountApp();
    const { secret } = await enableFor(app);
    const { body } = await passwordStep(app);
    userStore.users.get("alice").banned = true;
    const res = await post(app, "/api/login/2fa", null, { challenge: body.challenge, code: codeAt(secret, 1) });
    expect(res.status).toBe(401);
    expect(sidFrom(res)).toBeNull();
  });

  test("a challenge works only for the account it was issued for", async () => {
    const { app } = makeAccountApp();
    await enableFor(app, "alice");
    const bobSetup = await enableFor(app, "bob");
    const { body } = await passwordStep(app, "alice");
    // bob's valid code does not open alice's challenge
    const res = await post(app, "/api/login/2fa", null, { challenge: body.challenge, code: codeAt(bobSetup.secret, 1) });
    expect(res.status).toBe(401);
  });

  test("a stale session cookie sent with the second step is retired, the new session gets a new id", async () => {
    const { app, sessionStore } = makeAccountApp();
    const { secret } = await enableFor(app);
    const stale = await signIn(app, "bob");
    const { body } = await passwordStep(app);
    const res = await request(app)
      .post("/api/login/2fa")
      .set("Cookie", stale.cookie)
      .send({ challenge: body.challenge, code: codeAt(secret, 1) });
    expect(res.status).toBe(200);
    expect(sidFrom(res)).not.toBe(stale.sid);
    expect(sessionStore.sessions.has(stale.sid)).toBe(false);
  });
});

describe("recovery codes", () => {
  test("a recovery code signs in once and then never again", async () => {
    const { app, sessionStore } = makeAccountApp();
    const { recoveryCodes } = await enableFor(app);
    const code = recoveryCodes[0];

    const first = await passwordStep(app);
    const ok = await post(app, "/api/login/2fa", null, { challenge: first.body.challenge, recoveryCode: code });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ usedRecoveryCode: true, recoveryCodesRemaining: 9 });
    expect([...sessionStore.sessions.values()].find((r) => r.token === sidFrom(ok)).authMethod).toBe("recovery_code");

    const second = await passwordStep(app);
    const reuse = await post(app, "/api/login/2fa", null, { challenge: second.body.challenge, recoveryCode: code });
    expect(reuse.status).toBe(401);
    expect(reuse.body.error).toBe("Invalid code.");
    // another code from the sheet still works on the same challenge
    const other = await post(app, "/api/login/2fa", null, { challenge: second.body.challenge, recoveryCode: recoveryCodes[1] });
    expect(other.status).toBe(200);
  });

  test("is forgiving about case, dashes and spaces", async () => {
    const { app } = makeAccountApp();
    const { recoveryCodes } = await enableFor(app);
    const { body } = await passwordStep(app);
    const typed = recoveryCodes[3].toLowerCase().replace("-", " ");
    const res = await post(app, "/api/login/2fa", null, { challenge: body.challenge, recoveryCode: typed });
    expect(res.status).toBe(200);
  });

  test("a wrong recovery code counts toward the challenge lock", async () => {
    const { app } = makeAccountApp();
    await enableFor(app);
    const { body } = await passwordStep(app);
    let last;
    for (let i = 0; i < 5; i += 1) {
      last = await post(app, "/api/login/2fa", null, { challenge: body.challenge, recoveryCode: "AAAAA-AAAAA" });
    }
    expect(last.status).toBe(429);
  });

  test("regenerating needs the password and a code, kills the old codes and shows ten new ones", async () => {
    const { app, twoFactorStore } = makeAccountApp();
    const { secret, recoveryCodes, cookie } = await enableFor(app);

    expect((await post(app, "/api/2fa/recovery-codes", cookie, {})).status).toBe(401);
    const noCode = await post(app, "/api/2fa/recovery-codes", cookie, { password: PASSWORD });
    expect(noCode.status).toBe(401);
    expect(noCode.body.twoFactorRequired).toBe(true);
    expect([...twoFactorStore.codes.get(UUID_ALICE).values()].every((used) => used === null)).toBe(true);

    advanceSteps(1);
    const res = await post(app, "/api/2fa/recovery-codes", cookie, { password: PASSWORD, code: codeAt(secret) });
    expect(res.status).toBe(200);
    expect(res.body.recoveryCodes).toHaveLength(10);
    expect(res.body.recoveryCodes.some((c) => recoveryCodes.includes(c))).toBe(false);

    const { body } = await passwordStep(app);
    const old = await post(app, "/api/login/2fa", null, { challenge: body.challenge, recoveryCode: recoveryCodes[0] });
    expect(old.status).toBe(401);
    const fresh = await post(app, "/api/login/2fa", null, { challenge: body.challenge, recoveryCode: res.body.recoveryCodes[0] });
    expect(fresh.status).toBe(200);
  });

  test("can be refused while 2FA is off", async () => {
    const { app } = makeAccountApp();
    const { cookie } = await signIn(app);
    const res = await post(app, "/api/2fa/recovery-codes", cookie, { password: PASSWORD });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/2fa/disable", () => {
  test("needs the password and a code", async () => {
    const { app, twoFactorStore } = makeAccountApp();
    const { secret, cookie } = await enableFor(app);

    expect((await post(app, "/api/2fa/disable", cookie, {})).status).toBe(401);
    const wrongPassword = await post(app, "/api/2fa/disable", cookie, { password: "nope-nope", code: codeAt(secret, 1) });
    expect(wrongPassword.status).toBe(401);
    const noCode = await post(app, "/api/2fa/disable", cookie, { password: PASSWORD });
    expect(noCode.status).toBe(401);
    expect(noCode.body.twoFactorRequired).toBe(true);
    const wrongCode = await post(app, "/api/2fa/disable", cookie, { password: PASSWORD, code: "000000" });
    expect(wrongCode.status).toBe(401);
    expect(twoFactorStore.rows.get(UUID_ALICE).enabled).toBe(true);
  });

  test("turns it off and forgets the secret and the recovery codes", async () => {
    const { app, twoFactorStore } = makeAccountApp();
    const { secret, cookie } = await enableFor(app);
    const res = await post(app, "/api/2fa/disable", cookie, { password: PASSWORD, code: codeAt(secret, 1) });
    expect(res.status).toBe(200);
    expect(twoFactorStore.rows.has(UUID_ALICE)).toBe(false);
    expect(twoFactorStore.codes.has(UUID_ALICE)).toBe(false);

    const login = await passwordStep(app);
    expect(login.body.twoFactorRequired).toBeUndefined();
    expect(sidFrom(login)).not.toBeNull();
  });

  test("a recovery code can disable it (lost authenticator)", async () => {
    const { app } = makeAccountApp();
    const { recoveryCodes, cookie } = await enableFor(app);
    const res = await post(app, "/api/2fa/disable", cookie, { password: PASSWORD, recoveryCode: recoveryCodes[0] });
    expect(res.status).toBe(200);
  });

  test("can drop an unconfirmed setup with just the password", async () => {
    const { app, twoFactorStore } = makeAccountApp();
    const { cookie } = await signIn(app);
    await post(app, "/api/2fa/setup", cookie, { password: PASSWORD });
    const res = await post(app, "/api/2fa/disable", cookie, { password: PASSWORD });
    expect(res.status).toBe(200);
    expect(twoFactorStore.rows.size).toBe(0);
  });

  test("is refused when there is nothing to turn off", async () => {
    const { app } = makeAccountApp();
    const { cookie } = await signIn(app);
    expect((await post(app, "/api/2fa/disable", cookie, { password: PASSWORD })).status).toBe(400);
  });

  test("a stolen session alone cannot turn 2FA off: wrong passwords are limited", async () => {
    const { app } = makeAccountApp();
    const { cookie } = await enableFor(app);
    let last;
    for (let i = 0; i < 10; i += 1) last = await post(app, "/api/2fa/disable", cookie, { password: `guess-${i}-xx`, code: "000000" });
    expect(last.status).toBe(429);
  });
});

describe("re-authentication on the other sensitive routes", () => {
  test("changing the password asks for a code once 2FA is on", async () => {
    const { app, userStore } = makeAccountApp();
    const { secret, cookie } = await enableFor(app);
    const body = { username: "alice", currentPassword: PASSWORD, newPassword: "brand-new-pass" };

    const missing = await request(app).put("/api/password").set("Cookie", cookie).send(body);
    expect(missing.status).toBe(401);
    expect(missing.body).toMatchObject({ twoFactorRequired: true });

    const wrong = await request(app).put("/api/password").set("Cookie", cookie).send({ ...body, code: "000000" });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toBe("Invalid code.");

    const hashBefore = userStore.users.get("alice").password_hash;
    advanceSteps(1);
    const ok = await request(app).put("/api/password").set("Cookie", cookie).send({ ...body, code: codeAt(secret) });
    expect(ok.status).toBe(200);
    expect(hashBefore).toBeDefined();
  });

  test("deleting the account asks for a code once 2FA is on", async () => {
    const { app } = makeAccountApp();
    const { secret, cookie } = await enableFor(app);
    const missing = await request(app).post("/api/profile/delete").set("Cookie", cookie).send({ username: "alice", password: PASSWORD });
    expect(missing.status).toBe(401);
    expect(missing.body).toMatchObject({ twoFactorRequired: true });
    advanceSteps(1);
    const ok = await request(app)
      .post("/api/profile/delete")
      .set("Cookie", cookie)
      .send({ username: "alice", password: PASSWORD, code: codeAt(secret) });
    expect(ok.status).toBe(200);
  });

  test("without 2FA nothing changes: the password is enough", async () => {
    const { app } = makeAccountApp();
    const { cookie } = await signIn(app);
    const res = await request(app)
      .put("/api/password")
      .set("Cookie", cookie)
      .send({ username: "alice", currentPassword: PASSWORD, newPassword: "brand-new-pass" });
    expect(res.status).toBe(200);
  });
});
