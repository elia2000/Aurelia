import { describe, expect, test } from "vitest";
import {
  base32Decode,
  base32Encode,
  buildOtpauthUri,
  generateTotpSecret,
  hotp,
  normalizeTotpCode,
  totp,
  totpStep,
  verifyTotp,
} from "../../lib/totp.js";

// RFC 6238 appendix B: the SHA-1 seed is the ASCII string "12345678901234567890".
const SEED_SHA1 = Buffer.from("12345678901234567890", "ascii");
const SEED_SHA256 = Buffer.from("12345678901234567890123456789012", "ascii");
const SEED_SHA512 = Buffer.from(
  "1234567890123456789012345678901234567890123456789012345678901234",
  "ascii",
);

describe("HOTP (RFC 4226 appendix D)", () => {
  const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
  test.each(expected.map((code, counter) => [counter, code]))("counter %i -> %s", (counter, code) => {
    expect(hotp(SEED_SHA1, counter)).toBe(code);
  });
});

describe("TOTP test vectors (RFC 6238 appendix B)", () => {
  const vectors = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];
  test.each(vectors)("SHA-1 at %i s -> %s (8 digits)", (seconds, code) => {
    expect(totp(SEED_SHA1, seconds * 1000, { digits: 8 })).toBe(code);
  });

  test("the 6 digit code is the last six digits of the 8 digit one", () => {
    expect(totp(SEED_SHA1, 59_000)).toBe("287082");
    expect(totp(SEED_SHA1, 1111111109_000)).toBe("081804");
  });

  test("SHA-256 and SHA-512 seeds work too (not used by the app, proves the HMAC wiring)", () => {
    expect(totp(SEED_SHA256, 59_000, { digits: 8, algorithm: "sha256" })).toBe("46119246");
    expect(totp(SEED_SHA512, 59_000, { digits: 8, algorithm: "sha512" })).toBe("90693936");
  });

  test("a base32 secret and its raw bytes give the same code", () => {
    const b32 = base32Encode(SEED_SHA1);
    expect(totp(b32, 59_000)).toBe(totp(SEED_SHA1, 59_000));
  });

  test("a code only changes at a 30 second boundary", () => {
    expect(totp(SEED_SHA1, 30_000)).toBe(totp(SEED_SHA1, 59_999));
    expect(totp(SEED_SHA1, 59_999)).not.toBe(totp(SEED_SHA1, 60_000));
    expect(totpStep(59_999)).toBe(1);
    expect(totpStep(60_000)).toBe(2);
  });
});

describe("base32", () => {
  test("round-trips arbitrary bytes", () => {
    for (const length of [1, 5, 10, 20, 33]) {
      const bytes = Buffer.from(Array.from({ length }, (_, i) => (i * 37 + 11) % 256));
      expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
    }
  });
  test("matches the RFC 4648 vectors", () => {
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
    expect(base32Decode("MZXW6YTBOI====").toString()).toBe("foobar");
  });
  test("ignores spaces, dashes, padding and case; rejects other characters", () => {
    expect(base32Decode("mzxw 6ytb-oi").toString()).toBe("foobar");
    expect(base32Decode("MZXW1YTBOI")).toBeNull(); // 1 is not in the alphabet
    expect(base32Decode("")).toBeNull();
  });
  test("a generated secret is 160 bits: 32 base32 characters, different every time", () => {
    const a = generateTotpSecret();
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(a)).toHaveLength(20);
    expect(generateTotpSecret()).not.toBe(a);
  });
});

describe("verifyTotp", () => {
  const secret = base32Encode(SEED_SHA1);
  const now = 1111111111_000;
  const at = (deltaSteps) => totp(secret, now + deltaSteps * 30_000);

  test("accepts the current code and reports its step", () => {
    expect(verifyTotp(secret, at(0), { now })).toEqual({ ok: true, step: totpStep(now) });
  });

  test("accepts one step before and after (clock drift), not two", () => {
    expect(verifyTotp(secret, at(-1), { now }).ok).toBe(true);
    expect(verifyTotp(secret, at(1), { now }).ok).toBe(true);
    expect(verifyTotp(secret, at(-2), { now })).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyTotp(secret, at(2), { now })).toEqual({ ok: false, reason: "mismatch" });
  });

  test("the window can be narrowed to the exact step", () => {
    expect(verifyTotp(secret, at(-1), { now, window: 0 }).ok).toBe(false);
    expect(verifyTotp(secret, at(0), { now, window: 0 }).ok).toBe(true);
  });

  test("rejects a wrong code", () => {
    const wrong = at(0) === "000000" ? "000001" : "000000";
    expect(verifyTotp(secret, wrong, { now })).toEqual({ ok: false, reason: "mismatch" });
  });

  test("rejects anything that is not six digits without comparing", () => {
    for (const bad of ["", "12345", "1234567", "abcdef", null, undefined, 123456.5, "12 3456x"]) {
      expect(verifyTotp(secret, bad, { now })).toEqual({ ok: false, reason: "format" });
    }
  });

  test("tolerates a space in the middle, as authenticator apps show codes", () => {
    const code = at(0);
    expect(verifyTotp(secret, `${code.slice(0, 3)} ${code.slice(3)}`, { now }).ok).toBe(true);
    expect(normalizeTotpCode(" 123 456 ")).toBe("123456");
  });

  test("replay: a step that was already accepted is refused, and so is any earlier one", () => {
    const first = verifyTotp(secret, at(0), { now });
    expect(first.ok).toBe(true);
    // same code again
    expect(verifyTotp(secret, at(0), { now, lastUsedStep: first.step })).toEqual({ ok: false, reason: "replay" });
    // the previous step's code is still inside the window but older than the last used step
    expect(verifyTotp(secret, at(-1), { now, lastUsedStep: first.step })).toEqual({ ok: false, reason: "replay" });
    // the next step's code is fine
    expect(verifyTotp(secret, at(1), { now, lastUsedStep: first.step }).ok).toBe(true);
  });

  test("a code from the future step is accepted once, then cannot be replayed at its own time", () => {
    const early = verifyTotp(secret, at(1), { now });
    expect(early.step).toBe(totpStep(now) + 1);
    const later = now + 30_000;
    expect(verifyTotp(secret, at(1), { now: later, lastUsedStep: early.step })).toEqual({ ok: false, reason: "replay" });
  });
});

describe("buildOtpauthUri", () => {
  test("follows the Key URI Format", () => {
    const uri = buildOtpauthUri({ secret: "JBSWY3DPEHPK3PXP", account: "alice", issuer: "Aurelle" });
    expect(uri.startsWith("otpauth://totp/Aurelle:alice?")).toBe(true);
    const params = new URL(uri).searchParams;
    expect(params.get("secret")).toBe("JBSWY3DPEHPK3PXP");
    expect(params.get("issuer")).toBe("Aurelle");
    expect(params.get("algorithm")).toBe("SHA1");
    expect(params.get("digits")).toBe("6");
    expect(params.get("period")).toBe("30");
  });
  test("escapes the account name", () => {
    const uri = buildOtpauthUri({ secret: "AAAA", account: "a b/c", issuer: "Aurelle" });
    expect(uri).toContain("Aurelle:a%20b%2Fc");
  });
});
