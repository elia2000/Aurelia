import { describe, test, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { makeApp, makeUserStore } from "../helpers/makeApp.js";
import { makeP256PublicKey, b64u } from "../helpers/p256.js";
import { createCallRegistry } from "../../lib/calls.js";

const ALICE_ID = "a0a0a0a0-b1b1-4c2c-8d3d-e4e4e4e4e4e4";
const BOB_ID = "b0b0b0b0-c1c1-4d2d-8e3e-f4f4f4f4f4f4";
const CAROL_ID = "c0c0c0c0-d1d1-4e2e-8f3f-a4a4a4a4a4a4";
const DM_CHAT = "d0d0d0d0-e1e1-4f2f-8040-b5b5b5b5b5b5";
const GROUP_CHAT = "e0e0e0e0-f1f1-4a2a-8b3b-c5c5c5c5c5c5";
const CALL_ID = "f0f0f0f0-a1a1-4b2b-8c3c-d5d5d5d5d5d5";

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

describe("call signaling API", () => {
  let ctx;
  let aliceDevice;
  let bobDevice;
  let online;
  let push;
  let alice;
  let bob;
  let carol;

  const inviteBody = (overrides = {}) => ({
    callId: CALL_ID,
    chatId: DM_CHAT,
    kind: "audio",
    invite: {
      deviceId: aliceDevice.id,
      eph: makeP256PublicKey(),
      ts: Date.now(),
      sig: b64u(64),
    },
    ...overrides,
  });
  const acceptBody = () => ({
    accept: { deviceId: bobDevice.id, eph: makeP256PublicKey(), sig: b64u(64) },
  });
  const placeCall = (body = inviteBody()) =>
    alice(request(ctx.app).post("/api/calls")).send(body);

  beforeEach(() => {
    online = new Set(["alice", "bob"]);
    push = vi.fn(async () => {});
    const userStore = makeUserStore([
      user(ALICE_ID, "alice"),
      user(BOB_ID, "bob"),
      user(CAROL_ID, "carol"),
    ]);
    const chats = {
      [DM_CHAT]: { id: DM_CHAT, type: "dm" },
      [GROUP_CHAT]: { id: GROUP_CHAT, type: "group" },
    };
    const members = {
      [DM_CHAT]: [user(ALICE_ID, "alice"), user(BOB_ID, "bob")],
      [GROUP_CHAT]: [user(ALICE_ID, "alice"), user(BOB_ID, "bob"), user(CAROL_ID, "carol")],
    };
    ctx = makeApp({
      userStore,
      deps: {
        callRegistry: createCallRegistry(),
        findChatById: (id) => chats[id] || null,
        isMember: (chatId, userId) => (members[chatId] || []).some((m) => m.id === userId),
        listChatMembers: (chatId) => members[chatId] || [],
        isUserConnected: (username) => online.has(username),
        sendPushNotificationToUsers: push,
      },
    });
    ["alice", "bob", "carol"].forEach((name) =>
      ctx.sessionStore.createSession(
        { alice: ALICE_ID, bob: BOB_ID, carol: CAROL_ID }[name],
        `tok-${name}`,
      ),
    );
    alice = (req) => req.set("Cookie", ["sid=tok-alice"]);
    bob = (req) => req.set("Cookie", ["sid=tok-bob"]);
    carol = (req) => req.set("Cookie", ["sid=tok-carol"]);
    aliceDevice = ctx.e2eeStore.createE2eeDevice({
      userId: ALICE_ID, ecdhPublic: makeP256PublicKey(), ecdsaPublic: makeP256PublicKey(),
    });
    bobDevice = ctx.e2eeStore.createE2eeDevice({
      userId: BOB_ID, ecdhPublic: makeP256PublicKey(), ecdsaPublic: makeP256PublicKey(),
    });
  });

  test("rings the callee with the signed invite and caller details", async () => {
    const res = await placeCall();
    expect(res.status).toBe(201);
    const [event] = ctx.eventRecorder.of("call_invite");
    expect(event.username).toBe("bob");
    expect(event.payload).toMatchObject({
      callId: CALL_ID,
      kind: "audio",
      chatId: DM_CHAT,
      from: { userId: ALICE_ID, username: "alice", nickname: "ALICE" },
    });
    expect(event.payload.invite.deviceId).toBe(aliceDevice.id);
    expect(push).not.toHaveBeenCalled();
  });

  test("sends a short-lived web push when the callee is offline", async () => {
    online.delete("bob");
    await placeCall(inviteBody({ kind: "video" }));
    expect(push).toHaveBeenCalledTimes(1);
    const [recipients, payload] = push.mock.calls[0];
    expect(recipients).toEqual([BOB_ID]);
    expect(payload).toMatchObject({
      title: "ALICE",
      body: "Incoming video call",
      ttl: 45,
      data: { type: "call", callId: CALL_ID, chatId: DM_CHAT },
    });
  });

  test("only direct chats can be called", async () => {
    const res = await placeCall(inviteBody({ chatId: GROUP_CHAT }));
    expect(res.status).toBe(400);
  });

  test("outsiders cannot start a call in someone else's chat", async () => {
    const res = await carol(request(ctx.app).post("/api/calls")).send(inviteBody());
    expect(res.status).toBe(403);
  });

  test("the signing device must belong to the caller", async () => {
    const res = await placeCall(inviteBody({
      invite: { deviceId: bobDevice.id, eph: makeP256PublicKey(), ts: Date.now(), sig: b64u(64) },
    }));
    expect(res.status).toBe(400);
  });

  test("rejects stale, malformed or unknown-kind invitations", async () => {
    expect((await placeCall(inviteBody({ kind: "screen" }))).status).toBe(400);
    const stale = inviteBody();
    stale.invite.ts = Date.now() - 10 * 60 * 1000;
    expect((await placeCall(stale)).status).toBe(400);
    const badKey = inviteBody();
    badKey.invite.eph = "short";
    expect((await placeCall(badKey)).status).toBe(400);
  });

  test("answers busy when the callee is already ringing or in a call", async () => {
    expect((await placeCall()).status).toBe(201);
    const second = await carol(request(ctx.app).post("/api/calls")).send(inviteBody());
    expect(second.status).toBe(403); // carol is not in the DM
    const other = await alice(request(ctx.app).post("/api/calls")).send(
      inviteBody({ callId: "11111111-2222-4333-8444-555555555555" }),
    );
    expect(other.status).toBe(409);
    expect(other.body.code).toBe("busy_self");
  });

  test("callee accept is relayed to the caller; other devices stop ringing", async () => {
    await placeCall();
    ctx.eventRecorder.clear();
    const res = await bob(request(ctx.app).post(`/api/calls/${CALL_ID}/accept`)).send(acceptBody());
    expect(res.status).toBe(200);
    const accept = ctx.eventRecorder.of("call_accept")[0];
    expect(accept.username).toBe("alice");
    expect(accept.payload.accept.deviceId).toBe(bobDevice.id);
    const elsewhere = ctx.eventRecorder.of("call_accepted_elsewhere")[0];
    expect(elsewhere.username).toBe("bob");
    expect(elsewhere.payload.deviceId).toBe(bobDevice.id);
  });

  test("the caller cannot accept their own call, and it cannot be accepted twice", async () => {
    await placeCall();
    const own = await alice(request(ctx.app).post(`/api/calls/${CALL_ID}/accept`)).send({
      accept: { deviceId: aliceDevice.id, eph: makeP256PublicKey(), sig: b64u(64) },
    });
    expect(own.status).toBe(403);
    expect((await bob(request(ctx.app).post(`/api/calls/${CALL_ID}/accept`)).send(acceptBody())).status).toBe(200);
    expect((await bob(request(ctx.app).post(`/api/calls/${CALL_ID}/accept`)).send(acceptBody())).status).toBe(409);
  });

  describe("after the call is accepted", () => {
    beforeEach(async () => {
      await placeCall();
      await bob(request(ctx.app).post(`/api/calls/${CALL_ID}/accept`)).send(acceptBody());
      ctx.eventRecorder.clear();
    });

    test("relays opaque signals to the other participant only", async () => {
      const blob = b64u(300, 9);
      const res = await alice(request(ctx.app).post(`/api/calls/${CALL_ID}/signal`))
        .send({ kind: "offer", blob, seq: 1 });
      expect(res.status).toBe(200);
      const [event] = ctx.eventRecorder.of("call_signal");
      expect(event.username).toBe("bob");
      expect(event.payload).toMatchObject({
        callId: CALL_ID, kind: "offer", blob, seq: 1, toDeviceId: bobDevice.id,
      });

      const back = await bob(request(ctx.app).post(`/api/calls/${CALL_ID}/signal`))
        .send({ kind: "answer", blob });
      expect(back.status).toBe(200);
      expect(ctx.eventRecorder.of("call_signal")[1].username).toBe("alice");
      expect(ctx.eventRecorder.of("call_signal")[1].payload.toDeviceId).toBe(aliceDevice.id);
    });

    test("refuses strangers, bad kinds and oversize or non-base64 blobs", async () => {
      const blob = b64u(300);
      expect((await carol(request(ctx.app).post(`/api/calls/${CALL_ID}/signal`)).send({ kind: "offer", blob })).status).toBe(403);
      expect((await alice(request(ctx.app).post(`/api/calls/${CALL_ID}/signal`)).send({ kind: "sdp", blob })).status).toBe(400);
      expect((await alice(request(ctx.app).post(`/api/calls/${CALL_ID}/signal`)).send({ kind: "offer", blob: "!!not base64!!" + "a".repeat(40) })).status).toBe(400);
      expect((await alice(request(ctx.app).post(`/api/calls/${CALL_ID}/signal`)).send({ kind: "offer", blob: "a".repeat(40_000) })).status).toBe(400);
      expect(ctx.eventRecorder.of("call_signal")).toHaveLength(0);
    });

    test("hang up notifies both users and frees them for new calls", async () => {
      const res = await alice(request(ctx.app).post(`/api/calls/${CALL_ID}/end`)).send({});
      expect(res.status).toBe(200);
      const ends = ctx.eventRecorder.of("call_end");
      expect(ends.map((e) => e.username).sort()).toEqual(["alice", "bob"]);
      expect(ends[0].payload).toMatchObject({ callId: CALL_ID, reason: "hangup", by: ALICE_ID });

      const again = await placeCall(inviteBody({ callId: "11111111-2222-4333-8444-555555555555" }));
      expect(again.status).toBe(201);
    });

    test("signals are refused once the call has ended", async () => {
      await bob(request(ctx.app).post(`/api/calls/${CALL_ID}/end`)).send({});
      const res = await alice(request(ctx.app).post(`/api/calls/${CALL_ID}/signal`))
        .send({ kind: "ice", blob: b64u(60) });
      expect(res.status).toBe(409);
    });
  });

  test("declining a ringing call tells the caller why", async () => {
    await placeCall();
    ctx.eventRecorder.clear();
    await bob(request(ctx.app).post(`/api/calls/${CALL_ID}/end`)).send({});
    expect(ctx.eventRecorder.of("call_end")[0].payload.reason).toBe("declined");
  });

  test("cancelling before answer reports 'cancelled'", async () => {
    await placeCall();
    ctx.eventRecorder.clear();
    await alice(request(ctx.app).post(`/api/calls/${CALL_ID}/end`)).send({});
    expect(ctx.eventRecorder.of("call_end")[0].payload.reason).toBe("cancelled");
  });

  test("pending returns the ringing call for a reloaded callee", async () => {
    await placeCall();
    const res = await bob(request(ctx.app).get("/api/calls/pending"));
    expect(res.body.call).toMatchObject({
      callId: CALL_ID,
      kind: "audio",
      from: { username: "alice" },
    });
    const none = await alice(request(ctx.app).get("/api/calls/pending"));
    expect(none.body.call).toBeNull();
  });

  test("ice-config requires a session and never caches", async () => {
    expect((await request(ctx.app).get("/api/calls/ice-config")).status).toBe(401);
    const res = await alice(request(ctx.app).get("/api/calls/ice-config"));
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.iceServers).toEqual([]);
  });

  test("the whole API is switched off when calls are disabled", async () => {
    const off = makeApp({
      deps: { callsConfig: () => ({ enabled: false }), callSweepIntervalMs: 0 },
    });
    const res = await request(off.app).get("/api/calls/pending");
    expect(res.status).toBe(503);
  });
});
