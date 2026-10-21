import { describe, test, expect } from "vitest";
import { getMaxPinnedChats, getMaxPinnedMessages, setPinLimits } from "../../src/utils/pinLimits.js";

describe("pinLimits", () => {
  test("keeps the limits the server reports", () => {
    setPinLimits({ messages: 12, chats: 8 });
    expect(getMaxPinnedMessages()).toBe(12);
    expect(getMaxPinnedChats()).toBe(8);
  });

  test("clamps a limit outside the range the server allows", () => {
    setPinLimits({ messages: 5000, chats: 400 });
    expect(getMaxPinnedMessages()).toBe(100);
    expect(getMaxPinnedChats()).toBe(30);
  });

  test("an older server that does not send them leaves the defaults", () => {
    setPinLimits({});
    expect(getMaxPinnedMessages()).toBe(20);
    expect(getMaxPinnedChats()).toBe(5);
    setPinLimits();
    expect(getMaxPinnedChats()).toBe(5);
  });
});
