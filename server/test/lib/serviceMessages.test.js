import { describe, test, expect } from "vitest";
import {
  SYSTEM_MESSAGE_PREFIX,
  buildPinServiceBody,
  isServiceMessageBody,
  parsePinServiceBody,
} from "../../lib/serviceMessages.js";

const MSG = "d0d0d0d0-e1e1-4f2f-b040-171717171717";
const ACTOR = "a0a0a0a0-b1b1-4c2c-8d3d-e4e4e4e4e4e4";

describe("isServiceMessageBody", () => {
  test.each([
    ["[[system:joined:Bob]]", true],
    ["[[system:left:Bob]]", true],
    ["[[system:removed:Bob]]", true],
    [`[[system:pinned:${MSG}]]`, true],
    ["  [[system:joined:Bob]]", true],
    ["\n[[system:joined:Bob]]", true],
    ["hello", false],
    ["say [[system:joined:Bob]]", false],
    ["", false],
    [null, false],
    [undefined, false],
  ])("%j -> %j", (body, expected) => {
    expect(isServiceMessageBody(body)).toBe(expected);
  });
});

describe("pin service message", () => {
  test("is stored in the same [[system:...]] form as the other service entries", () => {
    const body = buildPinServiceBody(MSG);
    expect(body).toBe(`[[system:pinned:${MSG}]]`);
    expect(body.startsWith(SYSTEM_MESSAGE_PREFIX)).toBe(true);
    expect(isServiceMessageBody(body)).toBe(true);
  });

  test("is read back as { action, messageId, actorId }", () => {
    expect(parsePinServiceBody(buildPinServiceBody(MSG), ACTOR)).toEqual({
      action: "pin",
      messageId: MSG,
      actorId: ACTOR,
    });
  });

  test("an unknown actor is null", () => {
    expect(parsePinServiceBody(buildPinServiceBody(MSG))).toEqual({
      action: "pin",
      messageId: MSG,
      actorId: null,
    });
  });

  test("the message id comes back in lower case", () => {
    expect(parsePinServiceBody(buildPinServiceBody(MSG.toUpperCase()), ACTOR).messageId).toBe(MSG);
  });

  test.each([
    ["ordinary text", "hello"],
    ["another service entry", "[[system:joined:Bob]]"],
    ["a pin entry without an id", "[[system:pinned:]]"],
    ["a pin entry with a bad id", "[[system:pinned:not-a-uuid]]"],
    ["a pin entry with extra text", `[[system:pinned:${MSG}]] more`],
    ["text before the entry", `x [[system:pinned:${MSG}]]`],
    ["null", null],
    ["undefined", undefined],
  ])("is null for %s", (_label, body) => {
    expect(parsePinServiceBody(body, ACTOR)).toBeNull();
  });
});
