import { describe, expect, test } from "vitest";
import {
  RUN_GAP_MS,
  computeMessageRuns,
  isRunBreak,
} from "../../src/utils/messageRuns.js";

const at = (minutes) =>
  new Date(Date.UTC(2024, 0, 1, 12, 0, 0) + minutes * 60 * 1000).toISOString();
const msg = (username, minutes, extra = {}) => ({
  id: `${username}-${minutes}`,
  username,
  created_at: at(minutes),
  ...extra,
});

describe("isRunBreak", () => {
  test("breaks when there is no neighbour", () => {
    expect(isRunBreak(null, msg("a", 0))).toBe(true);
    expect(isRunBreak(msg("a", 0), undefined)).toBe(true);
  });

  test("keeps the same sender within the gap together", () => {
    expect(isRunBreak(msg("a", 0), msg("a", 1))).toBe(false);
    expect(isRunBreak(msg("a", 0), msg("a", RUN_GAP_MS / 60000))).toBe(false);
  });

  test("breaks when the sender changes (case-insensitive usernames join)", () => {
    expect(isRunBreak(msg("a", 0), msg("b", 1))).toBe(true);
    expect(isRunBreak(msg("Alice", 0), msg("alice", 1))).toBe(false);
  });

  test("breaks when the messages are further apart than the gap", () => {
    expect(isRunBreak(msg("a", 0), msg("a", RUN_GAP_MS / 60000 + 1))).toBe(true);
  });

  test("breaks around system lines and messages without a sender", () => {
    expect(isRunBreak(msg("a", 0), msg("a", 1, { _systemEvent: { type: "x" } }))).toBe(true);
    expect(isRunBreak(msg("a", 0, { _systemEvent: { type: "x" } }), msg("a", 1))).toBe(true);
    expect(isRunBreak({ id: 1 }, { id: 2 })).toBe(true);
  });

  test("a call entry breaks the run on both sides, like a service line", () => {
    const call = msg("a", 1, { messageType: "call", call: { kind: "audio", outcome: "completed" } });
    expect(isRunBreak(msg("a", 0), call)).toBe(true);
    expect(isRunBreak(call, msg("a", 2))).toBe(true);
    expect(isRunBreak(call, msg("a", 1, { messageType: "call", call: {} }))).toBe(true);
  });

  test("a message without a date does not break a run by itself", () => {
    expect(isRunBreak(msg("a", 0), { id: 2, username: "a" })).toBe(false);
  });

  test("joins an optimistic message (no user_id) with the stored one", () => {
    const local = { id: "c1", _clientId: "c1", username: "a", created_at: at(0) };
    const stored = msg("a", 1, { user_id: 7 });
    expect(isRunBreak(local, stored)).toBe(false);
  });
});

describe("computeMessageRuns", () => {
  test("a call entry between two bubbles of one sender splits them into two runs", () => {
    const runs = computeMessageRuns([
      msg("a", 0),
      msg("a", 1, { messageType: "call", call: { kind: "video", outcome: "missed" } }),
      msg("a", 2),
    ]);
    expect(runs).toEqual([
      { isRunStart: true, isRunEnd: true },
      { isRunStart: true, isRunEnd: true },
      { isRunStart: true, isRunEnd: true },
    ]);
  });

  test("marks first and last bubble of each run", () => {
    const runs = computeMessageRuns([
      msg("a", 0),
      msg("a", 1),
      msg("a", 2),
      msg("b", 3),
      msg("a", 4),
    ]);
    expect(runs.map((r) => [r.isRunStart, r.isRunEnd])).toEqual([
      [true, false],
      [false, false],
      [false, true],
      [true, true],
      [true, true],
    ]);
  });

  test("a single message is both the start and the end of its run", () => {
    expect(computeMessageRuns([msg("a", 0)])).toEqual([
      { isRunStart: true, isRunEnd: true },
    ]);
  });

  test("handles empty and invalid input", () => {
    expect(computeMessageRuns([])).toEqual([]);
    expect(computeMessageRuns(null)).toEqual([]);
  });
});
