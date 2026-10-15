import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, renderHook } from "vitest-browser-react";
import { act } from "react";

const hoisted = vi.hoisted(() => ({
  manager: null,
  services: null,
  beacon: vi.fn(),
}));

vi.mock("../../../src/calls/callManager.js", () => {
  const CALL_PHASE = {
    IDLE: "idle", OUTGOING: "outgoing", INCOMING: "incoming", CONNECTING: "connecting", CONNECTED: "connected", ENDED: "ended",
  };
  class CallManager {
    constructor(options) {
      this.options = options;
      this.state = { phase: "idle", callId: null };
      this.listeners = new Set();
      this.isBusy = false;
      this.handleEvent = vi.fn();
      this.handleBroadcast = vi.fn();
      this.setPageHidden = vi.fn();
      this.hangupOnUnload = vi.fn();
      this.dispose = vi.fn();
      hoisted.manager = this;
    }
    getState = () => this.state;
    subscribe = (listener) => {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    };
    setState(next) {
      this.state = next;
      this.listeners.forEach((listener) => listener());
    }
  }
  return { CallManager, CALL_PHASE };
});
vi.mock("../../../src/calls/ringtone.js", () => ({ startRingtone: () => () => {} }));
vi.mock("../../../src/api/e2eeApi.js", () => ({ endCallBeacon: (...args) => hoisted.beacon(...args) }));
vi.mock("../../../src/e2ee/services.js", () => ({
  getE2eeServices: () => hoisted.services,
  isCallingSupported: () => true,
  isE2eeSupported: () => true,
}));

import { CallProvider } from "../../../src/calls/CallProvider.jsx";
import { CALL_EVENT, REALTIME_OPEN_EVENT } from "../../../src/calls/callContext.js";
import { useDeviceRegistration } from "../../../src/e2ee/useDeviceRegistration.js";
import { CHAT_PAGE_CONFIG } from "../../../src/settings/chatPageConfig.js";

const user = { id: "u-bob", username: "bob" };
const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

let registration;
const originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");

beforeEach(() => {
  hoisted.manager = null;
  hoisted.beacon.mockReset();
  hoisted.services = {
    api: { fetchPendingCall: vi.fn().mockResolvedValue({ call: null }) },
    directory: {},
    getIdentity: vi.fn().mockResolvedValue({}),
  };
  registration = {
    showNotification: vi.fn().mockResolvedValue(),
    getNotifications: vi.fn().mockResolvedValue([]),
  };
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { ready: Promise.resolve(registration) },
  });
  vi.stubGlobal("Notification", { permission: "granted" });
  window.localStorage.removeItem("songbird-notify-enabled");
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalServiceWorker) Object.defineProperty(navigator, "serviceWorker", originalServiceWorker);
  else delete navigator.serviceWorker;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
});

const hideDocument = (hidden) =>
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });

async function mount() {
  await render(<CallProvider user={user}><div /></CallProvider>);
  await flush();
  return hoisted.manager;
}

describe("CallProvider", () => {
  test("forwards realtime call events to the manager", async () => {
    const manager = await mount();
    const detail = { type: "call_invite", callId: "c1" };
    window.dispatchEvent(new CustomEvent(CALL_EVENT, { detail }));
    expect(manager.handleEvent).toHaveBeenCalledWith(detail);
  });

  test("asks for a call that rang while the page was closed, and again whenever realtime reconnects", async () => {
    const manager = await mount();
    expect(hoisted.services.api.fetchPendingCall).toHaveBeenCalledTimes(1);

    // An invite sent while the connection was down is never replayed.
    hoisted.services.api.fetchPendingCall.mockResolvedValueOnce({
      call: { callId: "c9", kind: "audio", from: { userId: "u-alice" }, invite: {} },
    });
    window.dispatchEvent(new Event(REALTIME_OPEN_EVENT));
    await flush();
    expect(hoisted.services.api.fetchPendingCall).toHaveBeenCalledTimes(2);
    expect(manager.handleEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "call_invite", callId: "c9" }));
  });

  test("does not look for a pending call while one is already in progress", async () => {
    const manager = await mount();
    manager.isBusy = true;
    window.dispatchEvent(new Event(REALTIME_OPEN_EVENT));
    await flush();
    expect(hoisted.services.api.fetchPendingCall).toHaveBeenCalledTimes(1);
  });

  test("closing the page asks the manager (not the server) what to do", async () => {
    const manager = await mount();
    window.dispatchEvent(new Event("pagehide"));
    expect(manager.hangupOnUnload).toHaveBeenCalledTimes(1);
    expect(manager.hangupOnUnload.mock.calls[0][0]).toBeTypeOf("function");
  });

  test("tells the manager when the page is hidden or shown (the camera is released in the background)", async () => {
    const manager = await mount();
    hideDocument(true);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(manager.setPageHidden).toHaveBeenLastCalledWith(true);
    hideDocument(false);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(manager.setPageHidden).toHaveBeenLastCalledWith(false);
  });

  test("registers no device itself: that no longer depends on calls", async () => {
    await mount();
    expect(hoisted.services.getIdentity).not.toHaveBeenCalled();
  });

  describe("incoming call notification", () => {
    const ring = (manager, extra = {}) =>
      act(async () => {
        manager.setState({
          phase: "incoming", callId: "call-7", kind: "video", ringing: true,
          peer: { nickname: "Alice" }, ...extra,
        });
        await flush();
      });

    test("a hidden page shows one, tagged with the call", async () => {
      const manager = await mount();
      hideDocument(true);
      await ring(manager);
      expect(registration.showNotification).toHaveBeenCalledTimes(1);
      const [title, options] = registration.showNotification.mock.calls[0];
      expect(title).toBe("Alice");
      expect(options).toMatchObject({ tag: "call-call-7", body: "Incoming video call" });
    });

    test("a visible page does not (it shows the call itself)", async () => {
      const manager = await mount();
      hideDocument(false);
      await ring(manager);
      expect(registration.showNotification).not.toHaveBeenCalled();
    });

    test("nothing is shown when notifications are switched off in the app's settings", async () => {
      window.localStorage.setItem("songbird-notify-enabled", "0");
      const manager = await mount();
      hideDocument(true);
      await ring(manager);
      expect(registration.showNotification).not.toHaveBeenCalled();
    });

    test("it is taken down when another device answered, which resets quietly to idle with no call id", async () => {
      const notification = { close: vi.fn() };
      registration.getNotifications.mockResolvedValue([notification]);
      const manager = await mount();
      hideDocument(true);
      await ring(manager);
      await act(async () => {
        manager.setState({ phase: "idle", callId: null });
        await flush();
      });
      expect(registration.getNotifications).toHaveBeenCalledWith({ tag: "call-call-7" });
      expect(notification.close).toHaveBeenCalledTimes(1);
    });

    test("it is also taken down when the call is answered here", async () => {
      const notification = { close: vi.fn() };
      registration.getNotifications.mockResolvedValue([notification]);
      const manager = await mount();
      hideDocument(true);
      await ring(manager);
      await act(async () => {
        manager.setState({ phase: "connecting", callId: "call-7" });
        await flush();
      });
      expect(notification.close).toHaveBeenCalledTimes(1);
    });
  });
});

describe("useDeviceRegistration", () => {
  test("registers this device even when the admin switched calls off", async () => {
    const previous = CHAT_PAGE_CONFIG.callsEnabled;
    CHAT_PAGE_CONFIG.callsEnabled = false;
    try {
      await renderHook(() => useDeviceRegistration("u-bob"));
      await new Promise((resolve) => setTimeout(resolve, 1800));
      expect(hoisted.services.getIdentity).toHaveBeenCalledWith("u-bob");
    } finally {
      CHAT_PAGE_CONFIG.callsEnabled = previous;
    }
  });

  test("does nothing without a signed-in user", async () => {
    await renderHook(() => useDeviceRegistration(null));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(hoisted.services.getIdentity).not.toHaveBeenCalled();
  });
});
