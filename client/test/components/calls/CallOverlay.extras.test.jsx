import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
const e2ee = vi.hoisted(() => ({
  services: {
    api: { listMyDevices: async () => ({ devices: [] }) },
    directory: { getUserDevices: async () => ({ devices: [], assessment: { status: "ok", added: [] } }) },
    trust: { isVerified: async () => false },
  },
}));
vi.mock("../../../src/e2ee/services.js", () => ({ getE2eeServices: () => e2ee.services }));

import CallOverlay from "../../../src/components/calls/CallOverlay.jsx";
import { CallContext } from "../../../src/calls/callContext.js";
import { CALL_SHORTCUT_KEY, getCallShortcutsEnabled, reloadCallShortcutsEnabled } from "../../../src/calls/callShortcutPrefs.js";

const peer = { userId: "u-bob", username: "bob", nickname: "Bob", avatarUrl: "", color: "#10b981" };

function withCalls(state, overrides = {}) {
  return {
    supported: true,
    manager: null,
    state: { kind: "audio", muted: false, cameraOn: false, remoteCameraOn: false, trust: { status: "ok" }, ...state },
    minimized: false,
    setMinimized: vi.fn(),
    startCall: vi.fn(),
    accept: vi.fn(),
    decline: vi.fn(),
    hangup: vi.fn(),
    dismiss: vi.fn(),
    setMuted: vi.fn(),
    setCameraEnabled: vi.fn(),
    setQuality: vi.fn(),
    screenSupported: true,
    startScreenShare: vi.fn(),
    stopScreenShare: vi.fn(),
    toggleScreenShare: vi.fn(),
    inCall: state.phase !== "idle",
    ...overrides,
  };
}

const ui = (value, props = {}) => (
  <CallContext.Provider value={value}>
    <CallOverlay user={{ id: "u-alice", username: "alice" }} {...props} />
  </CallContext.Provider>
);
async function renderOverlay(state, overrides, props) {
  const value = withCalls(state, overrides);
  const result = await render(ui(value, props));
  return { value, ...result, show: (next) => result.rerender(ui(next, props)) };
}

const connected = (extra = {}) => ({
  phase: "connected", kind: "audio", peer, connectedAt: Date.now(), screenAvailable: true, ...extra,
});
const videoCall = (extra = {}) => connected({ kind: "video", cameraOn: true, remoteCameraOn: true, ...extra });
const theirScreen = () => ({ remoteScreenOn: true, remoteScreenStream: new MediaStream(), remoteScreenSize: { w: 1920, h: 1080 } });
const view = (who) => document.querySelector(`video[data-view="${who}"]`);

const press = (key, extra = {}, target = document) => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra });
  target.dispatchEvent(event);
  return event;
};
const shift = { shiftKey: true };

// ── browser API stand-ins ──
let restore = [];
function stubPip({ enabled = true, allow = true } = {}) {
  let element = null;
  Object.defineProperty(document, "pictureInPictureEnabled", { configurable: true, get: () => enabled });
  Object.defineProperty(document, "pictureInPictureElement", { configurable: true, get: () => element });
  const exit = vi.fn(async () => {
    const was = element;
    element = null;
    was?.dispatchEvent(new Event("leavepictureinpicture", { bubbles: true }));
  });
  Object.defineProperty(document, "exitPictureInPicture", { configurable: true, value: exit });
  const request = vi.fn(async function request() {
    if (!allow) throw Object.assign(new Error("not allowed"), { name: "NotAllowedError" });
    element = this;
    this.dispatchEvent(new Event("enterpictureinpicture", { bubbles: true }));
  });
  Object.defineProperty(HTMLVideoElement.prototype, "requestPictureInPicture", { configurable: true, writable: true, value: request });
  restore.push(() => {
    delete document.pictureInPictureEnabled;
    delete document.pictureInPictureElement;
    delete document.exitPictureInPicture;
  });
  return { request, exit, current: () => element };
}
function stubMediaSession() {
  const handlers = {};
  const spy = vi.spyOn(navigator.mediaSession, "setActionHandler").mockImplementation((action, handler) => {
    handlers[action] = handler;
  });
  return { handlers, spy };
}
function stubFullscreen({ enabled = true } = {}) {
  let element = null;
  Object.defineProperty(document, "fullscreenEnabled", { configurable: true, get: () => enabled });
  Object.defineProperty(document, "webkitFullscreenEnabled", { configurable: true, get: () => enabled }); // Chromium has the old name too
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => element });
  const exit = vi.fn(async () => {
    element = null;
    document.dispatchEvent(new Event("fullscreenchange"));
  });
  Object.defineProperty(document, "exitFullscreen", { configurable: true, value: exit });
  const request = vi.fn(async function request() {
    element = this;
    document.dispatchEvent(new Event("fullscreenchange"));
  });
  Object.defineProperty(Element.prototype, "requestFullscreen", { configurable: true, writable: true, value: request });
  restore.push(() => {
    delete document.fullscreenEnabled;
    delete document.webkitFullscreenEnabled;
    delete document.fullscreenElement;
    delete document.exitFullscreen;
  });
  return { request, exit };
}

beforeEach(() => {
  localStorage.clear();
  restore = [];
});
afterEach(() => {
  vi.restoreAllMocks();
  restore.forEach((undo) => undo());
  document.querySelectorAll("[data-test-extra]").forEach((el) => el.remove());
});

// ─────────────────────────────────────────────────────────────────────────────
describe("the connection indicator", () => {
  const indicator = () => document.querySelector("[data-quality]");
  const lit = () => [...indicator().querySelectorAll("rect")].filter((bar) => bar.getAttribute("opacity") === "1").length;

  test("is in the header of a voice call, saying that nothing is measured yet", async () => {
    await renderOverlay(connected());
    const button = page.getByRole("button", { name: "Connection: Checking…" });
    await expect.element(button).toBeInTheDocument();
    expect(indicator().closest('[data-chrome="header"]')).not.toBeNull();
    expect(lit()).toBe(0);
  });

  test.each([
    [3, "Excellent", "excellent", 4, "text-emerald-200"],
    [2, "Good", "good", 3, "text-emerald-200"],
    [1, "Fair", "fair", 2, "text-amber-300"],
    [0, "Poor", "poor", 1, "text-rose-400"],
  ])("rank %i reads 'Connection: %s'", async (rank, label, id, bars, tone) => {
    await renderOverlay(videoCall({ connectionQuality: rank }));
    await expect.element(page.getByRole("button", { name: `Connection: ${label}` })).toBeInTheDocument();
    expect(indicator().dataset.quality).toBe(id);
    expect(indicator().title).toBe(`Connection: ${label}`);
    expect(lit()).toBe(bars);
    expect(indicator().className).toContain(tone);
  });

  test("a relayed connection says so in the tooltip", async () => {
    await renderOverlay(connected({ connectionQuality: 2, relayed: true }));
    expect(indicator().title).toBe("Connection: Good · relayed");
    expect(indicator().getAttribute("aria-label")).toBe("Connection: Good");
  });

  test("says 'Reconnecting…' when the connection dropped, in the header and where it is announced", async () => {
    await renderOverlay(connected({ connectionQuality: 3, reconnecting: true }));
    await expect.element(page.getByRole("button", { name: "Connection: Reconnecting…" })).toBeInTheDocument();
    const note = page.getByText("Reconnecting…", { exact: true });
    await expect.element(note).toBeInTheDocument();
    expect(note.element().closest("[aria-live]")).not.toBeNull();
    expect(indicator().dataset.quality).toBe("reconnecting");
  });

  test("is not there before the call is connected or after it ended", async () => {
    await renderOverlay({ phase: "connecting", kind: "audio", peer });
    await expect.element(page.getByRole("dialog")).toBeInTheDocument();
    expect(indicator()).toBeNull();
  });

  test("the details of a video call stay while it reconnects", async () => {
    await renderOverlay(videoCall({ reconnecting: true }), undefined, { autoHideMs: 80 });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(document.querySelector('[data-chrome="header"]').hasAttribute("inert")).toBe(false);
  });

  test("a press opens the settings, where the numbers are", async () => {
    await renderOverlay(connected({ connectionQuality: 2, connectionStats: { rttMs: 42, lossPct: 0.5, jitterMs: 3, availableKbps: 1835 } }));
    await page.getByRole("button", { name: "Connection: Good" }).click();
    const group = page.getByRole("group", { name: "Connection" });
    await expect.element(group).toBeInTheDocument();
    const text = group.element().textContent;
    expect(text).toContain("Good");
    for (const part of ["Round trip", "42 ms", "Packet loss", "0.5 %", "Jitter", "3 ms", "Outgoing bandwidth", "1.8 Mbit/s", "Direct"]) {
      expect(text).toContain(part);
    }
  });

  test("the settings say what holds a poor connection back, and that it is relayed", async () => {
    await renderOverlay(connected({
      connectionQuality: 1,
      connectionLimit: "loss",
      relayed: true,
      connectionStats: { rttMs: 120, lossPct: 5, jitterMs: 10, availableKbps: 300 },
    }));
    await page.getByRole("button", { name: "Call settings" }).click();
    const text = page.getByRole("group", { name: "Connection" }).element().textContent;
    expect(text).toContain("Fair");
    expect(text).toContain("Held back by lost packets.");
    expect(text).toContain("Relayed through your server");
  });

  test("the numbers are dashes until they are measured", async () => {
    await renderOverlay(connected());
    await page.getByRole("button", { name: "Call settings" }).click();
    const text = page.getByRole("group", { name: "Connection" }).element().textContent;
    expect(text).toContain("Checking…");
    expect(text).toContain("Round trip–");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("the Picture in picture button", () => {
  const button = () => page.getByRole("button", { name: "Picture in picture" });

  test("is there when the browser can and their video is on screen", async () => {
    stubPip();
    await renderOverlay(videoCall());
    await expect.element(button()).toBeInTheDocument();
    expect(button().element().closest('[data-chrome="header"]')).not.toBeNull();
  });

  test("is not there where the browser cannot (document.pictureInPictureEnabled is not true)", async () => {
    stubPip({ enabled: false });
    await renderOverlay(videoCall());
    await expect.element(page.getByRole("button", { name: "Minimise call" })).toBeInTheDocument();
    expect(button().elements()).toHaveLength(0);
    expect(document.querySelector("video[data-view='remote']")).not.toBeNull();
  });

  test("is not there in a voice call, which has no video of theirs to show", async () => {
    stubPip();
    await renderOverlay(connected());
    await expect.element(page.getByRole("button", { name: "Minimise call" })).toBeInTheDocument();
    expect(button().elements()).toHaveLength(0);
  });

  test("is not there while their camera is off", async () => {
    stubPip();
    await renderOverlay(videoCall({ remoteCameraOn: false }));
    await expect.element(page.getByRole("button", { name: "Minimise call" })).toBeInTheDocument();
    expect(button().elements()).toHaveLength(0);
  });

  test("is not there before the call is up", async () => {
    stubPip();
    await renderOverlay({ phase: "outgoing", kind: "video", peer, cameraOn: true, remoteCameraOn: true });
    await expect.element(page.getByRole("dialog")).toBeInTheDocument();
    expect(button().elements()).toHaveLength(0);
  });

  test("is there for a shared screen, also in a voice call", async () => {
    stubPip();
    await renderOverlay(connected(theirScreen()));
    await expect.element(button()).toBeInTheDocument();
  });

  test("a press floats their camera, and another press brings it back", async () => {
    const pip = stubPip();
    await renderOverlay(videoCall());
    await button().click();
    expect(pip.request).toHaveBeenCalledTimes(1);
    expect(pip.request.mock.contexts[0]).toBe(view("remote"));
    await expect.element(page.getByRole("button", { name: "Picture in picture", pressed: true })).toBeInTheDocument();
    await button().click();
    expect(pip.exit).toHaveBeenCalledTimes(1);
    await expect.element(page.getByRole("button", { name: "Picture in picture", pressed: false })).toBeInTheDocument();
  });

  test("floats the shared screen when that is what fills the call", async () => {
    const pip = stubPip();
    await renderOverlay(videoCall(theirScreen()));
    await button().click();
    expect(pip.request.mock.contexts[0]).toBe(view("screen"));
  });

  test("floats their camera when the screen is the small picture", async () => {
    const pip = stubPip();
    await renderOverlay(videoCall(theirScreen()));
    await page.getByRole("button", { name: "Show their camera full screen" }).click();
    await button().click();
    expect(pip.request.mock.contexts[0]).toBe(view("remote"));
  });

  test("never floats your own picture", async () => {
    const pip = stubPip();
    await renderOverlay(videoCall());
    await page.getByRole("button", { name: "Show your picture full screen" }).click();
    await button().click();
    expect(pip.request.mock.contexts[0]).toBe(view("remote"));
  });

  test("a refusal is said on the call, quietly", async () => {
    stubPip({ allow: false });
    await renderOverlay(videoCall());
    await button().click();
    const note = page.getByText("Picture in picture is not available right now.");
    await expect.element(note).toBeInTheDocument();
    expect(note.element().closest("[aria-live]")).not.toBeNull();
    // and the button is not stuck on
    await expect.element(page.getByRole("button", { name: "Picture in picture", pressed: false })).toBeInTheDocument();
  });

  test("the window closes when the call is minimised", async () => {
    const pip = stubPip();
    const { value, show } = await renderOverlay(videoCall());
    await button().click();
    expect(pip.current()).toBe(view("remote"));
    await show({ ...value, minimized: true });
    await expect.poll(() => pip.exit.mock.calls.length).toBeGreaterThan(0);
  });

  test("the window closes when the call is over", async () => {
    const pip = stubPip();
    const { value, show } = await renderOverlay(videoCall());
    await button().click();
    await show({ ...value, state: { ...value.state, phase: "ended", endReason: "hangup", remoteCameraOn: false } });
    await expect.poll(() => pip.exit.mock.calls.length).toBeGreaterThan(0);
  });

  test("the window follows when the other person starts sharing their screen", async () => {
    const pip = stubPip();
    const { value, show } = await renderOverlay(videoCall());
    await button().click();
    await show({ ...value, state: { ...value.state, ...theirScreen() } });
    await expect.poll(() => pip.request.mock.contexts.at(-1)).toBe(view("screen"));
  });

  test("a picture in picture window of something else in the page is none of the call's business", async () => {
    const pip = stubPip();
    const other = document.createElement("video");
    other.dataset.testExtra = "";
    document.body.appendChild(other);
    const { value, show } = await renderOverlay(videoCall());
    await pip.request.call(other);
    await expect.element(page.getByRole("button", { name: "Picture in picture", pressed: false })).toBeInTheDocument();
    await show({ ...value, minimized: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(pip.exit).not.toHaveBeenCalled();
  });
});

describe("the window's own buttons (Media Session)", () => {
  test("mute, camera and hang up are offered while their video is on screen, and do what they say", async () => {
    stubPip();
    const session = stubMediaSession();
    const { value } = await renderOverlay(videoCall());
    await expect.poll(() => Object.keys(session.handlers).sort()).toEqual(["enterpictureinpicture", "hangup", "togglecamera", "togglemicrophone"]);
    session.handlers.togglemicrophone();
    expect(value.setMuted).toHaveBeenCalledWith(true);
    session.handlers.togglecamera();
    expect(value.setCameraEnabled).toHaveBeenCalledWith(false);
    session.handlers.hangup();
    expect(value.hangup).toHaveBeenCalledTimes(1);
  });

  test("a voice call with a shared screen has no camera button", async () => {
    stubPip();
    const session = stubMediaSession();
    await renderOverlay(connected(theirScreen()));
    await expect.poll(() => Object.keys(session.handlers).sort()).toEqual(["enterpictureinpicture", "hangup", "togglemicrophone"]);
  });

  test("the browser's open-by-itself hook floats their video", async () => {
    const pip = stubPip();
    const session = stubMediaSession();
    await renderOverlay(videoCall());
    await expect.poll(() => typeof session.handlers.enterpictureinpicture).toBe("function");
    await session.handlers.enterpictureinpicture();
    expect(pip.request).toHaveBeenCalledTimes(1);
    expect(pip.current()).toBe(view("remote"));
  });

  test("a refusal in that hook is silent", async () => {
    stubPip({ allow: false });
    const session = stubMediaSession();
    await renderOverlay(videoCall());
    await expect.poll(() => typeof session.handlers.enterpictureinpicture).toBe("function");
    await expect(session.handlers.enterpictureinpicture()).resolves.toBeUndefined();
    expect(page.getByText("Picture in picture is not available right now.").elements()).toHaveLength(0);
  });

  test("the window it opened by itself closes when the person comes back", async () => {
    const pip = stubPip();
    const session = stubMediaSession();
    await renderOverlay(videoCall());
    await expect.poll(() => typeof session.handlers.enterpictureinpicture).toBe("function");
    await session.handlers.enterpictureinpicture();
    expect(pip.current()).not.toBeNull();
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    restore.push(() => delete document.hidden);
    document.dispatchEvent(new Event("visibilitychange"));
    await expect.poll(() => pip.exit.mock.calls.length).toBe(1);
  });

  test("a window the person opened with the button stays when they come back", async () => {
    const pip = stubPip();
    await renderOverlay(videoCall());
    await page.getByRole("button", { name: "Picture in picture" }).click();
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(pip.exit).not.toHaveBeenCalled();
  });

  test("nothing is offered where picture in picture is not", async () => {
    stubPip({ enabled: false });
    const session = stubMediaSession();
    await renderOverlay(videoCall());
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(Object.keys(session.handlers)).toEqual([]);
  });

  test("when their video goes, the handlers go", async () => {
    stubPip();
    const session = stubMediaSession();
    const { value, show } = await renderOverlay(videoCall());
    await expect.poll(() => typeof session.handlers.hangup).toBe("function");
    await show({ ...value, minimized: true });
    await expect.poll(() => session.handlers.hangup).toBeNull();
    expect(session.handlers.enterpictureinpicture).toBeNull();
  });

  test("the window's buttons show whether the microphone and the camera are on", async () => {
    stubPip();
    stubMediaSession();
    const mic = vi.spyOn(navigator.mediaSession, "setMicrophoneActive").mockImplementation(() => {});
    const camera = vi.spyOn(navigator.mediaSession, "setCameraActive").mockImplementation(() => {});
    const { value, show } = await renderOverlay(videoCall());
    await expect.poll(() => mic.mock.calls.at(-1)).toEqual([true]);
    expect(camera.mock.calls.at(-1)).toEqual([true]);
    await show({ ...value, state: { ...value.state, muted: true, cameraOn: false } });
    await expect.poll(() => mic.mock.calls.at(-1)).toEqual([false]);
    expect(camera.mock.calls.at(-1)).toEqual([false]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("keyboard shortcuts", () => {
  test("M mutes, and unmutes", async () => {
    const { value, show } = await renderOverlay(connected());
    expect(press("m").defaultPrevented).toBe(true);
    expect(value.setMuted).toHaveBeenLastCalledWith(true);
    await show({ ...value, state: { ...value.state, muted: true } });
    press("M"); // caps lock
    expect(value.setMuted).toHaveBeenLastCalledWith(false);
  });

  test("works on a Persian keyboard too (the physical key)", async () => {
    const { value } = await renderOverlay(connected());
    press("ئ", { code: "KeyM" });
    expect(value.setMuted).toHaveBeenCalledWith(true);
  });

  test("a key press is announced to screen readers", async () => {
    await renderOverlay(connected());
    press("m");
    await expect.poll(() => document.querySelector('[role="dialog"] p[role="status"]')?.textContent).toBe("Microphone muted");
  });

  test("an announcement is not lost when the details are out of the way", async () => {
    await renderOverlay(videoCall(), undefined, { autoHideMs: 60 });
    await expect.poll(() => document.querySelector('[data-chrome="controls"]').hasAttribute("inert")).toBe(true);
    press("v");
    await expect.poll(() => document.querySelector('[role="dialog"] p[role="status"]')?.textContent).toBe("Camera off");
    expect(document.querySelector('[role="dialog"] p[role="status"]').closest("[inert]")).toBeNull();
  });

  test("a shortcut brings the details back, so the change can be seen", async () => {
    await renderOverlay(videoCall(), undefined, { autoHideMs: 60 });
    await expect.poll(() => document.querySelector('[data-chrome="controls"]').hasAttribute("inert")).toBe(true);
    press("m");
    await expect.poll(() => document.querySelector('[data-chrome="controls"]').hasAttribute("inert")).toBe(false);
  });

  test("V turns the camera of a video call off, and on", async () => {
    const { value, show } = await renderOverlay(videoCall());
    press("v");
    expect(value.setCameraEnabled).toHaveBeenLastCalledWith(false);
    await show({ ...value, state: { ...value.state, cameraOn: false } });
    press("v");
    expect(value.setCameraEnabled).toHaveBeenLastCalledWith(true);
  });

  test("V does nothing in a voice call", async () => {
    const { value } = await renderOverlay(connected());
    const event = press("v");
    expect(value.setCameraEnabled).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  test("S starts and stops sharing the screen", async () => {
    const { value } = await renderOverlay(connected());
    press("s");
    expect(value.toggleScreenShare).toHaveBeenCalledTimes(1);
  });

  test("S does nothing where the browser cannot capture a screen (a phone)", async () => {
    const { value } = await renderOverlay(connected(), { screenSupported: false });
    expect(press("s").defaultPrevented).toBe(false);
    expect(value.toggleScreenShare).not.toHaveBeenCalled();
  });

  test("S does nothing while the call is still connecting", async () => {
    const { value } = await renderOverlay({ phase: "connecting", kind: "audio", peer, screenAvailable: false });
    press("s");
    expect(value.toggleScreenShare).not.toHaveBeenCalled();
  });

  test("S does nothing when the other person's app cannot show a screen", async () => {
    const { value } = await renderOverlay(connected({ screenAvailable: false }));
    press("s");
    expect(value.toggleScreenShare).not.toHaveBeenCalled();
  });

  test("S stops a share that is going on, and it is said once the share has really stopped", async () => {
    const { value, show } = await renderOverlay(connected({ screenSharing: true, screenSurface: "monitor" }));
    press("s");
    expect(value.toggleScreenShare).toHaveBeenCalledTimes(1);
    await show({ ...value, state: { ...value.state, screenSharing: false } });
    await expect.poll(() => document.querySelector('[role="dialog"] p[role="status"]')?.textContent).toBe("Stopped sharing your screen");
  });

  test("P floats their video", async () => {
    const pip = stubPip();
    await renderOverlay(videoCall());
    expect(press("p").defaultPrevented).toBe(true);
    await expect.poll(() => pip.request.mock.calls.length).toBe(1);
    await expect.poll(() => document.querySelector('[role="dialog"] p[role="status"]')?.textContent).toBe("Picture in picture on");
  });

  test("P does nothing without a video to float", async () => {
    stubPip();
    await renderOverlay(connected());
    expect(press("p").defaultPrevented).toBe(false);
  });

  test("P does nothing in a browser without picture in picture", async () => {
    stubPip({ enabled: false });
    await renderOverlay(videoCall());
    expect(press("p").defaultPrevented).toBe(false);
  });

  test("F puts the call card in full screen, and F takes it out", async () => {
    const full = stubFullscreen();
    await renderOverlay(connected());
    expect(press("f").defaultPrevented).toBe(true);
    await expect.poll(() => full.request.mock.calls.length).toBe(1);
    expect(full.request.mock.contexts[0]).toBe(document.querySelector('[role="dialog"]'));
    await expect.poll(() => document.querySelector('[role="dialog"] p[role="status"]')?.textContent).toBe("Full screen on");
    press("f");
    await expect.poll(() => full.exit.mock.calls.length).toBe(1);
  });

  test("F does nothing where full screen is not allowed", async () => {
    const full = stubFullscreen({ enabled: false });
    await renderOverlay(connected());
    expect(press("f").defaultPrevented).toBe(false);
    expect(full.request).not.toHaveBeenCalled();
  });

  test("Shift+H ends the call, and plain H does not", async () => {
    const { value } = await renderOverlay(connected());
    press("h");
    expect(value.hangup).not.toHaveBeenCalled();
    press("H", shift);
    expect(value.hangup).toHaveBeenCalledTimes(1);
  });

  test("Shift+H also cancels a call that is still ringing", async () => {
    const { value } = await renderOverlay({ phase: "outgoing", kind: "audio", peer, ringing: true });
    press("H", shift);
    expect(value.hangup).toHaveBeenCalledTimes(1);
  });

  test("Escape minimises the call, and is not also the page's Escape (which closes the open chat)", async () => {
    const { value } = await renderOverlay(connected());
    const closesChat = vi.fn(); // like the page's own Escape handler
    document.addEventListener("keydown", closesChat);
    try {
      const event = press("Escape");
      expect(event.defaultPrevented).toBe(true);
      expect(value.setMinimized).toHaveBeenCalledWith(true);
      expect(closesChat).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", closesChat);
    }
  });

  test("Escape closes the settings first, and only the next one minimises", async () => {
    const { value } = await renderOverlay(connected());
    await page.getByRole("button", { name: "Call settings" }).click();
    await expect.element(page.getByRole("group", { name: "Call settings" })).toBeInTheDocument();
    press("Escape");
    await expect.poll(() => document.querySelector('[role="group"][aria-label="Call settings"]')).toBeNull();
    expect(value.setMinimized).not.toHaveBeenCalled();
    press("Escape");
    expect(value.setMinimized).toHaveBeenCalledWith(true);
  });

  test("Escape leaves a ringing call alone (it cannot be minimised: the buttons would be gone)", async () => {
    const { value } = await renderOverlay({ phase: "incoming", kind: "audio", peer, ringing: true });
    const event = press("Escape");
    expect(value.setMinimized).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  test("? opens the settings on the shortcuts, and ? again closes them", async () => {
    await renderOverlay(connected());
    expect(press("?", shift).defaultPrevented).toBe(true);
    await expect.element(page.getByRole("group", { name: "Call settings" })).toBeInTheDocument();
    const details = document.querySelector("details[data-shortcuts]");
    expect(details.open).toBe(true);
    await expect.poll(() => document.activeElement?.tagName).toBe("SUMMARY");
    press("?", shift);
    await expect.poll(() => document.querySelector('[role="group"][aria-label="Call settings"]')).toBeNull();
  });

  test("the settings button alone does not open the list of shortcuts, but lists them folded away", async () => {
    await renderOverlay(connected());
    await page.getByRole("button", { name: "Call settings" }).click();
    const details = document.querySelector("details[data-shortcuts]");
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    // The list is there in full for anyone who opens it.
    const text = details.textContent;
    for (const part of ["Mute or unmute the microphone", "Turn the camera on or off", "Share your screen, or stop sharing", "Picture in picture", "Full screen", "Minimise the call", "End the call", "Show this list"]) {
      expect(text).toContain(part);
    }
    expect([...details.querySelectorAll("kbd")].map((key) => key.textContent)).toEqual(["M", "V", "S", "P", "F", "Esc", "Shift", "H", "?"]);
  });

  test("a phone with only a touch screen is not told about keys", async () => {
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      matches: !query.includes("any-pointer: fine"),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }));
    await renderOverlay(connected());
    await page.getByRole("button", { name: "Call settings" }).click();
    await expect.element(page.getByRole("group", { name: "Call settings" })).toBeInTheDocument();
    expect(document.querySelector("details[data-shortcuts]")).toBeNull();
  });

  test("the buttons say their key in the tooltip, and keep their names", async () => {
    await renderOverlay(videoCall());
    expect(page.getByRole("button", { name: "Mute microphone" }).element().title).toBe("Mute microphone (M)");
    expect(page.getByRole("button", { name: "Turn camera off" }).element().title).toBe("Turn camera off (V)");
    expect(page.getByRole("button", { name: "Share screen" }).element().title).toBe("Share screen (S)");
    expect(page.getByRole("button", { name: "End call" }).element().title).toBe("End call (Shift+H)");
    expect(page.getByRole("button", { name: "Minimise call" }).element().title).toBe("Minimise call (Esc)");
  });

  describe("they leave the key alone", () => {
    const field = (tag, attrs = {}) => {
      const el = document.createElement(tag);
      el.dataset.testExtra = "";
      Object.entries(attrs).forEach(([name, value]) => el.setAttribute(name, value));
      document.body.appendChild(el);
      el.focus();
      return el;
    };

    test("while the person types in an input, a text area or an editable element", async () => {
      const { value } = await renderOverlay(connected());
      for (const el of [field("input", { type: "text" }), field("textarea"), field("div", { contenteditable: "true", tabindex: "0" }), field("input", { type: "search" })]) {
        const event = press("m", {}, el);
        expect(event.defaultPrevented).toBe(false);
        press("H", shift, el);
        press("Escape", {}, el);
      }
      expect(value.setMuted).not.toHaveBeenCalled();
      expect(value.hangup).not.toHaveBeenCalled();
      expect(value.setMinimized).not.toHaveBeenCalled();
    });

    test("while a modifier key is held", async () => {
      const { value } = await renderOverlay(connected());
      for (const extra of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) press("m", extra);
      press("H", { shiftKey: true, ctrlKey: true });
      expect(value.setMuted).not.toHaveBeenCalled();
      expect(value.hangup).not.toHaveBeenCalled();
    });

    test("while a key is held down (no repeat)", async () => {
      const { value } = await renderOverlay(connected());
      press("m", { repeat: true });
      expect(value.setMuted).not.toHaveBeenCalled();
    });

    test("while a modal window is open", async () => {
      const { value } = await renderOverlay(connected());
      const modal = document.createElement("div");
      modal.setAttribute("role", "dialog");
      modal.setAttribute("aria-modal", "true");
      modal.dataset.testExtra = "";
      document.body.appendChild(modal);
      press("m");
      press("Escape");
      press("H", shift);
      expect(value.setMuted).not.toHaveBeenCalled();
      expect(value.setMinimized).not.toHaveBeenCalled();
      expect(value.hangup).not.toHaveBeenCalled();
    });

    test("while a menu or another dialog is in front", async () => {
      const { value } = await renderOverlay(connected());
      const menu = document.createElement("div");
      menu.setAttribute("role", "menu");
      menu.dataset.testExtra = "";
      document.body.appendChild(menu);
      press("Escape");
      expect(value.setMinimized).not.toHaveBeenCalled();
      menu.remove();
      const dialog = document.createElement("div");
      dialog.setAttribute("role", "dialog");
      dialog.dataset.testExtra = "";
      document.body.appendChild(dialog);
      press("m");
      expect(value.setMuted).not.toHaveBeenCalled();
    });

    test("while the call is minimised: the chat keeps its keys", async () => {
      const { value } = await renderOverlay(connected(), { minimized: true });
      await expect.element(page.getByRole("button", { name: "Expand call" })).toBeInTheDocument();
      const events = [press("m"), press("Escape"), press("H", shift), press("?", shift)];
      expect(events.every((event) => !event.defaultPrevented)).toBe(true);
      expect(value.setMuted).not.toHaveBeenCalled();
      expect(value.hangup).not.toHaveBeenCalled();
      expect(value.setMinimized).not.toHaveBeenCalled();
    });

    test("while a call is ringing (nothing to mute yet)", async () => {
      const { value } = await renderOverlay({ phase: "incoming", kind: "audio", peer, ringing: true });
      press("m");
      press("H", shift);
      expect(value.setMuted).not.toHaveBeenCalled();
      expect(value.hangup).not.toHaveBeenCalled();
    });

    test("when there is no call at all", async () => {
      const { value } = await renderOverlay({ phase: "idle" });
      expect(press("m").defaultPrevented).toBe(false);
      expect(value.setMuted).not.toHaveBeenCalled();
    });

    test("a key somebody else already handled", async () => {
      const { value } = await renderOverlay(connected());
      const first = (event) => event.preventDefault();
      window.addEventListener("keydown", first, true);
      try {
        press("m");
      } finally {
        window.removeEventListener("keydown", first, true);
      }
      expect(value.setMuted).not.toHaveBeenCalled();
    });

    test("a focused button or slider still takes the shortcuts", async () => {
      const { value } = await renderOverlay(connected());
      const button = page.getByRole("button", { name: "Mute microphone" }).element();
      button.focus();
      press("m", {}, button);
      expect(value.setMuted).toHaveBeenCalledWith(true);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("the switch for the single-letter keys", () => {
  const letters = ["m", "v", "s", "p", "f"];
  const lettersOff = () => {
    localStorage.setItem(CALL_SHORTCUT_KEY, "0");
    reloadCallShortcutsEnabled();
  };
  beforeEach(() => {
    localStorage.clear();
    reloadCallShortcutsEnabled();
  });
  afterEach(() => {
    localStorage.clear();
    reloadCallShortcutsEnabled();
  });

  test("the letter keys are on by default", async () => {
    expect(getCallShortcutsEnabled()).toBe(true);
    const { value } = await renderOverlay(connected());
    expect(press("m").defaultPrevented).toBe(true);
    expect(value.setMuted).toHaveBeenCalledWith(true);
  });

  test("switched off, M, V, S, P and F do nothing at all and are left to the page", async () => {
    lettersOff();
    stubPip();
    stubFullscreen();
    const { value } = await renderOverlay(videoCall());
    for (const letter of letters) {
      const event = press(letter);
      expect(event.defaultPrevented, letter).toBe(false);
      press(letter.toUpperCase());
    }
    expect(value.setMuted).not.toHaveBeenCalled();
    expect(value.setCameraEnabled).not.toHaveBeenCalled();
    expect(value.toggleScreenShare).not.toHaveBeenCalled();
    expect(document.fullscreenElement).toBeNull();
  });

  test("switched off, Escape, ? and Shift+H are as always", async () => {
    lettersOff();
    const { value } = await renderOverlay(connected());
    expect(press("?", shift).defaultPrevented).toBe(true);
    await expect.element(page.getByRole("group", { name: "Call settings" })).toBeInTheDocument();
    press("?", shift); // closes the settings again
    await expect.poll(() => document.querySelector('[role="group"][aria-label="Call settings"]')).toBeNull();
    expect(press("Escape").defaultPrevented).toBe(true);
    expect(value.setMinimized).toHaveBeenCalledWith(true);
    press("H", shift);
    expect(value.hangup).toHaveBeenCalledTimes(1);
  });

  test("switched off, the buttons stop naming their letters in the tooltips (Esc and Shift+H stay)", async () => {
    lettersOff();
    stubPip();
    await renderOverlay(videoCall());
    expect(page.getByRole("button", { name: "Mute microphone" }).element().title).toBe("Mute microphone");
    expect(page.getByRole("button", { name: "Turn camera off" }).element().title).toBe("Turn camera off");
    expect(page.getByRole("button", { name: "Share screen" }).element().title).toBe("Share screen");
    expect(page.getByRole("button", { name: "Picture in picture" }).element().title).toBe("Picture in picture");
    expect(page.getByRole("button", { name: "End call" }).element().title).toBe("End call (Shift+H)");
    expect(page.getByRole("button", { name: "Minimise call" }).element().title).toBe("Minimise call (Esc)");
  });

  test("the call settings hold the switch, at the top of the Keyboard shortcuts list, and it is on", async () => {
    await renderOverlay(connected());
    expect(press("?", shift).defaultPrevented).toBe(true);
    const toggle = page.getByRole("switch", { name: /Single-key shortcuts/ });
    await expect.element(toggle).toBeInTheDocument();
    await expect.element(toggle).toHaveAttribute("aria-checked", "true");
    const details = document.querySelector("details[data-shortcuts]");
    expect(details.contains(toggle.element())).toBe(true);
    expect(details.querySelector("[data-shortcuts-switch]")).toBe(toggle.element());
  });

  test("turning it off there takes effect at once, is remembered on this device, and says what stays", async () => {
    const { value } = await renderOverlay(connected());
    press("?", shift);
    const toggle = page.getByRole("switch", { name: /Single-key shortcuts/ });
    await toggle.click();
    await expect.element(toggle).toHaveAttribute("aria-checked", "false");
    expect(localStorage.getItem(CALL_SHORTCUT_KEY)).toBe("0");
    expect(getCallShortcutsEnabled()).toBe(false);
    await expect.element(page.getByText(/The letter keys are off\. Esc, \? and Shift\+H still work\./)).toBeInTheDocument();
    expect(press("m").defaultPrevented).toBe(false);
    expect(value.setMuted).not.toHaveBeenCalled();

    await toggle.click();
    await expect.element(toggle).toHaveAttribute("aria-checked", "true");
    expect(localStorage.getItem(CALL_SHORTCUT_KEY)).toBe("1");
    expect(press("m").defaultPrevented).toBe(true);
    expect(value.setMuted).toHaveBeenCalledWith(true);
  });

  test("the switch can be reached and used with the keyboard", async () => {
    await renderOverlay(connected());
    press("?", shift);
    await expect.element(page.getByRole("switch", { name: /Single-key shortcuts/ })).toBeInTheDocument();
    const toggle = page.getByRole("switch", { name: /Single-key shortcuts/ }).element();
    toggle.focus();
    expect(document.activeElement).toBe(toggle); // it is a real button in the tab order
    toggle.click(); // what Space or Enter does on a button
    await expect.poll(() => toggle.getAttribute("aria-checked")).toBe("false");
  });

  test("an off choice saved earlier is honoured from the first key press", async () => {
    localStorage.setItem(CALL_SHORTCUT_KEY, "0");
    reloadCallShortcutsEnabled();
    const { value } = await renderOverlay(connected());
    press("m");
    expect(value.setMuted).not.toHaveBeenCalled();
  });

  test("a phone with only a touch screen has no list of keys in the call settings (and the app's settings hold the switch)", async () => {
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      matches: !query.includes("any-pointer: fine"),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }));
    await renderOverlay(connected());
    await page.getByRole("button", { name: "Call settings" }).click();
    await expect.element(page.getByRole("group", { name: "Call settings" })).toBeInTheDocument();
    expect(page.getByRole("switch", { name: /Single-key shortcuts/ }).elements()).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("the letter keys belong to the call only while the focus is on it", () => {
  beforeEach(() => {
    localStorage.clear();
    reloadCallShortcutsEnabled();
  });
  const outside = (tag = "button") => {
    const el = document.createElement(tag);
    el.dataset.testExtra = "";
    el.textContent = "a row of the chat";
    document.body.appendChild(el);
    el.focus();
    return el;
  };

  test("on the chat list or a message behind the card, a letter is the chat's", async () => {
    const { value } = await renderOverlay(connected());
    const row = outside();
    for (const letter of ["m", "v", "s", "p", "f"]) expect(press(letter, {}, row).defaultPrevented, letter).toBe(false);
    expect(press("?", shift, row).defaultPrevented).toBe(false);
    press("H", shift, row);
    expect(value.setMuted).not.toHaveBeenCalled();
    expect(value.toggleScreenShare).not.toHaveBeenCalled();
    expect(value.hangup).not.toHaveBeenCalled();
    expect(document.querySelector('[role="group"][aria-label="Call settings"]')).toBeNull();
  });

  test("Escape still minimises the call from there (and is not also the chat's Escape)", async () => {
    const { value } = await renderOverlay(connected());
    const row = outside();
    expect(press("Escape", {}, row).defaultPrevented).toBe(true);
    expect(value.setMinimized).toHaveBeenCalledWith(true);
  });

  test("on the card itself, or a button in it, the keys work", async () => {
    const { value } = await renderOverlay(connected());
    document.querySelector('[role="dialog"]').focus();
    press("m", {}, document.activeElement);
    expect(value.setMuted).toHaveBeenCalledWith(true);
    const button = page.getByRole("button", { name: "Call settings" }).element();
    button.focus();
    press("?", shift, button);
    await expect.element(page.getByRole("group", { name: "Call settings" })).toBeInTheDocument();
  });

  test("with nothing in particular focused (the bare page), they work", async () => {
    const { value } = await renderOverlay(connected());
    document.activeElement?.blur?.();
    expect(document.activeElement).toBe(document.body);
    press("m");
    expect(value.setMuted).toHaveBeenCalledWith(true);
  });

  test("once the focus is back on the card, the keys work again", async () => {
    const { value } = await renderOverlay(connected());
    const row = outside();
    press("m", {}, row);
    expect(value.setMuted).not.toHaveBeenCalled();
    row.remove();
    document.querySelector('[role="dialog"]').focus();
    press("m", {}, document.activeElement);
    expect(value.setMuted).toHaveBeenCalledTimes(1);
  });
});
