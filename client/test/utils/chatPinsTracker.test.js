import { describe, test, expect, beforeEach } from "vitest";
import {
  getPinnedChatListVersion,
  notePinnedChatList,
  resetPinnedChatListTracker,
  withNewestChatPins,
} from "../../src/utils/chatPinsTracker.js";

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const A = id(1);
const B = id(2);
const C = id(3);

// What GET /api/chats answers: the pins as they were when the server read them.
const fetched = () => [
  { id: A, pinned: false, pinPosition: null },
  { id: B, pinned: false, pinPosition: null },
  { id: C, pinned: true, pinPosition: 0 },
];

beforeEach(() => resetPinnedChatListTracker());

describe("chat pin tracker", () => {
  test("nothing changed since the request left: the answer is used as it is", () => {
    const list = fetched();
    const start = getPinnedChatListVersion();
    expect(withNewestChatPins(list, start)).toBe(list);
  });

  test("a pin made while the request travelled is not undone by its older answer", () => {
    const start = getPinnedChatListVersion();
    notePinnedChatList([{ chatId: B, position: 0 }, { chatId: C, position: 1 }]);
    const next = withNewestChatPins(fetched(), start);
    expect(next.map((chat) => [chat.id, chat.pinned, chat.pinPosition])).toEqual([
      [A, false, null],
      [B, true, 0],
      [C, true, 1],
    ]);
  });

  test("a list that was emptied meanwhile unpins everything", () => {
    const start = getPinnedChatListVersion();
    notePinnedChatList([]);
    const next = withNewestChatPins(fetched(), start);
    expect(next.every((chat) => chat.pinned === false && chat.pinPosition === null)).toBe(true);
  });

  test("the newest list wins when there were several", () => {
    const start = getPinnedChatListVersion();
    notePinnedChatList([{ chatId: A, position: 0 }]);
    notePinnedChatList([{ chatId: B, position: 0 }]);
    const next = withNewestChatPins(fetched(), start);
    expect(next.filter((chat) => chat.pinned).map((chat) => chat.id)).toEqual([B]);
  });

  test("an answer to a request that left after the last change is trusted", () => {
    notePinnedChatList([{ chatId: A, position: 0 }]);
    const list = fetched();
    expect(withNewestChatPins(list, getPinnedChatListVersion())).toBe(list);
  });

  test("a broken list counts as empty and bad input is left alone", () => {
    const start = getPinnedChatListVersion();
    notePinnedChatList("nope");
    expect(withNewestChatPins(fetched(), start).some((chat) => chat.pinned)).toBe(false);
    expect(withNewestChatPins(null, start)).toBeNull();
  });
});
