import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "vitest-browser-react";
import { act } from "react";
import { RECORDER_PHASE, useVideoNoteRecorder } from "../../../src/videoNote/useVideoNoteRecorder.js";

const originalRecorder = globalThis.MediaRecorder;
const originalGetUserMedia = navigator.mediaDevices?.getUserMedia;

class FakeTrack {
  constructor(kind) {
    this.kind = kind;
    this.stopped = false;
    this.onended = null;
  }
  stop() {
    this.stopped = true;
  }
}
const makeStream = () => {
  const tracks = [new FakeTrack("video"), new FakeTrack("audio")];
  return { tracks, getTracks: () => tracks };
};

let recorders;
class FakeRecorder {
  static isTypeSupported = () => true;
  constructor(stream) {
    this.stream = stream;
    this.state = "inactive";
    this.mimeType = "video/webm";
    recorders.push(this);
  }
  start() {
    this.state = "recording";
  }
  stop() {
    if (this.state === "inactive") throw new DOMException("not recording", "InvalidStateError");
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob([new Uint8Array(4000)]) });
    queueMicrotask(() => this.onstop?.());
  }
}

let getUserMedia;
let streams;
beforeEach(() => {
  recorders = [];
  streams = [];
  globalThis.MediaRecorder = FakeRecorder;
  getUserMedia = vi.fn(async () => {
    const stream = makeStream();
    streams.push(stream);
    return stream;
  });
  Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: getUserMedia, configurable: true, writable: true });
});
afterEach(() => {
  globalThis.MediaRecorder = originalRecorder;
  Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: originalGetUserMedia, configurable: true, writable: true });
});

const waitUntil = async (predicate, label) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 4000) throw new Error(`Timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openRecorder() {
  const view = await renderHook(() => useVideoNoteRecorder({ open: true, videoElementRef: { current: null } }));
  await waitUntil(() => view.result.current.phase === RECORDER_PHASE.PREVIEW, "camera preview");
  return view;
}

// The options the composer's record button uses: a press-and-hold has no separate
// "record" step, a short clip is dropped, and the owner hears about clips and failures.
const open = (options = {}) =>
  renderHook(() => useVideoNoteRecorder({ open: true, videoElementRef: { current: null }, autoStart: true, ...options }));

describe("useVideoNoteRecorder", () => {
  test("when the camera is taken away mid-recording, what was captured is kept", async () => {
    const view = await openRecorder();
    await act(async () => view.result.current.startRecording());
    await sleep(900); // long enough to be a real clip
    await act(async () => {
      streams[0].tracks[0].onended?.(); // another app grabbed the camera
    });
    await waitUntil(() => view.result.current.phase === RECORDER_PHASE.REVIEW, "review after interruption");
    expect(view.result.current.result.blob.size).toBeGreaterThan(0);
    expect(view.result.current.error).toMatch(/interrupted/i);
    expect(streams[0].tracks.every((t) => t.stopped)).toBe(true);
  });

  test("handing the clip over keeps its preview alive when the recorder closes", async () => {
    const view = await openRecorder();
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    await act(async () => view.result.current.startRecording());
    await sleep(900);
    await act(async () => view.result.current.stopRecording());
    await waitUntil(() => view.result.current.phase === RECORDER_PHASE.REVIEW, "review");
    const url = view.result.current.result.previewUrl;

    // Delivered: ownership moves to the caller, closing must not revoke the URL.
    await act(async () => view.result.current.handOver());
    view.unmount();
    expect(revoke).not.toHaveBeenCalledWith(url);
    revoke.mockRestore();
    URL.revokeObjectURL(url);
  });

  test("a clip that was not handed over is released when the recorder closes", async () => {
    const view = await openRecorder();
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    await act(async () => view.result.current.startRecording());
    await sleep(900);
    await act(async () => view.result.current.stopRecording());
    await waitUntil(() => view.result.current.phase === RECORDER_PHASE.REVIEW, "review");
    const url = view.result.current.result.previewUrl;
    view.unmount();
    expect(revoke).toHaveBeenCalledWith(url);
    revoke.mockRestore();
  });
});

describe("useVideoNoteRecorder: recording for a press-and-hold", () => {
  test("starts recording by itself as soon as the camera is ready", async () => {
    const view = await open();
    await waitUntil(() => view.result.current.phase === RECORDER_PHASE.RECORDING, "recording");
    expect(recorders).toHaveLength(1);
    expect(recorders[0].state).toBe("recording");
    expect(view.result.current.getPhase()).toBe(RECORDER_PHASE.RECORDING);
  });

  test("the rear camera can be asked for first", async () => {
    await open({ initialFacing: "environment" });
    await waitUntil(() => getUserMedia.mock.calls.length === 1, "camera request");
    expect(getUserMedia.mock.calls[0][0].video.facingMode).toBe("environment");
  });

  test("a clip that is too short is dropped and reported, and the camera is not put back", async () => {
    const onShort = vi.fn();
    const onClip = vi.fn();
    const view = await open({ onShort, onClip });
    await waitUntil(() => view.result.current.phase === RECORDER_PHASE.RECORDING, "recording");
    await act(async () => view.result.current.stopRecording());
    await waitUntil(() => onShort.mock.calls.length === 1, "short clip reported");
    expect(onClip).not.toHaveBeenCalled();
    expect(view.result.current.phase).toBe(RECORDER_PHASE.IDLE);
    expect(view.result.current.result).toBeNull();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(streams[0].tracks.every((t) => t.stopped)).toBe(true);
  });

  test("a finished clip is handed to the owner with why it ended", async () => {
    const onClip = vi.fn();
    const view = await open({ onClip });
    await waitUntil(() => view.result.current.phase === RECORDER_PHASE.RECORDING, "recording");
    await sleep(900);
    await act(async () => view.result.current.stopRecording());
    await waitUntil(() => onClip.mock.calls.length === 1, "clip");
    const [clip, reason] = onClip.mock.calls[0];
    expect(reason).toBe("user");
    expect(clip.blob.size).toBeGreaterThan(0);
    expect(clip.durationMs).toBeGreaterThanOrEqual(800);
    expect(view.result.current.result).toBe(clip);
    expect(streams[0].tracks.every((t) => t.stopped)).toBe(true);
  });

  test("a camera taken away mid-recording ends it with the reason 'lost' and keeps the clip", async () => {
    const onClip = vi.fn();
    const view = await open({ onClip });
    await waitUntil(() => view.result.current.phase === RECORDER_PHASE.RECORDING, "recording");
    await sleep(900);
    await act(async () => {
      streams[0].tracks[0].onended?.();
    });
    await waitUntil(() => onClip.mock.calls.length === 1, "clip");
    expect(onClip.mock.calls[0][1]).toBe("lost");
  });

  test("a camera that cannot be opened is reported with the reason", async () => {
    getUserMedia.mockRejectedValueOnce(Object.assign(new Error("no"), { name: "NotAllowedError" }));
    const onFail = vi.fn();
    const view = await open({ onFail });
    await waitUntil(() => onFail.mock.calls.length === 1, "failure");
    expect(onFail.mock.calls[0][0]).toMatch(/blocked/i);
    expect(view.result.current.phase).toBe(RECORDER_PHASE.ERROR);
  });

  test("switching camera while recording starts over on the other one and sends nothing", async () => {
    const onClip = vi.fn();
    const view = await open({ onClip });
    await waitUntil(() => view.result.current.phase === RECORDER_PHASE.RECORDING, "recording");
    expect(view.result.current.facing).toBe("user");
    await act(async () => view.result.current.switchCamera());
    await waitUntil(
      () => getUserMedia.mock.calls.length === 2 && view.result.current.phase === RECORDER_PHASE.RECORDING,
      "recording on the other camera",
    );
    expect(getUserMedia.mock.calls[1][0].video.facingMode).toBe("environment");
    expect(view.result.current.facing).toBe("environment");
    expect(streams[0].tracks.every((t) => t.stopped)).toBe(true);
    expect(recorders).toHaveLength(2);
    expect(onClip).not.toHaveBeenCalled();
  });

  test("counts the cameras so the flip button is only offered when there is a choice", async () => {
    const enumerateDevices = vi.fn(async () => [
      { kind: "videoinput" },
      { kind: "videoinput" },
      { kind: "audioinput" },
    ]);
    const original = navigator.mediaDevices.enumerateDevices;
    Object.defineProperty(navigator.mediaDevices, "enumerateDevices", { value: enumerateDevices, configurable: true, writable: true });
    try {
      const view = await open();
      await waitUntil(() => view.result.current.cameraCount === 2, "camera count");
    } finally {
      Object.defineProperty(navigator.mediaDevices, "enumerateDevices", { value: original, configurable: true, writable: true });
    }
  });
});

