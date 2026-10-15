import { describe, test, expect, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";

const hook = vi.hoisted(() => ({ state: null }));
vi.mock("../../../src/videoNote/useVideoNoteRecorder.js", () => ({
  RECORDER_PHASE: {
    IDLE: "idle", STARTING: "starting", PREVIEW: "preview", RECORDING: "recording", REVIEW: "review", ERROR: "error",
  },
  useVideoNoteRecorder: () => hook.state,
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

const clip = { blob: new Blob([new Uint8Array(2048)]), mime: "video/webm", durationMs: 5000, previewUrl: "blob:clip" };
const self = { id: "u-alice", username: "alice" };

beforeEach(() => {
  hook.state = {
    phase: "review", stream: null, elapsedMs: 5000, result: clip, error: "", facing: "user",
    startRecording: vi.fn(), stopRecording: vi.fn(), retake: vi.fn(), switchCamera: vi.fn(),
    handOver: vi.fn(), reset: vi.fn(),
  };
});

const send = () => page.getByRole("button", { name: "Send video message" }).click();

describe("VideoNoteRecorder sending", () => {
  test("a delivered clip is handed over and the dialog closes", async () => {
    const onSend = vi.fn().mockResolvedValue({ ok: true });
    const onClose = vi.fn();
    render(<VideoNoteRecorder open onClose={onClose} onSend={onSend} selfUser={self} chatId="chat" />);
    await send();
    expect(onSend).toHaveBeenCalledWith(clip, { acknowledgeChanges: false });
    expect(hook.state.handOver).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("a refused send keeps the clip and says why inside the dialog", async () => {
    const onSend = vi.fn().mockResolvedValue({ ok: false, error: "You appear to be offline." });
    const onClose = vi.fn();
    render(<VideoNoteRecorder open onClose={onClose} onSend={onSend} selfUser={self} chatId="chat" />);
    await send();
    await expect.element(page.getByText("You appear to be offline.")).toBeInTheDocument();
    expect(hook.state.handOver).not.toHaveBeenCalled();
    expect(hook.state.retake).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    // The recording is still there to send again.
    await expect.element(page.getByRole("button", { name: "Send video message" })).toBeInTheDocument();
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
    render(<VideoNoteRecorder open onClose={() => {}} onSend={onSend} selfUser={self} chatId="chat" />);
    await send();
    await expect.element(page.getByText(/has a new device/)).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Review", exact: true })).toBeInTheDocument();
    await page.getByRole("button", { name: "Send anyway" }).click();
    expect(onSend).toHaveBeenLastCalledWith(clip, { acknowledgeChanges: true });
    expect(hook.state.handOver).toHaveBeenCalledTimes(1);
  });

  test("for a verified contact there is no 'send anyway', only a review", async () => {
    const onSend = vi.fn().mockResolvedValue({
      ok: false,
      error: "A verified contact has a new device. Check their safety number before sending.",
      changes: [{ userId: "u-bob", username: "bob", added: ["d2"], verified: true }],
      requiresVerification: true,
    });
    render(<VideoNoteRecorder open onClose={() => {}} onSend={onSend} selfUser={self} chatId="chat" />);
    await send();
    await expect.element(page.getByText(/verified contact has a new device/)).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Review", exact: true })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("Send anyway");
    await page.getByRole("button", { name: "Review", exact: true }).click();
    await expect.element(page.getByText("Verify security")).toBeInTheDocument();
  });
});
