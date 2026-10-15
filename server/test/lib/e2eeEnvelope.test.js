import { describe, test, expect } from "vitest";
import {
  parseVideoNoteEnvelope,
  safeParseStoredEnvelope,
  E2EE_ENVELOPE_MAX_RECIPIENT_KEYS,
} from "../../lib/e2eeEnvelope.js";
import { b64u, makeP256PublicKey } from "../helpers/p256.js";

const DEVICE_A = "a0a0a0a0-b1b1-4c2c-8d3d-e4e4e4e4e4e4";
const DEVICE_B = "b0b0b0b0-c1c1-4d2d-8e3e-f4f4f4f4f4f4";

const makeEnvelope = (overrides = {}) => ({
  v: 2,
  kind: "video_note",
  senderDeviceId: DEVICE_A,
  iv: b64u(12),
  durationMs: 8123,
  mime: "video/mp4",
  poster: { iv: b64u(12), ct: b64u(600) },
  keys: [
    { deviceId: DEVICE_A, epk: makeP256PublicKey(), iv: b64u(12), ct: b64u(48) },
    { deviceId: DEVICE_B, epk: makeP256PublicKey(), iv: b64u(12), ct: b64u(48) },
  ],
  sig: b64u(64),
  ...overrides,
});

describe("parseVideoNoteEnvelope", () => {
  test("accepts a well-formed envelope (object or JSON string)", () => {
    const env = makeEnvelope();
    expect(parseVideoNoteEnvelope(env).ok).toBe(true);
    expect(parseVideoNoteEnvelope(JSON.stringify(env)).ok).toBe(true);
  });

  test("drops unknown fields before storing", () => {
    const result = parseVideoNoteEnvelope(
      makeEnvelope({ evil: "<script>", keys: [{ ...makeEnvelope().keys[0], extra: 1 }] }),
    );
    expect(result.ok).toBe(true);
    expect(result.envelope.evil).toBeUndefined();
    expect(result.envelope.keys[0].extra).toBeUndefined();
    expect(JSON.parse(result.json).evil).toBeUndefined();
  });

  test.each([
    ["previous version", { v: 1 }],
    ["off-curve ephemeral key", { keys: [{ deviceId: DEVICE_A, epk: b64u(65), iv: b64u(12), ct: b64u(48) }] }],
    ["wrong kind", { kind: "text" }],
    ["bad sender id", { senderDeviceId: "nope" }],
    ["short iv", { iv: b64u(8) }],
    ["negative duration", { durationMs: -1 }],
    ["too long", { durationMs: 10 * 60 * 1000 }],
    ["unsupported container", { mime: "application/x-evil" }],
    ["short signature", { sig: b64u(10) }],
    ["no recipients", { keys: [] }],
    ["wrapped key wrong size", { keys: [{ deviceId: DEVICE_A, epk: makeP256PublicKey(), iv: b64u(12), ct: b64u(47) }] }],
    ["duplicate recipient", { keys: [makeEnvelope().keys[0], makeEnvelope().keys[0]] }],
    ["oversized poster", { poster: { iv: b64u(12), ct: b64u(20 * 1024) } }],
  ])("rejects %s", (_name, patch) => {
    expect(parseVideoNoteEnvelope(makeEnvelope(patch)).ok).toBe(false);
  });

  test("rejects too many recipient devices", () => {
    const keys = Array.from({ length: E2EE_ENVELOPE_MAX_RECIPIENT_KEYS + 1 }, (_, i) => ({
      deviceId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      epk: makeP256PublicKey(),
      iv: b64u(12),
      ct: b64u(48),
    }));
    expect(parseVideoNoteEnvelope(makeEnvelope({ keys })).ok).toBe(false);
  });

  test("rejects non-objects and invalid JSON", () => {
    expect(parseVideoNoteEnvelope("{nope").ok).toBe(false);
    expect(parseVideoNoteEnvelope("[]").ok).toBe(false);
    expect(parseVideoNoteEnvelope(null).ok).toBe(false);
  });
});

describe("safeParseStoredEnvelope", () => {
  test("returns null for empty or broken values", () => {
    expect(safeParseStoredEnvelope(null)).toBeNull();
    expect(safeParseStoredEnvelope("{")).toBeNull();
    expect(safeParseStoredEnvelope('{"v":1}')).toEqual({ v: 1 });
  });
});
