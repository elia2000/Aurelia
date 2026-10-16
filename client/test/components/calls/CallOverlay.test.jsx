import { describe, test, expect, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
const e2ee = vi.hoisted(() => ({
  services: {
    api: { listMyDevices: async () => ({ devices: [] }) },
    directory: { getUserDevices: async () => ({ devices: [], assessment: { status: "ok", added: [] } }) },
    trust: { isVerified: async () => false },
  },
}));
vi.mock("../../../src/e2ee/services.js", () => ({ getE2eeServices: () => e2ee.services }));

import CallOverlay from "../../../src/components/calls/CallOverlay.jsx";
import CallButtons from "../../../src/components/calls/CallButtons.jsx";
import { CallContext } from "../../../src/calls/callContext.js";
import { CHAT_PAGE_CONFIG } from "../../../src/settings/chatPageConfig.js";

beforeEach(() => localStorage.clear());

const peer = { userId: "u-bob", username: "bob", nickname: "Bob", avatarUrl: "", color: "#10b981" };

function withCalls(state, overrides = {}) {
  const value = {
    supported: true,
    manager: null,
    state: { kind: "audio", muted: false, cameraOn: false, remoteCameraOn: false, ...state },
    minimized: false,
    setMinimized: vi.fn(),
    startCall: vi.fn(),
    accept: vi.fn(),
    decline: vi.fn(),
    hangup: vi.fn(),
    dismiss: vi.fn(),
    setMuted: vi.fn(),
    setCameraEnabled: vi.fn(),
    inCall: state.phase !== "idle",
    ...overrides,
  };
  return value;
}

const renderOverlay = (state, overrides, props = {}) => {
  const value = withCalls(state, overrides);
  render(
    <CallContext.Provider value={value}>
      <CallOverlay user={{ id: "u-alice", username: "alice" }} {...props} />
    </CallContext.Provider>,
  );
  return value;
};

describe("CallOverlay", () => {
  test("renders nothing while idle", async () => {
    renderOverlay({ phase: "idle" });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  test("an incoming call can be accepted or declined", async () => {
    const value = renderOverlay({ phase: "incoming", ringing: true, peer, trust: { status: "ok" } });
    await expect.element(page.getByText("Incoming voice call")).toBeInTheDocument();
    await expect.element(page.getByText("Bob")).toBeInTheDocument();
    await page.getByRole("button", { name: "Accept call" }).click();
    expect(value.accept).toHaveBeenCalledTimes(1);
    await page.getByRole("button", { name: "Decline call" }).click();
    expect(value.decline).toHaveBeenCalledTimes(1);
  });

  test("warns about a first contact and tells the user how to check", async () => {
    renderOverlay({ phase: "incoming", ringing: true, peer, trust: { status: "new" } });
    await expect.element(page.getByText(/First secure call with this contact/)).toBeInTheDocument();
  });

  test("warns when a new device was added for the contact", async () => {
    renderOverlay({ phase: "incoming", ringing: true, peer, trust: { status: "devices_added" } });
    await expect.element(page.getByText(/new device was added/i)).toBeInTheDocument();
  });

  test("a new device of a verified contact is called out more strongly and offers a review", async () => {
    renderOverlay({ phase: "incoming", ringing: true, peer, trust: { status: "devices_added", verified: true } });
    await expect.element(page.getByText(/safety number changed/i)).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Review" })).toBeInTheDocument();
  });

  test("an incoming call does not take focus away from the message being typed", async () => {
    const input = document.createElement("textarea");
    document.body.appendChild(input);
    input.focus();
    renderOverlay({ phase: "incoming", ringing: true, peer, trust: { status: "ok" } });
    await expect.element(page.getByText("Incoming voice call")).toBeInTheDocument();
    // Space or Enter typed now must still go into the message box, not press Accept.
    expect(document.activeElement).toBe(input);
    input.remove();
  });

  test("with nothing being typed, the call dialog (not the Accept button) takes focus", async () => {
    document.activeElement?.blur?.();
    renderOverlay({ phase: "incoming", ringing: true, peer, trust: { status: "ok" } });
    await expect.element(page.getByText("Incoming voice call")).toBeInTheDocument();
    const dialog = document.querySelector('[role="dialog"]');
    expect(document.activeElement).toBe(dialog);
    expect(document.activeElement?.getAttribute("aria-label")).not.toBe("Accept call");
  });

  test("the running clock is a timer that is not announced every second", async () => {
    renderOverlay({ phase: "connected", peer, connectedAt: Date.now() - 5000 });
    await expect.element(page.getByRole("timer")).toBeInTheDocument();
    expect(document.querySelector('[role="timer"]').getAttribute("aria-live")).toBe("off");
  });

  test("an outgoing call says Waiting… until the other app is ringing, then Ringing…", async () => {
    renderOverlay({ phase: "outgoing", ringing: false, waiting: true, peer });
    await expect.element(page.getByText("Waiting…")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("Ringing…");
  });

  test("before the call is placed it says Calling…", async () => {
    renderOverlay({ phase: "outgoing", ringing: false, waiting: false, peer });
    await expect.element(page.getByText("Calling…")).toBeInTheDocument();
  });

  test("a video call can be answered with the camera off; a voice call has no such button", async () => {
    const value = renderOverlay({ phase: "incoming", kind: "video", ringing: true, peer, trust: { status: "ok" } });
    await page.getByRole("button", { name: "Answer with camera off" }).click();
    expect(value.accept).toHaveBeenCalledWith({ camera: false });
    await page.getByRole("button", { name: "Accept call" }).click();
    expect(value.accept).toHaveBeenLastCalledWith();
  });

  test("an incoming voice call offers no camera choice", async () => {
    renderOverlay({ phase: "incoming", kind: "audio", ringing: true, peer, trust: { status: "ok" } });
    await expect.element(page.getByRole("button", { name: "Accept call" })).toBeInTheDocument();
    expect(document.querySelector('button[aria-label="Answer with camera off"]')).toBeNull();
  });

  test("in a video call, when the other camera is off the screen is black with a clear label (no avatar)", async () => {
    renderOverlay({ phase: "connected", kind: "video", peer, cameraOn: true, remoteCameraOn: false, connectedAt: Date.now() });
    await expect.element(page.getByText("Camera off")).toBeInTheDocument();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog.className).toContain("bg-black");
    // No avatar stage: the name is still there so you know who it is.
    expect(dialog.querySelector("h2").textContent).toBe("Bob");
    expect(dialog.querySelector(".h-28.w-28")).toBeNull();
  });

  test("your own camera being off shows a black tile instead of a missing picture", async () => {
    renderOverlay({ phase: "connected", kind: "video", peer, cameraOn: false, remoteCameraOn: true, connectedAt: Date.now() });
    await expect.element(page.getByRole("img", { name: "Your camera is off" })).toBeInTheDocument();
  });

  test("a voice call keeps the avatar stage and never says the camera is off", async () => {
    renderOverlay({ phase: "connected", kind: "audio", peer, connectedAt: Date.now() });
    await expect.element(page.getByRole("timer")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("Camera off");
    expect(document.querySelector('[role="dialog"]').className).not.toContain("bg-black");
  });

  test("a slow connection says it is still trying", async () => {
    renderOverlay({ phase: "connecting", peer, connectingSlow: true });
    await expect.element(page.getByText(/Still connecting/)).toBeInTheDocument();
  });

  test("an unreachable relay is pointed out while the call is still connecting", async () => {
    renderOverlay({ phase: "connecting", peer, connectingSlow: false, relayCheck: "unreachable" });
    await expect.element(page.getByText(/Can't reach the relay server yet/)).toBeInTheDocument();
    expect(document.body.textContent).toContain("VPN or proxy");
  });

  test("a relay that refuses this device says so while the call is still connecting", async () => {
    renderOverlay({ phase: "connecting", peer, relayCheck: "refused" });
    await expect.element(page.getByText(/relay server refused this device/)).toBeInTheDocument();
  });

  test("a relay behind Cloudflare's proxy is explained while the call is still connecting", async () => {
    renderOverlay({ phase: "connecting", peer, relayCheck: "proxied" });
    await expect.element(page.getByText(/behind Cloudflare's proxy/)).toBeInTheDocument();
  });

  test("a relay that answers, or one still being tried, adds no warning", async () => {
    renderOverlay({ phase: "connecting", peer, relayCheck: "ok" });
    await expect.element(page.getByText("Connecting…")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("relay server yet");
  });

  test("a call that could not connect offers its technical details", async () => {
    renderOverlay({
      phase: "ended",
      endReason: "connect_failed_relay_unreachable",
      peer,
      connectionDetails: ["Relay candidates: 0", "turn:relay.example:3478?transport=tcp: error 701 Cannot connect"],
    });
    await page.getByText("Technical details").click();
    await expect.element(page.getByText("Relay candidates: 0")).toBeVisible();
    await expect.element(page.getByText(/error 701 Cannot connect/)).toBeVisible();
  });

  test("the technical details can be copied as one report", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderOverlay({
      phase: "ended",
      endReason: "connect_failed_relay_unreachable",
      peer,
      connectionDetails: ["Relay candidates: 0", "Role: caller"],
    });
    await page.getByText("Technical details").click();
    await page.getByRole("button", { name: "Copy report" }).click();
    expect(writeText).toHaveBeenCalledTimes(1);
    const text = writeText.mock.calls[0][0];
    expect(text).toContain("Aurelle call report");
    expect(text).toContain("Result: connect_failed_relay_unreachable");
    expect(text).toContain("Relay candidates: 0\nRole: caller");
    await expect.element(page.getByRole("button", { name: "Copied" })).toBeVisible();
  });

  describe("swapping the two pictures", () => {
    const videoCall = (extra = {}) => ({
      phase: "connected", kind: "video", peer, cameraOn: true, remoteCameraOn: true, connectedAt: Date.now(), ...extra,
    });
    const slot = (who) => document.querySelector(`video[data-view="${who}"]`)?.dataset.slot;

    test("the other person fills the screen and you are the small picture", async () => {
      renderOverlay(videoCall());
      await expect.element(page.getByRole("button", { name: "Show your picture full screen" })).toBeInTheDocument();
      expect(slot("remote")).toBe("main");
      expect(slot("local")).toBe("tile");
    });

    test("tapping your own picture swaps the two, and tapping again swaps back", async () => {
      renderOverlay(videoCall());
      await page.getByRole("button", { name: "Show your picture full screen" }).click();
      expect(slot("remote")).toBe("tile");
      expect(slot("local")).toBe("main");
      await page.getByRole("button", { name: "Show their picture full screen" }).click();
      expect(slot("remote")).toBe("main");
      expect(slot("local")).toBe("tile");
    });

    test("with their camera off the small picture says so after a swap", async () => {
      renderOverlay(videoCall({ remoteCameraOn: false }));
      expect(document.querySelector('video[data-view="remote"]')).toBeNull();
      await page.getByRole("button", { name: "Show your picture full screen" }).click();
      expect(slot("local")).toBe("main");
      await expect.element(page.getByRole("img", { name: "Their camera is off" })).toBeInTheDocument();
    });

    test("with your own camera off there is nothing to swap", async () => {
      renderOverlay(videoCall({ cameraOn: false }));
      await expect.element(page.getByRole("img", { name: "Your camera is off" })).toBeInTheDocument();
      expect(page.getByRole("button", { name: /full screen/ }).elements()).toHaveLength(0);
      expect(document.querySelector("video[data-view='local']")).toBeNull();
    });

    test("while the call is still being set up there is nothing to swap, only your own small picture", async () => {
      renderOverlay(videoCall({ phase: "outgoing", remoteCameraOn: false, connectedAt: null }));
      await expect.element(page.getByRole("dialog")).toBeInTheDocument();
      expect(slot("local")).toBe("tile");
      expect(page.getByRole("button", { name: /full screen/ }).elements()).toHaveLength(0);
    });

    test("the swap is still there after the call was minimised and opened again", async () => {
      const value = withCalls(videoCall());
      const ui = (v) => (
        <CallContext.Provider value={v}>
          <CallOverlay user={{ id: "u-alice", username: "alice" }} />
        </CallContext.Provider>
      );
      const { rerender } = await render(ui(value));
      await page.getByRole("button", { name: "Show your picture full screen" }).click();
      expect(slot("local")).toBe("main");
      await rerender(ui({ ...value, minimized: true }));
      expect(document.querySelector("video")).toBeNull();
      await rerender(ui({ ...value, minimized: false }));
      expect(slot("local")).toBe("main");
      expect(slot("remote")).toBe("tile");
    });

    test("the swap is forgotten once your own camera is turned off", async () => {
      const value = withCalls(videoCall());
      const ui = (v) => (
        <CallContext.Provider value={v}>
          <CallOverlay user={{ id: "u-alice", username: "alice" }} />
        </CallContext.Provider>
      );
      const { rerender } = await render(ui(value));
      await page.getByRole("button", { name: "Show your picture full screen" }).click();
      await rerender(ui({ ...value, state: { ...value.state, cameraOn: false } }));
      expect(slot("remote")).toBe("main");
      await rerender(ui({ ...value, state: { ...value.state, cameraOn: true } }));
      expect(slot("remote")).toBe("main");
      expect(slot("local")).toBe("tile");
    });
  });

  describe("call settings", () => {
    const connected = (extra = {}) => ({
      phase: "connected", kind: "audio", peer, connectedAt: Date.now(), microphoneId: "default", ...extra,
    });
    const device = (kind, deviceId, label) => ({ kind, deviceId, label });
    const withDevices = (list) => {
      Object.defineProperty(navigator.mediaDevices, "enumerateDevices", { value: async () => list, configurable: true });
    };

    test("a computer with one microphone and no choice of speaker has no settings button for a voice call", async () => {
      withDevices([device("audioinput", "default", "Microphone"), device("audiooutput", "default", "Speakers")]);
      renderOverlay(connected());
      await expect.element(page.getByRole("button", { name: "Mute microphone" })).toBeInTheDocument();
      expect(document.querySelector('[aria-label="Call settings"]')).toBeNull();
      expect(document.body.textContent).not.toContain("Switch to");
      expect(page.getByRole("button", { name: "Call settings" }).elements()).toHaveLength(0);
    });

    test("with several microphones the settings list them and a click switches the call to that one", async () => {
      withDevices([
        device("audioinput", "default", "Default - Built-in"),
        device("audioinput", "usb", "USB Headset"),
      ]);
      const value = renderOverlay(connected(), { setMicrophone: vi.fn(async () => true) });
      await page.getByRole("button", { name: "Call settings" }).click();
      await expect.element(page.getByRole("radiogroup", { name: "Microphone" })).toBeInTheDocument();
      await expect.element(page.getByRole("radio", { name: "Default - Built-in" })).toHaveAttribute("aria-checked", "true");
      await page.getByRole("radio", { name: "USB Headset" }).click();
      expect(value.setMicrophone).toHaveBeenCalledWith("usb");
    });

    test("on a phone the routes are listed and a quick button flips between speaker and earpiece", async () => {
      withDevices([
        device("audioinput", "default", "Default"),
        device("audioinput", "r-spk", "Speakerphone"),
        device("audioinput", "r-ear", "Headset earpiece"),
      ]);
      const value = renderOverlay(connected({ microphoneId: "r-spk" }), { setMicrophone: vi.fn(async () => true) });
      // The speaker is on: the button offers the earpiece.
      const quick = page.getByRole("button", { name: "Switch to phone earpiece" });
      await expect.element(quick).toHaveAttribute("aria-pressed", "true");
      await quick.click();
      expect(value.setMicrophone).toHaveBeenCalledWith("r-ear");

      await page.getByRole("button", { name: "Call settings" }).click();
      await expect.element(page.getByRole("radiogroup", { name: "Sound" })).toBeInTheDocument();
      await expect.element(page.getByRole("radio", { name: "Speaker" })).toHaveAttribute("aria-checked", "true");
      await page.getByRole("radio", { name: "Phone earpiece" }).click();
      expect(value.setMicrophone).toHaveBeenLastCalledWith("r-ear");
    });

    test("on the earpiece the quick button goes back to the speaker", async () => {
      withDevices([
        device("audioinput", "default", "Default"),
        device("audioinput", "r-spk", "Speakerphone"),
        device("audioinput", "r-ear", "Headset earpiece"),
      ]);
      const value = renderOverlay(connected({ microphoneId: "r-ear" }), { setMicrophone: vi.fn(async () => true) });
      const quick = page.getByRole("button", { name: "Switch to speaker" });
      await expect.element(quick).not.toHaveAttribute("aria-pressed", "true");
      await quick.click();
      expect(value.setMicrophone).toHaveBeenCalledWith("r-spk");
    });

    test("a video call has a quality slider with Auto on top, and the picture that arrives is shown", async () => {
      withDevices([device("audioinput", "default", "Microphone")]);
      const value = renderOverlay(
        connected({ kind: "video", cameraOn: true, remoteCameraOn: true, quality: "auto", videoStats: { width: 1280, height: 720, fps: 30 } }),
        { setQuality: vi.fn() },
      );
      await page.getByRole("button", { name: "Call settings" }).click();
      const auto = page.getByRole("switch", { name: /Auto/ });
      await expect.element(auto).toHaveAttribute("aria-checked", "true");
      // Auto is on: the slider waits.
      await expect.element(page.getByRole("slider", { name: "Video quality" })).toBeDisabled();
      await expect.element(page.getByText("Receiving 1280×720 · 30 fps")).toBeInTheDocument();
      // Turning Auto off lets the person pick a level; it starts at a good one.
      await auto.click();
      expect(value.setQuality).toHaveBeenLastCalledWith("hd");
    });

    test("with a fixed level the slider shows it, moves through the levels and Auto can be switched back on", async () => {
      withDevices([device("audioinput", "default", "Microphone")]);
      const value = renderOverlay(
        connected({ kind: "video", cameraOn: true, remoteCameraOn: true, quality: "high" }),
        { setQuality: vi.fn() },
      );
      await page.getByRole("button", { name: "Call settings" }).click();
      const slider = page.getByRole("slider", { name: "Video quality" });
      await expect.element(slider).toBeEnabled();
      await expect.element(slider).toHaveAttribute("aria-valuetext", "480p");
      await expect.element(page.getByRole("switch", { name: /Auto/ })).toHaveAttribute("aria-checked", "false");
      await slider.fill("4");
      expect(value.setQuality).toHaveBeenLastCalledWith("fhd");
      await slider.fill("0");
      expect(value.setQuality).toHaveBeenLastCalledWith("low");
      await page.getByRole("switch", { name: /Auto/ }).click();
      expect(value.setQuality).toHaveBeenLastCalledWith("auto");
    });

    test("the levels are named under the slider", async () => {
      withDevices([device("audioinput", "default", "Microphone")]);
      renderOverlay(connected({ kind: "video", cameraOn: true, remoteCameraOn: true, quality: "hd" }));
      await page.getByRole("button", { name: "Call settings" }).click();
      for (const label of ["240p", "360p", "480p", "720p", "1080p"]) {
        await expect.element(page.getByText(label, { exact: true }).first()).toBeInTheDocument();
      }
    });

    test("a video call can choose how the picture sits on the screen", async () => {
      withDevices([device("audioinput", "default", "Microphone")]);
      renderOverlay(connected({ kind: "video", cameraOn: true, remoteCameraOn: true, quality: "auto" }));
      const mainFit = () => document.querySelector('video[data-slot="main"]')?.dataset.fit;
      await page.getByRole("button", { name: "Call settings" }).click();
      await expect.element(page.getByRole("radiogroup", { name: "Picture" })).toBeInTheDocument();
      await page.getByRole("radio", { name: /Show the whole picture/ }).click();
      expect(mainFit()).toBe("contain");
      await page.getByRole("radio", { name: /Fill the screen/ }).click();
      expect(mainFit()).toBe("cover");
      expect(localStorage.getItem("aurelle-call-fit")).toBe("fill");
    });

    test("the settings close with Escape, and leave the call on screen", async () => {
      withDevices([device("audioinput", "default", "Microphone")]);
      renderOverlay(connected({ kind: "video", cameraOn: true, remoteCameraOn: true, quality: "auto" }));
      await page.getByRole("button", { name: "Call settings" }).click();
      await expect.element(page.getByRole("group", { name: "Call settings" })).toBeInTheDocument();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await expect.poll(() => document.querySelector('[role="group"][aria-label="Call settings"]')).toBeNull();
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    });

    test("Escape pressed in a window on top of the call is left to that window", async () => {
      withDevices([device("audioinput", "default", "Microphone")]);
      renderOverlay(connected({ kind: "video", cameraOn: true, remoteCameraOn: true, quality: "auto" }));
      await page.getByRole("button", { name: "Call settings" }).click();
      const other = document.createElement("div");
      document.body.appendChild(other);
      const seen = vi.fn();
      window.addEventListener("keydown", seen);
      try {
        other.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        expect(seen).toHaveBeenCalled();
        expect(document.querySelector('[role="group"][aria-label="Call settings"]')).not.toBeNull();
      } finally {
        window.removeEventListener("keydown", seen);
        other.remove();
      }
    });

    test("the settings button says whether the settings are open", async () => {
      withDevices([device("audioinput", "default", "Microphone")]);
      renderOverlay(connected({ kind: "video", cameraOn: true, remoteCameraOn: true, quality: "auto" }));
      const button = page.getByRole("button", { name: "Call settings", expanded: false });
      await button.click();
      await expect.element(page.getByRole("button", { name: "Call settings", expanded: true })).toBeInTheDocument();
    });

    test("a microphone that could not be opened is explained", async () => {
      withDevices([device("audioinput", "default", "A"), device("audioinput", "b", "B")]);
      renderOverlay(connected({ audioDeviceError: "no_device" }));
      await page.getByRole("button", { name: "Call settings" }).click();
      await expect.element(page.getByText("That microphone is not available any more.")).toBeInTheDocument();
    });
  });

  describe("tapping the picture hides the details", () => {
    const videoCall = (extra = {}) => ({
      phase: "connected", kind: "video", peer, cameraOn: true, remoteCameraOn: true, connectedAt: Date.now(), trust: { status: "ok" }, ...extra,
    });
    const hidden = (what) => document.querySelector(`[data-chrome="${what}"]`)?.hasAttribute("inert");
    // A tap on the picture itself (not on a button): the click lands on the dialog.
    const tapPicture = () => document.querySelector('[role="dialog"]').click();

    test("a tap on the picture hides the name, the encryption chip and the buttons, and another brings them back", async () => {
      renderOverlay(videoCall());
      await expect.element(page.getByRole("dialog")).toBeInTheDocument();
      expect(hidden("header")).toBe(false);
      tapPicture();
      await expect.poll(() => hidden("header")).toBe(true);
      expect(hidden("status")).toBe(true);
      expect(hidden("controls")).toBe(true);
      // The small picture of yourself stays, so a tap on it still swaps.
      await expect.element(page.getByRole("button", { name: "Show your picture full screen" })).toBeInTheDocument();
      tapPicture();
      await expect.poll(() => hidden("header")).toBe(false);
      expect(hidden("controls")).toBe(false);
    });

    test("with a mouse the details show when it moves and hide when it rests: a click does not hide them", async () => {
      renderOverlay(videoCall(), undefined, { autoHideMs: 100 });
      const dialog = document.querySelector('[role="dialog"]') || (await expect.element(page.getByRole("dialog")).toBeInTheDocument(), document.querySelector('[role="dialog"]'));
      await expect.poll(() => hidden("controls")).toBe(true); // rested: hidden
      dialog.dispatchEvent(new PointerEvent("pointermove", { pointerType: "mouse", bubbles: true }));
      await expect.poll(() => hidden("controls")).toBe(false);
      // A mouse press and click on the picture right after the move: still showing.
      dialog.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "mouse", bubbles: true }));
      dialog.click();
      await new Promise((r) => setTimeout(r, 30));
      expect(hidden("controls")).toBe(false);
    });

    test("a tap on a button does its job and does not hide anything", async () => {
      const value = renderOverlay(videoCall());
      await page.getByRole("button", { name: "Mute microphone" }).click();
      expect(hidden("controls")).toBe(false);
      expect(value.setMuted).toHaveBeenCalled();
    });

    test("they hide by themselves after a few seconds without a touch, and a key press shows them again", async () => {
      renderOverlay(videoCall(), undefined, { autoHideMs: 150 });
      await expect.poll(() => hidden("controls")).toBe(true);
      document.querySelector('[role="dialog"]').dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", bubbles: true }));
      await expect.poll(() => hidden("controls")).toBe(false);
    });

    test("a voice call keeps its details on screen", async () => {
      renderOverlay({ phase: "connected", kind: "audio", peer, connectedAt: Date.now() }, undefined, { autoHideMs: 100 });
      await new Promise((r) => setTimeout(r, 400));
      tapPicture();
      expect(hidden("header")).toBe(false);
      expect(hidden("controls")).toBe(false);
    });

    test("they stay while a warning about a new device is on screen, and while the settings are open", async () => {
      renderOverlay(videoCall({ trust: { status: "devices_added", verified: false, added: ["d"] } }), undefined, { autoHideMs: 100 });
      await new Promise((r) => setTimeout(r, 400));
      expect(hidden("header")).toBe(false);
      expect(hidden("controls")).toBe(false);
    });

    const press = (el) => {
      el.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "touch", bubbles: true }));
      el.click();
    };

    test("a tap outside the open settings closes them and does not hide the details", async () => {
      renderOverlay(videoCall({ quality: "auto" }));
      await page.getByRole("button", { name: "Call settings" }).click();
      const menu = document.querySelector('[role="group"][aria-label="Call settings"]');
      press(menu.previousElementSibling); // the layer behind the menu
      await expect.poll(() => document.querySelector('[role="group"][aria-label="Call settings"]')).toBeNull();
      expect(hidden("controls")).toBe(false);
      expect(hidden("header")).toBe(false);
    });

    test("a tap on plain text inside the settings does not hide the details behind them", async () => {
      renderOverlay(videoCall({ quality: "auto" }));
      await page.getByRole("button", { name: "Call settings" }).click();
      const menu = document.querySelector('[role="group"][aria-label="Call settings"]');
      press(menu.querySelector("p"));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await expect.poll(() => document.querySelector('[role="group"][aria-label="Call settings"]')).toBeNull();
      expect(hidden("controls")).toBe(false);
    });

    test("with no picture on the screen the details stay, so there is something to read", async () => {
      renderOverlay(videoCall({ remoteCameraOn: false }), undefined, { autoHideMs: 100 });
      await new Promise((r) => setTimeout(r, 400));
      expect(hidden("header")).toBe(false);
      expect(hidden("controls")).toBe(false);
      await expect.element(page.getByText("Camera off")).toBeVisible();
    });

    test("while a button has keyboard focus the details stay, and they go once it lets go", async () => {
      renderOverlay(videoCall(), undefined, { autoHideMs: 120 });
      await expect.element(page.getByRole("dialog")).toBeInTheDocument();
      await userEvent.tab();
      const focused = document.activeElement;
      expect(document.querySelector('[role="dialog"]').contains(focused)).toBe(true);
      await new Promise((r) => setTimeout(r, 500));
      expect(hidden("controls")).toBe(false);
      focused.blur();
      await expect.poll(() => hidden("controls")).toBe(true);
    });

    test("when they hide the keyboard still reaches the call: a key brings them back", async () => {
      renderOverlay(videoCall(), undefined, { autoHideMs: 100 });
      await expect.poll(() => hidden("controls")).toBe(true);
      // Nothing has focus any more (the hidden buttons are inert): the key goes to the page.
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
      await expect.poll(() => hidden("controls")).toBe(false);
    });

    test("a call that has ended always shows its card", async () => {
      renderOverlay({ phase: "ended", kind: "video", endReason: "hangup", peer });
      await expect.element(page.getByRole("dialog")).toBeInTheDocument();
      tapPicture();
      expect(hidden("header")).toBe(false);
    });
  });

  test("a call that ended normally has no technical details", async () => {
    renderOverlay({ phase: "ended", endReason: "hangup", peer, connectionDetails: null });
    await expect.element(page.getByText("Call ended")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("Technical details");
  });

  test("a connection that is not slow says nothing extra", async () => {
    renderOverlay({ phase: "connecting", peer, connectingSlow: false });
    await expect.element(page.getByText("Connecting…")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("Still connecting");
  });

  test("the hint disappears with the connecting phase even if the flag is stale", async () => {
    renderOverlay({ phase: "connected", peer, connectingSlow: true, connectedAt: Date.now() });
    expect(document.body.textContent).not.toContain("Still connecting");
  });

  test("a blocked or missing camera is explained", async () => {
    renderOverlay({ phase: "connected", kind: "video", peer, cameraBlocked: "permission_denied", connectedAt: Date.now() });
    await expect.element(page.getByText(/Camera access is blocked, so you are not sending video/)).toBeInTheDocument();
  });

  test("an outgoing call shows ringing and can be cancelled", async () => {
    const value = renderOverlay({ phase: "outgoing", ringing: true, peer });
    await expect.element(page.getByText("Ringing…")).toBeInTheDocument();
    await page.getByRole("button", { name: "Cancel call" }).click();
    expect(value.hangup).toHaveBeenCalled();
  });

  test("a connected call shows the encryption badge, the emoji code and the controls", async () => {
    const value = renderOverlay({
      phase: "connected",
      peer,
      connectedAt: Date.now() - 65_000,
      sas: ["🌲", "🌴", "🌷", "🌺"],
    });
    await expect.element(page.getByText("01:0", { exact: false })).toBeInTheDocument();
    await expect.element(page.getByText("Encrypted")).toBeInTheDocument();
    await expect.element(page.getByText("🌲🌴🌷🌺")).toBeInTheDocument();
    await page.getByRole("button", { name: "Mute microphone" }).click();
    expect(value.setMuted).toHaveBeenCalledWith(true);
    await page.getByRole("button", { name: "End call" }).click();
    expect(value.hangup).toHaveBeenCalled();
  });

  test("video calls offer a camera toggle; audio calls do not", async () => {
    const value = renderOverlay({ phase: "connected", kind: "video", cameraOn: true, peer, connectedAt: Date.now() });
    await page.getByRole("button", { name: "Turn camera off" }).click();
    expect(value.setCameraEnabled).toHaveBeenCalledWith(false);
  });

  test("audio calls have no camera button", async () => {
    renderOverlay({ phase: "connected", kind: "audio", peer, connectedAt: Date.now() });
    expect(document.querySelector('button[aria-label^="Turn camera"]')).toBeNull();
  });

  test("a muted peer and a poor connection are explained", async () => {
    renderOverlay({ phase: "connected", kind: "video", peer, connectedAt: Date.now(), remoteMuted: true, networkPaused: true });
    await expect.element(page.getByText("Bob is muted")).toBeInTheDocument();
    await expect.element(page.getByText(/Video paused to keep the call going/)).toBeInTheDocument();
  });

  test.each([
    ["declined", "Call declined"],
    ["busy", "User is busy"],
    ["busy_self", "You are already in a call"],
    ["connect_failed", "Couldn't connect. Check your network and try again."],
    ["connect_failed_no_relay", "Couldn't connect. This server has no relay (TURN) set up, which calls between different networks need."],
    ["connect_failed_relay_unreachable", "Couldn't reach this server's relay. If you use a VPN or proxy, it must allow connections to the server."],
    ["connect_failed_relay_refused", "This server's relay refused this device. Ask whoever runs the server to check the relay settings."],
    ["connect_failed_relay_proxied", "This server's relay is behind Cloudflare's proxy, which cannot carry calls. Ask whoever runs the server to set its DNS record to “DNS only”."],
    ["connection_lost", "Connection lost"],
    ["clock_skew", "This device's clock looks wrong. Check the date and time."],
    ["relay_unavailable", "This server only allows relayed calls, but no relay is set up."],
    ["no_answer", "No answer"],
    ["handshake_failed", "Security check failed. The call was blocked."],
    ["key_mismatch", "This contact's security keys changed (a new device). The call was blocked."],
    ["permission_denied", "Microphone or camera access was blocked"],
  ])("explains why a call ended: %s", async (reason, text) => {
    renderOverlay({ phase: "ended", endReason: reason, peer });
    await expect.element(page.getByText(text)).toBeInTheDocument();
  });

  test("the card of an ended call can be closed right away", async () => {
    const value = renderOverlay({ phase: "ended", endReason: "connect_failed_no_relay", peer });
    await page.getByRole("button", { name: "Close" }).click();
    expect(value.dismiss).toHaveBeenCalledTimes(1);
  });

  test("a call that fails while minimised opens up so the reason can be read", async () => {
    const value = renderOverlay(
      { phase: "ended", endReason: "connect_failed_no_relay", peer },
      { minimized: true },
    );
    await vi.waitFor(() => expect(value.setMinimized).toHaveBeenCalledWith(false));
  });

  test("a normal hang-up while minimised leaves the pill alone", async () => {
    const value = renderOverlay({ phase: "ended", endReason: "hangup", peer }, { minimized: true });
    await expect.element(page.getByText("Call ended")).toBeInTheDocument();
    expect(value.setMinimized).not.toHaveBeenCalled();
  });

  test("the pill shortens a long status instead of squeezing its name and buttons", async () => {
    renderOverlay({ phase: "connecting", peer }, { minimized: true });
    await expect.element(page.getByText("Connecting…")).toBeInTheDocument();
    // (no stylesheet is loaded in these tests, so the classes are what can be checked)
    const status = [...document.querySelectorAll('[role="status"] span')].find((el) => el.textContent === "Connecting…");
    expect(status.className).toContain("truncate");
    expect(status.getAttribute("title")).toBe("Connecting…");
    for (const name of ["Expand call", "End call"]) {
      expect(document.querySelector(`button[aria-label="${name}"]`).className).toContain("shrink-0");
    }
  });

  test("status hints sit in a live region so screen readers announce them", async () => {
    renderOverlay({ phase: "connecting", peer, connectingSlow: true });
    await expect.element(page.getByText(/Still connecting/)).toBeInTheDocument();
    const hint = [...document.querySelectorAll("p")].find((el) => el.textContent.includes("Still connecting"));
    expect(hint.closest('[aria-live="polite"]')).not.toBeNull();
  });

  test("a camera problem is announced too", async () => {
    renderOverlay({ phase: "connected", kind: "video", peer, cameraBlocked: "no_device", connectedAt: Date.now() });
    await expect.element(page.getByText(/No camera was found/)).toBeInTheDocument();
    const blocked = [...document.querySelectorAll("p")].find((el) => el.textContent.includes("No camera was found"));
    expect(blocked.closest('[aria-live="polite"]')).not.toBeNull();
  });

  test("a call that is still going has no Close button", async () => {
    renderOverlay({ phase: "connected", peer, connectedAt: Date.now() });
    expect(document.querySelector('button[aria-label="Close"]')).toBeNull();
  });

  test("minimised calls collapse to a pill that keeps hang-up one tap away", async () => {
    const value = renderOverlay(
      { phase: "connected", peer, connectedAt: Date.now() },
      { minimized: true },
    );
    await expect.element(page.getByText("Bob")).toBeInTheDocument();
    await page.getByRole("button", { name: "Expand call" }).click();
    expect(value.setMinimized).toHaveBeenCalledWith(false);
    await page.getByRole("button", { name: "End call" }).click();
    expect(value.hangup).toHaveBeenCalled();
  });
});

describe("CallButtons", () => {
  const dmPeer = { id: "u-bob", username: "bob", nickname: "Bob", avatar_url: "", color: "#10b981" };
  const renderButtons = (overrides, props = {}) => {
    const value = withCalls({ phase: "idle" }, overrides);
    render(
      <CallContext.Provider value={value}>
        <CallButtons chatId="chat-1" peer={dmPeer} {...props} />
      </CallContext.Provider>,
    );
    return value;
  };

  test("starts a voice or a video call with the peer's details", async () => {
    const value = renderButtons();
    await page.getByRole("button", { name: "Voice call" }).click();
    expect(value.startCall).toHaveBeenCalledWith({
      chatId: "chat-1",
      kind: "audio",
      peer: { userId: "u-bob", username: "bob", nickname: "Bob", avatarUrl: "", color: "#10b981" },
    });
    await page.getByRole("button", { name: "Video call" }).click();
    expect(value.startCall).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "video" }));
  });

  test("is disabled while another call is in progress", async () => {
    renderButtons({ inCall: true });
    await expect.element(page.getByRole("button", { name: "Voice call" })).toBeDisabled();
  });

  test("is hidden when the browser cannot call, or the admin turned calls off", async () => {
    renderButtons({ supported: false });
    expect(document.querySelector('button[aria-label="Voice call"]')).toBeNull();
  });

  test("the safety-number button is there even when calls are not available, and opens the verification screen", async () => {
    renderButtons({ supported: false }, { user: { id: "u-alice", username: "alice" } });
    expect(document.querySelector('button[aria-label="Voice call"]')).toBeNull();
    await page.getByRole("button", { name: "Encryption and safety number" }).click();
    await expect.element(page.getByText("Verify security")).toBeInTheDocument();
  });

  test("is hidden for deleted accounts", async () => {
    renderButtons({}, { peer: { ...dmPeer, isDeleted: true } });
    expect(document.querySelector('button[aria-label="Voice call"]')).toBeNull();
  });

  test("is hidden when the server switched calls off", async () => {
    const previous = CHAT_PAGE_CONFIG.callsEnabled;
    CHAT_PAGE_CONFIG.callsEnabled = false;
    try {
      renderButtons();
      expect(document.querySelector('button[aria-label="Voice call"]')).toBeNull();
    } finally {
      CHAT_PAGE_CONFIG.callsEnabled = previous;
    }
  });
});
