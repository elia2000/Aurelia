import { describe, test, expect, vi } from "vitest";
import {
  MAX_PINNED_DEFAULT,
  PIN_PREVIEW_MAX_CHARS,
  PIN_PREVIEW_SOURCE_MAX_CHARS,
  buildPinEntry,
  buildPreviewText,
  canManagePins,
  chatTypeGetsPinServiceMessage,
  classifyAttachment,
  clampMaxPinnedMessages,
  emitUnpinnedMessages,
  groupPinsByChat,
  stripMarkdown,
  toIsoTimestamp,
  truncateChars,
} from "../../lib/pins.js";

const A = "a0a0a0a0-b1b1-4c2c-8d3d-e4e4e4e4e4e4";
const B = "b0b0b0b0-c1c1-4d2d-9e3e-f5f5f5f5f5f5";
const CHAT = "c0c0c0c0-d1d1-4e2e-af3f-060606060606";
const CHAT_2 = "c1c1c1c1-d1d1-4e2e-af3f-070707070707";
const M1 = "d0d0d0d0-e1e1-4f2f-b040-171717171717";
const M2 = "e0e0e0e0-f1f1-4020-c151-282828282828";

describe("clampMaxPinnedMessages", () => {
  test.each([
    [20, 20],
    [1, 1],
    [100, 100],
    [0, 1],
    [-3, 1],
    [101, 100],
    [9999, 100],
    ["7", 7],
    [7.9, 7],
  ])("%j -> %j", (input, expected) => {
    expect(clampMaxPinnedMessages(input)).toBe(expected);
  });

  test.each([[null], [undefined], [""], ["  "], ["many"], [NaN], [Infinity], [{}]])(
    "%j is the default",
    (input) => {
      expect(clampMaxPinnedMessages(input)).toBe(MAX_PINNED_DEFAULT);
    },
  );
});

describe("canManagePins", () => {
  test.each(["member", "owner", "admin", ""])("direct messages: role %j may", (role) => {
    expect(canManagePins({ chatType: "dm", role })).toBe(true);
  });

  test("Saved Messages: the person may", () => {
    expect(canManagePins({ chatType: "saved", role: "owner" })).toBe(true);
    expect(canManagePins({ chatType: "saved", role: "member" })).toBe(true);
  });

  test("group: owner and administrators may, members only with the setting", () => {
    expect(canManagePins({ chatType: "group", role: "owner" })).toBe(true);
    expect(canManagePins({ chatType: "group", role: "admin" })).toBe(true);
    expect(canManagePins({ chatType: "group", role: "member" })).toBe(false);
    expect(canManagePins({ chatType: "group", role: "member", allowMemberPins: 0 })).toBe(false);
    expect(canManagePins({ chatType: "group", role: "member", allowMemberPins: 1 })).toBe(true);
    expect(canManagePins({ chatType: "group", role: "member", allowMemberPins: true })).toBe(true);
    expect(canManagePins({ chatType: "group", role: "member", allowMemberPins: "1" })).toBe(true);
    expect(canManagePins({ chatType: "group", role: "member", allowMemberPins: "0" })).toBe(false);
  });

  test("channel: only owner and administrators, whatever the group setting says", () => {
    expect(canManagePins({ chatType: "channel", role: "owner" })).toBe(true);
    expect(canManagePins({ chatType: "channel", role: "admin" })).toBe(true);
    expect(canManagePins({ chatType: "channel", role: "member" })).toBe(false);
    expect(canManagePins({ chatType: "channel", role: "member", allowMemberPins: 1 })).toBe(false);
  });

  test("anything unknown is refused", () => {
    expect(canManagePins({ chatType: "", role: "owner" })).toBe(false);
    expect(canManagePins({ chatType: "bot", role: "owner" })).toBe(false);
    expect(canManagePins({})).toBe(false);
    expect(canManagePins({ chatType: "group", role: null })).toBe(false);
  });

  test("is case-insensitive about types and roles", () => {
    expect(canManagePins({ chatType: "GROUP", role: "OWNER" })).toBe(true);
  });
});

describe("chatTypeGetsPinServiceMessage", () => {
  test.each([
    ["dm", true],
    ["saved", true],
    ["group", true],
    ["channel", false],
    ["", false],
    [null, false],
  ])("%j -> %j", (type, expected) => {
    expect(chatTypeGetsPinServiceMessage(type)).toBe(expected);
  });
});

describe("stripMarkdown", () => {
  test.each([
    ["**bold** text", "bold text"],
    ["__bold__ text", "bold text"],
    ["*italic* and _italic_", "italic and italic"],
    ["~~gone~~", "gone"],
    ["||spoiler||", "spoiler"],
    ["`code` here", "code here"],
    ["[a link](https://example.com/x?y=1) rest", "a link rest"],
    ["![an image](https://example.com/i.png)", "an image"],
    ["# Heading\nbody", "Heading body"],
    ["> quoted", "quoted"],
    ["```js\nconst a = 1;\n```", "const a = 1;"],
    ["snake_case_name stays", "snake_case_name stays"],
    ["2 * 3 * 4", "2 * 3 * 4"],
    ["line one\n\n  line   two", "line one line two"],
    ["", ""],
    [null, ""],
    [undefined, ""],
  ])("%j -> %j", (input, expected) => {
    expect(stripMarkdown(input)).toBe(expected);
  });

  test("does not hang on pathological input", () => {
    const started = Date.now();
    stripMarkdown("*".repeat(5000) + "_".repeat(5000) + "`".repeat(5000));
    stripMarkdown("[".repeat(3000) + "(".repeat(3000));
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

// A pin list is rebuilt on every read and a message can be thousands of
// characters long, so the cost of a preview must not depend on how long or how
// hostile the text is (the markdown patterns used to backtrack quadratically).
describe("previews of very long or hostile messages", () => {
  const hostile = {
    "open brackets": (n) => "[".repeat(n),
    "open image brackets": (n) => "![".repeat(n / 2),
    "unfinished links": (n) => "[a](".repeat(n / 4),
    "unclosed bold": (n) => "**a ".repeat(n / 4),
    "unclosed strike-through": (n) => "~~a ".repeat(n / 4),
    "unclosed spoilers": (n) => "||a ".repeat(n / 4),
    "mixed markers": (n) => "*_`[(|~".repeat(n / 7),
  };

  test.each(Object.keys(hostile))("twenty pinned messages of %s cost next to nothing", (name) => {
    const body = hostile[name](20000);
    const started = performance.now();
    for (let i = 0; i < 20; i += 1) buildPreviewText(body);
    expect(performance.now() - started).toBeLessThan(250);
  });

  test("a whole pin list of hostile messages is built quickly", () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      message_id: `d0d0d0d0-e1e1-4f2f-b040-1717171717${String(i).padStart(2, "0")}`,
      sender_id: A,
      sender_username: "alice",
      body: "[".repeat(20000),
      edited_body: i % 2 ? "[a](".repeat(5000) : null,
      message_created_at: "2025-01-01 10:00:00",
      file_count: 0,
    }));
    const started = performance.now();
    const entries = rows.map((row) => buildPinEntry(row, { type: "group" }));
    expect(performance.now() - started).toBeLessThan(250);
    expect(entries).toHaveLength(20);
    for (const entry of entries) {
      expect(Array.from(entry.message.text).length).toBeLessThanOrEqual(PIN_PREVIEW_MAX_CHARS);
    }
  });

  test("only the start of a message is read, and it is still the right start", () => {
    const body = `**bold** and [a link](https://example.com) ${"word ".repeat(20000)}`;
    const preview = buildPreviewText(body);
    expect(preview.startsWith("bold and a link word word")).toBe(true);
    expect(Array.from(preview)).toHaveLength(PIN_PREVIEW_MAX_CHARS);
    expect(preview.endsWith("…")).toBe(true);
  });

  test("markdown that ends before the cut is still taken apart", () => {
    const body = `${"x".repeat(100)} ~~gone~~ [site](https://example.com/${"p".repeat(300)}) end ${"y".repeat(5000)}`;
    const text = stripMarkdown(body);
    expect(text.startsWith(`${"x".repeat(100)} gone site end `)).toBe(true);
  });

  test("the cut never leaves half of an emoji behind", () => {
    const body = `${"x".repeat(PIN_PREVIEW_SOURCE_MAX_CHARS - 1)}\u{1F600} and more`;
    const text = stripMarkdown(body);
    expect(text).toMatch(/x$/);
    expect(text).not.toMatch(/[\ud800-\udbff]$/);
  });

  test("a message shorter than the cut is read whole", () => {
    const body = `${"a ".repeat(PIN_PREVIEW_SOURCE_MAX_CHARS / 2 - 4)}**end**`;
    expect(stripMarkdown(body).endsWith("a end")).toBe(true);
  });
});

describe("truncateChars / buildPreviewText", () => {
  test("short text is untouched", () => {
    expect(truncateChars("hello", 10)).toBe("hello");
  });

  test("long text is cut with an ellipsis and never exceeds the limit", () => {
    const cut = truncateChars("x".repeat(500), 140);
    expect(Array.from(cut)).toHaveLength(140);
    expect(cut.endsWith("…")).toBe(true);
  });

  test("counts characters, not UTF-16 units, so emoji are not split", () => {
    const text = "\u{1F600}".repeat(200);
    const cut = truncateChars(text, 140);
    expect(Array.from(cut)).toHaveLength(140);
    expect(cut).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  test("the preview is the stripped text cut to 140 characters", () => {
    const preview = buildPreviewText(`**${"word ".repeat(100).trim()}**`);
    expect(Array.from(preview).length).toBeLessThanOrEqual(PIN_PREVIEW_MAX_CHARS);
    expect(preview).not.toContain("*");
    expect(PIN_PREVIEW_MAX_CHARS).toBe(140);
  });
});

describe("classifyAttachment", () => {
  test("no file is no attachment", () => {
    expect(classifyAttachment({ fileCount: 0 })).toBeNull();
    expect(classifyAttachment({})).toBeNull();
  });

  test.each([
    ["image/png", "media", "image"],
    ["image/jpeg", "image", "image"],
    ["video/mp4", "media", "video"],
    ["audio/ogg", "audio", "audio"],
    ["audio/mpeg", "media", "audio"],
    ["application/pdf", "document", "document"],
    ["application/zip", "", "document"],
    ["", "", "document"],
    ["image/png", "document", "document"],
  ])("%s (%s) -> %s", (mime, kind, expected) => {
    expect(classifyAttachment({ fileCount: 1, firstFileMime: mime, firstFileKind: kind })).toBe(expected);
  });

  test("an encrypted round video is a video note", () => {
    expect(classifyAttachment({ fileCount: 1, firstFileMime: "video/mp4", encrypted: true })).toBe("video_note");
  });
});

describe("toIsoTimestamp", () => {
  test("turns the stored UTC format into ISO 8601", () => {
    expect(toIsoTimestamp("2025-01-01 10:00:00")).toBe("2025-01-01T10:00:00.000Z");
  });

  test("keeps ISO strings", () => {
    expect(toIsoTimestamp("2025-01-01T10:00:00.000Z")).toBe("2025-01-01T10:00:00.000Z");
  });

  test.each([[null], [undefined], [""], ["garbage"]])("%j -> null", (value) => {
    expect(toIsoTimestamp(value)).toBeNull();
  });
});

describe("buildPinEntry", () => {
  const row = {
    message_id: M1,
    pinned_by: A,
    pinned_at: "2025-02-02T00:00:00.000Z",
    sender_id: B,
    sender_username: "bob",
    sender_nickname: "Bobby",
    body: "**hi** there",
    edited_body: null,
    message_created_at: "2025-01-01 10:00:00",
    e2ee_envelope: null,
    file_count: 0,
    first_file_mime: null,
    first_file_kind: null,
  };

  test("has exactly the documented shape", () => {
    expect(buildPinEntry(row, { type: "group", name: "G" })).toEqual({
      messageId: M1,
      pinnedBy: A,
      pinnedAt: "2025-02-02T00:00:00.000Z",
      message: {
        id: M1,
        senderId: B,
        senderName: "Bobby",
        type: "text",
        text: "hi there",
        hasFile: false,
        fileKind: null,
        createdAt: "2025-01-01T10:00:00.000Z",
      },
    });
  });

  test("falls back to the username, then to a deleted user", () => {
    expect(buildPinEntry({ ...row, sender_nickname: null }, { type: "group" }).message.senderName).toBe("bob");
    expect(
      buildPinEntry({ ...row, sender_id: null, sender_username: null, sender_nickname: null }, { type: "group" })
        .message.senderName,
    ).toBe("Deleted user");
  });

  test("a channel's posts speak for the channel", () => {
    expect(buildPinEntry(row, { type: "channel", name: "News" }).message.senderName).toBe("News");
    expect(buildPinEntry(row, { type: "channel", name: "", group_username: "news" }).message.senderName).toBe("news");
    expect(buildPinEntry(row, { type: "channel" }).message.senderName).toBe("Channel");
  });

  test("an edited message shows its current text", () => {
    expect(buildPinEntry({ ...row, edited_body: "new" }, { type: "group" }).message.text).toBe("new");
  });

  test("a pin whose person is gone keeps pinnedBy null", () => {
    expect(buildPinEntry({ ...row, pinned_by: null }, { type: "group" }).pinnedBy).toBeNull();
  });

  test("files set the type and flags", () => {
    const entry = buildPinEntry(
      { ...row, body: "", file_count: 2, first_file_mime: "image/png", first_file_kind: "media" },
      { type: "group" },
    );
    expect(entry.message).toMatchObject({ type: "image", hasFile: true, fileKind: "image", text: "" });
  });
});

describe("groupPinsByChat / emitUnpinnedMessages", () => {
  const rows = [
    { chat_id: CHAT, message_id: M1 },
    { chat_id: CHAT, message_id: M2 },
    { chat_id: CHAT_2, message_id: M1 },
    { chat_id: null, message_id: M1 },
    null,
  ];

  test("groups message ids by chat and skips junk", () => {
    expect([...groupPinsByChat(rows)]).toEqual([
      [CHAT, [M1, M2]],
      [CHAT_2, [M1]],
    ]);
    expect(groupPinsByChat(undefined).size).toBe(0);
  });

  test("tells each chat about each unpinned message", () => {
    const emit = vi.fn();
    emitUnpinnedMessages(emit, rows);
    expect(emit.mock.calls).toEqual([
      [CHAT, { type: "message_unpinned", chatId: CHAT, messageId: M1 }],
      [CHAT, { type: "message_unpinned", chatId: CHAT, messageId: M2 }],
      [CHAT_2, { type: "message_unpinned", chatId: CHAT_2, messageId: M1 }],
    ]);
  });

  test("does nothing without a sender or without rows", () => {
    expect(() => emitUnpinnedMessages(undefined, rows)).not.toThrow();
    const emit = vi.fn();
    emitUnpinnedMessages(emit, []);
    emitUnpinnedMessages(emit, undefined);
    expect(emit).not.toHaveBeenCalled();
  });
});
