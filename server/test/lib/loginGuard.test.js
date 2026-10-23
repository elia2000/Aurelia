import { describe, expect, test } from "vitest";
import { createLoginGuard, loginGuardFor } from "../../lib/loginGuard.js";
import { redactSensitive, REDACTED } from "../../lib/redact.js";

describe("login guard", () => {
  const who = (over = {}) => ({ ip: "10.0.0.1", account: "alice", ...over });

  test("allows until eight failures for one IP and account, then blocks that pair", () => {
    const guard = createLoginGuard();
    for (let i = 0; i < 8; i += 1) {
      expect(guard.check(who()).allowed).toBe(true);
      guard.recordFailure(who());
    }
    expect(guard.check(who()).allowed).toBe(false);
    // the same person from another address is not blocked by the pair bucket
    expect(guard.check(who({ ip: "10.0.0.2" })).allowed).toBe(true);
    // nor another account from the same address
    expect(guard.check(who({ account: "bob" })).allowed).toBe(true);
  });

  test("many addresses guessing one account hit the per-account ceiling", () => {
    const guard = createLoginGuard();
    for (let i = 0; i < 30; i += 1) guard.recordFailure(who({ ip: `10.1.0.${i}` }));
    expect(guard.check(who({ ip: "10.9.9.9" })).allowed).toBe(false);
    expect(guard.check(who({ ip: "10.9.9.9", account: "bob" })).allowed).toBe(true);
  });

  test("one address walking many account names hits the per-IP ceiling", () => {
    const guard = createLoginGuard();
    for (let i = 0; i < 60; i += 1) guard.recordFailure(who({ account: `user${i}` }));
    expect(guard.check(who({ account: "fresh" })).allowed).toBe(false);
    expect(guard.check(who({ ip: "10.0.0.2", account: "fresh" })).allowed).toBe(true);
  });

  test("a good sign-in clears the pair but not the other buckets", () => {
    const guard = createLoginGuard();
    for (let i = 0; i < 7; i += 1) guard.recordFailure(who());
    guard.recordSuccess(who());
    for (let i = 0; i < 7; i += 1) expect(guard.check(who()).allowed).toBe(true);
  });

  test("the window slides", () => {
    let clock = 0;
    const guard = createLoginGuard({ now: () => clock, windowMs: 1000 });
    for (let i = 0; i < 8; i += 1) guard.recordFailure(who());
    expect(guard.check(who()).allowed).toBe(false);
    clock = 1001;
    expect(guard.check(who()).allowed).toBe(true);
  });

  test("names are compared case-insensitively and unknown names count like known ones", () => {
    const guard = createLoginGuard();
    for (let i = 0; i < 8; i += 1) guard.recordFailure(who({ account: i % 2 ? "Alice" : "alice " }));
    expect(guard.check(who({ account: "ALICE" })).allowed).toBe(false);
  });

  test("loginGuardFor hands every route module the same guard", () => {
    const deps = {};
    expect(loginGuardFor(deps)).toBe(loginGuardFor(deps));
    expect(loginGuardFor({})).not.toBe(loginGuardFor(deps));
  });
});

describe("redactSensitive", () => {
  test("masks credentials at any depth and leaves the rest", () => {
    const out = redactSensitive({
      username: "alice",
      password: "hunter2",
      currentPassword: "a",
      newPassword: "b",
      code: "123456",
      recoveryCode: "ABCDE-FGHJK",
      challenge: "xyz",
      nested: { token: "t", fine: 1, list: [{ secret: "s", name: "n" }] },
      recoveryCodes: ["A", "B"],
      otpauthUri: "otpauth://...",
    });
    expect(out).toEqual({
      username: "alice",
      password: REDACTED,
      currentPassword: REDACTED,
      newPassword: REDACTED,
      code: REDACTED,
      recoveryCode: REDACTED,
      challenge: REDACTED,
      nested: { token: REDACTED, fine: 1, list: [{ secret: REDACTED, name: "n" }] },
      recoveryCodes: REDACTED,
      otpauthUri: REDACTED,
    });
  });
  test("handles null, primitives and deep nesting", () => {
    expect(redactSensitive(null)).toBeNull();
    expect(redactSensitive("text")).toBe("text");
    let deep = { a: 1 };
    for (let i = 0; i < 20; i += 1) deep = { next: deep };
    expect(JSON.stringify(redactSensitive(deep))).toContain(REDACTED);
  });
});
