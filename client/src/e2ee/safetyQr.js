// The text inside a safety-number QR code, and how a scanned (or pasted) one is
// judged. The code is a way to compare the 60 digits without reading them out:
// it carries no secret that the screen does not already show.
//
//   aurelle-sn:1:<user id of the person showing the code>:<user id of the person it is about>:<60 digits>
//
// Both ids are there so a code can only ever be accepted by the one person it
// was made for: A shows (A, B, digits), and only B's screen accepts it, as
// "the code of B's contact A". Everything is checked strictly: a code that is
// slightly off is rejected, never "repaired".

export const SAFETY_QR_PREFIX = "aurelle-sn";
export const SAFETY_QR_VERSION = 1;
const MAX_LENGTH = 256;
const DIGITS = /^\d{60}$/;
// What a user id may look like inside the code: no ":" (the separator), no spaces.
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export const SAFETY_QR_PROBLEM = Object.freeze({
  MALFORMED: "malformed",
  VERSION: "unsupported_version",
  OWN_CODE: "own_code",
  OTHER_PERSON: "different_person",
  MISMATCH: "mismatch",
});

/** What a person is told for each way a code can be unusable. */
export const SAFETY_QR_MESSAGES = Object.freeze({
  [SAFETY_QR_PROBLEM.MALFORMED]: "This is not an Aurelle safety number code.",
  [SAFETY_QR_PROBLEM.VERSION]: "This code was made by a different version of Aurelle and cannot be checked.",
  [SAFETY_QR_PROBLEM.OWN_CODE]: "This is your own code. Ask your contact to show theirs.",
  [SAFETY_QR_PROBLEM.OTHER_PERSON]: "This code is for a different person.",
  [SAFETY_QR_PROBLEM.MISMATCH]: "The numbers do not match - do not trust this contact.",
});
export const SAFETY_QR_MATCH_MESSAGE = "Safety number matches";

/** The text to put into the QR code of `selfUserId` about `peerUserId`. */
export function buildSafetyPayload({ selfUserId, peerUserId, digits }) {
  if (!ID.test(String(selfUserId ?? "")) || !ID.test(String(peerUserId ?? ""))) {
    throw new TypeError("A safety number code needs both user ids.");
  }
  if (!DIGITS.test(String(digits ?? ""))) {
    throw new TypeError("A safety number code needs the 60-digit number.");
  }
  return [SAFETY_QR_PREFIX, SAFETY_QR_VERSION, selfUserId, peerUserId, digits].join(":");
}

/**
 * @returns {{ok: true, version: number, ownerId: string, aboutId: string, digits: string}
 *          | {ok: false, problem: string}}
 */
export function parseSafetyPayload(text) {
  if (typeof text !== "string") return { ok: false, problem: SAFETY_QR_PROBLEM.MALFORMED };
  const value = text.trim();
  if (!value || value.length > MAX_LENGTH) return { ok: false, problem: SAFETY_QR_PROBLEM.MALFORMED };
  const parts = value.split(":");
  if (parts.length !== 5 || parts[0] !== SAFETY_QR_PREFIX) {
    return { ok: false, problem: SAFETY_QR_PROBLEM.MALFORMED };
  }
  const [, versionText, ownerId, aboutId, digits] = parts;
  if (!/^\d{1,6}$/.test(versionText)) return { ok: false, problem: SAFETY_QR_PROBLEM.MALFORMED };
  if (!ID.test(ownerId) || !ID.test(aboutId) || !DIGITS.test(digits)) {
    return { ok: false, problem: SAFETY_QR_PROBLEM.MALFORMED };
  }
  // Only the exact spelling of the version we know ("01" is not "1").
  if (versionText !== String(SAFETY_QR_VERSION)) return { ok: false, problem: SAFETY_QR_PROBLEM.VERSION };
  return { ok: true, version: SAFETY_QR_VERSION, ownerId, aboutId, digits };
}

/**
 * Judges a scanned or pasted code against what THIS screen shows for exactly
 * this pair of people.
 *
 * @param {string} text  the scanned text
 * @param {{selfUserId: string, peerUserId: string, digits: string}} current
 *        the user ids and the safety number as computed right now
 * @returns {{ok: true} | {ok: false, problem: string}}
 */
export function checkScannedSafetyPayload(text, { selfUserId, peerUserId, digits }) {
  const parsed = parseSafetyPayload(text);
  if (!parsed.ok) return parsed;
  if (parsed.ownerId === selfUserId && parsed.aboutId === peerUserId) {
    return { ok: false, problem: SAFETY_QR_PROBLEM.OWN_CODE };
  }
  // The code must be the contact's, made for this account.
  if (parsed.ownerId !== peerUserId || parsed.aboutId !== selfUserId) {
    return { ok: false, problem: SAFETY_QR_PROBLEM.OTHER_PERSON };
  }
  if (!DIGITS.test(String(digits ?? "")) || parsed.digits !== digits) {
    return { ok: false, problem: SAFETY_QR_PROBLEM.MISMATCH };
  }
  return { ok: true };
}

/**
 * Typed or pasted by hand: either a whole code (see above) or the 60 digits,
 * with spaces, dashes or line breaks between the groups.
 *
 * @returns {{state: "empty"|"partial"|"too_long"|"invalid"} | {state: "complete", problem?: string, ok: boolean}}
 *          `partial` carries `count`, how many digits were typed so far.
 */
export function checkTypedSafetyNumber(text, current) {
  const value = String(text ?? "").trim();
  if (!value) return { state: "empty" };
  if (value.toLowerCase().startsWith(`${SAFETY_QR_PREFIX}:`)) {
    const result = checkScannedSafetyPayload(value, current);
    return { state: "complete", ...result };
  }
  // Only digits and the separators people put between groups: anything else is not a number.
  if (value.length > MAX_LENGTH || !/^[\d\s\-.,‐-―]+$/.test(value)) return { state: "invalid" };
  const typed = value.replace(/\D/g, "");
  if (typed.length < 60) return { state: "partial", count: typed.length };
  if (typed.length > 60) return { state: "too_long", count: typed.length };
  const ok = typed === current.digits;
  return { state: "complete", ok, ...(ok ? {} : { problem: SAFETY_QR_PROBLEM.MISMATCH }) };
}
