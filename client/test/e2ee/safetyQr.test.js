import { describe, test, expect } from "vitest";
import {
  buildSafetyPayload,
  parseSafetyPayload,
  checkScannedSafetyPayload,
  checkTypedSafetyNumber,
  SAFETY_QR_PROBLEM as P,
  SAFETY_QR_MESSAGES,
} from "../../src/e2ee/safetyQr.js";
import { encodeQr } from "../../src/utils/qr/qrEncoder.js";

const ALICE = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const BOB = "f0e1d2c3-b4a5-4968-8776-655443322110";
const EVE = "11111111-2222-4333-8444-555555555555";
const DIGITS = "123450987612345098761234509876123450987612345098761234509876";
const OTHER_DIGITS = `${DIGITS.slice(0, 59)}7`;

// Alice scans the code Bob shows: it is Bob's code about Alice.
const bobsCode = buildSafetyPayload({ selfUserId: BOB, peerUserId: ALICE, digits: DIGITS });
const alicesScreen = { selfUserId: ALICE, peerUserId: BOB, digits: DIGITS };

describe("buildSafetyPayload", () => {
  test("is versioned and self-describing", () => {
    expect(bobsCode).toBe(`aurelle-sn:1:${BOB}:${ALICE}:${DIGITS}`);
  });

  test("fits a small QR code (version 8 at level M)", () => {
    expect(bobsCode.length).toBeLessThanOrEqual(152);
    expect(encodeQr(bobsCode, { ecc: "M" }).version).toBe(8);
  });

  test("refuses ids that would break the format, and a number that is not 60 digits", () => {
    const ok = { selfUserId: BOB, peerUserId: ALICE, digits: DIGITS };
    for (const bad of ["", "a:b", "with space", "x".repeat(65), null, undefined, "line\nbreak", "é"]) {
      expect(() => buildSafetyPayload({ ...ok, selfUserId: bad })).toThrow(TypeError);
      expect(() => buildSafetyPayload({ ...ok, peerUserId: bad })).toThrow(TypeError);
    }
    for (const bad of ["", DIGITS.slice(1), `${DIGITS}1`, `${DIGITS.slice(1)}x`, null, 123, "۱".repeat(60)]) {
      expect(() => buildSafetyPayload({ ...ok, digits: bad })).toThrow(TypeError);
    }
  });
});

describe("parseSafetyPayload", () => {
  test("reads back what was built, ignoring whitespace around it", () => {
    expect(parseSafetyPayload(`  ${bobsCode}\n`)).toEqual({
      ok: true,
      version: 1,
      ownerId: BOB,
      aboutId: ALICE,
      digits: DIGITS,
    });
  });

  const hostile = {
    "not a string": [null, undefined, 42, {}, [], true, () => "x"],
    empty: ["", "   ", "\n"],
    "wrong prefix": [`aurelle:1:${BOB}:${ALICE}:${DIGITS}`, `AURELLE-SN:1:${BOB}:${ALICE}:${DIGITS}`, `signal:1:${BOB}:${ALICE}:${DIGITS}`, DIGITS, "https://example.com"],
    "wrong number of fields": [`aurelle-sn:1:${BOB}:${DIGITS}`, `aurelle-sn:1:${BOB}:${ALICE}:${DIGITS}:extra`, `aurelle-sn:1:${BOB}:${ALICE}:${DIGITS}:`, "aurelle-sn", "aurelle-sn:"],
    "bad number": [`aurelle-sn:1:${BOB}:${ALICE}:${DIGITS.slice(1)}`, `aurelle-sn:1:${BOB}:${ALICE}:${DIGITS}0`, `aurelle-sn:1:${BOB}:${ALICE}:${"a".repeat(60)}`, `aurelle-sn:1:${BOB}:${ALICE}:${"۱".repeat(60)}`, `aurelle-sn:1:${BOB}:${ALICE}:${DIGITS.slice(0, 30)} ${DIGITS.slice(30)}`, `aurelle-sn:1:${BOB}:${ALICE}:-${DIGITS.slice(1)}`],
    "bad ids": [`aurelle-sn:1::${ALICE}:${DIGITS}`, `aurelle-sn:1:${BOB}::${DIGITS}`, `aurelle-sn:1:bo b:${ALICE}:${DIGITS}`, `aurelle-sn:1:${BOB}:${"x".repeat(65)}:${DIGITS}`, `aurelle-sn:1:<script>:${ALICE}:${DIGITS}`, `aurelle-sn:1:${BOB}:../etc:${DIGITS}`],
    "bad version spelling": [`aurelle-sn::${BOB}:${ALICE}:${DIGITS}`, `aurelle-sn:x:${BOB}:${ALICE}:${DIGITS}`, `aurelle-sn:1.0:${BOB}:${ALICE}:${DIGITS}`, `aurelle-sn:-1:${BOB}:${ALICE}:${DIGITS}`, `aurelle-sn:1e0:${BOB}:${ALICE}:${DIGITS}`, `aurelle-sn:0x1:${BOB}:${ALICE}:${DIGITS}`],
    "embedded line break": [`aurelle-sn:1:${BOB}:${ALICE}:${DIGITS}\naurelle-sn:1:${EVE}:${ALICE}:${DIGITS}`, `aurelle-sn:1:${BOB}\n:${ALICE}:${DIGITS}`],
    "too long": [`aurelle-sn:1:${BOB}:${ALICE}:${DIGITS}${" ".repeat(10)}${"x".repeat(300)}`, "a".repeat(100000)],
  };
  for (const [kind, inputs] of Object.entries(hostile)) {
    test(`rejects ${kind} as malformed`, () => {
      for (const input of inputs) {
        expect(parseSafetyPayload(input), JSON.stringify(input)?.slice(0, 80)).toEqual({ ok: false, problem: P.MALFORMED });
      }
    });
  }

  test("other versions are recognised but not accepted", () => {
    for (const version of ["0", "2", "01", "10", "999", "000001"]) {
      expect(parseSafetyPayload(`aurelle-sn:${version}:${BOB}:${ALICE}:${DIGITS}`)).toEqual({
        ok: false,
        problem: P.VERSION,
      });
    }
  });
});

describe("checkScannedSafetyPayload", () => {
  test("accepts the contact's code for exactly this pair and this number", () => {
    expect(checkScannedSafetyPayload(bobsCode, alicesScreen)).toEqual({ ok: true });
  });

  test("rejects the code of another person: another owner, another subject, or the pair turned around", () => {
    const evesCodeAboutAlice = buildSafetyPayload({ selfUserId: EVE, peerUserId: ALICE, digits: DIGITS });
    const bobsCodeAboutEve = buildSafetyPayload({ selfUserId: BOB, peerUserId: EVE, digits: DIGITS });
    const evesCodeAboutBob = buildSafetyPayload({ selfUserId: EVE, peerUserId: BOB, digits: DIGITS });
    for (const code of [evesCodeAboutAlice, bobsCodeAboutEve, evesCodeAboutBob]) {
      expect(checkScannedSafetyPayload(code, alicesScreen)).toEqual({ ok: false, problem: P.OTHER_PERSON });
    }
  });

  test("a code about someone else is a different person even when the digits happen to be the same", () => {
    const code = buildSafetyPayload({ selfUserId: EVE, peerUserId: BOB, digits: OTHER_DIGITS });
    expect(checkScannedSafetyPayload(code, alicesScreen).problem).toBe(P.OTHER_PERSON);
  });

  test("your own code, shown to your own camera, is called what it is", () => {
    const own = buildSafetyPayload({ selfUserId: ALICE, peerUserId: BOB, digits: DIGITS });
    expect(checkScannedSafetyPayload(own, alicesScreen)).toEqual({ ok: false, problem: P.OWN_CODE });
  });

  test("a different number for the right pair is a mismatch, even by one digit", () => {
    const code = buildSafetyPayload({ selfUserId: BOB, peerUserId: ALICE, digits: OTHER_DIGITS });
    expect(checkScannedSafetyPayload(code, alicesScreen)).toEqual({ ok: false, problem: P.MISMATCH });
  });

  test("an old or future version, and anything malformed, are refused", () => {
    expect(checkScannedSafetyPayload(`aurelle-sn:0:${BOB}:${ALICE}:${DIGITS}`, alicesScreen).problem).toBe(P.VERSION);
    expect(checkScannedSafetyPayload(`aurelle-sn:2:${BOB}:${ALICE}:${DIGITS}`, alicesScreen).problem).toBe(P.VERSION);
    expect(checkScannedSafetyPayload("hello", alicesScreen).problem).toBe(P.MALFORMED);
    expect(checkScannedSafetyPayload("", alicesScreen).problem).toBe(P.MALFORMED);
  });

  test("never accepts when this screen has no valid number to compare with", () => {
    for (const digits of [undefined, null, "", "123", `${DIGITS}0`]) {
      expect(checkScannedSafetyPayload(bobsCode, { ...alicesScreen, digits }).ok).toBe(false);
    }
  });

  test("ids are compared exactly, not case-insensitively or by prefix", () => {
    expect(checkScannedSafetyPayload(bobsCode.toUpperCase(), alicesScreen).ok).toBe(false);
    const upperBob = buildSafetyPayload({ selfUserId: BOB.toUpperCase(), peerUserId: ALICE, digits: DIGITS });
    expect(checkScannedSafetyPayload(upperBob, alicesScreen).problem).toBe(P.OTHER_PERSON);
    const prefix = buildSafetyPayload({ selfUserId: BOB.slice(0, 20), peerUserId: ALICE, digits: DIGITS });
    expect(checkScannedSafetyPayload(prefix, alicesScreen).problem).toBe(P.OTHER_PERSON);
  });

  test("every problem has a clear message for the person", () => {
    expect(SAFETY_QR_MESSAGES[P.OTHER_PERSON]).toBe("This code is for a different person.");
    expect(SAFETY_QR_MESSAGES[P.MISMATCH]).toBe("The numbers do not match - do not trust this contact.");
    for (const problem of Object.values(P)) expect(SAFETY_QR_MESSAGES[problem]).toMatch(/\S/);
  });
});

describe("checkTypedSafetyNumber", () => {
  const grouped = DIGITS.match(/.{5}/g).join(" ");

  test("nothing yet, then counting digits", () => {
    expect(checkTypedSafetyNumber("", alicesScreen)).toEqual({ state: "empty" });
    expect(checkTypedSafetyNumber("   ", alicesScreen)).toEqual({ state: "empty" });
    expect(checkTypedSafetyNumber("12345 09876", alicesScreen)).toEqual({ state: "partial", count: 10 });
  });

  test("the 60 digits, with whatever separators people paste, match", () => {
    for (const text of [DIGITS, grouped, grouped.replace(/ /g, "-"), grouped.replace(/ /g, "\n"), ` ${grouped} `, grouped.replace(/ /g, "  ")]) {
      expect(checkTypedSafetyNumber(text, alicesScreen)).toEqual({ state: "complete", ok: true });
    }
  });

  test("60 other digits do not match", () => {
    expect(checkTypedSafetyNumber(OTHER_DIGITS, alicesScreen)).toEqual({ state: "complete", ok: false, problem: P.MISMATCH });
  });

  test("more than 60 digits is called out", () => {
    expect(checkTypedSafetyNumber(`${DIGITS}1`, alicesScreen)).toEqual({ state: "too_long", count: 61 });
  });

  test("letters and other symbols are not a number", () => {
    for (const text of ["12345 abcde", `${DIGITS} please`, "<b>1</b>", "١٢٣٤٥", "۱۲۳۴۵ ۶۷۸۹۰", "1".repeat(100000)]) {
      expect(checkTypedSafetyNumber(text, alicesScreen).state, text.slice(0, 20)).toBe("invalid");
    }
  });

  test("a whole pasted code is judged like a scanned one", () => {
    expect(checkTypedSafetyNumber(bobsCode, alicesScreen)).toEqual({ state: "complete", ok: true });
    const evil = buildSafetyPayload({ selfUserId: EVE, peerUserId: ALICE, digits: DIGITS });
    expect(checkTypedSafetyNumber(evil, alicesScreen)).toEqual({ state: "complete", ok: false, problem: P.OTHER_PERSON });
    expect(checkTypedSafetyNumber("aurelle-sn:junk", alicesScreen)).toEqual({ state: "complete", ok: false, problem: P.MALFORMED });
  });
});
