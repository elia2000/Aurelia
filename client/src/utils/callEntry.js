// Call history entries: the "Outgoing call 0:23 / Missed call" lines a direct
// chat gets when a call ends (the server writes one message per call).
//
// Everything here is pure: what an entry says (title, reason, duration),
// which way it points, what the chat list shows for it, and which actions a
// call entry offers. The components only draw the result.

export const CALL_OUTCOMES = Object.freeze([
  "completed",
  "missed",
  "declined",
  "cancelled",
  "busy",
  "failed",
]);

const OUTCOME_SET = new Set(CALL_OUTCOMES);

/** True for a message that is a call history entry (REST row or realtime event). */
export function isCallMessage(msg) {
  if (!msg || typeof msg !== "object") return false;
  if (msg.messageType === "call" || msg.type === "call") return true;
  return Boolean(msg.call) && typeof msg.call === "object";
}

/**
 * The structured call of an entry, made safe to draw. A value the client does
 * not know (a newer server, a damaged row) becomes `outcome: "unknown"`, which
 * draws as a plain "Call" instead of an empty bubble.
 */
export function normalizeCall(raw) {
  const call = raw && typeof raw === "object" ? raw : {};
  const duration = Number(call.durationSec);
  return {
    callId: typeof call.callId === "string" ? call.callId : "",
    kind: call.kind === "video" ? "video" : "audio",
    outcome: OUTCOME_SET.has(call.outcome) ? call.outcome : "unknown",
    durationSec:
      call.durationSec !== null &&
      call.durationSec !== undefined &&
      Number.isFinite(duration) &&
      duration >= 0
        ? Math.round(duration)
        : null,
  };
}

const pad2 = (value) => String(value).padStart(2, "0");

const toWholeSeconds = (seconds) => {
  const value = Math.round(Number(seconds));
  return Number.isFinite(value) && value > 0 ? value : 0;
};

/** "0:23", "2:05", "1:02:03": the length of a call as a clock. */
export function formatCallDuration(seconds) {
  const total = toWholeSeconds(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours > 0
    ? `${hours}:${pad2(minutes)}:${pad2(secs)}`
    : `${minutes}:${pad2(secs)}`;
}

/** "23 s", "2 min 5 s", "2 min", "1 h 2 min": the same length in words. */
export function formatCallDurationWords(seconds) {
  const total = toWholeSeconds(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
  if (minutes > 0) return secs > 0 ? `${minutes} min ${secs} s` : `${minutes} min`;
  return `${secs} s`;
}

const nounOf = (kind) => (kind === "video" ? "video call" : "call");
const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * The headline of an entry for the person looking at it. `outgoing` is true
 * for the caller, false for the callee and null for a line that reads right
 * to both (the realtime event is one payload for both people). These are the
 * same lines the server writes for the chat list.
 */
export function callTitle({ kind, outcome, outgoing = null }) {
  const noun = nounOf(kind);
  switch (outcome) {
    case "completed":
      if (outgoing === true) return `Outgoing ${noun}`;
      if (outgoing === false) return `Incoming ${noun}`;
      return capitalize(noun);
    case "missed":
      return outgoing === true ? "No answer" : `Missed ${noun}`;
    case "declined":
      return `Declined ${noun}`;
    case "cancelled":
      return `Cancelled ${noun}`;
    case "busy":
      return "Busy";
    case "failed":
      return `${capitalize(noun)} failed`;
    default:
      return capitalize(noun);
  }
}

/** Why the call ended the way it did, when the length says nothing. */
export function callReason({ outcome, outgoing = null }) {
  const mine = outgoing === true;
  switch (outcome) {
    case "missed":
      return mine ? "They didn't answer" : "Not answered";
    case "declined":
      return mine ? "They declined" : "You declined";
    case "cancelled":
      return mine ? "You hung up first" : "They hung up first";
    case "busy":
      return mine ? "They were on another call" : "You were on another call";
    case "failed":
      return "Couldn't connect";
    default:
      return "";
  }
}

// Outcomes that are drawn in red: nobody talked, and it was not a plain hang-up.
// A cancelled call is only red for the person who did not get to answer it.
const isAlarming = (outcome, outgoing) => {
  if (outcome === "cancelled") return outgoing === false;
  return (
    outcome === "missed" ||
    outcome === "declined" ||
    outcome === "busy" ||
    outcome === "failed"
  );
};

/**
 * Everything the call entry draws, for the person looking at it.
 *
 *   direction  "out" | "in"   (the arrow)
 *   tone       "bad" | "ok"   (red or the normal colour)
 *   title      "Outgoing video call"
 *   subtitle   "2:05" for a call that connected, else the reason
 *   spoken     the same as one sentence for a screen reader ("... 2 min 5 s"),
 *              and subtitleSpoken for the subtitle alone
 *   callBack   { kind, label } what the round button starts and says
 */
export function describeCall(rawCall, { outgoing = null } = {}) {
  const call = normalizeCall(rawCall);
  const title = callTitle({ ...call, outgoing });
  const hasLength = call.outcome === "completed" && call.durationSec !== null;
  const subtitle = hasLength
    ? formatCallDuration(call.durationSec)
    : callReason({ outcome: call.outcome, outgoing });
  const subtitleSpoken = hasLength ? formatCallDurationWords(call.durationSec) : subtitle;
  return {
    ...call,
    outgoing: outgoing === true,
    direction: outgoing === false ? "in" : "out",
    tone: isAlarming(call.outcome, outgoing) ? "bad" : "ok",
    title,
    subtitle,
    subtitleSpoken,
    spoken: subtitleSpoken ? `${title}, ${subtitleSpoken}` : title,
    callBack: {
      kind: call.kind,
      label: call.kind === "video" ? "Video call back" : "Call back",
    },
  };
}

/** The line the chat list shows when the last message is a call entry. */
export function callPreviewText(rawCall, { outgoing = null } = {}) {
  const call = normalizeCall(rawCall);
  return callTitle({ ...call, outgoing });
}

const sameId = (a, b) =>
  a !== null &&
  a !== undefined &&
  b !== null &&
  b !== undefined &&
  String(a).toLowerCase() === String(b).toLowerCase();

/**
 * The chat list row of a chat whose last message is a call entry:
 * `{ text, direction, tone }`, or null for any other last message.
 * `me` is `{ id, username }` of the signed-in person.
 */
export function getChatCallPreview(chat, me = {}) {
  if (!chat || chat.last_message_type !== "call") return null;
  const call = normalizeCall(chat.last_call);
  // The username is refreshed by every realtime update, the id only by a
  // reload of the list, so the username decides when both are there.
  const outgoing = chat.last_sender_username
    ? sameId(chat.last_sender_username, me.username)
    : sameId(chat.last_sender_id, me.id);
  const view = describeCall(call, { outgoing });
  return { text: view.title, direction: view.direction, tone: view.tone };
}

/**
 * What a realtime "chat_message" event of a call entry changes in the chat
 * list row: the type, the structured call and the line the viewer sees.
 * Every other message resets the call fields so a later text message is not
 * drawn like a call.
 */
export function getChatPatchFromMessageEvent(payload, { outgoing = false } = {}) {
  if (!isCallMessage(payload)) {
    return { last_message_type: "message", last_call: null };
  }
  const call = normalizeCall(payload.call);
  return {
    last_message_type: "call",
    last_call: call,
    last_message: callPreviewText(call, { outgoing }),
  };
}

/**
 * Does this realtime event add to the other person's unread count? Only a
 * missed call does; every other call entry is stored already read.
 */
export function eventCountsAsUnread(payload) {
  if (!isCallMessage(payload)) return true;
  return payload.countsAsUnread === true;
}
