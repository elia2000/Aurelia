import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { dbKnex } from "../../db/knex.js";
import {
  beginTwoFactorEnrollment,
  consumeRecoveryCode,
  countUnusedRecoveryCodes,
  createSession,
  deleteSession,
  disableTwoFactor,
  enableTwoFactor,
  getSession,
  getUserTwoFactor,
  listUserSessions,
  markTotpStepUsed,
  purgeExpiredSessions,
  removeSessionLinks,
  replaceRecoveryCodes,
  revokeAllUserSessions,
  revokeOtherUserSessions,
  revokeUserSession,
  upsertPushSubscription,
} from "../../db.js";

// The same functions under the Postgres driver: they must return promises and
// read Postgres result shapes (rows / rowCount, BIGINTs as strings).

const USER = "a0000000-0000-4000-8000-000000000001";

describe("sessions and two-factor under both drivers", () => {
  let originalDbClient;
  let statements;

  const mockRaw = (responder) => {
    statements = [];
    vi.spyOn(dbKnex, "raw").mockImplementation(async (sql, params) => {
      // knex.raw is also used for small expressions inside builders; only whole statements are recorded.
      if (/^\s*(select|insert|update|delete)\b/i.test(String(sql))) {
        statements.push({ sql: String(sql), params });
      }
      return responder(String(sql).toLowerCase(), params);
    });
  };

  beforeEach(() => {
    originalDbClient = process.env.DB_CLIENT;
    process.env.DB_CLIENT = "postgres";
  });
  afterEach(() => {
    if (originalDbClient !== undefined) process.env.DB_CLIENT = originalDbClient;
    else delete process.env.DB_CLIENT;
    vi.restoreAllMocks();
  });

  test("createSession writes the public id, summary and method", async () => {
    mockRaw(() => ({ rows: [], rowCount: 1 }));
    await createSession(USER, "tok", { userAgent: "Firefox on Linux", authMethod: "password" });
    const insert = statements.find((s) => /insert into [`"]?sessions[`"]?/i.test(s.sql));
    expect(insert).toBeTruthy();
    expect(insert.sql).toMatch(/public_id/);
    expect(insert.params).toEqual(expect.arrayContaining([USER, "tok", "Firefox on Linux", "password"]));
    expect(insert.params.some((p) => /^[0-9a-f-]{36}$/.test(String(p)))).toBe(true);
  });

  test("getSession selects the public id and creation time", async () => {
    mockRaw(() => ({ rows: [{ id: USER, session_public_id: "p1", session_created_at: "2026-01-01 00:00:00+00" }] }));
    const session = await getSession("tok");
    expect(session).toMatchObject({ session_public_id: "p1" });
    expect(statements[0].sql).toMatch(/public_id. as .session_public_id/is);
  });

  test("listUserSessions never selects the token", async () => {
    mockRaw(() => ({ rows: [{ public_id: "p1" }] }));
    expect(await listUserSessions(USER)).toEqual([{ public_id: "p1" }]);
    expect(statements[0].sql).not.toMatch(/token/i);
  });

  test("revokeUserSession deletes the owner's row by public id and cleans up what the session registered", async () => {
    mockRaw((sql) => {
      if (sql.startsWith("select")) return { rows: [{ public_id: "p1", token: "tok" }] };
      return { rows: [], rowCount: 1 };
    });
    const result = await revokeUserSession(USER, "p1");
    expect(result).toEqual({ publicId: "p1", token: "tok" });
    const sqls = statements.map((s) => s.sql.toLowerCase());
    expect(sqls.some((s) => s.startsWith("delete from") && s.includes("sessions"))).toBe(true);
    expect(sqls.some((s) => s.startsWith("delete from") && s.includes("push_subscriptions"))).toBe(true);
    expect(sqls.some((s) => s.startsWith("update") && s.includes("e2ee_devices"))).toBe(true);
    const select = statements.find((s) => s.sql.toLowerCase().startsWith("select"));
    expect(select.params).toEqual(expect.arrayContaining([USER, "p1"]));
  });

  test("revoking a session that is not the user's finds nothing and deletes nothing", async () => {
    mockRaw(() => ({ rows: [] }));
    expect(await revokeUserSession(USER, "someone-elses")).toBeNull();
    expect(statements.every((s) => s.sql.toLowerCase().startsWith("select"))).toBe(true);
  });

  test("revokeOtherUserSessions excludes the kept session and revokeAll takes everything", async () => {
    mockRaw((sql) => (sql.startsWith("select") ? { rows: [{ public_id: "p2", token: "t2" }] } : { rows: [], rowCount: 1 }));
    expect(await revokeOtherUserSessions(USER, "p1")).toEqual([{ publicId: "p2", token: "t2" }]);
    expect(statements[0].sql).toMatch(/not .public_id. = \?/is);
    expect(await revokeAllUserSessions(USER)).toEqual([{ publicId: "p2", token: "t2" }]);
    expect(statements.some((s) => /delete from [`"]?push_subscriptions[`"]?/i.test(s.sql) && s.params.includes(USER))).toBe(true);
  });

  test("deleteSession and purgeExpiredSessions return promises", async () => {
    mockRaw((sql) => (sql.startsWith("select") ? { rows: [{ public_id: "p1" }] } : { rows: [], rowCount: 2 }));
    await expect(deleteSession("tok")).resolves.toBeDefined();
    await expect(purgeExpiredSessions("2020-01-01 00:00:00")).resolves.toBe(2);
    await expect(removeSessionLinks(["p1"], { revokeDevices: true })).resolves.toBeDefined();
  });

  test("push subscriptions remember the session", async () => {
    mockRaw(() => ({ rows: [], rowCount: 1 }));
    await upsertPushSubscription(USER, "https://push.example/1", "p", "a", 1, "p1");
    expect(statements[0].sql).toMatch(/session_public_id/);
    expect(statements[0].params).toContain("p1");
  });

  test("getUserTwoFactor reads BIGINT strings", async () => {
    mockRaw(() => ({ rows: [{ user_id: USER, secret_enc: "tfa1:x", enabled: "1", last_used_step: "59000000" }] }));
    expect(await getUserTwoFactor(USER)).toMatchObject({ enabled: true, last_used_step: 59000000 });
    mockRaw(() => ({ rows: [{ user_id: USER, secret_enc: "tfa1:x", enabled: "0", last_used_step: null }] }));
    expect(await getUserTwoFactor(USER)).toMatchObject({ enabled: false, last_used_step: null });
    mockRaw(() => ({ rows: [] }));
    expect(await getUserTwoFactor(USER)).toBeNull();
  });

  test("enrolment only replaces a secret that is not yet enabled", async () => {
    mockRaw(() => ({ rows: [], rowCount: 1 }));
    await beginTwoFactorEnrollment(USER, "tfa1:x");
    expect(statements[0].sql).toMatch(/on conflict/i);
    expect(statements[0].sql).toMatch(/where.*enabled = 0/is);
  });

  test("the atomic claims turn rowCount into booleans", async () => {
    mockRaw(() => ({ rows: [], rowCount: 1 }));
    expect(await markTotpStepUsed(USER, 5)).toBe(true);
    expect(await consumeRecoveryCode(USER, "h")).toBe(true);
    mockRaw(() => ({ rows: [], rowCount: 0 }));
    expect(await markTotpStepUsed(USER, 5)).toBe(false);
    expect(await consumeRecoveryCode(USER, "h")).toBe(false);
  });

  test("enable, replace, count and disable work with Postgres results", async () => {
    mockRaw((sql) => {
      if (sql.includes("count(")) return { rows: [{ total: "7" }] };
      return { rows: [], rowCount: 1 };
    });
    expect(await enableTwoFactor(USER, 5, ["a", "b"])).toBe(true);
    expect(await replaceRecoveryCodes(USER, ["c"])).toBeDefined();
    expect(await countUnusedRecoveryCodes(USER)).toBe(7);
    expect(await disableTwoFactor(USER)).toBe(true);
    const inserts = statements.filter((s) => /insert into [`"]?user_recovery_codes[`"]?/i.test(s.sql));
    expect(inserts.length).toBeGreaterThan(0);
  });

  test("the SQLite and Postgres paths agree on what a missing argument does", async () => {
    for (const mode of ["postgres", "sqlite3"]) {
      process.env.DB_CLIENT = mode;
      expect(await getUserTwoFactor(null)).toBeNull();
      expect(await revokeUserSession(null, "x")).toBeNull();
      expect(await revokeOtherUserSessions(null, "x")).toEqual([]);
      expect(await listUserSessions(null)).toEqual([]);
      expect(await markTotpStepUsed(null, 1)).toBe(false);
      expect(await consumeRecoveryCode(USER, "")).toBe(false);
      expect(await disableTwoFactor(null)).toBe(false);
    }
  });
});
