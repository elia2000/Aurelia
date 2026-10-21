import { describe, test, expect } from "vitest";
import {
  BATCH_MESSAGE_LIMIT,
  FORWARD_MAX_CREATED_MESSAGES,
  FORWARD_MAX_TARGET_CHATS,
  allocateAscendingIds,
  commonFailureStatus,
  compareChronologically,
  createdAtMs,
  parseMessageIdList,
  sortChronologically,
} from "../../lib/batchMessages.js";

const id = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

describe("limits", () => {
  test("the documented numbers", () => {
    expect(BATCH_MESSAGE_LIMIT).toBe(100);
    expect(FORWARD_MAX_TARGET_CHATS).toBe(20);
    expect(FORWARD_MAX_CREATED_MESSAGES).toBe(500);
  });
});

describe("parseMessageIdList", () => {
  test("accepts 1 to 100 uuids and keeps their order", () => {
    expect(parseMessageIdList([id(3), id(1), id(2)], "ids")).toEqual({ ok: true, ids: [id(3), id(1), id(2)] });
    const hundred = Array.from({ length: 100 }, (_, i) => id(i + 1));
    expect(parseMessageIdList(hundred, "ids")).toEqual({ ok: true, ids: hundred });
  });

  test("101 is too many, even when they are all the same id", () => {
    const tooMany = Array.from({ length: 101 }, (_, i) => id(i + 1));
    expect(parseMessageIdList(tooMany, "messageIds")).toEqual({
      ok: false,
      error: "Field 'messageIds' can name at most 100 messages.",
    });
    expect(parseMessageIdList(Array.from({ length: 101 }, () => id(1)), "ids").ok).toBe(false);
  });

  test("an empty list is refused", () => {
    expect(parseMessageIdList([], "ids")).toEqual({
      ok: false,
      error: "Field 'ids' must name at least one message.",
    });
  });

  test.each([["a string", "x"], ["null", null], ["undefined", undefined], ["an object", {}], ["a number", 4]])(
    "%s is not a list",
    (_name, value) => {
      expect(parseMessageIdList(value, "ids")).toEqual({
        ok: false,
        error: "Field 'ids' must be an array of message ids.",
      });
    },
  );

  test.each([
    ["a non-uuid string", "nope"],
    ["an empty string", ""],
    ["a number", 7],
    ["null", null],
    ["a nested list", [id(1)]],
    ["an object", { id: id(1) }],
    ["a uuid with a trailing character", `${id(1)}x`],
  ])("an entry that is %s is refused", (_name, entry) => {
    expect(parseMessageIdList([id(2), entry], "ids")).toEqual({
      ok: false,
      error: "Field 'ids' contains an invalid UUID.",
    });
  });

  test("surrounding spaces are ignored and a repeated id counts once (first place wins)", () => {
    expect(parseMessageIdList([id(2), ` ${id(1)} `, id(2), id(1)], "ids")).toEqual({
      ok: true,
      ids: [id(2), id(1)],
    });
  });

  test("a custom limit", () => {
    expect(parseMessageIdList([id(1), id(2)], "ids", 1).ok).toBe(false);
    expect(parseMessageIdList([id(1)], "ids", 1).ok).toBe(true);
  });
});

describe("createdAtMs", () => {
  test("the stored format, ISO text and dates mean the same moment", () => {
    const a = createdAtMs("2025-01-01 10:00:00");
    expect(a).toBe(Date.UTC(2025, 0, 1, 10, 0, 0));
    expect(createdAtMs("2025-01-01T10:00:00.000Z")).toBe(a);
    expect(createdAtMs(new Date(a))).toBe(a);
    expect(createdAtMs("2025-01-01 10:00:00.250")).toBe(a + 250);
  });

  test("anything unreadable sorts last", () => {
    expect(createdAtMs(null)).toBe(Number.MAX_SAFE_INTEGER);
    expect(createdAtMs("")).toBe(Number.MAX_SAFE_INTEGER);
    expect(createdAtMs("yesterday-ish")).toBe(Number.MAX_SAFE_INTEGER);
    expect(createdAtMs(new Date("nope"))).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("sortChronologically", () => {
  test("oldest first, never by the order they came in", () => {
    const rows = [
      { id: id(1), created_at: "2025-01-01 10:00:05" },
      { id: id(2), created_at: "2025-01-01 10:00:01" },
      { id: id(3), created_at: "2025-01-01 10:00:03" },
    ];
    expect(sortChronologically(rows).map((r) => r.id)).toEqual([id(2), id(3), id(1)]);
  });

  test("equal times fall back to the id, as the chat itself orders them", () => {
    const rows = [
      { id: id(9), created_at: "2025-01-01 10:00:00" },
      { id: id(2), created_at: "2025-01-01 10:00:00" },
      { id: id(5), created_at: "2025-01-01 10:00:00" },
    ];
    expect(sortChronologically(rows).map((r) => r.id)).toEqual([id(2), id(5), id(9)]);
  });

  test("mixed formats (SQLite text and Postgres dates) compare by moment", () => {
    const rows = [
      { id: id(1), created_at: new Date("2025-01-01T10:00:02Z") },
      { id: id(2), created_at: "2025-01-01 10:00:01" },
    ];
    expect(sortChronologically(rows).map((r) => r.id)).toEqual([id(2), id(1)]);
  });

  test("does not change the list it was given", () => {
    const rows = [
      { id: id(2), created_at: "2025-01-01 10:00:02" },
      { id: id(1), created_at: "2025-01-01 10:00:01" },
    ];
    const copy = [...rows];
    sortChronologically(rows);
    expect(rows).toEqual(copy);
  });

  test("not a list: nothing", () => {
    expect(sortChronologically(null)).toEqual([]);
    expect(sortChronologically(undefined)).toEqual([]);
  });

  test("compareChronologically is 0 for the same message", () => {
    const row = { id: id(1), created_at: "2025-01-01 10:00:00" };
    expect(compareChronologically(row, { ...row })).toBe(0);
    expect(compareChronologically(row, { id: id(2), created_at: "2025-01-01 10:00:00" })).toBe(-1);
    expect(compareChronologically({ id: id(2), created_at: "2025-01-01 10:00:00" }, row)).toBe(1);
  });
});

describe("allocateAscendingIds", () => {
  test("as many ids as asked for, ascending, all different and valid", () => {
    const ids = allocateAscendingIds(50);
    expect(ids).toHaveLength(50);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(50);
    for (const entry of ids) {
      // time-ordered ids (version 7 layout), see generateOrderedUuid
      expect(entry).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });

  test("sorts whatever the generator produces", () => {
    const queue = [id(9), id(1), id(5)];
    expect(allocateAscendingIds(3, () => queue.shift())).toEqual([id(1), id(5), id(9)]);
  });

  test("nothing for zero, negative or nonsense counts", () => {
    expect(allocateAscendingIds(0)).toEqual([]);
    expect(allocateAscendingIds(-3)).toEqual([]);
    expect(allocateAscendingIds("x")).toEqual([]);
    expect(allocateAscendingIds(undefined)).toEqual([]);
  });
});

describe("commonFailureStatus", () => {
  test("the shared status, or 400 when they differ", () => {
    expect(commonFailureStatus([404, 404])).toBe(404);
    expect(commonFailureStatus([403])).toBe(403);
    expect(commonFailureStatus([404, 403])).toBe(400);
    expect(commonFailureStatus([])).toBe(400);
    expect(commonFailureStatus(undefined)).toBe(400);
    expect(commonFailureStatus([404, undefined, null])).toBe(404);
    expect(commonFailureStatus([404, 403], 409)).toBe(409);
  });
});
