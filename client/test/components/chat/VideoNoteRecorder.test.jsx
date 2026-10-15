import { describe, test, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import VideoNoteRecorder from "../../../src/components/chat/videoNote/VideoNoteRecorder.jsx";

const original = navigator.mediaDevices?.getUserMedia;

afterEach(() => {
  if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = original;
});

function stubCamera(impl) {
  Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: impl, configurable: true, writable: true });
}

describe("VideoNoteRecorder", () => {
  test("explains when camera access is blocked, and nothing is recorded", async () => {
    const getUserMedia = vi.fn().mockRejectedValue(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
    stubCamera(getUserMedia);
    const onSend = vi.fn();
    render(<VideoNoteRecorder open onClose={() => {}} onSend={onSend} />);
    await expect.element(page.getByText(/Camera or microphone access was blocked/)).toBeInTheDocument();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });

  test("asks for a small square video and mono voice, not the camera's maximum", async () => {
    const getUserMedia = vi.fn().mockRejectedValue(Object.assign(new Error("none"), { name: "NotFoundError" }));
    stubCamera(getUserMedia);
    render(<VideoNoteRecorder open onClose={() => {}} onSend={() => {}} />);
    await expect.element(page.getByText(/No camera or microphone was found/)).toBeInTheDocument();
    const constraints = getUserMedia.mock.calls[0][0];
    expect(constraints.video.width.ideal).toBeLessThanOrEqual(480);
    expect(constraints.video.aspectRatio.ideal).toBe(1);
    expect(constraints.video.frameRate.max).toBeLessThanOrEqual(30);
    expect(constraints.audio.channelCount).toBe(1);
  });

  test("states that the message is end-to-end encrypted and can be closed", async () => {
    stubCamera(vi.fn().mockRejectedValue(Object.assign(new Error("x"), { name: "NotAllowedError" })));
    const onClose = vi.fn();
    render(<VideoNoteRecorder open onClose={onClose} onSend={() => {}} />);
    await expect.element(page.getByText("End-to-end encrypted")).toBeInTheDocument();
    await page.getByRole("button", { name: "Close" }).click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("does not touch the camera while closed", async () => {
    const getUserMedia = vi.fn();
    stubCamera(getUserMedia);
    render(<VideoNoteRecorder open={false} onClose={() => {}} onSend={() => {}} />);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
