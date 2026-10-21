import { isCallMessage } from "./callEntry.js";
import { parseServerDate } from "./chatFormat.js";

// Consecutive messages from one sender that are close in time form a "run".
// The timeline draws a run like Telegram does: the sender name sits on the
// first bubble, the avatar on the last one, and the bubbles are 2px apart
// (8px between runs).
export const RUN_GAP_MS = 5 * 60 * 1000;

const senderKey = (msg) =>
  String(msg?.username || msg?.user_id || "")
    .trim()
    .toLowerCase();

const timeOf = (msg) => {
  const raw = msg?.created_at || msg?._createdAt;
  if (!raw) return Number.NaN;
  return parseServerDate(raw).getTime();
};

// True when `next` cannot share a run with `prev` (different sender, a system
// line or a call entry, too far apart in time, or a missing neighbour).
export const isRunBreak = (prev, next, gapMs = RUN_GAP_MS) => {
  if (!prev || !next) return true;
  if (prev._systemEvent || next._systemEvent) return true;
  if (isCallMessage(prev) || isCallMessage(next)) return true;
  const a = senderKey(prev);
  const b = senderKey(next);
  if (!a || a !== b) return true;
  const ta = timeOf(prev);
  const tb = timeOf(next);
  if (Number.isFinite(ta) && Number.isFinite(tb) && Math.abs(tb - ta) > gapMs) {
    return true;
  }
  return false;
};

// Marks every message of one day with isRunStart / isRunEnd. A day never
// continues a run from the day before (the date chip sits between them).
export const computeMessageRuns = (messages, gapMs = RUN_GAP_MS) => {
  const list = Array.isArray(messages) ? messages : [];
  return list.map((msg, index) => ({
    isRunStart: isRunBreak(list[index - 1], msg, gapMs),
    isRunEnd: isRunBreak(msg, list[index + 1], gapMs),
  }));
};
