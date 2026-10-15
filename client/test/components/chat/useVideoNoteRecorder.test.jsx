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

describe("useVideoNoteRecorder", () => {
  test("a clip that is too short explains itself and puts the camera back, instead of vanishing", async () => {
    const view = await openRecorder();
    await act(async () => view.result.current.startRecording());
    await act(async () => view.result.current.stopRecording());
    await waitUntil(() => view.result.current.phase === RECORDER_PHASE.PREVIEW && getUserMedia.mock.calls.length === 2, "camera reopened");
    expect(view.result.current.error).toMatch(/too short/i);
    expect(view.result.current.result).toBeNull();
    // The first camera was released when the clip ended.
    expect(streams[0].tracks.every((t) => t.stopped)).toBe(true);
  });

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
