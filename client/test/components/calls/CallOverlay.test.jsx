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
