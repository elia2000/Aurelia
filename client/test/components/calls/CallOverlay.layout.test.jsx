import { describe, test, expect, vi, beforeEach } from "vitest";
import { useState } from "react";
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
import { TRUST } from "../../../src/e2ee/trust.js";

beforeEach(() => localStorage.clear());

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

// The overlay with a real `minimized` state, so that the card and the pill really swap places.
function Stateful({ initial, state, calls }) {
  const [minimized, setMinimized] = useState(initial);
  const value = { ...withCalls(state), ...calls, minimized, setMinimized };
  return ui(value);
}

const connected = (extra = {}) => ({
  phase: "connected", kind: "audio", peer, connectedAt: Date.now(), screenAvailable: true, ...extra,
});
const videoCall = (extra = {}) => connected({ kind: "video", cameraOn: true, remoteCameraOn: true, ...extra });
const theirScreen = () => ({ remoteScreenOn: true, remoteScreenStream: new MediaStream(), remoteScreenSize: { w: 1920, h: 1080 } });
const announcement = () => document.querySelector("p[role='status'].sr-only")?.textContent;
const dialog = () => document.querySelector('[role="dialog"]');

// ─────────────────────────────────────────────────────────────────────────────
describe("the sharing banner over a bright picture", () => {
  test("has a dark, nearly opaque backing of its own, not a faint tint that shows the video through", async () => {
    await renderOverlay(videoCall({ screenSharing: true, screenSurface: "monitor" }));
    const banner = document.querySelector("[data-screen-banner]");
    // rose-950 at 90% (measured against the brightest frame by "sharing-banner" in themeContrast.js);
    // the old bg-rose-500/20 was 1.4:1 over a white wall.
    expect(banner.className).toContain("bg-rose-950/90");
    expect(banner.className).not.toContain("bg-rose-500/20");
    expect(banner.className).toContain("text-rose-50");
    // The small line is not made fainter with opacity either.
    const lines = [...banner.querySelectorAll("span.block")];
    expect(lines.map((line) => line.className).join(" ")).not.toMatch(/text-rose-\d+\/\d+/);
  });

  test("is a labelled group of its own, not a status region that is inserted already filled", async () => {
    await renderOverlay(connected({ screenSharing: true, screenSurface: "window" }));
    const banner = document.querySelector("[data-screen-banner]");
    expect(banner.getAttribute("role")).toBe("group");
    expect(banner.getAttribute("aria-label")).toBe("Screen sharing");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("the trust warning while the other person shares their screen", () => {
  const warning = () => document.querySelector('[data-chrome="warning"]');

  test.each([
    ["a new device (with Review)", { status: TRUST.DEVICES_ADDED, verified: false }, "Review"],
    ["a verified contact's new device", { status: TRUST.DEVICES_ADDED, verified: true }, "Review"],
    ["the first secure call", { status: TRUST.NEW }, null],
  ])("keeps clear of the small pictures down the right edge: %s", async (_name, trust, button) => {
    await renderOverlay(videoCall({ ...theirScreen(), trust }));
    // Their camera and yours are tiles on the right while the screen fills the rest.
    expect(document.querySelector('video[data-view="remote"]').dataset.slot).toBe("tile");
    expect(document.querySelector('video[data-view="local"]').dataset.slot).toBe("tile");
    expect(warning()).not.toBeNull();
    expect(warning().style.marginRight).toBe("7rem");
    if (button) await expect.element(page.getByRole("button", { name: button })).toBeInTheDocument();
  });

  test("also while you share your own screen (its preview is a tile as well)", async () => {
    await renderOverlay(connected({ screenSharing: true, screenSurface: "monitor", trust: { status: TRUST.DEVICES_ADDED, verified: false } }));
    expect(warning().style.marginRight).toBe("7rem");
  });

  test("keeps clear of the tiles without a shared screen too (as before)", async () => {
    await renderOverlay(videoCall({ trust: { status: TRUST.DEVICES_ADDED, verified: false } }));
    expect(warning().style.marginRight).toBe("7rem");
  });

  test("uses the whole width when there is no tile at all", async () => {
    await renderOverlay(connected({ ...theirScreen(), trust: { status: TRUST.DEVICES_ADDED, verified: false } }));
    expect(document.querySelectorAll("[data-slot='tile']")).toHaveLength(0);
    expect(warning().style.marginRight).toBe("");
  });

  test("Review still opens the safety number", async () => {
    await renderOverlay(videoCall({ ...theirScreen(), sas: ["😀", "🐱", "🌳", "🚀"], trust: { status: TRUST.DEVICES_ADDED, verified: false } }));
    await page.getByRole("button", { name: "Review" }).click();
    await expect.element(page.getByRole("dialog", { name: "Verify security" })).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("the call settings while you share", () => {
  const settings = () => document.querySelector('[role="group"][aria-label="Call settings"]');

  test("the banner stays in the card, outside the panel, and above the click-catcher", async () => {
    const { value } = await renderOverlay(videoCall({ screenSharing: true, screenSurface: "monitor" }));
    await page.getByRole("button", { name: "Call settings" }).click();
    await expect.element(page.getByRole("group", { name: "Call settings" })).toBeInTheDocument();
    const banner = document.querySelector("[data-screen-banner]");
    expect(banner).not.toBeNull();
    expect(settings().contains(banner)).toBe(false);
    // z-35 is above the catcher (z-30) that closes the settings on a tap and below the panel (z-40).
    expect(banner.className).toContain("z-35");
    expect(document.querySelector(".z-30.absolute.inset-0")).not.toBeNull();
    expect(settings().className).toContain("z-40");
    // Stop sharing works with the settings open.
    banner.querySelector("[data-screen-stop]").click();
    expect(value.stopScreenShare).toHaveBeenCalledTimes(1);
  });

  test("the panel is told where the banner starts, and sits above it", async () => {
    await renderOverlay(videoCall({ screenSharing: true, screenSurface: "monitor" }));
    // Without the settings the panel is where it always was.
    await page.getByRole("button", { name: "Call settings" }).click();
    await expect.poll(() => settings().style.bottom).not.toBe("");
    const bottom = parseFloat(settings().style.bottom);
    // (No stylesheet in these tests: the exact position is checked in the browser scripts.)
    expect(bottom).toBeGreaterThanOrEqual(8);
    expect(settings().style.maxHeight).toContain("min(65%");
  });

  test("with nothing to clear, the panel keeps its usual place", async () => {
    await renderOverlay(videoCall());
    await page.getByRole("button", { name: "Call settings" }).click();
    await expect.element(page.getByRole("group", { name: "Call settings" })).toBeInTheDocument();
    expect(settings().style.bottom).toBe("");
    expect(settings().className).toContain("bottom-24");
  });

  test("the panel goes back to its place when sharing stops", async () => {
    const { value, show } = await renderOverlay(videoCall({ screenSharing: true, screenSurface: "monitor" }));
    await page.getByRole("button", { name: "Call settings" }).click();
    await expect.poll(() => settings().style.bottom).not.toBe("");
    await show({ ...value, state: { ...value.state, screenSharing: false } });
    await expect.poll(() => settings().style.bottom).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("what a screen reader hears about screen sharing", () => {
  test("the other person starting and stopping their share", async () => {
    const { value, show } = await renderOverlay(connected());
    expect(announcement()).toBe("");
    await show({ ...value, state: { ...value.state, ...theirScreen() } });
    await expect.poll(announcement).toBe("Bob is sharing their screen");
    await show({ ...value, state: { ...value.state, remoteScreenOn: false, remoteScreenStream: null } });
    await expect.poll(announcement).toBe("Bob stopped sharing their screen");
  });

  test("your own share starting and stopping, whichever way it was made", async () => {
    const { value, show } = await renderOverlay(connected());
    await show({ ...value, state: { ...value.state, screenSharing: true, screenSurface: "monitor" } });
    await expect.poll(announcement).toBe("You are sharing your screen");
    // (the browser's own "Stop sharing" bar changes nothing but the state)
    await show({ ...value, state: { ...value.state, screenSharing: false } });
    await expect.poll(announcement).toBe("Stopped sharing your screen");
  });

  test("nothing is said for a share that was already going when the card appeared", async () => {
    await renderOverlay(connected({ screenSharing: true, screenSurface: "monitor", ...theirScreen() }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(announcement()).toBe("");
  });

  test("nothing is said about the share when the call itself ends (the card says that)", async () => {
    const { value, show } = await renderOverlay(connected({ screenSharing: true, screenSurface: "monitor" }));
    await show({ ...value, state: { ...value.state, phase: "ended", endReason: "hangup", screenSharing: false } });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(announcement()).toBe("");
  });

  test("with the card minimised the pill has a live region for it", async () => {
    const { value, show } = await renderOverlay(connected({ screenSharing: true, screenSurface: "monitor" }), { minimized: true });
    expect(document.querySelector("p[role='status'].sr-only")).not.toBeNull();
    await show({ ...value, state: { ...value.state, screenSharing: false } });
    await expect.poll(announcement).toBe("Stopped sharing your screen");
  });

  test("the running clock of the pill is not read out every second", async () => {
    await renderOverlay(connected({ connectedAt: Date.now() - 5000 }), { minimized: true });
    const clock = page.getByRole("timer").element();
    expect(clock.closest("[role='status']")).not.toBeNull(); // inside the pill's status region...
    expect(clock.getAttribute("aria-live")).toBe("off"); // ...but silent itself, like the clock on the card
    expect(clock.textContent).toMatch(/^\d\d:\d\d$/);
  });

  test("the S key no longer says it a second time", async () => {
    const { value, show } = await renderOverlay(connected({ screenSharing: true, screenSurface: "monitor" }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "s", bubbles: true, cancelable: true }));
    expect(value.toggleScreenShare).toHaveBeenCalledTimes(1);
    // Nothing is claimed before the share has really stopped.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(announcement()).toBe("");
    await show({ ...value, state: { ...value.state, screenSharing: false } });
    await expect.poll(announcement).toBe("Stopped sharing your screen");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("where the focus goes when sharing stops or the card is minimised", () => {
  test("Stop sharing in the banner leaves the focus on the Share screen button", async () => {
    const value = withCalls(connected({ screenSharing: true, screenSurface: "monitor" }));
    // The manager answers a stop by clearing the state.
    value.stopScreenShare = vi.fn();
    const { rerender } = await render(ui(value));
    const stop = document.querySelector("[data-screen-stop]");
    stop.focus();
    expect(document.activeElement).toBe(stop);
    stop.click();
    expect(value.stopScreenShare).toHaveBeenCalledTimes(1);
    await rerender(ui({ ...value, state: { ...value.state, screenSharing: false } }));
    expect(document.querySelector("[data-screen-banner]")).toBeNull();
    await expect.poll(() => document.activeElement?.getAttribute("aria-label")).toBe("Share screen");
    expect(document.activeElement.closest('[data-chrome="controls"]')).not.toBeNull();
  });

  test("a share that ends by itself later does not take the focus", async () => {
    const value = withCalls(connected({ screenSharing: true, screenSurface: "monitor" }));
    const { rerender } = await render(ui(value));
    const other = document.createElement("button");
    other.dataset.testExtra = "";
    document.body.appendChild(other);
    other.focus();
    await rerender(ui({ ...value, state: { ...value.state, screenSharing: false } }));
    expect(document.activeElement).toBe(other);
    other.remove();
  });

  test("Stop sharing in the minimised pill hands the focus to Expand call", async () => {
    const value = withCalls(connected({ screenSharing: true, screenSurface: "monitor" }), { minimized: true });
    await render(ui(value));
    const stop = page.getByRole("button", { name: "Stop sharing" }).element();
    stop.focus();
    stop.click();
    expect(value.stopScreenShare).toHaveBeenCalledTimes(1);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Expand call");
  });

  test("Minimise call moves the focus to the pill's Expand call, and Expand call back to the card", async () => {
    await render(<Stateful initial={false} state={connected()} />);
    const minimise = page.getByRole("button", { name: "Minimise call" }).element();
    minimise.focus();
    minimise.click();
    await expect.element(page.getByRole("button", { name: "Expand call" })).toBeInTheDocument();
    await expect.poll(() => document.activeElement?.getAttribute("aria-label")).toBe("Expand call");
    page.getByRole("button", { name: "Expand call" }).element().click();
    await expect.element(page.getByRole("button", { name: "Minimise call" })).toBeInTheDocument();
    await expect.poll(() => document.activeElement).toBe(dialog());
  });

  test("minimising with the Escape key does not drag the focus out of the chat", async () => {
    await render(<Stateful initial={false} state={connected()} />);
    const chatRow = document.createElement("button");
    chatRow.dataset.testExtra = "";
    document.body.appendChild(chatRow);
    chatRow.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await expect.element(page.getByRole("button", { name: "Expand call" })).toBeInTheDocument();
    expect(document.activeElement).toBe(chatRow);
    chatRow.remove();
  });

  test("while the details are faded out, a key pressed in the chat's own message box does not pull the focus away", async () => {
    await renderOverlay(videoCall(), undefined, { autoHideMs: 60 });
    await expect.poll(() => document.querySelector('[data-chrome="controls"]').hasAttribute("inert")).toBe(true);
    const field = document.createElement("textarea");
    field.dataset.testExtra = "";
    document.body.appendChild(field);
    field.focus();
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "h", bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(document.activeElement).toBe(field);
    field.remove();
  });

  test("but when the buttons that had the focus went out of reach, the next key finds the focus on the card", async () => {
    await renderOverlay(videoCall(), undefined, { autoHideMs: 60 });
    const button = page.getByRole("button", { name: "Mute microphone" }).element();
    button.focus();
    await expect.poll(() => document.querySelector('[data-chrome="controls"]').hasAttribute("inert")).toBe(true);
    // (the faded-out button cannot keep the focus: it is on the card, or on nothing)
    document.activeElement?.blur?.();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(dialog());
  });

  test("the card of a call you place takes the focus, so its keys work", async () => {
    const trigger = document.createElement("button");
    trigger.dataset.testExtra = "";
    document.body.appendChild(trigger);
    trigger.focus();
    await renderOverlay({ phase: "outgoing", kind: "audio", peer, waiting: true });
    await expect.poll(() => document.activeElement).toBe(dialog());
    trigger.remove();
  });

  test("but not while the person is typing in the chat", async () => {
    const field = document.createElement("textarea");
    field.dataset.testExtra = "";
    document.body.appendChild(field);
    field.focus();
    await renderOverlay({ phase: "outgoing", kind: "audio", peer, waiting: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(document.activeElement).toBe(field);
    field.remove();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("small text on the call card", () => {
  test("'Relayed through your server' is slate-400 (about 7:1 on slate-950), not slate-500 (4.2:1)", async () => {
    await renderOverlay(connected({ relayed: true }));
    const note = page.getByText("Relayed through your server for privacy and reliability").element();
    expect(note.className).toContain("text-slate-400");
    expect(note.className).not.toContain("text-slate-500");
  });

  test("no small text on the card is slate-500 any more", async () => {
    await renderOverlay(videoCall({ relayed: true, reconnecting: false, remoteMuted: true, screenSharing: true, screenSurface: "monitor", connectionQuality: "good" }));
    await page.getByRole("button", { name: "Call settings" }).click();
    const faint = [...dialog().querySelectorAll("*")]
      .filter((el) => /\btext-slate-500\b/.test(el.getAttribute("class") || "") && el.textContent.trim() && !el.closest("[aria-hidden='true']") && !el.matches("svg *"))
      .map((el) => el.textContent.trim());
    expect(faint).toEqual([]);
  });
});
