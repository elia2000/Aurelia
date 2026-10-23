import { describe, expect, test, vi } from "vitest";
import { createSseHub } from "../../lib/sse.js";
import { createWebSocketGateway } from "../../lib/websocketGateway.js";
import { createRedisClient } from "../../lib/redis.js";

const fakeRes = () => ({ write: vi.fn(), end: vi.fn() });
const fakeWs = (sessionId) => ({
  readyState: 1,
  _sessionId: sessionId,
  send: vi.fn(),
  close: vi.fn(),
});
const REVOKED = { type: "session_revoked", reason: "signed_out" };

describe("SSE hub closeStreams", () => {
  test("tells and ends only the streams of the named sessions", () => {
    const hub = createSseHub({ listChatMembers: () => [] });
    const laptop = fakeRes();
    const phone = fakeRes();
    const bobsPhone = fakeRes();
    hub.addSseClient("alice", laptop, "session-laptop");
    hub.addSseClient("alice", phone, "session-phone");
    hub.addSseClient("bob", bobsPhone, "session-bob");

    const closed = hub.closeStreams({ sessionIds: ["session-phone"], payload: REVOKED });
    expect(closed).toBe(1);
    expect(phone.write).toHaveBeenCalledWith(`data: ${JSON.stringify(REVOKED)}\n\n`);
    expect(phone.end).toHaveBeenCalledTimes(1);
    expect(laptop.end).not.toHaveBeenCalled();
    expect(bobsPhone.end).not.toHaveBeenCalled();
  });

  test("can close every stream of a username (ban, deletion)", () => {
    const hub = createSseHub({ listChatMembers: () => [] });
    const a = fakeRes();
    const b = fakeRes();
    const other = fakeRes();
    hub.addSseClient("Alice", a, "s1");
    hub.addSseClient("alice", b);
    hub.addSseClient("bob", other, "s3");
    expect(hub.closeStreams({ username: "ALICE", payload: REVOKED })).toBe(2);
    expect(a.end).toHaveBeenCalled();
    expect(b.end).toHaveBeenCalled();
    expect(other.end).not.toHaveBeenCalled();
  });

  test("with nothing to match it closes nothing", () => {
    const hub = createSseHub({ listChatMembers: () => [] });
    const res = fakeRes();
    hub.addSseClient("alice", res, "s1");
    expect(hub.closeStreams({})).toBe(0);
    expect(hub.closeStreams({ sessionIds: [] })).toBe(0);
    expect(hub.closeStreams({ sessionIds: ["nope"] })).toBe(0);
    expect(res.end).not.toHaveBeenCalled();
  });

  test("a stream that fails to write does not stop the others", () => {
    const hub = createSseHub({ listChatMembers: () => [] });
    const broken = { write: () => { throw new Error("gone"); }, end: vi.fn() };
    const fine = fakeRes();
    hub.addSseClient("alice", broken, "s1");
    hub.addSseClient("alice", fine, "s1");
    expect(() => hub.closeStreams({ sessionIds: ["s1"], payload: REVOKED })).not.toThrow();
    expect(fine.end).toHaveBeenCalled();
  });
});

describe("WebSocket gateway revokeSessions", () => {
  test("sends the notice to, then closes, the sockets of the named sessions only", () => {
    const gateway = createWebSocketGateway({});
    const laptop = fakeWs("session-laptop");
    const phone = fakeWs("session-phone");
    const bob = fakeWs("session-bob");
    gateway.clientsByUsername.set("alice", new Set([laptop, phone]));
    gateway.clientsByUsername.set("bob", new Set([bob]));

    const closed = gateway.revokeSessions({ sessionIds: ["session-phone"] }, REVOKED);
    expect(closed).toBe(1);
    expect(phone.send).toHaveBeenCalledWith(JSON.stringify(REVOKED));
    expect(phone.close).toHaveBeenCalledWith(4001, "session revoked");
    expect(laptop.close).not.toHaveBeenCalled();
    expect(bob.close).not.toHaveBeenCalled();
    gateway.close();
  });

  test("can close every socket of a username", () => {
    const gateway = createWebSocketGateway({});
    const a = fakeWs("s1");
    const b = fakeWs("s2");
    const bob = fakeWs("s3");
    gateway.clientsByUsername.set("alice", new Set([a, b]));
    gateway.clientsByUsername.set("bob", new Set([bob]));
    expect(gateway.revokeSessions({ username: "Alice" }, REVOKED)).toBe(2);
    expect(bob.close).not.toHaveBeenCalled();
    gateway.close();
  });

  test("reaches the other instances through Redis, which close their own sockets and SSE streams", () => {
    const sharedState = { store: new Map(), subscribers: new Map() };
    const redisA = createRedisClient({ sharedState });
    const redisB = createRedisClient({ sharedState });
    const onSessionsRevoked = vi.fn();
    const instanceA = createWebSocketGateway({ redisClient: redisA });
    const instanceB = createWebSocketGateway({ redisClient: redisB, onSessionsRevoked });
    const remotePhone = fakeWs("session-phone");
    instanceB.clientsByUsername.set("alice", new Set([remotePhone]));

    instanceA.revokeSessions({ sessionIds: ["session-phone"] }, REVOKED);

    expect(remotePhone.close).toHaveBeenCalledWith(4001, "session revoked");
    expect(onSessionsRevoked).toHaveBeenCalledWith({ sessionIds: ["session-phone"] }, REVOKED);
    instanceA.close();
    instanceB.close();
  });
});
