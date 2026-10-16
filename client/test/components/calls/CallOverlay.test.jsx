import { describe, test, expect, vi } from "vitest";
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
import CallButtons from "../../../src/components/calls/CallButtons.jsx";
import { CallContext } from "../../../src/calls/callContext.js";
import { CHAT_PAGE_CONFIG } from "../../../src/settings/chatPageConfig.js";

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

const renderOverlay = (state, overrides) => {
  const value = withCalls(state, overrides);
  render(
    <CallContext.Provider value={value}>
      <CallOverlay user={{ id: "u-alice", username: "alice" }} />
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
