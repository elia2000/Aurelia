import { describe, test, expect } from "vitest";
import {
  MAX_PINNED_CHATS_DEFAULT,
  MAX_PINNED_CHATS_MAX,
  MAX_PINNED_CHATS_MIN,
  buildPinsChangedEvents,
  clampMaxPinnedChats,
  decideChatPin,
  parseOrderBody,
  planCompaction,
  planReorder,
  toPinnedPayload,
} from "../../lib/chatPins.js";

const A = "a1a1a1a1-b2b2-4c3c-8d4d-e5e5e5e5e5e5";
const B = "b1b1b1b1-b2b2-4c3c-8d4d-e5e5e5e5e5e5";
const C = "c1c1c1c1-b2b2-4c3c-8d4d-e5e5e5e5e5e5";
const D = "d1d1d1d1-b2b2-4c3c-8d4d-e5e5e5e5e5e5";

describe("clampMaxPinnedChats", () => {
  test("the range is 1-30 and the default is 5", () => {
    expect(MAX_PINNED_CHATS_MIN).toBe(1);
    expect(MAX_PINNED_CHATS_MAX).toBe(30);
    expect(MAX_PINNED_CHATS_DEFAULT).toBe(5);
  });

  test.each([
    [undefined, 5],
    [null, 5],
    ["", 5],
    ["   ", 5],
    ["abc", 5],
    [NaN, 5],
    [Infinity, 5],
    [0, 1],
    [-4, 1],
    [1, 1],
    [7, 7],
    ["12", 12],
    [7.9, 7],
    [30, 30],
    [31, 30],
    [1000, 30],
  ])("%j becomes %j", (input, expected) => {
    expect(clampMaxPinnedChats(input)).toBe(expected);
  });
});

describe("toPinnedPayload", () => {
  test("maps rows to { chatId, position } ordered by position", () => {
    expect(
      toPinnedPayload([
        { chat_id: B, position: 1 },
        { chat_id: A, position: 0 },
      ]),
    ).toEqual([
      { chatId: A, position: 0 },
      { chatId: B, position: 1 },
    ]);
  });

  test("ties are broken by chat id so the order is stable", () => {
    expect(
      toPinnedPayload([
        { chat_id: B, position: 0 },
        { chat_id: A, position: 0 },
      ]).map((p) => p.chatId),
    ).toEqual([A, B]);
  });

  test("position is a number even when the database hands out a string (Postgres bigint)", () => {
    expect(toPinnedPayload([{ chat_id: A, position: "3" }])).toEqual([{ chatId: A, position: 3 }]);
  });

  test("rows without a chat id or position are skipped; nothing in, nothing out", () => {
    expect(toPinnedPayload([{ chat_id: null, position: 0 }, { chat_id: A }, null])).toEqual([]);
    expect(toPinnedPayload(undefined)).toEqual([]);
    expect(toPinnedPayload(null)).toEqual([]);
  });

  test("never exposes anything but the chat id and the position", () => {
    const [entry] = toPinnedPayload([{ chat_id: A, position: 0, user_id: "u", pinned_at: "x" }]);
    expect(Object.keys(entry).sort()).toEqual(["chatId", "position"]);
  });
});

describe("planCompaction", () => {
  test("nothing to write when the positions are already 0..n-1", () => {
    expect(
      planCompaction([
        { chat_id: A, position: 0 },
        { chat_id: B, position: 1 },
      ]),
    ).toEqual([]);
  });

  test("closes gaps and keeps the order", () => {
    expect(
      planCompaction([
        { chat_id: A, position: 0 },
        { chat_id: B, position: 2 },
        { chat_id: C, position: 5 },
      ]),
    ).toEqual([
      { chatId: B, position: 1 },
      { chatId: C, position: 2 },
    ]);
  });

  test("starts at 0 when the top pin was removed", () => {
    expect(planCompaction([{ chat_id: B, position: 1 }])).toEqual([{ chatId: B, position: 0 }]);
  });

  test("an empty set needs nothing", () => {
    expect(planCompaction([])).toEqual([]);
    expect(planCompaction(undefined)).toEqual([]);
  });
});

describe("planReorder", () => {
  const current = [
    { chat_id: A, position: 0 },
    { chat_id: B, position: 1 },
    { chat_id: C, position: 2 },
  ];

  test("the same order changes nothing", () => {
    expect(planReorder(current, [A, B, C])).toEqual({ ok: true, updates: [] });
  });

  test("a new order writes only the rows that moved", () => {
    expect(planReorder(current, [C, B, A])).toEqual({
      ok: true,
      updates: [
        { chatId: C, position: 0 },
        { chatId: A, position: 2 },
      ],
    });
  });

  test("a gap-ridden current state is renumbered", () => {
    expect(
      planReorder(
        [
          { chat_id: A, position: 3 },
          { chat_id: B, position: 9 },
        ],
        [A, B],
      ),
    ).toEqual({
      ok: true,
      updates: [
        { chatId: A, position: 0 },
        { chatId: B, position: 1 },
      ],
    });
  });

  test.each([
    ["a missing chat", [A, B]],
    ["an extra chat", [A, B, C, D]],
    ["a chat that is not pinned", [A, B, D]],
    ["a duplicate", [A, A, B]],
    ["an empty list for a non-empty set", []],
  ])("refuses %s", (_name, requested) => {
    expect(planReorder(current, requested)).toEqual({ ok: false });
  });

  test("an empty list is fine for an empty set", () => {
    expect(planReorder([], [])).toEqual({ ok: true, updates: [] });
  });
});

describe("parseOrderBody", () => {
  test("accepts a list of distinct UUIDs", () => {
    expect(parseOrderBody({ chatIds: [A, B] })).toEqual({ ok: true, chatIds: [A, B] });
  });

  test("accepts an empty list", () => {
    expect(parseOrderBody({ chatIds: [] })).toEqual({ ok: true, chatIds: [] });
  });

  test.each([
    ["no body", undefined],
    ["a string body", "x"],
    ["no chatIds", {}],
    ["a string", { chatIds: A }],
    ["an object", { chatIds: { 0: A } }],
    ["null", { chatIds: null }],
  ])("rejects %s", (_name, body) => {
    const result = parseOrderBody(body);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/chatIds/);
  });

  test.each([
    ["a number", [1]],
    ["null", [null]],
    ["a nested array", [[A]]],
    ["an object", [{ id: A }]],
    ["text that is no UUID", ["nope"]],
    ["a UUID with spaces", [` ${A}`]],
    ["a SQL fragment", ["x' OR '1'='1"]],
  ])("rejects an entry that is %s", (_name, chatIds) => {
    const result = parseOrderBody({ chatIds });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/UUID/);
  });

  test("rejects duplicates", () => {
    const result = parseOrderBody({ chatIds: [A, B, A] });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/twice|duplicate/i);
  });

  test("rejects more entries than anybody may pin", () => {
    const many = Array.from({ length: MAX_PINNED_CHATS_MAX + 1 }, (_, i) =>
      `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    const result = parseOrderBody({ chatIds: many });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/at most/i);
  });

  test("accepts exactly the largest allowed list", () => {
    const many = Array.from({ length: MAX_PINNED_CHATS_MAX }, (_, i) =>
      `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    expect(parseOrderBody({ chatIds: many }).ok).toBe(true);
  });
});

describe("buildPinsChangedEvents", () => {
  const holders = [
    { user_id: "u1", username: "Alice" },
    { user_id: "u2", username: "bob" },
  ];

  test("one event per person with only that person's pins", () => {
    const events = buildPinsChangedEvents(holders, [
      { user_id: "u1", chat_id: A, position: 0 },
      { user_id: "u2", chat_id: B, position: 0 },
      { user_id: "u1", chat_id: C, position: 1 },
    ]);
    expect(events).toEqual([
      {
        targetUsername: "alice",
        payload: {
          type: "chat_pins_changed",
          pinned: [
            { chatId: A, position: 0 },
            { chatId: C, position: 1 },
          ],
        },
      },
      {
        targetUsername: "bob",
        payload: { type: "chat_pins_changed", pinned: [{ chatId: B, position: 0 }] },
      },
    ]);
  });

  test("a person who has nothing pinned any more still gets the (empty) list", () => {
    const events = buildPinsChangedEvents([holders[0]], []);
    expect(events).toEqual([
      { targetUsername: "alice", payload: { type: "chat_pins_changed", pinned: [] } },
    ]);
  });

  test("holders without a username are skipped; bad input gives no events", () => {
    expect(buildPinsChangedEvents([{ user_id: "u1", username: "" }], [])).toEqual([]);
    expect(buildPinsChangedEvents(undefined, undefined)).toEqual([]);
  });
});

describe("decideChatPin", () => {
  const rows = [
    { chat_id: A, position: 0 },
    { chat_id: B, position: 1 },
  ];

  test("a chat that is pinned stays where it is", () => {
    expect(decideChatPin({ rows, chatId: B, max: 2 })).toEqual({ action: "already", position: 1 });
  });

  test("a pinned chat is 'already' even when the list is full", () => {
    expect(decideChatPin({ rows, chatId: A, max: 2 }).action).toBe("already");
  });

  test("a new chat is refused when the limit is used up, also when it was lowered below the count", () => {
    expect(decideChatPin({ rows, chatId: C, max: 2 })).toEqual({ action: "limit" });
    expect(decideChatPin({ rows, chatId: C, max: 1 })).toEqual({ action: "limit" });
  });

  test("a new chat is accepted while there is room", () => {
    expect(decideChatPin({ rows, chatId: C, max: 3 })).toEqual({ action: "insert" });
    expect(decideChatPin({ rows: [], chatId: C, max: 1 })).toEqual({ action: "insert" });
  });

  test("a nonsense limit is at least 1", () => {
    expect(decideChatPin({ rows: [], chatId: C, max: 0 })).toEqual({ action: "insert" });
    expect(decideChatPin({ rows, chatId: C, max: -3 })).toEqual({ action: "limit" });
  });
});
