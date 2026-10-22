import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { CALL_PHASE } from "../../src/calls/callManager.js";
import { FakePeerConnection, FakeServer, waitFor } from "./fakes.js";

const phase = (p) => (c) => c.manager.getState().phase === p;

async function connectedCall({ kind = "audio" } = {}) {
  const server = new FakeServer();
  const alice = await server.addUser("alice");
  const bob = await server.addUser("bob");
  await alice.manager.startCall({ chatId: "chat-1", peer: { userId: bob.user.id, username: "bob" }, kind });
  await waitFor(() => phase(CALL_PHASE.INCOMING)(bob), { label: "bob ringing" });
  await bob.manager.accept();
  await waitFor(() => phase(CALL_PHASE.CONNECTED)(alice) && phase(CALL_PHASE.CONNECTED)(bob), { label: "both connected" });
  return { server, alice, bob, pcA: alice.pc, pcB: bob.pc };
}

beforeEach(() => {
  FakePeerConnection.instances = [];
  FakePeerConnection.autoConnect = true;
  FakePeerConnection.relayCandidates = false;
  FakePeerConnection.relayOn = null;
  FakePeerConnection.iceErrors = [];
  FakePeerConnection.gatheringCompletes = true;
});
afterEach(() => {
  vi.useRealTimers();
});

const stats = ({ rtt = 0.04, loss = 0, jitter = 0.004, bps = 2_000_000, relay = false } = {}) => [
  { id: "p", type: "candidate-pair", nominated: true, currentRoundTripTime: rtt, availableOutgoingBitrate: bps, localCandidateId: "l", remoteCandidateId: "r" },
  { id: "l", type: "local-candidate", candidateType: relay ? "relay" : "host" },
  { id: "r", type: "remote-candidate", candidateType: "host" },
  { id: "ri", type: "remote-inbound-rtp", kind: "audio", fractionLost: loss, jitter },
  { id: "in", type: "inbound-rtp", kind: "audio", jitter },
];
const tickStats = (n = 1) => (async () => {
  for (let i = 0; i < n; i += 1) await vi.advanceTimersByTimeAsync(5000);
})();
const fake = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });

describe("the connection quality of a running call", () => {
  test("is unknown until the first stats arrive, then excellent on a clean line, in a voice call too", async () => {
    fake();
    const { alice, pcA } = await connectedCall({ kind: "audio" });
    expect(alice.manager.getState()).toMatchObject({ connectionQuality: null, connectionStats: null, reconnecting: false });
    pcA.statsReport = stats();
    await tickStats();
    expect(alice.manager.getState().connectionQuality).toBe(3);
    expect(alice.manager.getState().connectionStats).toEqual({ rttMs: 40, lossPct: 0, jitterMs: 4, availableKbps: 2000000 / 1000 });
  });

  test("a poor line shows as poor after two bad samples, not after one", async () => {
    fake();
    const { alice, pcA } = await connectedCall();
    pcA.statsReport = stats();
    await tickStats();
    pcA.statsReport = stats({ rtt: 0.9, loss: 0.2 });
    await tickStats();
    expect(alice.manager.getState().connectionQuality).toBe(3); // one odd sample: nothing changes yet
    await tickStats();
    expect(alice.manager.getState().connectionQuality).toBe(0);
    // The numbers are the latest ones, whatever the level says.
    expect(alice.manager.getState().connectionStats).toMatchObject({ rttMs: 900, lossPct: 20 });
  });

  test("a single bad sample in a good stretch never shows", async () => {
    fake();
    const { alice, pcA } = await connectedCall();
    const seen = [];
    alice.manager.subscribe((s) => seen.push(s.connectionQuality));
    pcA.statsReport = stats();
    await tickStats(2);
    pcA.statsReport = stats({ loss: 0.3 });
    await tickStats();
    pcA.statsReport = stats();
    await tickStats(3);
    expect(new Set(seen.filter((q) => q !== null))).toEqual(new Set([3]));
  });

  test("a rough bandwidth estimate does not hold a voice call back, but it does hold a video call back", async () => {
    fake();
    const voice = await connectedCall({ kind: "audio" });
    voice.pcA.statsReport = stats({ bps: 120_000 });
    await tickStats();
    expect(voice.alice.manager.getState().connectionQuality).toBe(3);

    const video = await connectedCall({ kind: "video" });
    video.pcA.statsReport = stats({ bps: 120_000 });
    await tickStats();
    expect(video.alice.manager.getState().connectionQuality).toBe(1);
  });

  test("the relayed path is still reported next to it", async () => {
    fake();
    const { alice, pcA } = await connectedCall();
    pcA.statsReport = stats({ relay: true });
    await tickStats();
    expect(alice.manager.getState()).toMatchObject({ relayed: true, connectionQuality: 3 });
  });

  test("a dropped connection says reconnecting and goes back when the path returns", async () => {
    fake();
    const { alice, pcA } = await connectedCall();
    pcA.statsReport = stats();
    await tickStats();
    pcA.setState("disconnected");
    expect(alice.manager.getState().reconnecting).toBe(true);
    // The level that was measured is kept for when the line is back.
    expect(alice.manager.getState().connectionQuality).toBe(3);
    await vi.advanceTimersByTimeAsync(3000);
    pcA.setState("connected");
    expect(alice.manager.getState().reconnecting).toBe(false);
    expect(alice.manager.getState().phase).toBe(CALL_PHASE.CONNECTED);
  });

  test("a failed path is a reconnect too, while ICE is restarted", async () => {
    fake();
    const { alice, pcA } = await connectedCall();
    pcA.setState("failed");
    expect(alice.manager.getState().reconnecting).toBe(true);
  });

  test("a connection that is still being set up is not 'reconnecting'", async () => {
    FakePeerConnection.autoConnect = false;
    const server = new FakeServer();
    const alice = await server.addUser("alice");
    const bob = await server.addUser("bob");
    await alice.manager.startCall({ chatId: "chat-1", peer: { userId: bob.user.id, username: "bob" }, kind: "audio" });
    await waitFor(() => phase(CALL_PHASE.INCOMING)(bob));
    await bob.manager.accept();
    await waitFor(() => phase(CALL_PHASE.CONNECTING)(alice));
    alice.pc.setState("disconnected");
    expect(alice.manager.getState().reconnecting).toBe(false);
  });

  test("everything is cleared when the call ends", async () => {
    fake();
    const { alice, pcA } = await connectedCall();
    pcA.statsReport = stats();
    await tickStats();
    pcA.setState("disconnected");
    await alice.manager.hangup();
    expect(alice.manager.getState()).toMatchObject({ connectionQuality: null, connectionStats: null, reconnecting: false });
  });

  test("a call that broke after it worked has its last quality in the report", async () => {
    fake();
    const { alice, pcA } = await connectedCall();
    pcA.statsReport = stats({ rtt: 0.45, loss: 0.025, jitter: 0.04, relay: true });
    await tickStats();
    FakePeerConnection.instances.forEach((pc) => pc.setState("failed"));
    await vi.advanceTimersByTimeAsync(16_000);
    expect(alice.manager.getState().endReason).toBe("connection_lost");
    const details = alice.manager.getState().connectionDetails.join("\n");
    expect(details).toContain("Last measured quality: fair, relayed (round trip 450 ms, packet loss 2.5 %, jitter 40 ms");
    // Numbers only: no addresses, no credentials.
    expect(details).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });
});
