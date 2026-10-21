import { describe, expect, test } from "vitest";
import { isUnsupportedMessage } from "../../src/utils/messageKind.js";

describe("isUnsupportedMessage", () => {
  test("a message of an unknown type with nothing to show is unsupported", () => {
    expect(isUnsupportedMessage({ messageType: "poll", body: "", files: [] })).toBe(true);
    expect(isUnsupportedMessage({ messageType: "poll" })).toBe(true);
    expect(isUnsupportedMessage({ messageType: "poll", body: "   " })).toBe(true);
  });

  test("a message of an unknown type that has text or files is drawn normally", () => {
    expect(isUnsupportedMessage({ messageType: "poll", body: "Lunch?" })).toBe(false);
    expect(isUnsupportedMessage({ messageType: "poll", files: [{ id: "f" }] })).toBe(false);
  });

  test("text, call and untyped messages are known", () => {
    expect(isUnsupportedMessage({ messageType: "text", body: "" })).toBe(false);
    expect(isUnsupportedMessage({ messageType: "call", call: null })).toBe(false);
    expect(isUnsupportedMessage({ type: "call" })).toBe(false);
    expect(isUnsupportedMessage({ body: "" })).toBe(false);
    expect(isUnsupportedMessage({ messageType: "" })).toBe(false);
  });

  test("system lines, null and junk are left alone", () => {
    expect(isUnsupportedMessage({ messageType: "poll", _systemEvent: { type: "joined" } })).toBe(false);
    expect(isUnsupportedMessage(null)).toBe(false);
    expect(isUnsupportedMessage("poll")).toBe(false);
  });
});
