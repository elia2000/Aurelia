import { describe, test, expect, vi, afterEach } from "vitest";
import { createSseHub } from "../../lib/sse.js";
import { createCallMessageService } from "../../lib/services/callMessageService.js";
import { makeCallMessageStore } from "../helpers/callMessageStore.js";

const ALICE = { id: "a0a0a0a0-b1b1-4c2c-8d3d-e4e4e4e4e4e4", username: "alice" };
const BOB = { id: "b0b0b0b0-c1c1-4d2d-8e3e-f4f4f4f4f4f4", username: "bob" };
const CHAT_ID = "d0d0d0d0-e1e1-4f2f-8040-b5b5b5b5b5b5";
const CALL_ID = "f0f0f0f0-a1a1-4b2b-8c3c-d5d5d5d5d5d5";

const client = () => ({ write: vi.fn() });
const received = (res) =>
  res.write.mock.calls.map(([line]) => JSON.parse(String(line).replace(/^data: /, "")));

describe("the call entry reaches both people through the realtime hub", () => {
  let hub;
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup() {
    hub = createSseHub({ listChatMembers: () => [ALICE, BOB] });
    const aliceTab = client();
    const aliceOther = client();
    const bobTab = client();
    const carolTab = client();
    hub.addSseClient("alice", aliceTab);
    hub.addSseClient("alice", aliceOther);
    hub.addSseClient("bob", bobTab);
    hub.addSseClient("carol", carolTab);
    const store = makeCallMessageStore();
    const service = createCallMessageService({
      findChatById: () => ({ id: CHAT_ID, type: "dm" }),
      findUserById: (id) => [ALICE, BOB].find((u) => u.id === id) || null,
      isMember: () => true,
      createCallMessage: store.create,
      emitChatEvent: hub.emitChatEvent,
      getSetting: () => null,
    });
    return { service, store, aliceTab, aliceOther, bobTab, carolTab };
  }

  const call = (overrides = {}) => ({
    id: CALL_ID,
    kind: "video",
    chatId: CHAT_ID,
    caller: { id: ALICE.id, username: "alice" },
    callee: { id: BOB.id, username: "bob" },
    answeredAt: 5_000,
    connectedAt: 8_000,
    endedAt: 98_000,
    endedFrom: "active",
    endReason: "hangup",
    ...overrides,
  });

  test("every session of both members gets one chat_message, nobody else does", async () => {
    const { service, aliceTab, aliceOther, bobTab, carolTab } = setup();
    const result = await service.recordEndedCall(call());
    expect(result.recorded).toBe(true);

    for (const tab of [aliceTab, aliceOther, bobTab]) {
      const events = received(tab);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "chat_message",
        chatId: CHAT_ID,
        messageId: result.messageId,
        userId: ALICE.id,
        username: "alice",
        messageType: "call",
        call: { callId: CALL_ID, kind: "video", outcome: "completed", durationSec: 90 },
        countsAsUnread: false,
        reactions: [],
      });
    }
    expect(carolTab.write).not.toHaveBeenCalled();
  });

  test("a missed call tells the callee it is unread", async () => {
    const { service, bobTab } = setup();
    await service.recordEndedCall(
      call({ answeredAt: null, connectedAt: null, endedFrom: "ringing", endReason: "missed" }),
    );
    const [event] = received(bobTab);
    expect(event.countsAsUnread).toBe(true);
    expect(event.call).toEqual({ callId: CALL_ID, kind: "video", outcome: "missed", durationSec: null });
    expect(event.summaryText).toBe("Missed video call");
  });

  test("recording the call a second time says nothing more", async () => {
    const { service, aliceTab, bobTab } = setup();
    await service.recordEndedCall(call());
    await service.recordEndedCall(call());
    expect(received(aliceTab)).toHaveLength(1);
    expect(received(bobTab)).toHaveLength(1);
  });

  test("listeners of the hub (the websocket gateway) hear about it too", async () => {
    const { service } = setup();
    const listener = vi.fn();
    hub.onChatEvent(listener);
    await service.recordEndedCall(call());
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toBe(CHAT_ID);
    expect(listener.mock.calls[0][1]).toMatchObject({ type: "chat_message", messageType: "call" });
  });
});
