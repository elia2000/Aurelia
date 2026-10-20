import { describe, test, expect, vi, beforeEach } from "vitest";
import { createCallMessageService } from "../../../lib/services/callMessageService.js";
import { makeCallMessageStore } from "../../helpers/callMessageStore.js";

const ALICE = { id: "a0a0a0a0-b1b1-4c2c-8d3d-e4e4e4e4e4e4", username: "alice", banned: 0 };
const BOB = { id: "b0b0b0b0-c1c1-4d2d-8e3e-f4f4f4f4f4f4", username: "bob", banned: 0 };
const CHAT_ID = "d0d0d0d0-e1e1-4f2f-8040-b5b5b5b5b5b5";
const CALL_ID = "f0f0f0f0-a1a1-4b2b-8c3c-d5d5d5d5d5d5";

const endedCall = (overrides = {}) => ({
  id: CALL_ID,
  kind: "audio",
  chatId: CHAT_ID,
  caller: { id: ALICE.id, username: "alice" },
  callee: { id: BOB.id, username: "bob" },
  createdAt: 1_000,
  answeredAt: null,
  connectedAt: null,
  endedAt: 31_000,
  endedFrom: "ringing",
  endReason: "missed",
  offlineSince: null,
  reportedDurationMs: null,
  ...overrides,
});

const answeredCall = (overrides = {}) =>
  endedCall({
    answeredAt: 5_000,
    connectedAt: 8_000,
    endedAt: 38_000,
    endedFrom: "active",
    endReason: "hangup",
    ...overrides,
  });

describe("callMessageService.recordEndedCall", () => {
  let store;
  let emitChatEvent;
  let chat;
  let members;
  let users;
  let settings;
  let service;

  const build = (overrides = {}) =>
    createCallMessageService({
      findChatById: () => chat,
      findUserById: (id) => users[id] || null,
      isMember: (chatId, userId) => chatId === CHAT_ID && members.has(userId),
      createCallMessage: store.create,
      emitChatEvent,
      getSetting: (key) => settings[key] ?? null,
      ...overrides,
    });

  beforeEach(() => {
    store = makeCallMessageStore();
    emitChatEvent = vi.fn();
    chat = { id: CHAT_ID, type: "dm" };
    members = new Set([ALICE.id, BOB.id]);
    users = { [ALICE.id]: { ...ALICE }, [BOB.id]: { ...BOB } };
    settings = {};
    service = build();
  });

  describe("what is stored", () => {
    test.each([
      ["cancelled", { endReason: "cancelled" }, "cancelled", null],
      ["declined", { endReason: "declined" }, "declined", null],
      ["missed", { endReason: "missed" }, "missed", null],
    ])("a call %s by nobody answering", async (_label, overrides, outcome, durationSec) => {
      const result = await service.recordEndedCall(endedCall(overrides));
      expect(result.recorded).toBe(true);
      const [row] = [...store.rows.values()];
      expect(row).toMatchObject({
        chat_id: CHAT_ID,
        user_id: ALICE.id,
        call_id: CALL_ID,
        call_kind: "audio",
        call_outcome: outcome,
        call_duration_sec: durationSec,
      });
    });

    test("a call that was answered keeps how long it lasted", async () => {
      await service.recordEndedCall(answeredCall({ kind: "video" }));
      const [row] = [...store.rows.values()];
      expect(row).toMatchObject({ call_kind: "video", call_outcome: "completed", call_duration_sec: 30 });
    });

    test("a call that was answered but never connected failed", async () => {
      await service.recordEndedCall(
        answeredCall({ endedFrom: "connecting", connectedAt: null, endReason: "failed" }),
      );
      const [row] = [...store.rows.values()];
      expect(row).toMatchObject({ call_outcome: "failed", call_duration_sec: null });
    });

    test("the caller writes the entry, whoever ended the call", async () => {
      await service.recordEndedCall(endedCall({ endReason: "declined" }));
      expect([...store.rows.values()][0].user_id).toBe(ALICE.id);
    });
  });

  describe("who has read it", () => {
    test.each(["declined", "cancelled"])("a %s call is already read by the callee", async (endReason) => {
      await service.recordEndedCall(endedCall({ endReason }));
      expect(store.create.mock.calls[0][0].markReadBy).toBe(BOB.id);
    });

    test("a completed call is already read by the callee", async () => {
      await service.recordEndedCall(answeredCall());
      expect(store.create.mock.calls[0][0].markReadBy).toBe(BOB.id);
    });

    test("a failed call is already read by the callee", async () => {
      await service.recordEndedCall(answeredCall({ endedFrom: "connecting", connectedAt: null }));
      expect(store.create.mock.calls[0][0].markReadBy).toBe(BOB.id);
    });

    test("a missed call is left unread for the callee", async () => {
      await service.recordEndedCall(endedCall({ endReason: "missed" }));
      expect(store.create.mock.calls[0][0].markReadBy).toBeNull();
    });
  });

  describe("exactly once", () => {
    test("recording the same call again adds nothing and says nothing", async () => {
      const first = await service.recordEndedCall(endedCall());
      emitChatEvent.mockClear();
      const second = await service.recordEndedCall(endedCall());
      expect(first.recorded).toBe(true);
      expect(second).toMatchObject({ recorded: false, reason: "duplicate", messageId: first.messageId });
      expect(store.rows.size).toBe(1);
      expect(emitChatEvent).not.toHaveBeenCalled();
    });

    test("two requests at the same moment still make one entry and one event", async () => {
      const results = await Promise.all([
        service.recordEndedCall(endedCall()),
        service.recordEndedCall(endedCall()),
        service.recordEndedCall(endedCall()),
      ]);
      expect(results.filter((r) => r.recorded)).toHaveLength(1);
      expect(store.rows.size).toBe(1);
      expect(emitChatEvent).toHaveBeenCalledTimes(1);
    });

    test("with a database that answers with promises", async () => {
      const asyncStore = makeCallMessageStore();
      const asyncService = build({
        createCallMessage: async (args) => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return asyncStore.create(args);
        },
      });
      const results = await Promise.all([
        asyncService.recordEndedCall(endedCall()),
        asyncService.recordEndedCall(endedCall()),
      ]);
      expect(results.filter((r) => r.recorded)).toHaveLength(1);
      expect(emitChatEvent).toHaveBeenCalledTimes(1);
    });
  });

  describe("who may be written into the conversation", () => {
    test.each([
      ["a group", { id: CHAT_ID, type: "group" }],
      ["Saved Messages", { id: CHAT_ID, type: "saved" }],
      ["a channel", { id: CHAT_ID, type: "channel" }],
      ["a chat that is gone", null],
    ])("nothing is written into %s", async (_label, value) => {
      chat = value;
      const result = await service.recordEndedCall(endedCall());
      expect(result).toMatchObject({ recorded: false, reason: "not_a_dm" });
      expect(store.create).not.toHaveBeenCalled();
      expect(emitChatEvent).not.toHaveBeenCalled();
    });

    test.each([
      ["the caller", ALICE.id],
      ["the callee", BOB.id],
    ])("nothing is written once %s is no longer in the chat", async (_label, id) => {
      members.delete(id);
      const result = await service.recordEndedCall(endedCall());
      expect(result).toMatchObject({ recorded: false, reason: "not_member" });
      expect(store.create).not.toHaveBeenCalled();
    });

    test.each([
      ["the caller", ALICE.id],
      ["the callee", BOB.id],
    ])("nothing is written once the account of %s is gone", async (_label, id) => {
      delete users[id];
      const result = await service.recordEndedCall(endedCall());
      expect(result).toMatchObject({ recorded: false, reason: "user_unavailable" });
      expect(store.create).not.toHaveBeenCalled();
    });

    test.each([
      ["the caller", ALICE.id],
      ["the callee", BOB.id],
    ])("nothing is written once %s is banned", async (_label, id) => {
      users[id].banned = 1;
      const result = await service.recordEndedCall(endedCall());
      expect(result).toMatchObject({ recorded: false, reason: "user_unavailable" });
      expect(store.create).not.toHaveBeenCalled();
    });

    test("a call without a chat is ignored", async () => {
      const result = await service.recordEndedCall(endedCall({ chatId: null }));
      expect(result).toMatchObject({ recorded: false, reason: "not_a_dm" });
    });

    test("something that is not a call is ignored", async () => {
      expect(await service.recordEndedCall(null)).toMatchObject({ recorded: false });
      expect(await service.recordEndedCall({})).toMatchObject({ recorded: false });
      expect(store.create).not.toHaveBeenCalled();
    });

    test("a database with async lookups works the same", async () => {
      const asyncService = build({
        findChatById: async () => chat,
        findUserById: async (id) => users[id] || null,
        isMember: async (chatId, userId) => members.has(userId),
      });
      expect((await asyncService.recordEndedCall(endedCall())).recorded).toBe(true);
    });
  });

  describe("retention", () => {
    test("an entry expires like a text message does", async () => {
      settings.MESSAGE_TEXT_RETENTION = 2;
      const before = Date.now();
      await service.recordEndedCall(endedCall());
      const expiresAt = Date.parse(store.create.mock.calls[0][0].expiresAt);
      const twoDays = 2 * 24 * 60 * 60 * 1000;
      expect(expiresAt).toBeGreaterThanOrEqual(before + twoDays);
      expect(expiresAt).toBeLessThanOrEqual(Date.now() + twoDays);
    });

    test.each([0, null, undefined, -3, "abc", NaN])("retention %s keeps entries forever", async (value) => {
      settings.MESSAGE_TEXT_RETENTION = value;
      await service.recordEndedCall(endedCall());
      expect(store.create.mock.calls[0][0].expiresAt).toBeNull();
    });
  });

  describe("the realtime event", () => {
    test("tells everybody in the chat, with the structured call", async () => {
      const result = await service.recordEndedCall(answeredCall({ kind: "video" }));
      expect(emitChatEvent).toHaveBeenCalledTimes(1);
      const [chatId, payload] = emitChatEvent.mock.calls[0];
      expect(chatId).toBe(CHAT_ID);
      expect(payload).toMatchObject({
        type: "chat_message",
        chatId: CHAT_ID,
        messageId: result.messageId,
        userId: ALICE.id,
        username: "alice",
        body: "",
        messageType: "call",
        call: { callId: CALL_ID, kind: "video", outcome: "completed", durationSec: 30 },
        countsAsUnread: false,
        created_at: "2026-10-17 10:00:00",
      });
      expect(payload.summaryText).toBe("Video call");
    });

    test("an entry that is already read says so", async () => {
      await service.recordEndedCall(answeredCall());
      const [, payload] = emitChatEvent.mock.calls[0];
      expect(payload.read_by_user_id).toBe(BOB.id);
      expect(typeof payload.read_at).toBe("string");
    });

    test("a missed call counts as unread and is not marked read", async () => {
      await service.recordEndedCall(endedCall({ endReason: "missed" }));
      const [, payload] = emitChatEvent.mock.calls[0];
      expect(payload.countsAsUnread).toBe(true);
      expect(payload.call.outcome).toBe("missed");
      expect(payload.read_at).toBeUndefined();
      expect(payload.read_by_user_id).toBeUndefined();
      expect(payload.summaryText).toBe("Missed call");
    });

    test("the payload carries nothing secret about the call", async () => {
      await service.recordEndedCall(
        answeredCall({ invitePayload: { commit: "x", sig: "y" }, callerDeviceId: "dev-a" }),
      );
      const serialized = JSON.stringify(emitChatEvent.mock.calls[0][1]);
      expect(serialized).not.toMatch(/commit|sig|dev-a|invitePayload/);
    });

    test("a broken realtime hub does not undo the entry", async () => {
      emitChatEvent.mockImplementation(() => {
        throw new Error("hub down");
      });
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const result = await service.recordEndedCall(endedCall());
      expect(result.recorded).toBe(true);
      expect(store.rows.size).toBe(1);
      spy.mockRestore();
    });
  });

  describe("failures", () => {
    test("a database error is reported, never thrown at the caller", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const failing = build({
        createCallMessage: () => {
          throw new Error("disk full");
        },
      });
      await expect(failing.recordEndedCall(endedCall())).resolves.toMatchObject({
        recorded: false,
        reason: "error",
      });
      expect(emitChatEvent).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    test("a rejected promise from the database is handled too", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const failing = build({ createCallMessage: () => Promise.reject(new Error("gone")) });
      await expect(failing.recordEndedCall(endedCall())).resolves.toMatchObject({ reason: "error" });
      spy.mockRestore();
    });

    test("without a database function nothing happens", async () => {
      const bare = build({ createCallMessage: undefined });
      await expect(bare.recordEndedCall(endedCall())).resolves.toMatchObject({ recorded: false });
    });
  });
});

describe("callMessageService.recordBusyCall", () => {
  let store;
  let emitChatEvent;
  let service;

  beforeEach(() => {
    store = makeCallMessageStore();
    emitChatEvent = vi.fn();
    service = createCallMessageService({
      findChatById: () => ({ id: CHAT_ID, type: "dm" }),
      findUserById: (id) => ({ [ALICE.id]: ALICE, [BOB.id]: BOB })[id] || null,
      isMember: () => true,
      createCallMessage: store.create,
      emitChatEvent,
      getSetting: () => null,
    });
  });

  const busy = (overrides = {}) => ({
    callId: CALL_ID,
    kind: "video",
    chatId: CHAT_ID,
    caller: { id: ALICE.id, username: "alice" },
    callee: { id: BOB.id, username: "bob" },
    ...overrides,
  });

  test("leaves a busy entry that is read for both", async () => {
    const result = await service.recordBusyCall(busy());
    expect(result.recorded).toBe(true);
    expect([...store.rows.values()][0]).toMatchObject({
      user_id: ALICE.id,
      call_kind: "video",
      call_outcome: "busy",
      call_duration_sec: null,
      read_by: BOB.id,
    });
    const [, payload] = emitChatEvent.mock.calls[0];
    expect(payload).toMatchObject({ messageType: "call", countsAsUnread: false });
    expect(payload.call).toEqual({ callId: CALL_ID, kind: "video", outcome: "busy", durationSec: null });
  });

  test("trying again with the same call id adds nothing", async () => {
    await service.recordBusyCall(busy());
    emitChatEvent.mockClear();
    const again = await service.recordBusyCall(busy());
    expect(again.recorded).toBe(false);
    expect(store.rows.size).toBe(1);
    expect(emitChatEvent).not.toHaveBeenCalled();
  });
});
