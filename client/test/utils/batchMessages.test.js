import { describe, test, expect } from "vitest";
import {
  buildCopyText,
  canCopyMessage,
  canForwardMessage,
  describeDeleteEffect,
  describeSkipped,
  formatCopyTimestamp,
  getServerMessageId,
  interpretDeleteResponse,
  interpretForwardResponse,
  isMessageSelectable,
  isServiceMessage,
  messagesLabel,
  planDelete,
  planForwardRequests,
  summarizeDelete,
  summarizeForward,
} from "../../src/utils/batchMessages.js";

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const msg = (n, extra = {}) => ({
  id: uuid(n),
  username: "bob",
  nickname: "Bob",
  body: `text ${n}`,
  created_at: new Date(2026, 9, 20, 14, n).toISOString(),
  files: [],
  ...extra,
});

describe("getServerMessageId", () => {
  test("is the server id once the message has one, else the id, as a lower-case uuid", () => {
    expect(getServerMessageId({ id: "temp", _serverId: uuid(1).toUpperCase() })).toBe(uuid(1));
    expect(getServerMessageId({ id: uuid(2) })).toBe(uuid(2));
    expect(getServerMessageId({ id: "temp" })).toBeNull();
    expect(getServerMessageId(null)).toBeNull();
  });
});

describe("what can be selected, forwarded and copied", () => {
  test("a stored message can be selected; one still being sent or failed cannot", () => {
    expect(isMessageSelectable(msg(1))).toBe(true);
    expect(isMessageSelectable(msg(1, { _delivery: "sending" }))).toBe(false);
    expect(isMessageSelectable(msg(1, { _delivery: "failed" }))).toBe(false);
    expect(isMessageSelectable(msg(1, { _awaitingServerEcho: true }))).toBe(false);
    expect(isMessageSelectable(msg(1, { _processingPending: true }))).toBe(false);
    expect(isMessageSelectable({ id: "local-only", body: "x" })).toBe(false);
    expect(isMessageSelectable(msg(1, { _delivery: "sent", _serverId: uuid(1) }))).toBe(true);
  });

  test("call entries and service lines can be selected (to delete them)", () => {
    expect(isMessageSelectable(msg(1, { messageType: "call", call: { kind: "audio" } }))).toBe(true);
    expect(isMessageSelectable(msg(2, { _systemEvent: { type: "join" } }))).toBe(true);
  });

  test("isServiceMessage sees the parsed event and the raw marker", () => {
    expect(isServiceMessage(msg(1, { _systemEvent: { type: "left" } }))).toBe(true);
    expect(isServiceMessage(msg(1, { body: "[[system:joined:Alice]]" }))).toBe(true);
    expect(isServiceMessage(msg(1))).toBe(false);
  });

  test("calls, service lines and encrypted messages are not forwarded", () => {
    expect(canForwardMessage(msg(1))).toBe(true);
    expect(canForwardMessage(msg(1, { messageType: "call", call: { kind: "audio" } }))).toBe(false);
    expect(canForwardMessage(msg(1, { _systemEvent: { type: "join" } }))).toBe(false);
    expect(canForwardMessage(msg(1, { e2ee: { kind: "video_note" } }))).toBe(false);
    expect(canForwardMessage(msg(1, { _delivery: "sending" }))).toBe(false);
  });

  test("a photo can be forwarded", () => {
    expect(canForwardMessage(msg(1, { body: "Sent a photo", files: [{ id: 1 }] }))).toBe(true);
  });

  test("only messages with real text are copied", () => {
    expect(canCopyMessage(msg(1))).toBe(true);
    expect(canCopyMessage(msg(1, { body: "Sent a photo", files: [{ id: 1 }] }))).toBe(false);
    expect(canCopyMessage(msg(1, { body: "look at this", files: [{ id: 1 }] }))).toBe(true);
    expect(canCopyMessage(msg(1, { body: "" }))).toBe(false);
    expect(canCopyMessage(msg(1, { messageType: "call", call: { kind: "audio" } }))).toBe(false);
    expect(canCopyMessage(msg(1, { _systemEvent: { type: "join" } }))).toBe(false);
  });
});

describe("messagesLabel", () => {
  test("counts messages in words", () => {
    expect(messagesLabel(1)).toBe("1 message");
    expect(messagesLabel(2)).toBe("2 messages");
    expect(messagesLabel(0)).toBe("0 messages");
  });
});

describe("describeSkipped", () => {
  test("says what was left out of a forward", () => {
    expect(describeSkipped({ action: "forward", count: 1 })).toBe(
      "1 message can't be forwarded (calls, service and encrypted messages) and was skipped.",
    );
    expect(describeSkipped({ action: "forward", count: 3 })).toContain("3 messages can't be forwarded");
  });

  test("says what was left out of a copy", () => {
    expect(describeSkipped({ action: "copy", count: 2 })).toBe(
      "2 messages without text were skipped.",
    );
  });

  test("is empty when nothing was left out", () => {
    expect(describeSkipped({ action: "copy", count: 0 })).toBe("");
  });
});

describe("formatCopyTimestamp", () => {
  test("is day.month.year hour:minute in local time, like Telegram", () => {
    expect(formatCopyTimestamp(new Date(2026, 0, 5, 9, 7).toISOString())).toBe("05.01.2026 09:07");
    expect(formatCopyTimestamp(new Date(2026, 9, 20, 14, 3).toISOString())).toBe("20.10.2026 14:03");
  });

  test("is empty for a date that cannot be read", () => {
    expect(formatCopyTimestamp("not a date")).toBe("");
    expect(formatCopyTimestamp(undefined)).toBe("");
  });
});

describe("buildCopyText", () => {
  test("one message is just its text", () => {
    expect(buildCopyText([msg(1, { body: "  hello there \n" })])).toEqual({
      text: "hello there",
      copied: 1,
      skipped: 0,
    });
  });

  test("several messages are 'Name, [date time]' blocks separated by a blank line", () => {
    const result = buildCopyText([
      msg(1, { body: "first" }),
      msg(2, { body: "second\nline two", nickname: "Alice", username: "alice" }),
    ]);
    expect(result.text).toBe(
      "Bob, [20.10.2026 14:01]\nfirst\n\nAlice, [20.10.2026 14:02]\nsecond\nline two",
    );
    expect(result.copied).toBe(2);
  });

  test("skips what has no text and counts it", () => {
    const result = buildCopyText([
      msg(1, { body: "kept" }),
      msg(2, { body: "Sent a photo", files: [{ id: 1 }] }),
      msg(3, { messageType: "call", call: { kind: "audio" } }),
      msg(4, { _systemEvent: { type: "join" } }),
    ]);
    // only one message is left, so it is copied as plain text
    expect(result).toEqual({ text: "kept", copied: 1, skipped: 3 });
  });

  test("nothing to copy gives empty text", () => {
    expect(buildCopyText([msg(1, { body: "Sent a photo", files: [{ id: 1 }] })])).toEqual({
      text: "",
      copied: 0,
      skipped: 1,
    });
    expect(buildCopyText([])).toEqual({ text: "", copied: 0, skipped: 0 });
  });

  test("uses the nickname, else the username; a deleted account is named as such", () => {
    const result = buildCopyText([
      msg(1, { nickname: "", username: "carol", body: "a" }),
      msg(2, { username: "deleted", nickname: "Deleted user", body: "b" }),
    ]);
    expect(result.text).toContain("carol, [");
    expect(result.text).toContain("Deleted account, [");
  });

  test("in a channel the channel is the author", () => {
    const result = buildCopyText(
      [msg(1, { body: "a" }), msg(2, { body: "b" })],
      { channelName: "News" },
    );
    expect(result.text).toBe("News, [20.10.2026 14:01]\na\n\nNews, [20.10.2026 14:02]\nb");
  });
});

describe("planForwardRequests", () => {
  const ids = (n) => Array.from({ length: n }, (_, i) => uuid(i + 1));
  const chats = (n) => Array.from({ length: n }, (_, i) => `chat-${i + 1}`);

  test("one request when it fits, in the order given", () => {
    const plan = planForwardRequests(ids(5), chats(2));
    expect(plan).toEqual([{ sourceMessageIds: ids(5), targetChatIds: chats(2) }]);
  });

  test("never more than 500 message-chat pairs in a request", () => {
    const plan = planForwardRequests(ids(100), chats(10));
    expect(plan.length).toBeGreaterThan(1);
    plan.forEach((request) => {
      expect(request.sourceMessageIds.length * request.targetChatIds.length).toBeLessThanOrEqual(500);
      expect(request.sourceMessageIds.length).toBeLessThanOrEqual(100);
    });
    // every message reaches every chat exactly once, oldest first within a chat
    const reached = new Map();
    plan.forEach((request) =>
      request.targetChatIds.forEach((chat) => {
        reached.set(chat, [...(reached.get(chat) || []), ...request.sourceMessageIds]);
      }),
    );
    chats(10).forEach((chat) => expect(reached.get(chat)).toEqual(ids(100)));
  });

  test("never more than 20 chats in a request", () => {
    const plan = planForwardRequests(ids(3), chats(45));
    plan.forEach((request) => expect(request.targetChatIds.length).toBeLessThanOrEqual(20));
    const reached = new Set(plan.flatMap((request) => request.targetChatIds));
    expect(reached.size).toBe(45);
  });

  test("nothing to send gives no request", () => {
    expect(planForwardRequests([], chats(2))).toEqual([]);
    expect(planForwardRequests(ids(2), [])).toEqual([]);
  });
});

describe("interpretForwardResponse", () => {
  const request = { sourceMessageIds: [uuid(1), uuid(2)], targetChatIds: ["c1"] };

  test("reads forwarded and failed from a 200", () => {
    const data = {
      forwarded: [{ id: "n1", chatId: "c1", sourceMessageId: uuid(1) }],
      failed: [{ sourceMessageId: uuid(2), code: "gone", error: "Message is gone." }],
    };
    expect(interpretForwardResponse({ ok: true, status: 200, data }, request)).toEqual({
      forwarded: [{ sourceMessageId: uuid(1), targetChatId: "c1" }],
      failed: [{ sourceMessageId: uuid(2), targetChatId: null, code: "gone", error: "Message is gone." }],
    });
  });

  test("a 4xx that still lists failures is read the same way", () => {
    const data = {
      error: "Nothing could be forwarded.",
      forwarded: [],
      failed: [
        { sourceMessageId: uuid(1), code: "not_forwardable", error: "No." },
        { sourceMessageId: uuid(2), targetChatId: "c1", code: "encrypted", error: "No." },
      ],
    };
    const result = interpretForwardResponse({ ok: false, status: 400, data }, request);
    expect(result.forwarded).toEqual([]);
    expect(result.failed).toHaveLength(2);
    expect(result.failed[1]).toMatchObject({ targetChatId: "c1", code: "encrypted" });
  });

  test("a refusal of the whole request fails every message with the server's words", () => {
    const result = interpretForwardResponse(
      { ok: false, status: 403, data: { error: "Cannot send to one or more selected chats." } },
      request,
    );
    expect(result.forwarded).toEqual([]);
    expect(result.failed.map((item) => item.sourceMessageId)).toEqual([uuid(1), uuid(2)]);
    expect(result.failed[0].error).toBe("Cannot send to one or more selected chats.");
  });

  test("a refusal without a body still has a reason", () => {
    const result = interpretForwardResponse({ ok: false, status: 429, data: null }, request);
    expect(result.failed[0].error).toBeTruthy();
  });
});

describe("summarizeForward", () => {
  const sources = [uuid(1), uuid(2), uuid(3)];

  test("all forwarded: 'N messages forwarded'", () => {
    const result = summarizeForward({
      sourceIds: sources,
      forwarded: sources.map((id) => ({ sourceMessageId: id, targetChatId: "c1" })),
      failed: [],
    });
    expect(result).toEqual({ tone: "info", text: "3 messages forwarded", forwardedCount: 3 });
  });

  test("forwarding to two chats still counts messages, not copies", () => {
    const forwarded = sources.flatMap((id) => [
      { sourceMessageId: id, targetChatId: "c1" },
      { sourceMessageId: id, targetChatId: "c2" },
    ]);
    expect(summarizeForward({ sourceIds: sources, forwarded, failed: [] }).text).toBe(
      "3 messages forwarded",
    );
  });

  test("one message reads 'forwarded' in the singular", () => {
    const result = summarizeForward({
      sourceIds: [uuid(1)],
      forwarded: [{ sourceMessageId: uuid(1), targetChatId: "c1" }],
      failed: [],
    });
    expect(result.text).toBe("1 message forwarded");
  });

  test("some failed: says how many and why", () => {
    const result = summarizeForward({
      sourceIds: sources,
      forwarded: [{ sourceMessageId: uuid(1), targetChatId: "c1" }],
      failed: [
        { sourceMessageId: uuid(2), targetChatId: null, code: "gone", error: "x" },
        { sourceMessageId: uuid(3), targetChatId: null, code: "gone", error: "x" },
      ],
    });
    expect(result.tone).toBe("error");
    expect(result.forwardedCount).toBe(1);
    expect(result.text).toMatch(/^1 of 3 messages forwarded\./);
    expect(result.text).toMatch(/deleted/i);
  });

  test("nothing forwarded: an error that gives the reason", () => {
    const result = summarizeForward({
      sourceIds: sources,
      forwarded: [],
      failed: sources.map((id) => ({
        sourceMessageId: id,
        targetChatId: null,
        code: "request_failed",
        error: "Cannot send to one or more selected chats.",
      })),
    });
    expect(result.tone).toBe("error");
    expect(result.forwardedCount).toBe(0);
    expect(result.text).toContain("Cannot send to one or more selected chats.");
  });

  test("a message that reached one chat but not another counts as a partial failure", () => {
    const result = summarizeForward({
      sourceIds: [uuid(1)],
      forwarded: [{ sourceMessageId: uuid(1), targetChatId: "c1" }],
      failed: [{ sourceMessageId: uuid(1), targetChatId: "c2", code: "create_failed", error: "Boom." }],
    });
    expect(result.tone).toBe("error");
    expect(result.forwardedCount).toBe(1);
  });
});

describe("planDelete", () => {
  const mine = (n, extra) => msg(n, { username: "me", ...extra });
  const canEveryone = (m) => m.username === "me";

  test("splits what can go for everyone from what can only be hidden for me", () => {
    const plan = planDelete([mine(1), msg(2), mine(3)], { canDeleteForEveryone: canEveryone });
    expect(plan.ids).toEqual([uuid(1), uuid(2), uuid(3)]);
    expect(plan.everyoneIds).toEqual([uuid(1), uuid(3)]);
    expect(plan.selfOnlyIds).toEqual([uuid(2)]);
  });

  test("a call entry is only ever hidden for me, even my own", () => {
    const call = mine(1, { messageType: "call", call: { kind: "audio" } });
    const plan = planDelete([call], { canDeleteForEveryone: () => true });
    expect(plan.everyoneIds).toEqual([]);
    expect(plan.selfOnlyIds).toEqual([uuid(1)]);
  });

  test("leaves out messages that have no server id yet", () => {
    const plan = planDelete([mine(1), { id: "local", username: "me" }], {
      canDeleteForEveryone: canEveryone,
    });
    expect(plan.ids).toEqual([uuid(1)]);
  });
});

describe("interpretDeleteResponse", () => {
  const ids = [uuid(1), uuid(2)];

  test("reads the result of every message", () => {
    const data = {
      results: [
        { messageId: uuid(1), ok: true },
        { messageId: uuid(2), ok: false, code: "forbidden", error: "You cannot delete this message for everyone." },
      ],
    };
    expect(interpretDeleteResponse({ ok: true, status: 200, data }, ids)).toEqual({
      okIds: [uuid(1)],
      failed: [
        { messageId: uuid(2), code: "forbidden", error: "You cannot delete this message for everyone." },
      ],
    });
  });

  test("when every message failed the results still come with the error status", () => {
    const data = { error: "Nope.", results: ids.map((messageId) => ({ messageId, ok: false, code: "not_found", error: "Message not found." })) };
    const result = interpretDeleteResponse({ ok: false, status: 404, data }, ids);
    expect(result.okIds).toEqual([]);
    expect(result.failed).toHaveLength(2);
  });

  test("a refusal of the whole request fails every message", () => {
    const result = interpretDeleteResponse(
      { ok: false, status: 403, data: { error: "Not a member of this chat." } },
      ids,
    );
    expect(result.okIds).toEqual([]);
    expect(result.failed.map((item) => item.messageId)).toEqual(ids);
    expect(result.failed[0].error).toBe("Not a member of this chat.");
  });

  test("a message the server did not mention counts as failed", () => {
    const data = { results: [{ messageId: uuid(1), ok: true }] };
    const result = interpretDeleteResponse({ ok: true, status: 200, data }, ids);
    expect(result.okIds).toEqual([uuid(1)]);
    expect(result.failed.map((item) => item.messageId)).toEqual([uuid(2)]);
  });
});

describe("summarizeDelete", () => {
  test("all deleted", () => {
    expect(summarizeDelete({ total: 3, okCount: 3, failed: [] })).toEqual({
      tone: "info",
      text: "3 messages deleted",
    });
    expect(summarizeDelete({ total: 1, okCount: 1, failed: [] }).text).toBe("1 message deleted");
  });

  test("some failed: says how many and why", () => {
    const result = summarizeDelete({
      total: 5,
      okCount: 3,
      failed: [
        { messageId: "a", code: "forbidden", error: "You cannot delete this message for everyone." },
        { messageId: "b", code: "forbidden", error: "You cannot delete this message for everyone." },
      ],
    });
    expect(result.tone).toBe("error");
    expect(result.text).toBe(
      "3 of 5 messages deleted. You cannot delete this message for everyone.",
    );
  });

  test("none deleted", () => {
    const result = summarizeDelete({
      total: 2,
      okCount: 0,
      failed: [{ messageId: "a", code: "delete_failed", error: "Unable to delete message." }],
    });
    expect(result.tone).toBe("error");
    expect(result.text).toBe("Couldn't delete the messages. Unable to delete message.");
  });
});

describe("describeDeleteEffect", () => {
  test("messages that cannot go for everyone are only removed from the person's view", () => {
    expect(describeDeleteEffect({ total: 3, everyoneCount: 0, deleteForEveryone: true })).toBe(
      "You can only remove them from your own view. Everyone else in the chat keeps them.",
    );
    expect(describeDeleteEffect({ total: 1, everyoneCount: 0, deleteForEveryone: false })).toBe(
      "You can only remove it from your own view. Everyone else in the chat keeps it.",
    );
  });

  test("with the switch off it says what turning the switch on would do", () => {
    expect(describeDeleteEffect({ total: 4, everyoneCount: 4, deleteForEveryone: false })).toBe(
      'They are removed from your view only. Turn on "Delete for everyone" to remove them for everyone too.',
    );
    expect(describeDeleteEffect({ total: 5, everyoneCount: 2, deleteForEveryone: false })).toBe(
      'They are removed from your view only. Turn on "Delete for everyone" to also remove 2 of them for everyone.',
    );
  });

  test("with the switch on and all of them allowed, they go for everyone", () => {
    expect(describeDeleteEffect({ total: 4, everyoneCount: 4, deleteForEveryone: true })).toBe(
      "They are removed for everyone in this chat.",
    );
    expect(describeDeleteEffect({ total: 1, everyoneCount: 1, deleteForEveryone: true })).toBe(
      "It is removed for everyone in this chat.",
    );
  });

  test("with the switch on and some of them allowed, says how many go for everyone", () => {
    expect(describeDeleteEffect({ total: 5, everyoneCount: 3, deleteForEveryone: true })).toBe(
      "3 of them are removed for everyone. The other 2 can only be removed from your view.",
    );
    expect(describeDeleteEffect({ total: 3, everyoneCount: 1, deleteForEveryone: true })).toBe(
      "1 of them is removed for everyone. The other 2 can only be removed from your view.",
    );
  });
});
