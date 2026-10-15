import { describe, test, expect, beforeEach } from "vitest";
import request from "supertest";
import { makeApp, makeUserStore } from "../helpers/makeApp.js";
import { makeP256PublicKey } from "../helpers/p256.js";
import { MAX_ACTIVE_DEVICES_PER_USER } from "../../api/e2ee.js";

const ALICE_ID = "a0a0a0a0-b1b1-4c2c-8d3d-e4e4e4e4e4e4";
const BOB_ID = "b0b0b0b0-c1c1-4d2d-8e3e-f4f4f4f4f4f4";
const CAROL_ID = "c0c0c0c0-d1d1-4e2e-8f3f-a4a4a4a4a4a4";
const DM_CHAT = "d0d0d0d0-e1e1-4f2f-8040-b5b5b5b5b5b5";
const GROUP_CHAT = "e0e0e0e0-f1f1-4a2a-8b3b-c5c5c5c5c5c5";

const user = (id, username) => ({
  id,
  username,
  password_hash: "x",
  nickname: username,
  avatar_url: null,
  color: "#10b981",
  status: "online",
  role: "user",
  banned: false,
});

describe("E2EE device directory API", () => {
  let ctx;
  let alice;
  let bob;
  let carol;

  beforeEach(() => {
    const userStore = makeUserStore([
      user(ALICE_ID, "alice"),
      user(BOB_ID, "bob"),
      user(CAROL_ID, "carol"),
    ]);
    const members = {
      [DM_CHAT]: [user(ALICE_ID, "alice"), user(BOB_ID, "bob")],
      [GROUP_CHAT]: [user(ALICE_ID, "alice"), user(BOB_ID, "bob"), user(CAROL_ID, "carol")],
    };
    ctx = makeApp({
      userStore,
      deps: {
        findDmChat: (a, b) =>
          [a, b].sort().join() === [ALICE_ID, BOB_ID].sort().join() ? DM_CHAT : null,
        isMember: (chatId, userId) =>
          (members[chatId] || []).some((m) => m.id === userId),
        listChatMembers: (chatId) => members[chatId] || [],
        e2eeNewDevicesPerHour: 1000,
      },
    });
    ctx.sessionStore.createSession(ALICE_ID, "tok-alice");
    ctx.sessionStore.createSession(BOB_ID, "tok-bob");
    ctx.sessionStore.createSession(CAROL_ID, "tok-carol");
    alice = (req) => req.set("Cookie", ["sid=tok-alice"]);
    bob = (req) => req.set("Cookie", ["sid=tok-bob"]);
    carol = (req) => req.set("Cookie", ["sid=tok-carol"]);
  });

  const register = (as, body = {}) =>
    as(request(ctx.app).post("/api/e2ee/devices")).send({
      ecdhPublic: makeP256PublicKey(),
      ecdsaPublic: makeP256PublicKey(),
      label: "Laptop",
      ...body,
    });

  test("requires a session", async () => {
    const res = await request(ctx.app).get("/api/e2ee/devices");
    expect(res.status).toBe(401);
  });

  test("registers a device and lists it", async () => {
    const res = await register(alice);
    expect(res.status).toBe(201);
    expect(res.body.device.userId).toBe(ALICE_ID);
    expect(res.body.device.label).toBe("Laptop");

    const list = await alice(request(ctx.app).get("/api/e2ee/devices"));
    expect(list.body.devices).toHaveLength(1);
    expect(list.body.devices[0].id).toBe(res.body.device.id);
  });

  test("rejects invalid or off-curve public keys", async () => {
    const bad = await register(alice, { ecdhPublic: Buffer.alloc(65, 1).toString("base64url") });
    expect(bad.status).toBe(400);
    const missing = await alice(request(ctx.app).post("/api/e2ee/devices")).send({});
    expect(missing.status).toBe(400);
  });

  test("re-registering the same keys with the same device id is idempotent", async () => {
    const keys = { ecdhPublic: makeP256PublicKey(), ecdsaPublic: makeP256PublicKey() };
    const first = await register(alice, keys);
    const again = await register(alice, { ...keys, deviceId: first.body.device.id });
    expect(again.status).toBe(200);
    expect(again.body.device.id).toBe(first.body.device.id);
    expect(ctx.e2eeStore.devices.size).toBe(1);
  });

  test("a changed key never overwrites an existing device: it becomes a new device", async () => {
    const first = await register(alice);
    const changed = await register(alice, { deviceId: first.body.device.id });
    expect(changed.status).toBe(201);
    expect(changed.body.device.id).not.toBe(first.body.device.id);
    const original = ctx.e2eeStore.devices.get(first.body.device.id);
    expect(original.ecdh_public).toBe(first.body.device.ecdhPublic);
  });

  test("at the device cap the least recently seen device is retired instead of locking the user out", async () => {
    const ids = [];
    for (let i = 0; i < MAX_ACTIVE_DEVICES_PER_USER; i += 1) {
      const res = await register(alice);
      expect(res.status).toBe(201);
      ids.push(res.body.device.id);
      // Spread last-seen so "stalest" is well defined.
      ctx.e2eeStore.devices.get(res.body.device.id).last_seen_at = `2024-01-01 00:00:${String(i).padStart(2, "0")}`;
    }
    const next = await register(alice);
    expect(next.status).toBe(201);
    expect(ctx.e2eeStore.devices.get(ids[0]).revoked_at).toBeTruthy();
    expect(ctx.e2eeStore.devices.get(ids[1]).revoked_at).toBeFalsy();
    const list = await alice(request(ctx.app).get("/api/e2ee/devices"));
    expect(list.body.devices).toHaveLength(MAX_ACTIVE_DEVICES_PER_USER);
  });

  test("re-confirming an existing device never counts against the registration throttle", async () => {
    const keys = { ecdhPublic: makeP256PublicKey(), ecdsaPublic: makeP256PublicKey() };
    const first = await register(alice, keys);
    for (let i = 0; i < 60; i += 1) {
      const again = await register(alice, { ...keys, deviceId: first.body.device.id });
      expect(again.status).toBe(200);
    }
    // ... and another account behind the same address is unaffected.
    expect((await register(bob)).status).toBe(201);
  });

  test("creating many new devices is throttled per person, not per address", async () => {
    const strict = makeApp({
      userStore: makeUserStore([user(ALICE_ID, "alice"), user(BOB_ID, "bob")]),
      deps: { e2eeNewDevicesPerHour: 3 },
    });
    strict.sessionStore.createSession(ALICE_ID, "t-a");
    strict.sessionStore.createSession(BOB_ID, "t-b");
    const post = (token) =>
      request(strict.app)
        .post("/api/e2ee/devices")
        .set("Cookie", [`sid=${token}`])
        .send({ ecdhPublic: makeP256PublicKey(), ecdsaPublic: makeP256PublicKey() });
    const statuses = [];
    for (let i = 0; i < 5; i += 1) statuses.push((await post("t-a")).status);
    expect(statuses).toEqual([201, 201, 201, 429, 429]);
    // Same address, different person: unaffected.
    expect((await post("t-b")).status).toBe(201);
  });

  test("revokes only your own devices", async () => {
    const mine = (await register(alice)).body.device;
    const theirs = (await register(bob)).body.device;

    const foreign = await alice(request(ctx.app).delete(`/api/e2ee/devices/${theirs.id}`));
    expect(foreign.status).toBe(404);
    const own = await alice(request(ctx.app).delete(`/api/e2ee/devices/${mine.id}`));
    expect(own.status).toBe(200);
    const list = await alice(request(ctx.app).get("/api/e2ee/devices"));
    expect(list.body.devices).toHaveLength(0);
  });

  test("a peer's devices are visible with a direct chat or a named shared chat only", async () => {
    await register(bob);
    const ok = await alice(request(ctx.app).get(`/api/e2ee/users/${BOB_ID}/devices`));
    expect(ok.status).toBe(200);
    expect(ok.body.devices).toHaveLength(1);

    // Carol shares only a group with Bob: no DM, so a bare lookup is refused ...
    const denied = await carol(request(ctx.app).get(`/api/e2ee/users/${BOB_ID}/devices`));
    expect(denied.status).toBe(403);
    // ... but naming the shared group makes the keys available, so group
    // members can verify each other's messages.
    const viaGroup = await carol(
      request(ctx.app).get(`/api/e2ee/users/${BOB_ID}/devices?chatId=${GROUP_CHAT}`),
    );
    expect(viaGroup.status).toBe(200);
    expect(viaGroup.body.devices).toHaveLength(1);
  });

  test("a named chat does not open the directory to people outside it", async () => {
    await register(alice);
    // Carol is not in the DM chat.
    const outsider = await carol(
      request(ctx.app).get(`/api/e2ee/users/${ALICE_ID}/devices?chatId=${DM_CHAT}`),
    );
    expect(outsider.status).toBe(403);
    const bad = await carol(request(ctx.app).get(`/api/e2ee/users/${ALICE_ID}/devices?chatId=nope`));
    expect(bad.status).toBe(400);
  });

  test("a former member's keys stay available for messages they posted in the chat", async () => {
    const dave = "d4d4d4d4-a1a1-4b2b-8c3c-d5d5d5d5d5d5";
    const roster = [user(ALICE_ID, "alice"), user(CAROL_ID, "carol")];
    const withHistory = makeApp({
      userStore: makeUserStore([user(ALICE_ID, "alice"), user(CAROL_ID, "carol"), user(dave, "dave")]),
      deps: {
        findDmChat: () => null,
        isMember: (chatId, userId) => roster.some((m) => m.id === userId),
        listChatMembers: () => roster,
        userHasMessageInChat: (_chatId, userId) => userId === dave,
      },
    });
    withHistory.sessionStore.createSession(ALICE_ID, "tok-a");
    await withHistory.e2eeStore.createE2eeDevice({
      userId: dave,
      ecdhPublic: makeP256PublicKey(),
      ecdsaPublic: makeP256PublicKey(),
    });
    const res = await request(withHistory.app)
      .get(`/api/e2ee/users/${dave}/devices?chatId=${GROUP_CHAT}`)
      .set("Cookie", ["sid=tok-a"]);
    expect(res.status).toBe(200);
    expect(res.body.devices).toHaveLength(1);
  });

  test("a revoked device is returned only when asked for by id, flagged as revoked", async () => {
    const device = (await register(bob)).body.device;
    await bob(request(ctx.app).delete(`/api/e2ee/devices/${device.id}`));

    const plain = await alice(request(ctx.app).get(`/api/e2ee/users/${BOB_ID}/devices`));
    expect(plain.body.devices).toHaveLength(0);

    const named = await alice(
      request(ctx.app).get(`/api/e2ee/users/${BOB_ID}/devices?deviceId=${device.id}`),
    );
    expect(named.body.devices).toHaveLength(1);
    expect(named.body.devices[0].revokedAt).toBeTruthy();
  });

  test("chat devices lists every member device and who has none", async () => {
    await register(alice);
    await register(bob);
    const res = await alice(request(ctx.app).get(`/api/e2ee/chats/${GROUP_CHAT}/devices`));
    expect(res.status).toBe(200);
    expect(res.body.devices.map((d) => d.username).sort()).toEqual(["alice", "bob"]);
    expect(res.body.membersWithoutDevice).toEqual([{ userId: CAROL_ID, username: "carol" }]);
  });

  test("chat devices are hidden from non-members", async () => {
    const res = await carol(request(ctx.app).get(`/api/e2ee/chats/${DM_CHAT}/devices`));
    expect(res.status).toBe(403);
  });

  test("rejects malformed ids", async () => {
    const res = await alice(request(ctx.app).get("/api/e2ee/users/not-a-uuid/devices"));
    expect(res.status).toBe(400);
  });
});
