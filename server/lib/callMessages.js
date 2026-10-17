// Call history entries: the "Outgoing call 0:23 / Missed call / Declined"
// bubbles in a direct chat.
//
// When a call ends, the server writes ONE message into the chat of the two
// people (see lib/services/callMessageService.js). This file holds the pure
// part: which outcome an ended call has, how long it lasted, how the entry is
// shown as structured data and as a one-line preview.

import { CALL_KINDS, CALL_STATES } from "./calls.js";

export const CALL_OUTCOMES = Object.freeze([
  "completed", // was answered and connected (has a duration)
  "missed", // the callee never answered: it rang out
  "declined", // the callee refused it
  "cancelled", // the caller hung up before it was answered
  "busy", // the callee was in another call
  "failed", // answered, but the media never connected
]);

const OUTCOME_SET = new Set(CALL_OUTCOMES);

// The one outcome that waits to be read: the callee did not get to answer.
const UNREAD_OUTCOMES = new Set(["missed"]);

/** True for a message row that is a call history entry. */
export function isCallMessage(row) {
  return Boolean(row && typeof row.call_id === "string" && row.call_id !== "");
}

/** Does an entry with this outcome count as unread for the callee? */
export function callCountsAsUnread(outcome) {
  return UNREAD_OUTCOMES.has(outcome);
}

const toMs = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);

/**
 * How long a call that connected lasted, in whole seconds.
 *
 * Preferred: what the device that hung up reported (the registry already cut
 * it to the time between answer and end). Otherwise the server's own clock
 * from the moment the media was reported connected, or from the answer when
 * that was never reported. A call that was dropped because both people
 * vanished stops counting where they vanished. Never negative, never longer
 * than the time between answer and end.
 */
function connectedDurationSec(call) {
  const answeredAt = toMs(call.answeredAt);
  let endedAt = toMs(call.endedAt);
  if (endedAt == null) return 0;
  const offlineSince = toMs(call.offlineSince);
  if (call.endReason === "failed" && offlineSince != null && offlineSince < endedAt) {
    endedAt = offlineSince;
  }
  const startedAt = toMs(call.connectedAt) ?? answeredAt ?? endedAt;
  const window = Math.max(0, endedAt - (answeredAt ?? startedAt));

  const reported = toMs(call.reportedDurationMs);
  const ms = reported != null && reported >= 0 ? reported : endedAt - startedAt;
  return Math.round(Math.min(Math.max(0, ms), window) / 1000);
}

/**
 * The outcome of a call that has ended, from what the registry recorded:
 * `{ outcome, durationSec }` (`durationSec` is null unless it was completed).
 *
 * - never answered: declined by the callee, rang out (missed) or hung up by
 *   the caller (cancelled, also the answer for anything unexpected);
 * - answered and the media connected: completed, whatever ended it afterwards
 *   (hang-up, a dropped connection, the six-hour limit, both sides vanishing);
 * - answered but the media never connected: failed, whatever ended it (unless
 *   the device that hung up reports that the call ran for a while).
 */
export function resolveCallOutcome(call) {
  if (call?.answeredAt == null) {
    switch (call?.endReason) {
      case "declined":
        return { outcome: "declined", durationSec: null };
      case "missed":
      case "timeout":
        return { outcome: "missed", durationSec: null };
      default:
        return { outcome: "cancelled", durationSec: null };
    }
  }
  // The server learns that the media connected from a request the device
  // makes at that moment. If that one request was lost but the same device
  // reports on hanging up how long the call ran, believe the device.
  const reported = toMs(call.reportedDurationMs);
  const deviceSaysItRan = call.endReason === "hangup" && reported != null && reported > 0;
  if (call.endedFrom === CALL_STATES.ACTIVE || deviceSaysItRan) {
    return { outcome: "completed", durationSec: connectedDurationSec(call) };
  }
  return { outcome: "failed", durationSec: null };
}

/**
 * The structured form of a call entry, or null for any other message:
 * `{ callId, kind, outcome, durationSec }`. Values read from the database that
 * are not one of the known ones are replaced, so a damaged row cannot send the
 * client something it cannot draw.
 */
export function serializeCall(row) {
  if (!isCallMessage(row)) return null;
  const duration = Number(row.call_duration_sec);
  return {
    callId: row.call_id,
    kind: CALL_KINDS.includes(row.call_kind) ? row.call_kind : "audio",
    outcome: OUTCOME_SET.has(row.call_outcome) ? row.call_outcome : "failed",
    durationSec:
      row.call_duration_sec !== null &&
      row.call_duration_sec !== undefined &&
      Number.isFinite(duration) &&
      duration >= 0
        ? Math.round(duration)
        : null,
  };
}

/**
 * A short English line for the chat list, and the fallback for clients that
 * do not draw the structured call themselves.
 *
 * `outgoing` says whose view it is: true for the caller, false for the callee,
 * null for a line that reads right to both (the realtime event is one payload
 * for both people).
 */
export function callPreviewText({ kind, outcome, outgoing = null } = {}) {
  const video = kind === "video";
  const noun = video ? "video call" : "call";
  const Noun = video ? "Video call" : "Call";
  switch (outcome) {
    case "completed":
      if (outgoing === true) return `Outgoing ${noun}`;
      if (outgoing === false) return `Incoming ${noun}`;
      return Noun;
    case "missed":
      return outgoing === true ? "No answer" : `Missed ${noun}`;
    case "declined":
      return `Declined ${noun}`;
    case "cancelled":
      return `Cancelled ${noun}`;
    case "busy":
      return "Busy";
    default:
      return `${Noun} failed`;
  }
}
