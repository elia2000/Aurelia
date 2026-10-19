import { useEffect } from "react";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { pointer, sleep, waitUntil } from "./recordTestUtils.js";

// The camera is replaced by a hook the test drives: it records, and the test
// decides when the clip is ready. Everything else is the real recording session
// (gesture, send, refusals) and the real round-camera overlay.
const camera = vi.hoisted(() => ({ options: null, state: null }));
vi.mock("../../../src/videoNote/useVideoNoteRecorder.js", async (importOriginal) => ({
  ...(await importOriginal()),
  useVideoNoteRecorder: (options) => {
    camera.options = options;
    return camera.state;
  },
}));
const e2ee = vi.hoisted(() => ({
  services: {
    api: { listMyDevices: async () => ({ devices: [] }) },
    directory: { getUserDevices: async () => ({ devices: [], assessment: { status: "ok", added: [] } }) },
    trust: { isVerified: async () => false },
  },
}));
vi.mock("../../../src/e2ee/services.js", () => ({ getE2eeServices: () => e2ee.services }));

import VideoNoteRecorder from "../../../src/components/chat/videoNote/VideoNoteRecorder.jsx";
import { useRecordingSession } from "../../../src/hooks/chat/useRecordingSession.js";

const clip = { blob: new Blob([new Uint8Array(2048)]), mime: "video/webm", durationMs: 5000, previewUrl: "blob:clip" };
const self = { id: "u-alice", username: "alice" };

// The session the harness is currently rendering, for the test to look at.
const latest = { session: null };
function Harness({ onSend }) {
  const session = useRecordingSession({ chatId: "chat", onSendVideoNote: onSend, onVoiceReady: vi.fn() });
  useEffect(() => {
    latest.session = session;
  });
  return (
    <div>
      <button type="button" data-testid="record" {...session.recordButtonProps}>
        record
      </button>
      <button type="button" onClick={session.actions.send}>
        Send video message
      </button>
      <button type="button" onClick={session.actions.discard}>
        Delete recording
      </button>
      <output data-testid="phase">{session.phase}</output>
      {session.kind === "video" && session.phase !== "idle" ? (
        <VideoNoteRecorder session={session} chatId="chat" selfUser={self} />
      ) : null}
    </div>
  );
}

const phase = () => document.querySelector("[data-testid='phase']").textContent;

beforeEach(() => {
  localStorage.setItem("aurelle-record-mode", "video");
  camera.state = {
    phase: "recording",
    stream: null,
    elapsedMs: 0,
    facing: "user",
    cameraCount: 1,
    getPhase: () => camera.state.phase,
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    switchCamera: vi.fn(),
    handOver: vi.fn(),
    reset: vi.fn(),
  };
});
afterEach(() => {
  localStorage.removeItem("aurelle-record-mode");
  vi.restoreAllMocks();
});

// Press and hold the record button until the recording starts.
async function hold() {
  const finger = pointer(document.querySelector("[data-testid='record']"), { pointerType: "touch" });
  finger.down();
  await waitUntil(() => phase() === "recording", "recording to start");
  return finger;
}

// Release (which stops the camera) and let the clip arrive, as the recorder does.
async function releaseAndDeliver(finger, reason = "user") {
  finger.up();
  await waitUntil(() => camera.state.stopRecording.mock.calls.length === 1, "camera to be told to stop");
  camera.options.onClip(clip, reason);
}

describe("sending a video message", () => {
  test("releasing the button sends the clip once the camera hands it over, and the recorder closes", async () => {
    const onSend = vi.fn().mockResolvedValue({ ok: true });
    await render(<Harness onSend={onSend} />);
    const finger = await hold();
    await releaseAndDeliver(finger);
    await waitUntil(() => onSend.mock.calls.length === 1, "send");
    expect(onSend).toHaveBeenCalledWith(clip, { acknowledgeChanges: false });
    expect(camera.state.handOver).toHaveBeenCalledTimes(1);
    await waitUntil(() => phase() === "idle", "recorder to close");
    expect(document.querySelector("[data-video-note-recorder]")).toBeNull();
  });

  test("a clip that is too short is dropped with a hint to hold, and nothing is sent", async () => {
    const onSend = vi.fn();
    await render(<Harness onSend={onSend} />);
    const finger = await hold();
    finger.up();
    camera.options.onShort();
    await waitUntil(() => phase() === "idle", "recorder to close");
    expect(onSend).not.toHaveBeenCalled();
    expect(latest.session.hint.text).toMatch(/Hold to record a video message/);
  });

  test("a locked recording is stopped, reviewed and then sent with the Send button", async () => {
    const onSend = vi.fn().mockResolvedValue({ ok: true });
    await render(<Harness onSend={onSend} />);
    const finger = await hold();
    finger.moveBy(0, -90);
    await waitUntil(() => latest.session.locked, "lock");
    finger.up();
    await sleep(500);
    latest.session.actions.stop();
    camera.options.onClip(clip, "user");
    await waitUntil(() => phase() === "preview", "review");
    expect(onSend).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Play preview" }).click();
    await page.getByRole("button", { name: "Send video message" }).click();
    await waitUntil(() => onSend.mock.calls.length === 1, "send");
    expect(onSend).toHaveBeenCalledWith(clip, { acknowledgeChanges: false });
  });

  test("the length limit stops the recording and offers it for review instead of sending it", async () => {
    const onSend = vi.fn();
    await render(<Harness onSend={onSend} />);
    const finger = await hold();
    finger.moveBy(0, -90);
    await waitUntil(() => latest.session.locked, "lock");
    finger.up();
    camera.options.onClip(clip, "limit");
    await waitUntil(() => phase() === "preview", "review");
    expect(onSend).not.toHaveBeenCalled();
    expect(latest.session.hint.text).toMatch(/Maximum length reached/);
  });

  test("sliding left throws the recording away", async () => {
    const onSend = vi.fn();
    await render(<Harness onSend={onSend} />);
    const finger = await hold();
    finger.moveBy(-150, 0);
    await waitUntil(() => phase() === "idle", "cancel");
    finger.up();
    expect(onSend).not.toHaveBeenCalled();
    expect(document.querySelector("[data-video-note-recorder]")).toBeNull();
  });

  test("a camera that fails to open ends the recording with the reason", async () => {
    await render(<Harness onSend={vi.fn()} />);
    const finger = await hold();
    camera.options.onFail("No camera or microphone was found.");
    await waitUntil(() => phase() === "idle", "recorder to close");
    finger.up();
    expect(latest.session.hint).toMatchObject({ text: "No camera or microphone was found.", tone: "error" });
  });
});

describe("a send that is refused", () => {
  async function recordAndRefuse(onSend) {
    await render(<Harness onSend={onSend} />);
    const finger = await hold();
    await releaseAndDeliver(finger);
    await waitUntil(() => onSend.mock.calls.length >= 1 && phase() === "preview", "refusal");
  }

  test("keeps the clip, says why, and can be sent again", async () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const onSend = vi.fn().mockResolvedValueOnce({ ok: false, error: "You appear to be offline." }).mockResolvedValueOnce({ ok: true });
    await recordAndRefuse(onSend);
    await expect.element(page.getByText("You appear to be offline.")).toBeInTheDocument();
    expect(revoke).not.toHaveBeenCalledWith("blob:clip");
    // The recording is still there to send again (once the click that follows
    // the lift of the finger can no longer be mistaken for a press on Send).
    await sleep(500);
    await page.getByRole("button", { name: "Send video message" }).click();
    await waitUntil(() => onSend.mock.calls.length === 2, "second send");
    expect(onSend).toHaveBeenLastCalledWith(clip, { acknowledgeChanges: false });
    await waitUntil(() => phase() === "idle", "recorder to close");
  });

  test("deleting it afterwards lets go of the clip", async () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const onSend = vi.fn().mockResolvedValue({ ok: false, error: "You appear to be offline." });
    await recordAndRefuse(onSend);
    await page.getByRole("button", { name: "Delete recording" }).click();
    await waitUntil(() => phase() === "idle", "recorder to close");
    expect(revoke).toHaveBeenCalledWith("blob:clip");
  });

  test("a contact with a new device can be reviewed or, if never verified, sent to anyway", async () => {
    const onSend = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: "A contact has a new device. Review it before sending.",
        changes: [{ userId: "u-bob", username: "bob", added: ["d2"], verified: false }],
        requiresVerification: false,
      })
      .mockResolvedValueOnce({ ok: true });
    await recordAndRefuse(onSend);
    await expect.element(page.getByText(/has a new device/)).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Review", exact: true })).toBeInTheDocument();
    await page.getByRole("button", { name: "Send anyway" }).click();
    await waitUntil(() => onSend.mock.calls.length === 2, "send anyway");
    expect(onSend).toHaveBeenLastCalledWith(clip, { acknowledgeChanges: true });
    await waitUntil(() => phase() === "idle", "recorder to close");
  });

  test("for a verified contact there is no 'send anyway', only a review", async () => {
    const onSend = vi.fn().mockResolvedValue({
      ok: false,
      error: "A verified contact has a new device. Check their safety number before sending.",
      changes: [{ userId: "u-bob", username: "bob", added: ["d2"], verified: true }],
      requiresVerification: true,
    });
    await recordAndRefuse(onSend);
    await expect.element(page.getByText(/verified contact has a new device/)).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Review", exact: true })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("Send anyway");
    await page.getByRole("button", { name: "Review", exact: true }).click();
    await expect.element(page.getByText("Verify security")).toBeInTheDocument();
  });

  test("a send that throws is reported like a refusal", async () => {
    const onSend = vi.fn().mockRejectedValue(new Error("boom"));
    await recordAndRefuse(onSend);
    await expect.element(page.getByText("The video message could not be sent.")).toBeInTheDocument();
  });
});
