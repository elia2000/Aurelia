import { afterAll, describe, expect, test, vi } from "vitest";
import crypto from "node:crypto";

// A database of its own (see callMessages.test.js). Runs before any import.
vi.hoisted(() => {
  const fs = process.getBuiltinModule("node:fs");
  const os = process.getBuiltinModule("node:os");
  const path = process.getBuiltinModule("node:path");
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sessions-2fa-"));
});

const { dbKnex } = await import("../../db/knex.js");
const db = await import("../../db.js");
const {
  adminListUsers,
  beginTwoFactorEnrollment,
  consumeRecoveryCode,
  countUnusedRecoveryCodes,
  createE2eeDevice,
  createSession,
  createUser,
  deleteSession,
  deleteUserById,
  disableTwoFactor,
  enableTwoFactor,
  findE2eeDevice,
  getAll,
  getRow,
  getSession,
  getUserTwoFactor,
  listPushSubscriptionsByUserIds,
  listUserSessions,
  markTotpStepUsed,
  purgeExpiredSessions,
  listExpiredSessionIds,
  replaceRecoveryCodes,
  revokeAllUserSessions,
  revokeOtherUserSessions,
  revokeUserSession,
  run,
  touchE2eeDevice,
  upsertPushSubscription,
} = db;

afterAll(() => {
  try {
    process.getBuiltinModule("node:fs").rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

const unique = () => crypto.randomBytes(5).toString("hex");
const newUser = async () => createUser(`s2_${unique()}`, "hash", "Nick", null, "#10b981");
const token = () => crypto.randomBytes(24).toString("hex");

async function newSession(userId, meta = { userAgent: "Firefox on Linux", authMethod: "password" }) {
  const t = token();
  await createSession(userId, t, meta);
  const session = await getSession(t);
  return { token: t, publicId: session.session_public_id };
}

describe("migration 050/051 schema", () => {
  test("sessions got the metadata columns and a unique public id", async () => {
    const cols = (await getAll("PRAGMA table_info(sessions)")).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["public_id", "user_agent", "auth_method", "created_at", "last_seen"]));
    expect(cols).toContain("last_seen");
    const indexes = (await getAll("PRAGMA index_list(sessions)")).map((i) => i.name);
    expect(indexes).toContain("idx_sessions_public_id");
  });

  test("push subscriptions and E2EE devices can name the session behind them", async () => {
    for (const table of ["push_subscriptions", "e2ee_devices"]) {
      const cols = (await getAll(`PRAGMA table_info(${table})`)).map((c) => c.name);
      expect(cols).toContain("session_public_id");
    }
  });

  test("the two-factor tables exist with the expected columns", async () => {
    const tf = (await getAll("PRAGMA table_info(user_two_factor)")).map((c) => c.name).sort();
    expect(tf).toEqual(["created_at", "enabled", "enabled_at", "last_used_step", "secret_enc", "user_id"]);
    const rc = (await getAll("PRAGMA table_info(user_recovery_codes)")).map((c) => c.name).sort();
    expect(rc).toEqual(["code_hash", "created_at", "used_at", "user_id"]);
  });
});

describe("createSession / getSession / listUserSessions", () => {
  test("stores the summary and method, hands out a public id, and getSession reports it", async () => {
    const userId = await newUser();
    const { token: t, publicId } = await newSession(userId, { userAgent: "Chrome on Android", authMethod: "password_2fa" });
    expect(publicId).toMatch(/^[0-9a-f-]{36}$/);
    const session = await getSession(t);
    expect(session).toMatchObject({ id: userId, session_public_id: publicId });
    expect(session.session_created_at).toBeTruthy();

    const [row] = await listUserSessions(userId);
    expect(row).toMatchObject({ public_id: publicId, user_agent: "Chrome on Android", auth_method: "password_2fa" });
    expect(row.created_at).toBeTruthy();
    expect(row.last_seen).toBeTruthy();
    expect(Object.keys(row)).not.toContain("token");
  });

  test("the user agent is clipped and missing metadata is stored as null", async () => {
    const userId = await newUser();
    const t = token();
    await createSession(userId, t, { userAgent: "x".repeat(500) });
    const t2 = token();
    await createSession(userId, t2);
    const rows = await listUserSessions(userId);
    expect(rows.map((r) => (r.user_agent || "").length).sort((a, b) => a - b)).toEqual([0, 120]);
    expect(rows.some((r) => r.auth_method === null)).toBe(true);
  });

  test("lists only the person's own sessions", async () => {
    const a = await newUser();
    const b = await newUser();
    await newSession(a);
    await newSession(b);
    await newSession(b);
    expect(await listUserSessions(a)).toHaveLength(1);
    expect(await listUserSessions(b)).toHaveLength(2);
    expect(await listUserSessions(null)).toEqual([]);
  });
});

describe("revoking sessions", () => {
  test("revokeUserSession removes only the named session of the owner", async () => {
    const owner = await newUser();
    const stranger = await newUser();
    const mine = await newSession(owner);
    const keep = await newSession(owner);
    const theirs = await newSession(stranger);

    // not theirs: nothing happens
    expect(await revokeUserSession(owner, theirs.publicId)).toBeNull();
    expect(await getSession(theirs.token)).not.toBeNull();
    expect(await revokeUserSession(owner, "no-such-id")).toBeNull();

    const done = await revokeUserSession(owner, mine.publicId);
    expect(done).toEqual({ publicId: mine.publicId, token: mine.token });
    expect(await getSession(mine.token)).toBeNull();
    expect(await getSession(keep.token)).not.toBeNull();
  });

  test("revokeOtherUserSessions keeps the named one and nobody else's", async () => {
    const owner = await newUser();
    const stranger = await newUser();
    const here = await newSession(owner);
    const a = await newSession(owner);
    const b = await newSession(owner);
    const other = await newSession(stranger);

    const revoked = await revokeOtherUserSessions(owner, here.publicId);
    expect(revoked.map((r) => r.publicId).sort()).toEqual([a.publicId, b.publicId].sort());
    expect(await getSession(here.token)).not.toBeNull();
    expect(await getSession(a.token)).toBeNull();
    expect(await getSession(other.token)).not.toBeNull();
    expect(await revokeOtherUserSessions(owner, here.publicId)).toEqual([]);
  });

  test("revokeAllUserSessions ends everything and drops the person's push subscriptions", async () => {
    const owner = await newUser();
    const s1 = await newSession(owner);
    await newSession(owner);
    await upsertPushSubscription(owner, `https://push.example/${unique()}`, "p", "a", 1, s1.publicId);
    await upsertPushSubscription(owner, `https://push.example/${unique()}`, "p", "a", 1, null);
    const revoked = await revokeAllUserSessions(owner);
    expect(revoked).toHaveLength(2);
    expect(await listUserSessions(owner)).toEqual([]);
    expect(await listPushSubscriptionsByUserIds([owner])).toEqual([]);
  });

  test("revoking a session removes the push subscriptions it registered and retires its E2EE device", async () => {
    const owner = await newUser();
    const laptop = await newSession(owner);
    const phone = await newSession(owner);
    const laptopEndpoint = `https://push.example/${unique()}`;
    const phoneEndpoint = `https://push.example/${unique()}`;
    await upsertPushSubscription(owner, laptopEndpoint, "p", "a", 1, laptop.publicId);
    await upsertPushSubscription(owner, phoneEndpoint, "p", "a", 1, phone.publicId);
    const laptopDevice = await createE2eeDevice({ userId: owner, label: "l", ecdhPublic: "x", ecdsaPublic: "y", sessionPublicId: laptop.publicId });
    const phoneDevice = await createE2eeDevice({ userId: owner, label: "p", ecdhPublic: "x", ecdsaPublic: "y", sessionPublicId: phone.publicId });

    await revokeUserSession(owner, phone.publicId);

    const endpoints = (await listPushSubscriptionsByUserIds([owner])).map((s) => s.endpoint);
    expect(endpoints).toEqual([laptopEndpoint]);
    expect((await findE2eeDevice(owner, phoneDevice.id)).revoked_at).toBeTruthy();
    expect((await findE2eeDevice(owner, laptopDevice.id)).revoked_at).toBeFalsy();
  });

  test("touching a device re-links it to the session that confirms it", async () => {
    const owner = await newUser();
    const first = await newSession(owner);
    const second = await newSession(owner);
    const device = await createE2eeDevice({ userId: owner, label: "l", ecdhPublic: "x", ecdsaPublic: "y", sessionPublicId: first.publicId });
    await touchE2eeDevice(owner, device.id, second.publicId);
    await revokeUserSession(owner, first.publicId);
    expect((await findE2eeDevice(owner, device.id)).revoked_at).toBeFalsy();
    await revokeUserSession(owner, second.publicId);
    expect((await findE2eeDevice(owner, device.id)).revoked_at).toBeTruthy();
  });

  test("a normal sign-out drops that session's push subscriptions but keeps the device key", async () => {
    const owner = await newUser();
    const s = await newSession(owner);
    const endpoint = `https://push.example/${unique()}`;
    await upsertPushSubscription(owner, endpoint, "p", "a", 1, s.publicId);
    const device = await createE2eeDevice({ userId: owner, label: "l", ecdhPublic: "x", ecdsaPublic: "y", sessionPublicId: s.publicId });
    await deleteSession(s.token);
    expect(await getSession(s.token)).toBeNull();
    expect(await listPushSubscriptionsByUserIds([owner])).toEqual([]);
    expect((await findE2eeDevice(owner, device.id)).revoked_at).toBeFalsy();
    // signing out an unknown token is harmless
    expect(() => deleteSession("nope")).not.toThrow();
  });

  test("purgeExpiredSessions removes only sessions older than the cutoff", async () => {
    const owner = await newUser();
    const old = await newSession(owner);
    const fresh = await newSession(owner);
    await run("UPDATE sessions SET created_at = ? WHERE token = ?", ["2000-01-01 00:00:00", old.token]);
    const removed = await purgeExpiredSessions("2020-01-01 00:00:00");
    expect(Number(removed)).toBeGreaterThanOrEqual(1);
    expect(await getSession(old.token)).toBeNull();
    expect(await getSession(fresh.token)).not.toBeNull();
  });
});

describe("expired sessions leave nothing behind", () => {
  test("purgeExpiredSessions also removes the push subscriptions the expired session registered", async () => {
    const owner = await newUser();
    const old = await newSession(owner);
    const fresh = await newSession(owner);
    const oldEndpoint = `https://push.example/${unique()}`;
    const freshEndpoint = `https://push.example/${unique()}`;
    await upsertPushSubscription(owner, oldEndpoint, "p", "a", 1, old.publicId);
    await upsertPushSubscription(owner, freshEndpoint, "p", "a", 1, fresh.publicId);
    await run("UPDATE sessions SET created_at = ? WHERE token = ?", ["2000-01-01 00:00:00", old.token]);
    await purgeExpiredSessions("2020-01-01 00:00:00");
    const left = (await listPushSubscriptionsByUserIds([owner])).map((row) => row.endpoint);
    expect(left).toEqual([freshEndpoint]);
  });

  test("listExpiredSessionIds names the sessions older than the cutoff and nothing else", async () => {
    const owner = await newUser();
    const old = await newSession(owner);
    const fresh = await newSession(owner);
    await run("UPDATE sessions SET created_at = ? WHERE token = ?", ["2000-01-01 00:00:00", old.token]);
    const ids = await listExpiredSessionIds("2020-01-01 00:00:00");
    expect(ids).toContain(old.publicId);
    expect(ids).not.toContain(fresh.publicId);
    expect(await listExpiredSessionIds("")).toEqual([]);
  });
});

describe("two-factor storage", () => {
  test("enrolment is pending until confirmed, and a pending secret can be replaced", async () => {
    const userId = await newUser();
    expect(await getUserTwoFactor(userId)).toBeNull();
    await beginTwoFactorEnrollment(userId, "tfa1:first");
    expect(await getUserTwoFactor(userId)).toMatchObject({ secret_enc: "tfa1:first", enabled: false, last_used_step: null });
    await beginTwoFactorEnrollment(userId, "tfa1:second");
    expect((await getUserTwoFactor(userId)).secret_enc).toBe("tfa1:second");
  });

  test("enabling stores the recovery codes and the confirming step; the secret of an enabled account can not be replaced", async () => {
    const userId = await newUser();
    await beginTwoFactorEnrollment(userId, "tfa1:secret");
    expect(await enableTwoFactor(userId, 1234, ["h1", "h2", "h3"])).toBe(true);
    expect(await getUserTwoFactor(userId)).toMatchObject({ enabled: true, last_used_step: 1234 });
    expect(await countUnusedRecoveryCodes(userId)).toBe(3);
    // enabling twice does nothing; replacing the secret is refused while enabled
    expect(await enableTwoFactor(userId, 9999, ["z"])).toBe(false);
    // ...and the call that lost the race leaves the recovery codes the person was shown alone
    expect(await countUnusedRecoveryCodes(userId)).toBe(3);
    expect(await consumeRecoveryCode(userId, "h1")).toBe(true);
    await beginTwoFactorEnrollment(userId, "tfa1:attacker");
    expect((await getUserTwoFactor(userId)).secret_enc).toBe("tfa1:secret");
  });

  test("a time step can be claimed once, and only moving forward", async () => {
    const userId = await newUser();
    await beginTwoFactorEnrollment(userId, "tfa1:s");
    await enableTwoFactor(userId, 100, ["h"]);
    expect(await markTotpStepUsed(userId, 100)).toBe(false);
    expect(await markTotpStepUsed(userId, 99)).toBe(false);
    expect(await markTotpStepUsed(userId, 101)).toBe(true);
    expect(await markTotpStepUsed(userId, 101)).toBe(false);
    expect((await getUserTwoFactor(userId)).last_used_step).toBe(101);
  });

  test("a step claimed twice at the same moment is granted to one caller only", async () => {
    const userId = await newUser();
    await beginTwoFactorEnrollment(userId, "tfa1:s");
    await enableTwoFactor(userId, 1, ["h"]);
    const results = await Promise.all([markTotpStepUsed(userId, 50), markTotpStepUsed(userId, 50), markTotpStepUsed(userId, 50)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  test("a recovery code is spent exactly once and only by its owner", async () => {
    const owner = await newUser();
    const other = await newUser();
    await beginTwoFactorEnrollment(owner, "tfa1:s");
    await enableTwoFactor(owner, 1, ["hash-a", "hash-b"]);
    expect(await consumeRecoveryCode(other, "hash-a")).toBe(false);
    expect(await consumeRecoveryCode(owner, "hash-a")).toBe(true);
    expect(await consumeRecoveryCode(owner, "hash-a")).toBe(false);
    expect(await consumeRecoveryCode(owner, "hash-unknown")).toBe(false);
    expect(await countUnusedRecoveryCodes(owner)).toBe(1);
    const concurrent = await Promise.all([consumeRecoveryCode(owner, "hash-b"), consumeRecoveryCode(owner, "hash-b")]);
    expect(concurrent.filter(Boolean)).toHaveLength(1);
  });

  test("replacing the recovery codes kills the old ones", async () => {
    const userId = await newUser();
    await beginTwoFactorEnrollment(userId, "tfa1:s");
    await enableTwoFactor(userId, 1, ["old-1", "old-2"]);
    await replaceRecoveryCodes(userId, ["new-1"]);
    expect(await consumeRecoveryCode(userId, "old-1")).toBe(false);
    expect(await consumeRecoveryCode(userId, "new-1")).toBe(true);
  });

  test("disabling forgets the secret and every code", async () => {
    const userId = await newUser();
    await beginTwoFactorEnrollment(userId, "tfa1:s");
    await enableTwoFactor(userId, 1, ["h"]);
    expect(await disableTwoFactor(userId)).toBe(true);
    expect(await getUserTwoFactor(userId)).toBeNull();
    expect(await countUnusedRecoveryCodes(userId)).toBe(0);
    expect(await disableTwoFactor(userId)).toBe(false);
  });

  test("deleting the account deletes its secret and codes", async () => {
    const userId = await newUser();
    await beginTwoFactorEnrollment(userId, "tfa1:s");
    await enableTwoFactor(userId, 1, ["h"]);
    await newSession(userId);
    await deleteUserById(userId);
    expect(await getRow("SELECT 1 AS n FROM user_two_factor WHERE user_id = ?", [userId])).toBeNull();
    expect(await getRow("SELECT 1 AS n FROM user_recovery_codes WHERE user_id = ?", [userId])).toBeNull();
    expect(await listUserSessions(userId)).toEqual([]);
  });

  test("the admin user list shows who has 2FA on (not a pending setup)", async () => {
    const withTwoFactor = await newUser();
    const pending = await newUser();
    const without = await newUser();
    await beginTwoFactorEnrollment(withTwoFactor, "tfa1:s");
    await enableTwoFactor(withTwoFactor, 1, ["h"]);
    await beginTwoFactorEnrollment(pending, "tfa1:s");
    const { users } = await adminListUsers({ limit: 500 });
    const flag = (id) => Number(users.find((u) => u.id === id)?.two_factor);
    expect(flag(withTwoFactor)).toBe(1);
    expect(flag(pending)).toBe(0);
    expect(flag(without)).toBe(0);
  });
});

describe("migrations are safe to run again on every start", () => {
  test("050 and 051 re-run without error and keep the data; sessions without a public id get one", async () => {
    const { migrations } = await import("../../migrations/index.js");
    const m050 = migrations.find((m) => m.version === 50);
    const m051 = migrations.find((m) => m.version === 51);
    expect(m050 && m051).toBeTruthy();
    const userId = await newUser();
    // a session as it looked before migration 050
    await run("INSERT INTO sessions (user_id, token, public_id) VALUES (?, ?, NULL)", [userId, token()]);
    const ctx = {
      db: { run: (sql, params) => run(sql, params) },
      getAll: (sql, params) => getAll(sql, params),
      tableExists: (name) => Boolean(getRow("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [name])),
      hasColumn: (table, col) => getAll(`PRAGMA table_info('${table}')`).some((c) => c.name === col),
    };
    await m050.up(ctx);
    await m050.up(ctx);
    await m051.up(ctx);
    await m051.up(ctx);
    const rows = await listUserSessions(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].public_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(rows[0].user_agent).toBeNull();
    expect(Math.max(...migrations.map((m) => m.version))).toBeGreaterThanOrEqual(51);
    expect(new Set(migrations.map((m) => m.version)).size).toBe(migrations.length);
  });
});

void dbKnex;
