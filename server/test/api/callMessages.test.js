import { describe, test, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { makeApp, makeUserStore } from "../helpers/makeApp.js";
import { makeP256PublicKey, b64u } from "../helpers/p256.js";
import { makeCallMessageStore } from "../helpers/callMessageStore.js";
import { createCallRegistry } from "../../lib/calls.js";

const ALICE_ID = "a0a0a0a0-b1b1-4c2c-8d3d-e4e4e4e4e4e4";
const BOB_ID = "b0b0b0b0-c1c1-4d2d-8e3e-f4f4f4f4f4f4";
const CAROL_ID = "c0c0c0c0-d1d1-4e2e-8f3f-a4a4a4a4a4a4";
const DM_CHAT = "d0d0d0d0-e1e1-4f2f-8040-b5b5b5b5b5b5";
const DM_CAROL_BOB = "d1d1d1d1-e1e1-4f2f-8040-b5b5b5b5b5b5";
const CALL_ID = "f0f0f0f0-a1a1-4b2b-8c3c-d5d5d5d5d5d5";
const CALL_ID_2 = "f1f1f1f1-a1a1-4b2b-8c3c-d5d5d5d5d5d5";

const user = (id, username) => ({
  id,
  username,
  password_hash: "x",
  nickname: username.toUpperCase(),
  avatar_url: null,
  color: "#10b981",
  status: "online",
  role: "user",
  banned: false,
});

const until = async (predicate, timeoutMs = 1500) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for the condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

describe("call history entries in the chat", () => {
  let ctx;
  let store;
  let clock;
  let push;
  let chatEvents;
  let members;
  let aliceDevice;
  let bobDevice;
  let carolDevice;

  const as = (name) => (req) => req.set("Cookie", [`sid=tok-${name}`]);
  const alice = as("alice");
  const bob = as("bob");
  const carol = as("carol");

  const inviteBody = (device, overrides = {}) => ({
    callId: CALL_ID,
    chatId: DM_CHAT,
    kind: "audio",
    invite: { deviceId: device.id, commit: b64u(32), ts: Date.now(), sig: b64u(64) },
    ...overrides,
  });
  const acceptBody = () => ({
    accept: { deviceId: bobDevice.id, eph: makeP256PublicKey(), sig: b64u(64) },
  });
  const placeCall = (overrides = {}) =>
    alice(request(ctx.app).post("/api/calls")).send(inviteBody(aliceDevice, overrides));
  const accept = (callId = CALL_ID) =>
    bob(request(ctx.app).post(`/api/calls/${callId}/accept`)).send(acceptBody());
  const connected = (who = alice, callId = CALL_ID) =>
    who(request(ctx.app).post(`/api/calls/${callId}/connected`)).send({});
  const end = (who, body = {}, callId = CALL_ID) =>
    who(request(ctx.app).post(`/api/calls/${callId}/end`)).send(body);
  const chatMessages = () =>
    chatEvents.filter((e) => e.payload.type === "chat_message").map((e) => e.payload);

  function build({ sweepMs = 0, deps = {} } = {}) {
    // Everything a sweeper of this app touches is captured here, so a timer
    // left over from an earlier test cannot write into a later one.
    const ownClock = { t: Date.now() };
    const ownEvents = [];
    clock = ownClock;
    chatEvents = ownEvents;
    store = makeCallMessageStore();
    push = vi.fn(async () => {});
    members = {
      [DM_CHAT]: [user(ALICE_ID, "alice"), user(BOB_ID, "bob")],
      [DM_CAROL_BOB]: [user(CAROL_ID, "carol"), user(BOB_ID, "bob")],
    };
    const chats = {
      [DM_CHAT]: { id: DM_CHAT, type: "dm" },
      [DM_CAROL_BOB]: { id: DM_CAROL_BOB, type: "dm" },
    };
    ctx = makeApp({
      userStore: makeUserStore([
        user(ALICE_ID, "alice"),
        user(BOB_ID, "bob"),
        user(CAROL_ID, "carol"),
      ]),
      deps: {
        callRegistry: createCallRegistry({
          now: () => ownClock.t,
          ringTimeoutMs: 45_000,
          connectTimeoutMs: 60_000,
        }),
        callSweepIntervalMs: sweepMs,
        findChatById: (id) => chats[id] || null,
        isMember: (chatId, userId) => (members[chatId] || []).some((m) => m.id === userId),
        listChatMembers: (chatId) => members[chatId] || [],
        isUserConnected: () => true,
        sendPushNotificationToUsers: push,
        createCallMessage: store.create,
        emitChatEvent: (chatId, payload) => ownEvents.push({ chatId, payload }),
        ...deps,
      },
    });
    [
      ["alice", ALICE_ID],
      ["bob", BOB_ID],
      ["carol", CAROL_ID],
    ].forEach(([name, id]) => ctx.sessionStore.createSession(id, `tok-${name}`));
    const device = (userId) =>
      ctx.e2eeStore.createE2eeDevice({
        userId,
        ecdhPublic: makeP256PublicKey(),
        ecdsaPublic: makeP256PublicKey(),
      });
    aliceDevice = device(ALICE_ID);
    bobDevice = device(BOB_ID);
    carolDevice = device(CAROL_ID);
  }

  beforeEach(() => build());

  describe("every way a call can end leaves exactly one entry", () => {
    test("the caller hangs up before anyone answers: cancelled", async () => {
      await placeCall();
      expect((await end(alice)).status).toBe(200);
      expect(store.list()).toHaveLength(1);
      expect(store.list()[0]).toMatchObject({
        chat_id: DM_CHAT,
        user_id: ALICE_ID,
        body: "",
        call_id: CALL_ID,
        call_kind: "audio",
        call_outcome: "cancelled",
        call_duration_sec: null,
        read_by: BOB_ID,
      });
    });

    test("the callee declines: declined, still written by the caller", async () => {
      await placeCall({ kind: "video" });
      await end(bob);
      expect(store.list()).toHaveLength(1);
      expect(store.list()[0]).toMatchObject({
        user_id: ALICE_ID,
        call_kind: "video",
        call_outcome: "declined",
        read_by: BOB_ID,
      });
    });

    test("nobody picks up: missed, and it waits to be read by the callee", async () => {
      build({ sweepMs: 10 });
      await placeCall();
      clock.t += 46_000;
      await until(() => store.list().length === 1);
      expect(store.list()[0]).toMatchObject({
        user_id: ALICE_ID,
        call_outcome: "missed",
        call_duration_sec: null,
        read_by: null,
      });
      expect(chatMessages()[0]).toMatchObject({ countsAsUnread: true });
    });

    test("answered, connected and hung up: completed with how long it lasted", async () => {
      await placeCall();
      await accept();
      clock.t += 2_000;
      await connected();
      clock.t += 23_000;
      await end(bob);
      expect(store.list()).toHaveLength(1);
      expect(store.list()[0]).toMatchObject({
        user_id: ALICE_ID,
        call_outcome: "completed",
        call_duration_sec: 23,
        read_by: BOB_ID,
      });
    });

    test("video calls say so", async () => {
      await placeCall({ kind: "video" });
      await accept();
      await connected();
      clock.t += 5_000;
      await end(alice);
      expect(store.list()[0]).toMatchObject({ call_kind: "video", call_outcome: "completed" });
    });

    test("the device can report how long the call really lasted", async () => {
      await placeCall();
      await accept();
      clock.t += 1_000;
      await connected();
      clock.t += 29_000;
      await end(alice, { durationMs: 27_400 });
      expect(store.list()[0]).toMatchObject({ call_outcome: "completed", call_duration_sec: 27 });
    });

    test("a reported duration longer than the call could have lasted is cut to the real window", async () => {
      await placeCall();
      await accept();
      clock.t += 1_000;
      await connected();
      clock.t += 29_000;
      await end(alice, { durationMs: 86_400_000 });
      expect(store.list()[0].call_duration_sec).toBe(30);
    });

    test.each(["abc", -5, null, [], {}, 1e308, "12000"])(
      "a nonsense reported duration (%j) never stops the call from ending",
      async (durationMs) => {
        await placeCall();
        await accept();
        clock.t += 10_000;
        await connected();
        clock.t += 10_000;
        const res = await end(alice, { durationMs });
        expect(res.status).toBe(200);
        expect(store.list()).toHaveLength(1);
        expect(store.list()[0]).toMatchObject({ call_outcome: "completed" });
        // The server's own clock is used instead (10 s since the connection was reported,
        // or the whole 20 s when the report is huge but valid).
        expect([10, 20]).toContain(store.list()[0].call_duration_sec);
      },
    );

    test("answered but the media never connected: failed", async () => {
      await placeCall();
      await accept();
      await end(bob, { reason: "connect_failed" });
      expect(store.list()[0]).toMatchObject({
        call_outcome: "failed",
        call_duration_sec: null,
        read_by: BOB_ID,
      });
    });

    test("answered but never connected and nobody hung up: failed when the connection times out", async () => {
      build({ sweepMs: 10 });
      await placeCall();
      await accept();
      clock.t += 61_000;
      await until(() => store.list().length === 1);
      expect(store.list()[0]).toMatchObject({ call_outcome: "failed", read_by: BOB_ID });
    });

    test("an answered call that dropped is still a completed call", async () => {
      await placeCall();
      await accept();
      clock.t += 1_000;
      await connected();
      clock.t += 12_000;
      await end(alice, { reason: "failed" });
      expect(store.list()[0]).toMatchObject({ call_outcome: "completed", call_duration_sec: 12 });
    });

    test("the callee is busy: busy, written by the caller, in the right chat", async () => {
      await placeCall(); // alice rings bob
      const res = await carol(request(ctx.app).post("/api/calls")).send(
        inviteBody(carolDevice, { callId: CALL_ID_2, chatId: DM_CAROL_BOB, kind: "video" }),
      );
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("busy");
      expect(store.byCall(CALL_ID_2)).toHaveLength(1);
      expect(store.byCall(CALL_ID_2)[0]).toMatchObject({
        chat_id: DM_CAROL_BOB,
        user_id: CAROL_ID,
        call_kind: "video",
        call_outcome: "busy",
        call_duration_sec: null,
        read_by: BOB_ID,
      });
      // Nothing was added for the call that is actually running.
      expect(store.byCall(CALL_ID)).toHaveLength(0);
    });

    test("trying again after a busy answer does not repeat the entry", async () => {
      await placeCall();
      const body = inviteBody(carolDevice, { callId: CALL_ID_2, chatId: DM_CAROL_BOB });
      await carol(request(ctx.app).post("/api/calls")).send(body);
      await carol(request(ctx.app).post("/api/calls")).send({
        ...body,
        invite: { ...body.invite, commit: b64u(32) },
      });
      expect(store.byCall(CALL_ID_2)).toHaveLength(1);
    });

    test("a caller who is already in a call gets no entry: nobody was reached", async () => {
      await placeCall();
      const res = await alice(request(ctx.app).post("/api/calls")).send(
        inviteBody(aliceDevice, { callId: CALL_ID_2 }),
      );
      expect(res.body.code).toBe("busy_self");
      expect(store.byCall(CALL_ID_2)).toHaveLength(0);
    });

    test("a call that was refused or malformed leaves no entry", async () => {
      await alice(request(ctx.app).post("/api/calls")).send(inviteBody(aliceDevice, { kind: "screen" }));
      await carol(request(ctx.app).post("/api/calls")).send(inviteBody(carolDevice)); // not in the chat
      await alice(request(ctx.app).post("/api/calls")).send(inviteBody(bobDevice)); // not her device
      expect(store.list()).toHaveLength(0);
    });
  });

  describe("exactly once, however the call ends", () => {
    test("both people hang up at the same moment", async () => {
      await placeCall();
      await accept();
      await connected();
      clock.t += 10_000;
      const [a, b] = await Promise.all([end(alice), end(bob)]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(store.list()).toHaveLength(1);
      expect(chatMessages()).toHaveLength(1);
    });

    test("caller cancels while the callee declines at the same moment", async () => {
      await placeCall();
      const [a, b] = await Promise.all([end(alice), end(bob)]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(store.list()).toHaveLength(1);
      expect(["cancelled", "declined"]).toContain(store.list()[0].call_outcome);
      expect(chatMessages()).toHaveLength(1);
    });

    test("hanging up twice", async () => {
      await placeCall();
      await end(alice);
      await end(alice);
      await end(bob);
      expect(store.list()).toHaveLength(1);
      expect(chatMessages()).toHaveLength(1);
    });

    test("the expiry sweeper and a person ending the call together", async () => {
      build({ sweepMs: 5 });
      await placeCall();
      clock.t += 46_000;
      await Promise.all([end(bob), settle()]);
      await settle();
      expect(store.list()).toHaveLength(1);
      expect(chatMessages()).toHaveLength(1);
      expect(["declined", "missed"]).toContain(store.list()[0].call_outcome);
    });

    test("the callee answering a call that already expired changes nothing", async () => {
      build({ sweepMs: 5 });
      await placeCall();
      clock.t += 46_000;
      await until(() => store.list().length === 1);
      const late = await accept();
      expect(late.status).toBe(409);
      await end(bob);
      expect(store.list()).toHaveLength(1);
      expect(store.list()[0].call_outcome).toBe("missed");
    });

    test("every call has its own entry", async () => {
      await placeCall();
      await end(alice);
      await placeCall({ callId: CALL_ID_2 });
      await end(bob, {}, CALL_ID_2);
      expect(store.list().map((row) => row.call_outcome).sort()).toEqual(["cancelled", "declined"]);
    });

    test("an entry already stored for the call id is not written again", async () => {
      store.create({
        chatId: DM_CHAT,
        callerId: ALICE_ID,
        calleeId: BOB_ID,
        callId: CALL_ID,
        kind: "audio",
        outcome: "completed",
        durationSec: 5,
        expiresAt: null,
        markReadBy: BOB_ID,
      });
      await placeCall();
      await end(alice);
      expect(store.list()).toHaveLength(1);
      expect(chatMessages()).toHaveLength(0);
    });
  });

  describe("who may cause an entry", () => {
    test("someone outside the call cannot end it, so cannot write one", async () => {
      await placeCall();
      expect((await end(carol)).status).toBe(403);
      expect(store.list()).toHaveLength(0);
    });

    test("nothing is written once the callee left the chat; the call still ends normally", async () => {
      await placeCall();
      members[DM_CHAT] = [user(ALICE_ID, "alice")];
      const res = await end(alice);
      expect(res.status).toBe(200);
      expect(store.list()).toHaveLength(0);
      expect(ctx.eventRecorder.of("call_end")).toHaveLength(2);
    });

    test("nothing is written when the account of the callee was banned", async () => {
      await placeCall();
      ctx.userStore.users.get("bob").banned = 1;
      await end(alice);
      expect(store.list()).toHaveLength(0);
    });

    test("ending a call never fails because the entry could not be saved", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      build({
        deps: {
          createCallMessage: () => {
            throw new Error("disk full");
          },
        },
      });
      await placeCall();
      const res = await end(alice);
      expect(res.status).toBe(200);
      expect(ctx.eventRecorder.of("call_end")).toHaveLength(2);
      spy.mockRestore();
    });

    test("a server without the history function still runs calls", async () => {
      build({ deps: { createCallMessage: undefined } });
      await placeCall();
      expect((await end(alice)).status).toBe(200);
    });
  });

  describe("realtime and push", () => {
    test("both people are told about the new entry, once, in one event", async () => {
      await placeCall();
      await accept();
      await connected();
      clock.t += 8_000;
      await end(alice);
      const events = chatEvents.filter((e) => e.payload.type === "chat_message");
      expect(events).toHaveLength(1);
      expect(events[0].chatId).toBe(DM_CHAT);
      expect(events[0].payload).toMatchObject({
        type: "chat_message",
        chatId: DM_CHAT,
        userId: ALICE_ID,
        username: "alice",
        body: "",
        messageType: "call",
        call: { callId: CALL_ID, kind: "audio", outcome: "completed", durationSec: 8 },
        countsAsUnread: false,
      });
      expect(events[0].payload.messageId).toBe(store.list()[0].id);
    });

    test("the call_end signal still reaches both devices", async () => {
      await placeCall();
      await end(alice);
      expect(ctx.eventRecorder.of("call_end").map((e) => e.username).sort()).toEqual(["alice", "bob"]);
    });

    test("the entry adds no push of its own", async () => {
      await placeCall();
      await accept();
      await connected();
      push.mockClear();
      await end(alice);
      expect(push).not.toHaveBeenCalled();

      await placeCall({ callId: CALL_ID_2 });
      push.mockClear();
      await end(alice, {}, CALL_ID_2);
      // The one push is the existing "stop ringing" notice, not a message.
      expect(push).toHaveBeenCalledTimes(1);
      expect(push.mock.calls[0][1].data.type).toBe("call_end");
    });

    test("a missed call is announced as unread, a declined one is not", async () => {
      build({ sweepMs: 10 });
      await placeCall();
      clock.t += 46_000;
      await until(() => chatMessages().length === 1);
      expect(chatMessages()[0].countsAsUnread).toBe(true);
      expect(chatMessages()[0].read_by_user_id).toBeUndefined();

      await placeCall({ callId: CALL_ID_2 });
      await end(bob, {}, CALL_ID_2);
      const declined = chatMessages().find((m) => m.call.callId === CALL_ID_2);
      expect(declined.countsAsUnread).toBe(false);
      expect(declined.read_by_user_id).toBe(BOB_ID);
    });
  });

  describe("retention", () => {
    test("an entry is given the same expiry as a text message", async () => {
      build({ deps: { getSetting: (key) => (key === "MESSAGE_TEXT_RETENTION" ? 3 : null) } });
      await placeCall();
      await end(alice);
      const expiresAt = Date.parse(store.list()[0].expires_at);
      const threeDays = 3 * 24 * 60 * 60 * 1000;
      expect(expiresAt).toBeGreaterThan(Date.now() + threeDays - 60_000);
      expect(expiresAt).toBeLessThan(Date.now() + threeDays + 60_000);
    });

    test("without retention it is kept", async () => {
      await placeCall();
      await end(alice);
      expect(store.list()[0].expires_at).toBeNull();
    });
  });
});
