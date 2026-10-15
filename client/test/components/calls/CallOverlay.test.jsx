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
