import { describe, test, expect, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-react";
import { useEffect } from "react";

const hoisted = vi.hoisted(() => ({ manager: null, services: null, canShare: true }));

vi.mock("../../../src/calls/callManager.js", () => {
  const CALL_PHASE = {
    IDLE: "idle", OUTGOING: "outgoing", INCOMING: "incoming", CONNECTING: "connecting", CONNECTED: "connected", ENDED: "ended",
  };
  class CallManager {
    constructor() {
      this.state = { phase: "idle", callId: null };
      this.isBusy = false;
      this.canShareScreen = hoisted.canShare;
      this.handleEvent = vi.fn();
      this.handleBroadcast = vi.fn();
      this.setPageHidden = vi.fn();
      this.hangupOnUnload = vi.fn();
      this.dispose = vi.fn();
      this.startScreenShare = vi.fn(async () => "started");
      this.stopScreenShare = vi.fn(async () => "stopped");
      this.toggleScreenShare = vi.fn(async () => "toggled");
      hoisted.manager = this;
    }
    getState = () => this.state;
    subscribe = () => () => {};
  }
  return { CallManager, CALL_PHASE };
});
vi.mock("../../../src/calls/useCallSounds.js", () => ({ useCallSounds: () => {} }));
vi.mock("../../../src/api/e2eeApi.js", () => ({ endCallBeacon: vi.fn() }));
vi.mock("../../../src/e2ee/services.js", () => ({
  getE2eeServices: () => hoisted.services,
  isCallingSupported: () => true,
  isE2eeSupported: () => true,
}));

import { CallProvider } from "../../../src/calls/CallProvider.jsx";
import { useCalls } from "../../../src/calls/callContext.js";

const user = { id: "u-bob", username: "bob" };
const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(() => {
  hoisted.manager = null;
  hoisted.canShare = true;
  hoisted.services = {
    api: { fetchPendingCall: vi.fn().mockResolvedValue({ call: null }) },
    directory: {},
    getIdentity: vi.fn().mockResolvedValue({}),
  };
});

const seen = { calls: null };
function Probe() {
  const value = useCalls();
  useEffect(() => {
    seen.calls = value;
  });
  return null;
}
async function mount() {
  await render(<CallProvider user={user}><Probe /></CallProvider>);
  await flush();
  return hoisted.manager;
}

describe("screen sharing in the call context", () => {
  test("a computer is offered screen sharing, and the S key will have toggleScreenShare to call", async () => {
    const manager = await mount();
    expect(seen.calls.screenSupported).toBe(true);
    await expect(seen.calls.toggleScreenShare()).resolves.toBe("toggled");
    await expect(seen.calls.startScreenShare({ replace: true })).resolves.toBe("started");
    await expect(seen.calls.stopScreenShare()).resolves.toBe("stopped");
    expect(manager.toggleScreenShare).toHaveBeenCalledTimes(1);
    expect(manager.startScreenShare).toHaveBeenCalledWith({ replace: true });
    expect(manager.stopScreenShare).toHaveBeenCalledTimes(1);
  });

  test("a phone is not", async () => {
    hoisted.canShare = false;
    await mount();
    expect(seen.calls.screenSupported).toBe(false);
  });

  test("outside a provider (or before the manager exists) the calls do nothing and resolve", async () => {
    await render(<Probe />);
    expect(seen.calls.screenSupported).toBe(false);
    await expect(seen.calls.toggleScreenShare()).resolves.toBeUndefined();
    await expect(seen.calls.startScreenShare()).resolves.toBeUndefined();
    await expect(seen.calls.stopScreenShare()).resolves.toBeUndefined();
  });
});
