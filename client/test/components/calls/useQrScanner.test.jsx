import { describe, test, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-react";
import { useQrScanner } from "../../../src/components/calls/useQrScanner.js";

function Harness({ active }) {
  const { videoRef, phase } = useQrScanner({ active, onResult: () => {} });
  return (
    <div>
      <video ref={videoRef} />
      <span data-testid="phase">{phase}</span>
    </div>
  );
}

// A camera whose permission prompt stays open until `grant()` is called.
function fakeCamera() {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 48;
  canvas.getContext("2d").fillRect(0, 0, 10, 10);
  const stream = canvas.captureStream(5);
  const track = stream.getVideoTracks()[0];
  const realStop = track.stop.bind(track);
  track.stop = vi.fn(() => realStop());
  let grantCamera = null;
  Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
    configurable: true,
    value: () => new Promise((resolve) => { grantCamera = resolve; }),
  });
  window.BarcodeDetector = class {
    async detect() {
      return [];
    }
  };
  return { track, grant: () => grantCamera(stream), asked: () => typeof grantCamera === "function" };
}

afterEach(() => {
  delete window.BarcodeDetector;
});

describe("useQrScanner camera release", () => {
  test("stopping a running scan releases the camera", async () => {
    const camera = fakeCamera();
    const screen = await render(<Harness active />);
    await vi.waitFor(() => expect(camera.asked()).toBe(true));
    camera.grant();
    await vi.waitFor(() => expect(document.querySelector('[data-testid="phase"]').textContent).toBe("scanning"));
    await screen.rerender(<Harness active={false} />);
    expect(camera.track.stop).toHaveBeenCalledTimes(1);
  });

  test("a camera granted after the scan was stopped is released at once, not left on", async () => {
    const camera = fakeCamera();
    const screen = await render(<Harness active />);
    await vi.waitFor(() => expect(camera.asked()).toBe(true));
    await screen.rerender(<Harness active={false} />); // Stop, Esc or the dialog closing while the prompt is open
    camera.grant();
    await vi.waitFor(() => expect(camera.track.stop).toHaveBeenCalled());
  });
});
