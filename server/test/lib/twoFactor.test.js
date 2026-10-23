import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  CHALLENGE_TTL_MS,
  createChallengeGuard,
  decryptTotpSecret,
  encryptTotpSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  isTwoFactorKeyAvailable,
  normalizeRecoveryCode,
  signLoginChallenge,
  verifyLoginChallenge,
} from "../../lib/twoFactor.js";

const USER = "a0000000-0000-4000-8000-000000000001";
const OTHER = "b0000000-0000-4000-8000-000000000002";

let originalKey;
beforeEach(() => {
  originalKey = process.env.STORAGE_ENCRYPTION_KEY;
  process.env.STORAGE_ENCRYPTION_KEY = "unit-test-storage-key";
});
afterEach(() => {
  if (originalKey === undefined) delete process.env.STORAGE_ENCRYPTION_KEY;
  else process.env.STORAGE_ENCRYPTION_KEY = originalKey;
});

describe("TOTP secret at rest", () => {
  test("is encrypted, never the clear text", () => {
    const stored = encryptTotpSecret("JBSWY3DPEHPK3PXP", USER);
    expect(stored.startsWith("tfa1:")).toBe(true);
    expect(stored).not.toContain("JBSWY3DPEHPK3PXP");
  });

  test("decrypts for its owner, with a fresh IV every time", () => {
    const a = encryptTotpSecret("JBSWY3DPEHPK3PXP", USER);
    const b = encryptTotpSecret("JBSWY3DPEHPK3PXP", USER);
    expect(a).not.toBe(b);
    expect(decryptTotpSecret(a, USER)).toBe("JBSWY3DPEHPK3PXP");
    expect(decryptTotpSecret(b, USER)).toBe("JBSWY3DPEHPK3PXP");
  });

  test("a row copied to another user does not decrypt (the owner is authenticated data)", () => {
    const stored = encryptTotpSecret("JBSWY3DPEHPK3PXP", USER);
    expect(decryptTotpSecret(stored, OTHER)).toBeNull();
  });

  test("tampering is detected", () => {
    const stored = encryptTotpSecret("JBSWY3DPEHPK3PXP", USER);
    const flipped = `${stored.slice(0, -2)}${stored.endsWith("A") ? "B" : "A"}${stored.slice(-1)}`;
    expect(decryptTotpSecret(flipped, USER)).toBeNull();
    expect(decryptTotpSecret("tfa1:x.y.z", USER)).toBeNull();
    expect(decryptTotpSecret("plain", USER)).toBeNull();
    expect(decryptTotpSecret(null, USER)).toBeNull();
  });

  test("a different server secret cannot read it", () => {
    const stored = encryptTotpSecret("JBSWY3DPEHPK3PXP", USER);
    process.env.STORAGE_ENCRYPTION_KEY = "some-other-key";
    expect(decryptTotpSecret(stored, USER)).toBeNull();
  });

  test("without a server secret it refuses instead of storing clear text", () => {
    delete process.env.STORAGE_ENCRYPTION_KEY;
    expect(isTwoFactorKeyAvailable()).toBe(false);
    expect(() => encryptTotpSecret("JBSWY3DPEHPK3PXP", USER)).toThrow(/STORAGE_ENCRYPTION_KEY/);
  });
});

describe("recovery codes", () => {
  test("ten distinct codes shaped XXXXX-XXXXX without look-alike characters", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[A-HJKMNP-Z2-9]{5}-[A-HJKMNP-Z2-9]{5}$/);
  });

  test("normalisation accepts case, spaces and a missing dash", () => {
    expect(normalizeRecoveryCode("abcde-fghjk")).toBe("ABCDEFGHJK");
    expect(normalizeRecoveryCode(" abcde fghjk ")).toBe("ABCDEFGHJK");
    expect(normalizeRecoveryCode("short")).toBe("");
    expect(normalizeRecoveryCode("ABCDE-FGHJK-EXTRA")).toBe("");
    expect(normalizeRecoveryCode(null)).toBe("");
  });

  test("the stored value is a keyed hash, the same for every spelling of the code", () => {
    const hash = hashRecoveryCode("ABCDE-FGHJK");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain("ABCDE");
    expect(hashRecoveryCode("abcde fghjk")).toBe(hash);
    expect(hashRecoveryCode("ABCDE-FGHJM")).not.toBe(hash);
    expect(hashRecoveryCode("nope")).toBe("");
  });

  test("the hash depends on the server secret (a database copy alone cannot brute-force codes)", () => {
    const before = hashRecoveryCode("ABCDE-FGHJK");
    process.env.STORAGE_ENCRYPTION_KEY = "some-other-key";
    expect(hashRecoveryCode("ABCDE-FGHJK")).not.toBe(before);
  });
});

describe("login challenge", () => {
  test("is signed, carries the user, and verifies", () => {
    const { token, exp } = signLoginChallenge({ userId: USER, now: 1_000 });
    expect(exp).toBe(1_000 + CHALLENGE_TTL_MS);
    const payload = verifyLoginChallenge(token, { now: 2_000 });
    expect(payload).toMatchObject({ typ: "2fa-login", uid: USER });
    expect(payload.jti).toMatch(/^[0-9a-f]{32}$/);
  });

  test("lives five minutes", () => {
    const { token } = signLoginChallenge({ userId: USER, now: 0 });
    expect(verifyLoginChallenge(token, { now: 5 * 60 * 1000 - 1 })).not.toBeNull();
    expect(verifyLoginChallenge(token, { now: 5 * 60 * 1000 })).toBeNull();
  });

  test("a changed payload or signature is rejected", () => {
    const { token } = signLoginChallenge({ userId: USER });
    const [body, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ typ: "2fa-login", uid: OTHER, jti: "a".repeat(32), exp: Date.now() + 1e6 })).toString("base64url");
    expect(verifyLoginChallenge(`${forged}.${sig}`)).toBeNull();
    expect(verifyLoginChallenge(`${body}.${sig.slice(0, -2)}AA`)).toBeNull();
    expect(verifyLoginChallenge(`${body}.`)).toBeNull();
    expect(verifyLoginChallenge(body)).toBeNull();
    expect(verifyLoginChallenge(`${token}.extra`)).toBeNull();
    expect(verifyLoginChallenge("")).toBeNull();
    expect(verifyLoginChallenge(undefined)).toBeNull();
  });

  test("a token signed under another server secret is rejected", () => {
    const { token } = signLoginChallenge({ userId: USER });
    process.env.STORAGE_ENCRYPTION_KEY = "some-other-key";
    expect(verifyLoginChallenge(token)).toBeNull();
  });

  test("is single purpose: a valid signature over another kind of payload is not a challenge", () => {
    // Re-sign a payload with a different type the way another feature could.
    const { token } = signLoginChallenge({ userId: USER });
    const payload = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString());
    expect(payload.typ).toBe("2fa-login");
    const body = Buffer.from(JSON.stringify({ ...payload, typ: "something-else" })).toString("base64url");
    expect(verifyLoginChallenge(`${body}.${token.split(".")[1]}`)).toBeNull();
  });
});

describe("challenge guard", () => {
  test("locks after five wrong codes and counts down", () => {
    const guard = createChallengeGuard();
    expect(guard.status("j")).toBe("ok");
    expect(guard.fail("j", Date.now() + 1000)).toBe(4);
    expect(guard.fail("j", Date.now() + 1000)).toBe(3);
    expect(guard.fail("j", Date.now() + 1000)).toBe(2);
    expect(guard.fail("j", Date.now() + 1000)).toBe(1);
    expect(guard.status("j")).toBe("ok");
    expect(guard.fail("j", Date.now() + 1000)).toBe(0);
    expect(guard.status("j")).toBe("locked");
    expect(guard.status("another")).toBe("ok");
  });

  test("a used challenge can not be used again", () => {
    const guard = createChallengeGuard();
    guard.consume("j", Date.now() + 1000);
    expect(guard.status("j")).toBe("used");
  });

  test("forgets expired challenges", () => {
    let clock = 0;
    const guard = createChallengeGuard({ now: () => clock });
    guard.fail("j", 100);
    expect(guard.size()).toBe(1);
    clock = 101;
    expect(guard.status("j")).toBe("ok");
    expect(guard.size()).toBe(0);
  });
});
