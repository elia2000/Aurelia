import { describe, test, expect, vi, beforeEach } from "vitest";
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
const renderOverlay = async (state, overrides, props) => {
  const value = withCalls(state, overrides);
  await render(ui(value, props));
  return value;
};

const connected = (extra = {}) => ({
  phase: "connected", kind: "audio", peer, connectedAt: Date.now(), screenAvailable: true, ...extra,
});
const videoCall = (extra = {}) => connected({ kind: "video", cameraOn: true, remoteCameraOn: true, ...extra });
const theirScreen = () => ({ remoteScreenOn: true, remoteScreenStream: new MediaStream(), remoteScreenSize: { w: 1920, h: 1080 } });
const view = (who) => document.querySelector(`video[data-view="${who}"]`);
const slot = (who) => view(who)?.dataset.slot;
const hidden = (what) => document.querySelector(`[data-chrome="${what}"]`)?.hasAttribute("inert");
// The button among the call controls (a banner has a Stop sharing button too).
const controlButton = (name) => page.getByRole("button", { name }).elements().find((el) => el.closest('[data-chrome="controls"]'));

describe("the Share screen button", () => {
  test("is in the call controls of a computer", async () => {
    const value = await renderOverlay(connected());
    await expect.element(page.getByRole("button", { name: "Share screen" })).toBeEnabled();
    await page.getByRole("button", { name: "Share screen" }).click();
    expect(value.toggleScreenShare).toHaveBeenCalledTimes(1);
  });

  test("is not there at all where the browser cannot capture a screen (a phone)", async () => {
    await renderOverlay(connected(), { screenSupported: false });
    await expect.element(page.getByRole("button", { name: "Mute microphone" })).toBeInTheDocument();
    expect(page.getByRole("button", { name: /screen|sharing/i }).elements()).toHaveLength(0);
  });

  test("is shown off, with the reason, while the call is connecting", async () => {
    await renderOverlay({ phase: "connecting", kind: "audio", peer, screenAvailable: false });
    const button = page.getByRole("button", { name: "Share screen" });
    await expect.element(button).toBeDisabled();
    expect(button.element().title).toMatch(/once the call is connected/i);
  });

  test("is off, with the reason, when the other person's app cannot show a screen", async () => {
    await renderOverlay(connected({ screenAvailable: false }));
    const button = page.getByRole("button", { name: "Share screen" });
    await expect.element(button).toBeDisabled();
    expect(button.element().title).toMatch(/cannot show a shared screen/i);
  });

  test("is not offered while the call rings or after it ended", async () => {
    await renderOverlay({ phase: "outgoing", kind: "audio", peer, waiting: true });
    await expect.element(page.getByRole("button", { name: "Cancel call" })).toBeInTheDocument();
    expect(page.getByRole("button", { name: /Share screen/ }).elements()).toHaveLength(0);
  });

  test("becomes 'Stop sharing' while a screen is shared", async () => {
    const value = await renderOverlay(connected({ screenSharing: true, screenSurface: "monitor" }));
    await expect.element(page.getByText("You are sharing your screen")).toBeInTheDocument();
    const button = controlButton("Stop sharing");
    expect(button.disabled).toBe(false);
    expect(page.getByRole("button", { name: "Share screen" }).elements()).toHaveLength(0);
    button.click();
    expect(value.toggleScreenShare).toHaveBeenCalledTimes(1);
    expect(value.stopScreenShare).not.toHaveBeenCalled();
  });

  test("stays pressable while the browser's picker is open, so a second press can cancel", async () => {
    await renderOverlay(connected({ screenBusy: true }));
    await expect.element(page.getByRole("button", { name: "Share screen" })).toBeEnabled();
  });
});

describe("while you share", () => {
  test("a banner says so and offers to stop", async () => {
    const value = await renderOverlay(connected({ screenSharing: true, screenSurface: "window", screenStream: new MediaStream() }));
    await expect.element(page.getByText("You are sharing your screen")).toBeInTheDocument();
    expect(document.querySelector("[data-screen-banner]").textContent).toContain("A window");
    await page.getByText("Stop sharing", { exact: true }).click();
    expect(value.stopScreenShare).toHaveBeenCalledTimes(1);
  });

  test("the banner is not part of the details that get out of the way", async () => {
    await renderOverlay(videoCall({ screenSharing: true, screenSurface: "monitor" }), undefined, { autoHideMs: 80 });
    await expect.poll(() => hidden("controls")).toBe(true);
    const banner = document.querySelector("[data-screen-banner]");
    expect(banner).not.toBeNull();
    expect(banner.closest("[inert]")).toBeNull();
    expect(banner.className).not.toContain("opacity-0");
  });

  test("the whole screen is never mirrored live: a still label stands in for it", async () => {
    await renderOverlay(connected({ screenSharing: true, screenSurface: "monitor", screenStream: new MediaStream() }));
    const tile = document.querySelector('[data-view="screen-preview"]');
    expect(tile.dataset.live).toBe("false");
    expect(tile.querySelector("video")).toBeNull();
    expect(tile.textContent).toContain("Your entire screen");
  });

  test("neither is a window (it could be the one this call is in)", async () => {
    await renderOverlay(connected({ screenSharing: true, screenSurface: "window", screenStream: new MediaStream() }));
    expect(document.querySelector('[data-view="screen-preview"] video')).toBeNull();
  });

  test("a screen whose kind is unknown gets the still label as well", async () => {
    await renderOverlay(connected({ screenSharing: true, screenSurface: null, screenStream: new MediaStream() }));
    expect(document.querySelector('[data-view="screen-preview"] video')).toBeNull();
  });

  test("another browser tab can be previewed live, it cannot show itself", async () => {
    await renderOverlay(connected({ screenSharing: true, screenSurface: "browser", screenStream: new MediaStream() }));
    const tile = document.querySelector('[data-view="screen-preview"]');
    expect(tile.dataset.live).toBe("true");
    expect(tile.querySelector("video")).not.toBeNull();
    expect(tile.querySelector("video").muted).toBe(true);
  });

  test("the preview tile sits below your own picture", async () => {
    await renderOverlay(videoCall({ screenSharing: true, screenSurface: "monitor" }));
    const own = view("local");
    const preview = document.querySelector('[data-view="screen-preview"]');
    expect(own.style.top).not.toBe(""); // the first tile
    expect(preview.style.top).toBe(""); // the second, further down by class
    expect(preview.className).toContain("top-[calc(");
  });

  test("in a voice call it is the only tile", async () => {
    await renderOverlay(connected({ screenSharing: true, screenSurface: "monitor" }));
    expect(document.querySelector('[data-view="screen-preview"]').style.top).not.toBe("");
  });

  test("minimised, the pill still says it and stops it in one tap", async () => {
    const value = await renderOverlay(connected({ screenSharing: true, screenSurface: "monitor" }), { minimized: true });
    await expect.element(page.getByRole("button", { name: "Stop sharing" })).toBeInTheDocument();
    expect(document.querySelector('[data-view="screen-preview"]')).toBeNull();
    await page.getByRole("button", { name: "Stop sharing" }).click();
    expect(value.stopScreenShare).toHaveBeenCalledTimes(1);
  });

  test("a call that has ended shows no banner", async () => {
    await renderOverlay({ phase: "ended", endReason: "hangup", kind: "audio", peer, screenSharing: false });
    expect(document.querySelector("[data-screen-banner]")).toBeNull();
  });
});

describe("hints when a share did not start", () => {
  test.each([
    ["cancelled", /did not start/i],
    ["unsupported", /cannot share its screen/i],
    ["unavailable", /cannot show a shared screen/i],
    ["failed", /could not be started/i],
  ])("%s is a small hint on the call, not an error screen", async (screenError, text) => {
    await renderOverlay(connected({ screenError }));
    await expect.element(page.getByText(text).first()).toBeInTheDocument();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    // It sits in the live region, so it is announced.
    expect(page.getByText(text).first().element().closest("[aria-live]")).not.toBeNull();
  });

  test("an error word that is not known still gives a hint", async () => {
    await renderOverlay(connected({ screenError: "something-new" }));
    await expect.element(page.getByText(/could not be started/i)).toBeInTheDocument();
  });

  test("no hint, no text", async () => {
    await renderOverlay(connected({ screenError: null }));
    await expect.element(page.getByRole("timer")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Screen sharing could not|did not start/);
  });
});

describe("when the other person shares", () => {
  test("their screen fills the screen, all of it, with a label", async () => {
    await renderOverlay(connected(theirScreen()));
    expect(slot("screen")).toBe("main");
    expect(view("screen").dataset.fit).toBe("contain");
    expect(view("screen").className).toContain("object-contain");
    expect(view("screen").className).not.toContain("object-cover");
    await expect.element(page.getByText("Sharing their screen")).toBeInTheDocument();
  });

  test("a voice call turns into the stage layout: black, no avatar, no talk of a camera", async () => {
    await renderOverlay(connected(theirScreen()));
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog.className).toContain("bg-black");
    expect(dialog.querySelector(".h-28.w-28")).toBeNull();
    expect(document.body.textContent).not.toContain("Camera off");
    expect(dialog.querySelector("h2").textContent).toBe("Bob");
  });

  test("the stage is large on a computer, instead of the small card", async () => {
    await renderOverlay(connected(theirScreen()));
    expect(document.querySelector('[role="dialog"]').className).toContain("md:w-[min(92vw,1180px)]");
  });

  test("without a screen the call keeps its card and avatar", async () => {
    await renderOverlay(connected());
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog.className).toContain("md:w-[360px]");
    expect(dialog.className).not.toContain("bg-black");
  });

  test("a phone, which cannot share, still watches", async () => {
    await renderOverlay(connected(theirScreen()), { screenSupported: false });
    expect(slot("screen")).toBe("main");
    expect(page.getByRole("button", { name: /Share screen/ }).elements()).toHaveLength(0);
  });

  test("the picture is 'waiting' until the first frame is there", async () => {
    await renderOverlay(connected(theirScreen()));
    await expect.element(page.getByText("Waiting for the picture…")).toBeInTheDocument();
  });

  test("an announcement with no picture yet shows nothing: the screen needs both", async () => {
    await renderOverlay(connected({ remoteScreenOn: true, remoteScreenStream: null }));
    expect(view("screen")).toBeNull();
    expect(document.body.textContent).not.toContain("Sharing their screen");
    await renderOverlay(connected({ remoteScreenOn: false, remoteScreenStream: new MediaStream() }));
    expect(view("screen")).toBeNull();
  });

  test("their camera is the small picture, and your own sits below it", async () => {
    await renderOverlay(videoCall(theirScreen()));
    expect(slot("screen")).toBe("main");
    expect(slot("remote")).toBe("tile");
    expect(slot("local")).toBe("tile");
    expect(view("remote").style.top).not.toBe("");
    expect(view("local").style.top).toBe("");
    expect(view("local").className).toContain("top-[calc(");
  });

  test("tapping their small camera swaps it with the screen, and tapping again swaps back", async () => {
    await renderOverlay(videoCall(theirScreen()));
    await page.getByRole("button", { name: "Show their camera full screen" }).click();
    expect(slot("remote")).toBe("main");
    expect(slot("screen")).toBe("tile");
    expect(view("screen").className).toContain("object-contain"); // never cropped, even as a tile
    await page.getByRole("button", { name: "Show the shared screen full screen" }).click();
    expect(slot("screen")).toBe("main");
    expect(slot("remote")).toBe("tile");
  });

  test("the swap goes when their camera does", async () => {
    const value = withCalls(videoCall(theirScreen()));
    const { rerender } = await render(ui(value));
    await page.getByRole("button", { name: "Show their camera full screen" }).click();
    expect(slot("remote")).toBe("main");
    await rerender(ui({ ...value, state: { ...value.state, remoteCameraOn: false } }));
    expect(view("remote")).toBeNull();
    expect(slot("screen")).toBe("main");
    await rerender(ui({ ...value, state: { ...value.state, remoteCameraOn: true } }));
    expect(slot("screen")).toBe("main"); // not remembered
  });

  test("with their camera off there is nothing to swap and no talk of a missing camera", async () => {
    await renderOverlay(videoCall({ ...theirScreen(), remoteCameraOn: false }));
    expect(page.getByRole("button", { name: /full screen/ }).elements()).toHaveLength(0);
    expect(document.body.textContent).not.toContain("Camera off");
    expect(slot("screen")).toBe("main");
  });

  test("your own camera cannot take the whole screen while a shared screen is on", async () => {
    await renderOverlay(videoCall(theirScreen()));
    expect(page.getByRole("button", { name: "Show your picture full screen" }).elements()).toHaveLength(0);
    expect(slot("local")).toBe("tile");
  });

  test("the choice of how the camera sits on the screen never crops a shared screen", async () => {
    localStorage.setItem("aurelle-call-fit", "fill");
    await renderOverlay(videoCall(theirScreen()));
    expect(view("screen").dataset.fit).toBe("contain");
    await page.getByRole("button", { name: "Show their camera full screen" }).click();
    expect(view("remote").dataset.fit).toBe("cover"); // the camera follows the choice
    expect(view("screen").dataset.fit).toBeUndefined();
  });

  test("minimised, there is no picture to hold on to", async () => {
    await renderOverlay(connected(theirScreen()), { minimized: true });
    expect(document.querySelector("video")).toBeNull();
  });

  test("the picture is gone with the screen", async () => {
    const value = withCalls(connected(theirScreen()));
    const { rerender } = await render(ui(value));
    expect(view("screen")).not.toBeNull();
    await rerender(ui({ ...value, state: { ...value.state, remoteScreenOn: false, remoteScreenStream: null } }));
    expect(view("screen")).toBeNull();
    expect(document.querySelector('[role="dialog"]').className).toContain("md:w-[360px]");
    await expect.element(page.getByRole("timer")).toBeInTheDocument();
  });

  test("an ended call shows no screen, whatever state was left", async () => {
    await renderOverlay({ phase: "ended", endReason: "hangup", kind: "audio", peer, ...theirScreen() });
    expect(view("screen")).toBeNull();
    await expect.element(page.getByText("Call ended")).toBeInTheDocument();
  });

  test("the details get out of the way of the screen, as they do for video", async () => {
    await renderOverlay(connected(theirScreen()), undefined, { autoHideMs: 80 });
    await expect.poll(() => hidden("header")).toBe(true);
    expect(hidden("controls")).toBe(true);
    // A tap on the picture brings them back, and the next one hides them.
    document.querySelector('[role="dialog"]').click();
    await expect.poll(() => hidden("header")).toBe(false);
  });

  test("a voice call without a screen keeps its details", async () => {
    await renderOverlay(connected(), undefined, { autoHideMs: 80 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(hidden("header")).toBe(false);
  });

  test("the settings tell what arrives, and there is still no quality slider in a voice call", async () => {
    await renderOverlay(connected({ ...theirScreen(), screenStats: { width: 1920, height: 1080, fps: 9 }, microphoneId: "default" }), undefined, { autoHideMs: 10_000 });
    // A voice call with nothing to choose has no settings button; the camera's quality slider stays out.
    expect(page.getByRole("slider", { name: "Video quality" }).elements()).toHaveLength(0);
  });

  test("the settings of a video call list the shared screen's size and rate, and keep the camera's quality", async () => {
    await renderOverlay(videoCall({ ...theirScreen(), screenStats: { width: 1920, height: 1080, fps: 9 }, videoStats: { width: 640, height: 360, fps: 24 } }), undefined, { autoHideMs: 10_000 });
    await page.getByRole("button", { name: "Call settings" }).click();
    await expect.element(page.getByText("Receiving 1920×1080 · 9 fps")).toBeInTheDocument();
    await expect.element(page.getByText("Receiving 640×360 · 24 fps")).toBeInTheDocument();
    await expect.element(page.getByRole("slider", { name: "Video quality" })).toBeInTheDocument();
  });

  test("both people sharing: you see theirs full screen and the banner for yours", async () => {
    await renderOverlay(videoCall({ ...theirScreen(), screenSharing: true, screenSurface: "monitor" }));
    expect(slot("screen")).toBe("main");
    await expect.element(page.getByText("You are sharing your screen")).toBeInTheDocument();
    const preview = document.querySelector('[data-view="screen-preview"]');
    expect(preview.className).toContain("top-[calc("); // third tile: their camera, yours, the preview
    expect(preview.className).toContain("_+_20.5rem");
  });
});
