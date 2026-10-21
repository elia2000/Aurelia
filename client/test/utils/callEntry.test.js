import { describe, expect, test } from "vitest";
import {
  callPreviewText,
  callReason,
  callTitle,
  describeCall,
  eventCountsAsUnread,
  formatCallDuration,
  formatCallDurationWords,
  getChatCallPreview,
  getChatPatchFromMessageEvent,
  isCallMessage,
  normalizeCall,
} from "../../src/utils/callEntry.js";

const call = (overrides = {}) => ({
  callId: "c1",
  kind: "audio",
  outcome: "completed",
  durationSec: 23,
  ...overrides,
});

describe("isCallMessage", () => {
  test("knows an entry by messageType, type or the call object", () => {
    expect(isCallMessage({ messageType: "call" })).toBe(true);
    expect(isCallMessage({ type: "call" })).toBe(true);
    expect(isCallMessage({ call: call() })).toBe(true);
  });

  test("a text message, a system line and junk are not entries", () => {
    expect(isCallMessage({ messageType: "text", call: null, body: "hi" })).toBe(false);
    expect(isCallMessage({ _systemEvent: { type: "joined" } })).toBe(false);
    expect(isCallMessage(null)).toBe(false);
    expect(isCallMessage("call")).toBe(false);
    expect(isCallMessage({ call: "audio" })).toBe(false);
  });
});

describe("normalizeCall", () => {
  test("keeps a valid call as it is", () => {
    expect(normalizeCall(call({ kind: "video", durationSec: 125 }))).toEqual({
      callId: "c1",
      kind: "video",
      outcome: "completed",
      durationSec: 125,
    });
  });

  test("replaces values it does not know so nothing can break the bubble", () => {
    expect(normalizeCall(call({ kind: "hologram", outcome: "teleported", durationSec: -4 }))).toEqual({
      callId: "c1",
      kind: "audio",
      outcome: "unknown",
      durationSec: null,
    });
    expect(normalizeCall(null)).toEqual({
      callId: "",
      kind: "audio",
      outcome: "unknown",
      durationSec: null,
    });
  });

  test("rounds the length and drops a length that is not a number", () => {
    expect(normalizeCall(call({ durationSec: 12.6 })).durationSec).toBe(13);
    expect(normalizeCall(call({ durationSec: "soon" })).durationSec).toBeNull();
    expect(normalizeCall(call({ durationSec: null })).durationSec).toBeNull();
    expect(normalizeCall(call({ durationSec: 0 })).durationSec).toBe(0);
  });
});

describe("formatCallDuration (clock)", () => {
  test.each([
    [0, "0:00"],
    [5, "0:05"],
    [23, "0:23"],
    [59, "0:59"],
    [60, "1:00"],
    [125, "2:05"],
    [3599, "59:59"],
    [3600, "1:00:00"],
    [3723, "1:02:03"],
    [36000, "10:00:00"],
  ])("%i seconds is %s", (seconds, expected) => {
    expect(formatCallDuration(seconds)).toBe(expected);
  });

  test("a missing or negative length is 0:00", () => {
    expect(formatCallDuration(null)).toBe("0:00");
    expect(formatCallDuration(undefined)).toBe("0:00");
    expect(formatCallDuration(-9)).toBe("0:00");
    expect(formatCallDuration(Number.NaN)).toBe("0:00");
  });
});

describe("formatCallDurationWords", () => {
  test.each([
    [0, "0 s"],
    [23, "23 s"],
    [60, "1 min"],
    [125, "2 min 5 s"],
    [3600, "1 h"],
    [3720, "1 h 2 min"],
    [7325, "2 h 2 min"],
  ])("%i seconds is %s", (seconds, expected) => {
    expect(formatCallDurationWords(seconds)).toBe(expected);
  });
});

describe("callTitle", () => {
  test("a connected call says which way it went", () => {
    expect(callTitle({ kind: "audio", outcome: "completed", outgoing: true })).toBe("Outgoing call");
    expect(callTitle({ kind: "audio", outcome: "completed", outgoing: false })).toBe("Incoming call");
    expect(callTitle({ kind: "video", outcome: "completed", outgoing: true })).toBe("Outgoing video call");
    expect(callTitle({ kind: "video", outcome: "completed", outgoing: false })).toBe("Incoming video call");
  });

  test("a call nobody answered reads differently to the caller and the callee", () => {
    expect(callTitle({ kind: "audio", outcome: "missed", outgoing: false })).toBe("Missed call");
    expect(callTitle({ kind: "video", outcome: "missed", outgoing: false })).toBe("Missed video call");
    expect(callTitle({ kind: "audio", outcome: "missed", outgoing: true })).toBe("No answer");
    expect(callTitle({ kind: "video", outcome: "missed", outgoing: true })).toBe("No answer");
  });

  test("declined, cancelled, busy and failed", () => {
    expect(callTitle({ kind: "audio", outcome: "declined", outgoing: true })).toBe("Declined call");
    expect(callTitle({ kind: "video", outcome: "declined", outgoing: false })).toBe("Declined video call");
    expect(callTitle({ kind: "audio", outcome: "cancelled", outgoing: true })).toBe("Cancelled call");
    expect(callTitle({ kind: "video", outcome: "cancelled", outgoing: false })).toBe("Cancelled video call");
    expect(callTitle({ kind: "audio", outcome: "busy", outgoing: true })).toBe("Busy");
    expect(callTitle({ kind: "audio", outcome: "failed", outgoing: true })).toBe("Call failed");
    expect(callTitle({ kind: "video", outcome: "failed", outgoing: false })).toBe("Video call failed");
  });

  test("a line for both people (outgoing unknown) and an unknown outcome stay plain", () => {
    expect(callTitle({ kind: "audio", outcome: "completed" })).toBe("Call");
    expect(callTitle({ kind: "video", outcome: "completed" })).toBe("Video call");
    expect(callTitle({ kind: "video", outcome: "unknown", outgoing: true })).toBe("Video call");
  });
});

describe("callReason", () => {
  test("says why when there is no length", () => {
    expect(callReason({ outcome: "missed", outgoing: false })).toBe("Not answered");
    expect(callReason({ outcome: "missed", outgoing: true })).toBe("They didn't answer");
    expect(callReason({ outcome: "declined", outgoing: true })).toBe("They declined");
    expect(callReason({ outcome: "declined", outgoing: false })).toBe("You declined");
    expect(callReason({ outcome: "cancelled", outgoing: true })).toBe("You hung up first");
    expect(callReason({ outcome: "cancelled", outgoing: false })).toBe("They hung up first");
    expect(callReason({ outcome: "busy", outgoing: true })).toBe("They were on another call");
    expect(callReason({ outcome: "busy", outgoing: false })).toBe("You were on another call");
    expect(callReason({ outcome: "failed", outgoing: true })).toBe("Couldn't connect");
  });

  test("a connected or unknown call has no reason", () => {
    expect(callReason({ outcome: "completed", outgoing: true })).toBe("");
    expect(callReason({ outcome: "unknown", outgoing: true })).toBe("");
  });
});

describe("describeCall", () => {
  test("an outgoing voice call that connected shows the length and a phone button", () => {
    const view = describeCall(call({ durationSec: 23 }), { outgoing: true });
    expect(view).toMatchObject({
      kind: "audio",
      outcome: "completed",
      direction: "out",
      tone: "ok",
      title: "Outgoing call",
      subtitle: "0:23",
      spoken: "Outgoing call, 23 s",
      callBack: { kind: "audio", label: "Call back" },
    });
  });

  test("an incoming video call that connected has a video call back button", () => {
    const view = describeCall(call({ kind: "video", durationSec: 125 }), { outgoing: false });
    expect(view).toMatchObject({
      kind: "video",
      direction: "in",
      tone: "ok",
      title: "Incoming video call",
      subtitle: "2:05",
      spoken: "Incoming video call, 2 min 5 s",
      callBack: { kind: "video", label: "Video call back" },
    });
  });

  test("a call over an hour uses hours", () => {
    const view = describeCall(call({ durationSec: 3723 }), { outgoing: true });
    expect(view.subtitle).toBe("1:02:03");
    expect(view.spoken).toBe("Outgoing call, 1 h 2 min");
  });

  test("a connected call with no length (damaged row) shows no subtitle", () => {
    const view = describeCall(call({ durationSec: null }), { outgoing: true });
    expect(view.subtitle).toBe("");
    expect(view.spoken).toBe("Outgoing call");
  });

  test("a missed call is red for the callee and for the caller", () => {
    const callee = describeCall(call({ outcome: "missed", durationSec: null }), { outgoing: false });
    expect(callee).toMatchObject({
      tone: "bad",
      direction: "in",
      title: "Missed call",
      subtitle: "Not answered",
      spoken: "Missed call, Not answered",
    });
    const caller = describeCall(call({ outcome: "missed", durationSec: null }), { outgoing: true });
    expect(caller).toMatchObject({ tone: "bad", direction: "out", title: "No answer" });
  });

  test("a declined call is red and keeps the kind of the call back button", () => {
    const view = describeCall(call({ kind: "video", outcome: "declined", durationSec: null }), { outgoing: true });
    expect(view).toMatchObject({
      tone: "bad",
      title: "Declined video call",
      subtitle: "They declined",
      callBack: { kind: "video", label: "Video call back" },
    });
  });

  test("a cancelled call is red only for the person who did not get to answer", () => {
    expect(describeCall(call({ outcome: "cancelled", durationSec: null }), { outgoing: true }).tone).toBe("ok");
    expect(describeCall(call({ outcome: "cancelled", durationSec: null }), { outgoing: false }).tone).toBe("bad");
  });

  test("busy and failed are red", () => {
    expect(describeCall(call({ outcome: "busy", durationSec: null }), { outgoing: true })).toMatchObject({
      tone: "bad",
      title: "Busy",
    });
    expect(describeCall(call({ outcome: "failed", durationSec: null }), { outgoing: false })).toMatchObject({
      tone: "bad",
      title: "Call failed",
      subtitle: "Couldn't connect",
    });
  });

  test("an unknown outcome is a neutral Call and still has a call back button", () => {
    const view = describeCall({ kind: "video", outcome: "from-the-future" }, { outgoing: false });
    expect(view).toMatchObject({ title: "Video call", subtitle: "", tone: "ok" });
    expect(view.callBack.label).toBe("Video call back");
  });

  test("no call object at all still describes something", () => {
    const view = describeCall(undefined, { outgoing: true });
    expect(view.title).toBe("Call");
    expect(view.callBack.label).toBe("Call back");
  });
});

describe("callPreviewText", () => {
  test("matches the lines the server writes for the chat list", () => {
    expect(callPreviewText(call(), { outgoing: true })).toBe("Outgoing call");
    expect(callPreviewText(call(), { outgoing: false })).toBe("Incoming call");
    expect(callPreviewText(call({ kind: "video" }), { outgoing: true })).toBe("Outgoing video call");
    expect(callPreviewText(call({ outcome: "missed" }), { outgoing: false })).toBe("Missed call");
    expect(callPreviewText(call({ outcome: "missed", kind: "video" }), { outgoing: false })).toBe("Missed video call");
    expect(callPreviewText(call({ outcome: "missed" }), { outgoing: true })).toBe("No answer");
    expect(callPreviewText(call({ outcome: "declined" }), { outgoing: false })).toBe("Declined call");
    expect(callPreviewText(call({ outcome: "cancelled", kind: "video" }), { outgoing: true })).toBe("Cancelled video call");
    expect(callPreviewText(call({ outcome: "busy" }), { outgoing: true })).toBe("Busy");
    expect(callPreviewText(call({ outcome: "failed" }), { outgoing: true })).toBe("Call failed");
  });

  test("is never empty", () => {
    expect(callPreviewText(null)).toBe("Call");
    expect(callPreviewText({ outcome: "nonsense" })).toBe("Call");
  });
});

describe("getChatCallPreview", () => {
  const me = { id: "u-me", username: "alice" };

  test("is null when the last message is not a call", () => {
    expect(getChatCallPreview({ last_message_type: "message", last_message: "hi" }, me)).toBeNull();
    expect(getChatCallPreview({ last_message: "hi" }, me)).toBeNull();
    expect(getChatCallPreview(null, me)).toBeNull();
  });

  test("my own call is outgoing, the other person's is incoming", () => {
    const mine = getChatCallPreview(
      { last_message_type: "call", last_call: call(), last_sender_id: "u-me" },
      me,
    );
    expect(mine).toEqual({ text: "Outgoing call", direction: "out", tone: "ok" });
    const theirs = getChatCallPreview(
      { last_message_type: "call", last_call: call({ kind: "video" }), last_sender_id: "u-bob" },
      me,
    );
    expect(theirs).toEqual({ text: "Incoming video call", direction: "in", tone: "ok" });
  });

  test("the sender's username wins over an id a realtime update did not refresh", () => {
    // A call from bob arrived live: the row has bob's username but still the
    // id of the last message, which was mine.
    const view = getChatCallPreview(
      {
        last_message_type: "call",
        last_call: call(),
        last_sender_id: "u-me",
        last_sender_username: "bob",
      },
      me,
    );
    expect(view.text).toBe("Incoming call");
  });

  test("falls back to the sender's username when the id is missing", () => {
    const view = getChatCallPreview(
      { last_message_type: "call", last_call: call(), last_sender_username: "Alice" },
      me,
    );
    expect(view.text).toBe("Outgoing call");
  });

  test("a missed call from the other person is red", () => {
    const view = getChatCallPreview(
      {
        last_message_type: "call",
        last_call: call({ outcome: "missed", durationSec: null }),
        last_sender_id: "u-bob",
      },
      me,
    );
    expect(view).toEqual({ text: "Missed call", direction: "in", tone: "bad" });
  });

  test("a call with no call data still gives a line", () => {
    expect(getChatCallPreview({ last_message_type: "call", last_call: null, last_sender_id: "u-bob" }, me).text).toBe(
      "Call",
    );
  });
});

describe("getChatPatchFromMessageEvent", () => {
  test("a call event sets the type, the call and the viewer's line", () => {
    const payload = { type: "chat_message", messageType: "call", call: call({ outcome: "missed", durationSec: null }) };
    expect(getChatPatchFromMessageEvent(payload, { outgoing: false })).toEqual({
      last_message_type: "call",
      last_call: normalizeCall(payload.call),
      last_message: "Missed call",
    });
    expect(getChatPatchFromMessageEvent(payload, { outgoing: true }).last_message).toBe("No answer");
  });

  test("any other message resets the call fields", () => {
    expect(getChatPatchFromMessageEvent({ type: "chat_message", body: "hi" })).toEqual({
      last_message_type: "message",
      last_call: null,
    });
  });
});

describe("eventCountsAsUnread", () => {
  test("a call counts only when the server says so (missed)", () => {
    expect(eventCountsAsUnread({ messageType: "call", call: call(), countsAsUnread: true })).toBe(true);
    expect(eventCountsAsUnread({ messageType: "call", call: call(), countsAsUnread: false })).toBe(false);
    expect(eventCountsAsUnread({ messageType: "call", call: call() })).toBe(false);
  });

  test("every other message counts", () => {
    expect(eventCountsAsUnread({ type: "chat_message", body: "hi" })).toBe(true);
    expect(eventCountsAsUnread({ messageType: "text" })).toBe(true);
  });
});
