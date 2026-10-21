import { describe, test, expect } from "vitest";
import {
  DEFAULT_MAX_PINNED_MESSAGES,
  MAX_BAR_SEGMENTS,
  barIndexAfterChange,
  barSegments,
  buildPinSystemEvent,
  canManagePins,
  clampBarIndex,
  clampMaxPinnedMessages,
  describePinError,
  getMemberRole,
  hasPin,
  isPinServiceMessage,
  isPinnableMessage,
  nextBarIndex,
  normalizePin,
  normalizePinList,
  parsePinService,
  pinBarTitle,
  pinLimitText,
  pinOrdinal,
  pinPreview,
  removePin,
  samePins,
} from "../../src/utils/messagePins.js";

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ME = id(901);

const rawPin = (n, extra = {}, message = {}) => ({
  messageId: id(n),
  pinnedBy: ME,
  pinnedAt: `2026-03-0${n}T10:00:00.000Z`,
  message: {
    id: id(n),
    senderId: ME,
    senderName: "Ada",
    type: "text",
    text: `message ${n}`,
    hasFile: false,
    fileKind: null,
    createdAt: "2026-03-01T09:00:00.000Z",
    ...message,
  },
  ...extra,
});

const pins = (...numbers) => normalizePinList(numbers.map((n) => rawPin(n)));

describe("canManagePins", () => {
  test("anybody can pin in a direct chat and in Saved Messages", () => {
    expect(canManagePins({ chatType: "dm", role: "member" })).toBe(true);
    expect(canManagePins({ chatType: "saved", role: "owner" })).toBe(true);
  });

  test("in a group: the owner, or every member when the owner allowed it", () => {
    expect(canManagePins({ chatType: "group", role: "owner", allowMemberPins: 0 })).toBe(true);
    expect(canManagePins({ chatType: "group", role: "member", allowMemberPins: 0 })).toBe(false);
    expect(canManagePins({ chatType: "group", role: "member", allowMemberPins: 1 })).toBe(true);
    expect(canManagePins({ chatType: "group", role: "member" })).toBe(false);
  });

  test("in a channel only the owner, whatever the group setting says", () => {
    expect(canManagePins({ chatType: "channel", role: "owner" })).toBe(true);
    expect(canManagePins({ chatType: "channel", role: "member", allowMemberPins: 1 })).toBe(false);
  });

  test("an unknown chat type offers nothing", () => {
    expect(canManagePins({ chatType: "mystery", role: "owner" })).toBe(false);
    expect(canManagePins()).toBe(false);
  });

  test("getMemberRole reads the role of the signed-in person", () => {
    const members = [{ id: id(1), role: "Owner" }, { id: id(2), role: "member" }];
    expect(getMemberRole(members, id(1))).toBe("owner");
    expect(getMemberRole(members, id(2))).toBe("member");
    expect(getMemberRole(members, id(3))).toBe("");
    expect(getMemberRole(null, id(1))).toBe("");
  });
});

describe("isPinnableMessage", () => {
  test("a sent ordinary message can be pinned", () => {
    expect(isPinnableMessage({ id: id(1), body: "hi" })).toBe(true);
    expect(isPinnableMessage({ _serverId: id(1), id: "temp", body: "hi" })).toBe(true);
  });

  test("not a service line, a call entry, an unsent or a processing message", () => {
    expect(isPinnableMessage({ id: id(1), body: "[[system:left:Bob]]" })).toBe(false);
    expect(isPinnableMessage({ id: id(1), _systemEvent: { type: "pin" } })).toBe(false);
    expect(isPinnableMessage({ id: id(1), service: { action: "pin" } })).toBe(false);
    expect(isPinnableMessage({ id: id(1), messageType: "call", call: {} })).toBe(false);
    expect(isPinnableMessage({ id: id(1), _delivery: "sending" })).toBe(false);
    expect(isPinnableMessage({ id: id(1), _delivery: "failed" })).toBe(false);
    expect(isPinnableMessage({ id: id(1), _processingPending: true })).toBe(false);
    expect(isPinnableMessage({ id: "local-1" })).toBe(false);
    expect(isPinnableMessage(null)).toBe(false);
  });
});

describe("normalizePin and normalizePinList", () => {
  test("reads the server's entry", () => {
    expect(normalizePin(rawPin(1))).toEqual({
      messageId: id(1),
      pinnedBy: ME,
      pinnedAt: "2026-03-01T10:00:00.000Z",
      message: {
        id: id(1),
        senderId: ME,
        senderName: "Ada",
        type: "text",
        text: "message 1",
        hasFile: false,
        fileKind: null,
        createdAt: "2026-03-01T09:00:00.000Z",
      },
    });
  });

  test("an entry without a valid message id is dropped", () => {
    expect(normalizePin({ messageId: "x" })).toBeNull();
    expect(normalizePin(null)).toBeNull();
    expect(normalizePinList([{ messageId: "x" }, rawPin(2)]).map((p) => p.messageId)).toEqual([id(2)]);
  });

  test("an unknown file kind is ignored, a known one marks the pin as a file", () => {
    expect(normalizePin(rawPin(1, {}, { fileKind: "hologram" })).message.fileKind).toBeNull();
    const photo = normalizePin(rawPin(1, {}, { fileKind: "image", type: "image", hasFile: true, text: "" }));
    expect(photo.message).toMatchObject({ fileKind: "image", hasFile: true, type: "image" });
  });

  test("lists come out newest first, each message once", () => {
    const list = normalizePinList([rawPin(1), rawPin(3), rawPin(2), rawPin(3)]);
    expect(list.map((p) => p.messageId)).toEqual([id(3), id(2), id(1)]);
  });

  test("pins pinned at the same time keep the server's order", () => {
    const at = "2026-03-01T10:00:00.000Z";
    const list = normalizePinList([
      rawPin(2, { pinnedAt: at }),
      rawPin(1, { pinnedAt: at }),
    ]);
    expect(list.map((p) => p.messageId)).toEqual([id(2), id(1)]);
  });

  test("anything that is not a list is an empty list", () => {
    expect(normalizePinList(undefined)).toEqual([]);
    expect(normalizePinList({})).toEqual([]);
  });

  test("hasPin, removePin and samePins", () => {
    const list = pins(3, 2, 1);
    expect(hasPin(list, id(2))).toBe(true);
    expect(hasPin(list, id(9))).toBe(false);
    expect(removePin(list, id(2)).map((p) => p.messageId)).toEqual([id(3), id(1)]);
    expect(removePin(list, id(9))).toBe(list);
    expect(samePins(list, pins(3, 2, 1))).toBe(true);
    expect(samePins(list, pins(3, 2))).toBe(false);
    const edited = normalizePinList([rawPin(3, {}, { text: "changed" }), rawPin(2), rawPin(1)]);
    expect(samePins(list, edited)).toBe(false);
  });
});

describe("pinPreview", () => {
  test("a text pin shows the sender and the text", () => {
    expect(pinPreview(pins(1)[0])).toMatchObject({ sender: "Ada", text: "message 1", hasText: true });
  });

  test("a pin without text names its kind of file", () => {
    const kinds = {
      image: "Photo",
      video: "Video",
      audio: "Audio",
      document: "File",
      video_note: "Video message",
    };
    Object.entries(kinds).forEach(([fileKind, label]) => {
      const pin = normalizePin(rawPin(1, {}, { fileKind, hasFile: true, text: "" }));
      expect(pinPreview(pin)).toMatchObject({ text: label, hasText: false });
    });
  });

  test("a caption wins over the kind label", () => {
    const pin = normalizePin(rawPin(1, {}, { fileKind: "image", hasFile: true, text: "Sunset" }));
    expect(pinPreview(pin)).toMatchObject({ text: "Sunset", label: "Photo" });
  });

  test("an empty pin still says something", () => {
    const pin = normalizePin(rawPin(1, {}, { text: "", senderName: "" }));
    expect(pinPreview(pin).text).toBe("Message");
  });
});

describe("the bar: title, order and cycling", () => {
  test("one pin has no number, several count from the oldest", () => {
    expect(pinBarTitle(0, 1)).toBe("Pinned message");
    expect(pinBarTitle(0, 3)).toBe("Pinned message #3");
    expect(pinBarTitle(1, 3)).toBe("Pinned message #2");
    expect(pinBarTitle(2, 3)).toBe("Pinned message #1");
    expect(pinOrdinal(0, 2)).toBe(2);
  });

  test("a click moves to the next older pin and wraps to the newest", () => {
    expect(nextBarIndex(0, 3)).toBe(1);
    expect(nextBarIndex(1, 3)).toBe(2);
    expect(nextBarIndex(2, 3)).toBe(0);
    expect(nextBarIndex(0, 1)).toBe(0);
    expect(nextBarIndex(0, 0)).toBe(0);
  });

  test("clampBarIndex keeps the index inside the list", () => {
    expect(clampBarIndex(5, 3)).toBe(2);
    expect(clampBarIndex(-2, 3)).toBe(0);
    expect(clampBarIndex(Number.NaN, 3)).toBe(0);
    expect(clampBarIndex(1, 0)).toBe(0);
  });

  test("a new pin brings the bar to the newest", () => {
    const previous = pins(2, 1);
    const next = pins(3, 2, 1);
    expect(barIndexAfterChange({ previous, next, index: 1 })).toBe(0);
  });

  test("the bar stays on its message when another pin goes away", () => {
    const previous = pins(3, 2, 1);
    expect(barIndexAfterChange({ previous, next: pins(3, 1), index: 2 })).toBe(1);
    expect(barIndexAfterChange({ previous, next: pins(2, 1), index: 1 })).toBe(0);
  });

  test("when the shown pin goes away the bar keeps its place in the list", () => {
    const previous = pins(3, 2, 1);
    expect(barIndexAfterChange({ previous, next: pins(3, 1), index: 1 })).toBe(1);
    expect(barIndexAfterChange({ previous, next: pins(3, 2), index: 2 })).toBe(1);
  });

  test("an empty list resets the bar", () => {
    expect(barIndexAfterChange({ previous: pins(1), next: [], index: 0 })).toBe(0);
  });

  test("the first list ever received starts at the newest", () => {
    expect(barIndexAfterChange({ previous: [], next: pins(2, 1), index: 0 })).toBe(0);
  });
});

describe("barSegments", () => {
  test("no segments for zero or one pin", () => {
    expect(barSegments({ index: 0, count: 0 })).toEqual([]);
    expect(barSegments({ index: 0, count: 1 })).toEqual([]);
  });

  test("one segment per pin, the oldest on top; the shown one is active", () => {
    // 3 pins: index 0 is the newest = the bottom segment
    expect(barSegments({ index: 0, count: 3 })).toEqual([
      { active: false },
      { active: false },
      { active: true },
    ]);
    expect(barSegments({ index: 2, count: 3 }).map((s) => s.active)).toEqual([true, false, false]);
  });

  test("many pins show a sliding window of MAX_BAR_SEGMENTS", () => {
    for (let index = 0; index < 9; index += 1) {
      const segments = barSegments({ index, count: 9 });
      expect(segments).toHaveLength(MAX_BAR_SEGMENTS);
      expect(segments.filter((s) => s.active)).toHaveLength(1);
    }
  });
});

describe("the pin line in the chat", () => {
  const SERVICE = { action: "pin", messageId: id(7), actorId: id(5) };

  test("recognises the structured field and the body convention", () => {
    expect(parsePinService({ service: SERVICE })).toEqual({ messageId: id(7), actorId: id(5) });
    expect(parsePinService({ body: `[[system:pinned:${id(7)}]]`, user_id: id(5) })).toEqual({
      messageId: id(7),
      actorId: id(5),
    });
    expect(isPinServiceMessage({ body: `[[system:pinned:${id(7)}]]` })).toBe(true);
  });

  test("other messages and other service lines are not pin lines", () => {
    expect(parsePinService({ body: "hello" })).toBeNull();
    expect(parsePinService({ body: "[[system:left:Bob]]" })).toBeNull();
    expect(parsePinService({ body: "[[system:pinned:not-an-id]]" })).toBeNull();
    expect(parsePinService({ service: { action: "pin", messageId: "x" } })).toBeNull();
    expect(parsePinService(null)).toBeNull();
  });

  test("the chip names the actor, or says You, and points at the pinned message", () => {
    const other = buildPinSystemEvent({ service: SERVICE, nickname: "Bea", username: "bea" });
    expect(other).toMatchObject({
      type: "pin",
      name: "Bea",
      suffix: "pinned a message",
      text: "Bea pinned a message",
      jumpToMessageId: id(7),
    });
    expect(buildPinSystemEvent({ service: SERVICE, username: "ada" }, { isOwn: true }).name).toBe("You");
    expect(buildPinSystemEvent({ service: SERVICE, username: "bea" }).name).toBe("bea");
    expect(buildPinSystemEvent({ service: SERVICE }).name).toBe("A member");
    expect(buildPinSystemEvent({ body: "hello" })).toBeNull();
  });
});

describe("limits and notices", () => {
  test("clampMaxPinnedMessages keeps 1-100", () => {
    expect(clampMaxPinnedMessages(20)).toBe(20);
    expect(clampMaxPinnedMessages(500)).toBe(100);
    expect(clampMaxPinnedMessages(0)).toBe(DEFAULT_MAX_PINNED_MESSAGES);
    expect(clampMaxPinnedMessages(undefined)).toBe(DEFAULT_MAX_PINNED_MESSAGES);
  });

  test("pinLimitText names the limit", () => {
    expect(pinLimitText(20)).toBe("You can pin up to 20 messages in a chat");
    expect(pinLimitText(1)).toBe("You can pin up to 1 message in a chat");
    expect(pinLimitText(null)).toMatch(/can't pin more/i);
  });

  test("describePinError reads the limit from the server's text", () => {
    const body = {
      code: "pin_limit",
      error: "A chat can have at most 7 pinned messages. Unpin one first.",
    };
    expect(describePinError({ status: 409, body })).toBe("You can pin up to 7 messages in a chat");
    expect(describePinError({ status: 409, body: { code: "pin_limit" }, fallbackMax: 20 })).toBe(
      "You can pin up to 20 messages in a chat",
    );
  });

  test("describePinError for the other refusals", () => {
    expect(describePinError({ status: 403, body: {} })).toMatch(/can't pin/i);
    expect(describePinError({ status: 404, body: {} })).toMatch(/no longer available/i);
    expect(describePinError({ status: 429, body: {} })).toMatch(/too many/i);
    expect(describePinError({ status: 500 })).toMatch(/couldn't update/i);
  });
});
