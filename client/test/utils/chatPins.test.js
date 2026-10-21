import { describe, test, expect } from "vitest";
import {
  DEFAULT_MAX_PINNED_CHATS,
  applyPinnedList,
  applyPinnedOrder,
  clampMaxPinnedChats,
  describeChatPinError,
  dragOffsetLimits,
  dropIndexFor,
  getChatPinActions,
  getPinnedChatIds,
  isChatPinned,
  moveId,
  normalizePinnedList,
  orderChatsWithPins,
  pinLimitMessage,
  reorderIds,
  shiftForRow,
} from "../../src/utils/chatPins.js";

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const chat = (n, extra = {}) => ({ id: id(n), name: `chat ${n}`, ...extra });

describe("clampMaxPinnedChats", () => {
  test("keeps 1-30 and falls back to the default", () => {
    expect(clampMaxPinnedChats(3)).toBe(3);
    expect(clampMaxPinnedChats("12")).toBe(12);
    expect(clampMaxPinnedChats(99)).toBe(30);
    expect(clampMaxPinnedChats(0)).toBe(DEFAULT_MAX_PINNED_CHATS);
    expect(clampMaxPinnedChats(undefined)).toBe(DEFAULT_MAX_PINNED_CHATS);
    expect(clampMaxPinnedChats("many")).toBe(DEFAULT_MAX_PINNED_CHATS);
  });
});

describe("normalizePinnedList", () => {
  test("sorts by position and drops bad and repeated entries", () => {
    const list = normalizePinnedList([
      { chatId: id(2), position: 4 },
      { chatId: "nope", position: 0 },
      { chatId: id(1), position: 1 },
      { chatId: id(2), position: 0 },
      { chatId: id(3) },
      null,
    ]);
    expect(list).toEqual([
      { chatId: id(1), position: 1 },
      { chatId: id(2), position: 4 },
    ]);
  });

  test("anything that is not a list is an empty list", () => {
    expect(normalizePinnedList(undefined)).toEqual([]);
    expect(normalizePinnedList({})).toEqual([]);
  });
});

describe("applyPinnedList", () => {
  test("marks the pinned chats and clears the others (replace, not merge)", () => {
    const chats = [
      chat(1, { pinned: true, pinPosition: 0 }),
      chat(2),
      chat(3, { pinned: false, pinPosition: null }),
    ];
    const next = applyPinnedList(chats, [
      { chatId: id(3), position: 0 },
      { chatId: id(2), position: 1 },
    ]);
    expect(next.map((c) => [c.pinned, c.pinPosition])).toEqual([
      [false, null],
      [true, 1],
      [true, 0],
    ]);
  });

  test("the same list again changes nothing (same array back)", () => {
    const chats = [chat(1, { pinned: true, pinPosition: 0 }), chat(2, { pinned: false, pinPosition: null })];
    const same = applyPinnedList(chats, [{ chatId: id(1), position: 0 }]);
    expect(same).toBe(chats);
  });

  test("an empty list unpins everything", () => {
    const chats = [chat(1, { pinned: true, pinPosition: 0 })];
    expect(applyPinnedList(chats, [])[0]).toMatchObject({ pinned: false, pinPosition: null });
  });

  test("a chat that is not in the list of chats is simply ignored", () => {
    const chats = [chat(1)];
    expect(applyPinnedList(chats, [{ chatId: id(9), position: 0 }])).toBe(chats);
  });

  test("matches ids whatever their letter case", () => {
    const chats = [{ id: id(1).toUpperCase() }];
    expect(applyPinnedList(chats, [{ chatId: id(1), position: 0 }])[0].pinned).toBe(true);
  });
});

describe("orderChatsWithPins", () => {
  test("pinned chats first by position, the rest keep their order", () => {
    const chats = [
      chat(1),
      chat(2, { pinned: true, pinPosition: 5 }),
      chat(3),
      chat(4, { pinned: true, pinPosition: 1 }),
    ];
    expect(orderChatsWithPins(chats).map((c) => c.id)).toEqual([id(4), id(2), id(1), id(3)]);
  });

  test("returns the same array when nothing is pinned", () => {
    const chats = [chat(1), chat(2)];
    expect(orderChatsWithPins(chats)).toBe(chats);
  });

  test("pinned chats with the same position keep their relative order", () => {
    const chats = [
      chat(1, { pinned: true, pinPosition: 0 }),
      chat(2, { pinned: true, pinPosition: 0 }),
    ];
    expect(orderChatsWithPins(chats).map((c) => c.id)).toEqual([id(1), id(2)]);
  });

  test("a pinned chat without a position goes to the end of the pinned block", () => {
    const chats = [chat(1, { pinned: true }), chat(2, { pinned: true, pinPosition: 3 }), chat(3)];
    expect(orderChatsWithPins(chats).map((c) => c.id)).toEqual([id(2), id(1), id(3)]);
  });

  test("does not touch the list it was given", () => {
    const chats = [chat(1), chat(2, { pinned: true, pinPosition: 0 })];
    const copy = chats.slice();
    orderChatsWithPins(chats);
    expect(chats).toEqual(copy);
  });
});

describe("getPinnedChatIds and applyPinnedOrder", () => {
  test("lists the pinned ids top first", () => {
    const chats = [
      chat(1, { pinned: true, pinPosition: 2 }),
      chat(2),
      chat(3, { pinned: true, pinPosition: 0 }),
    ];
    expect(getPinnedChatIds(chats)).toEqual([id(3), id(1)]);
  });

  test("applyPinnedOrder rewrites the positions from an id list", () => {
    const chats = [
      chat(1, { pinned: true, pinPosition: 0 }),
      chat(2, { pinned: true, pinPosition: 1 }),
      chat(3, { pinned: true, pinPosition: 2 }),
    ];
    const next = applyPinnedOrder(chats, [id(3), id(1), id(2)]);
    expect(getPinnedChatIds(next)).toEqual([id(3), id(1), id(2)]);
    expect(next.every(isChatPinned)).toBe(true);
  });
});

describe("reorderIds and moveId", () => {
  test("moves an item to a new slot", () => {
    expect(reorderIds(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(reorderIds(["a", "b", "c", "d"], 3, 1)).toEqual(["a", "d", "b", "c"]);
  });

  test("a move that goes nowhere gives the same array back", () => {
    const ids = ["a", "b"];
    expect(reorderIds(ids, 1, 1)).toBe(ids);
    expect(reorderIds(ids, 5, 0)).toBe(ids);
    expect(reorderIds(ids, 0, 9)).toEqual(["b", "a"]);
  });

  test("moveId goes up and down but stops at the ends", () => {
    const ids = ["a", "b", "c"];
    expect(moveId(ids, "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveId(ids, "b", 1)).toEqual(["a", "c", "b"]);
    expect(moveId(ids, "a", -1)).toBe(ids);
    expect(moveId(ids, "c", 1)).toBe(ids);
    expect(moveId(ids, "zzz", 1)).toBe(ids);
  });
});

describe("getChatPinActions", () => {
  const chats = [
    chat(1, { pinned: true, pinPosition: 0 }),
    chat(2, { pinned: true, pinPosition: 1 }),
    chat(3, { pinned: true, pinPosition: 2 }),
    chat(4),
  ];

  test("the first pinned chat can only move down", () => {
    expect(getChatPinActions(chats[0], chats, { max: 5 })).toMatchObject({
      pinned: true,
      canMoveUp: false,
      canMoveDown: true,
      index: 0,
      count: 3,
    });
  });

  test("the last pinned chat can only move up", () => {
    expect(getChatPinActions(chats[2], chats)).toMatchObject({ canMoveUp: true, canMoveDown: false });
  });

  test("a chat that is not pinned cannot move and may hit the limit", () => {
    expect(getChatPinActions(chats[3], chats, { max: 3 })).toMatchObject({
      pinned: false,
      canMoveUp: false,
      canMoveDown: false,
      atLimit: true,
    });
    expect(getChatPinActions(chats[3], chats, { max: 4 }).atLimit).toBe(false);
    expect(getChatPinActions(chats[3], chats).atLimit).toBe(false);
  });

  test("a pinned chat is never 'at the limit'", () => {
    expect(getChatPinActions(chats[0], chats, { max: 1 }).atLimit).toBe(false);
  });
});

describe("dragging", () => {
  test("dropIndexFor follows the pointer by whole rows and stays inside the block", () => {
    expect(dropIndexFor({ startIndex: 1, offsetY: 0, rowHeight: 80, count: 4 })).toBe(1);
    expect(dropIndexFor({ startIndex: 1, offsetY: 90, rowHeight: 80, count: 4 })).toBe(2);
    expect(dropIndexFor({ startIndex: 1, offsetY: 39, rowHeight: 80, count: 4 })).toBe(1);
    expect(dropIndexFor({ startIndex: 1, offsetY: 41, rowHeight: 80, count: 4 })).toBe(2);
    expect(dropIndexFor({ startIndex: 1, offsetY: -400, rowHeight: 80, count: 4 })).toBe(0);
    expect(dropIndexFor({ startIndex: 1, offsetY: 4000, rowHeight: 80, count: 4 })).toBe(3);
  });

  test("dropIndexFor is safe with bad input", () => {
    expect(dropIndexFor({ startIndex: 2, offsetY: 50, rowHeight: 0, count: 4 })).toBe(2);
    expect(dropIndexFor({ startIndex: 2, offsetY: Number.NaN, rowHeight: 80, count: 4 })).toBe(2);
    expect(dropIndexFor({ startIndex: 9, offsetY: 0, rowHeight: 80, count: 4 })).toBe(3);
    expect(dropIndexFor({ startIndex: 0, offsetY: 10, rowHeight: 80, count: 0 })).toBe(0);
  });

  test("dragOffsetLimits keeps the dragged row inside the block", () => {
    expect(dragOffsetLimits({ startIndex: 1, count: 4, rowHeight: 80 })).toEqual({ min: -80, max: 160 });
    expect(dragOffsetLimits({ startIndex: 0, count: 1, rowHeight: 80 })).toEqual({ min: -0, max: 0 });
  });

  test("shiftForRow slides the rows between the old and the new slot", () => {
    // dragging row 0 down to slot 2: rows 1 and 2 move up
    const down = (index) => shiftForRow({ index, fromIndex: 0, toIndex: 2, rowHeight: 80 });
    expect([0, 1, 2, 3].map(down)).toEqual([0, -80, -80, 0]);
    // dragging row 3 up to slot 1: rows 1 and 2 move down
    const up = (index) => shiftForRow({ index, fromIndex: 3, toIndex: 1, rowHeight: 80 });
    expect([0, 1, 2, 3].map(up)).toEqual([0, 80, 80, 0]);
    // not moving: nothing shifts
    expect(shiftForRow({ index: 1, fromIndex: 2, toIndex: 2, rowHeight: 80 })).toBe(0);
  });
});

describe("notices", () => {
  test("pinLimitMessage names the limit", () => {
    expect(pinLimitMessage(5)).toBe("You can pin up to 5 chats");
    expect(pinLimitMessage(1)).toBe("You can pin up to 1 chat");
    expect(pinLimitMessage(undefined)).toMatch(/can't pin more/i);
  });

  test("describeChatPinError maps the server's codes", () => {
    expect(describeChatPinError({ status: 409, body: { code: "pin_limit", max: 3 } })).toBe(
      "You can pin up to 3 chats",
    );
    expect(describeChatPinError({ status: 409, body: { code: "pin_limit" }, fallbackMax: 5 })).toBe(
      "You can pin up to 5 chats",
    );
    expect(describeChatPinError({ status: 409, body: { code: "chat_hidden" } })).toMatch(/hidden/i);
    expect(describeChatPinError({ status: 409, body: { code: "pin_set_mismatch" } })).toMatch(/another device/i);
    expect(describeChatPinError({ status: 429, body: {} })).toMatch(/too many/i);
    expect(describeChatPinError({ status: 500, body: {} })).toMatch(/couldn't update/i);
    expect(describeChatPinError()).toMatch(/couldn't update/i);
  });
});
