import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  VOICE_MAX_MS,
  VOICE_MIN_MS,
  VOICE_PHASE,
  createVoiceFileFromChunks,
  createVoiceRecorder,
  voiceErrorCode,
} from "../../src/hooks/chat/useVoiceRecorder.js";

// A microphone and a MediaRecorder that do what the browser's do, without a device.

class FakeTrack {
  constructor() {
    this.stopped = false;
    this.onended = null;
  }
  stop() {
    this.stopped = true;
  }
}

let tracks;
let recorders;
class FakeRecorder {
  static isTypeSupported = () => true;
  constructor(stream, options) {
    this.stream = stream;
    this.options = options;
    this.state = "inactive";
    recorders.push(this);
  }
  start() {
    this.state = "recording";
    // The first chunk arrives with the first timeslice.
    this.ondataavailable?.({ data: new Blob([new Uint8Array(2000)], { type: "audio/webm" }) });
  }
  requestData() {}
  stop() {
    if (this.state === "inactive") throw new DOMException("not recording", "InvalidStateError");
    this.state = "inactive";
    this.onstop?.();
  }
}

let getUserMedia;
beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"],
  });
  tracks = [];
  recorders = [];
  getUserMedia = vi.fn(async () => {
    const track = new FakeTrack();
    tracks.push(track);
    return { getTracks: () => [track] };
  });
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("MediaRecorder", FakeRecorder);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("voice recorder: a clip", () => {
  test("held for long enough it becomes a file with its duration", async () => {
    const recorder = createVoiceRecorder();
    expect(await recorder.start()).toEqual({ ok: true });
    expect(recorder.getSnapshot().phase).toBe(VOICE_PHASE.RECORDING);
    await vi.advanceTimersByTimeAsync(2400);
    const result = await recorder.stop();
    expect(result.status).toBe("ok");
    expect(result.durationSeconds).toBe(2);
    expect(result.file.name).toMatch(/^voice-message-\d+\.webm$/);
    expect(result.mimeType).toContain("audio/webm");
    expect(recorder.getSnapshot().phase).toBe(VOICE_PHASE.IDLE);
  });

  test("a clip under the minimum is discarded, not sent as silence", async () => {
    const recorder = createVoiceRecorder();
    await recorder.start();
    await vi.advanceTimersByTimeAsync(VOICE_MIN_MS - 300);
    expect(await recorder.stop()).toEqual({ status: "short" });
  });

  test("the microphone is released as soon as the clip ends", async () => {
    const recorder = createVoiceRecorder();
    await recorder.start();
    await vi.advanceTimersByTimeAsync(1500);
    await recorder.stop();
    expect(tracks.every((track) => track.stopped)).toBe(true);
  });

  test("cancel throws the recording away and lets go of the microphone", async () => {
    const recorder = createVoiceRecorder();
    await recorder.start();
    await vi.advanceTimersByTimeAsync(3000);
    recorder.cancel();
    expect(tracks.every((track) => track.stopped)).toBe(true);
    expect(recorder.getSnapshot().phase).toBe(VOICE_PHASE.IDLE);
    expect(await recorder.stop()).toEqual({ status: "empty" });
  });

  test("a second start while recording is refused", async () => {
    const recorder = createVoiceRecorder();
    await recorder.start();
    expect(await recorder.start()).toEqual({ ok: false, error: "busy" });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  test("the file is a plain File the upload pipeline can read", () => {
    const payload = createVoiceFileFromChunks([new Blob(["x"], { type: "audio/webm" })], 3);
    expect(payload.file).toBeInstanceOf(Blob);
    expect(payload.durationSeconds).toBe(3);
    expect(createVoiceFileFromChunks([], 3)).toBeNull();
  });
});

describe("voice recorder: letting go before the microphone is ready", () => {
  test("releasing while the permission prompt is open drops the microphone that arrives later", async () => {
    let grant;
    getUserMedia.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          grant = () => {
            const track = new FakeTrack();
            tracks.push(track);
            resolve({ getTracks: () => [track] });
          };
        }),
    );
    const recorder = createVoiceRecorder();
    const started = recorder.start();
    expect(recorder.getSnapshot().phase).toBe(VOICE_PHASE.STARTING);
    expect(await recorder.stop()).toEqual({ status: "short" });
    grant();
    expect(await started).toEqual({ ok: false, error: "aborted" });
    expect(tracks.every((track) => track.stopped)).toBe(true);
    expect(recorders).toHaveLength(0);
    expect(recorder.getSnapshot().phase).toBe(VOICE_PHASE.IDLE);
  });
});

describe("voice recorder: errors keep their reason", () => {
  const rejectWith = (name) =>
    getUserMedia.mockRejectedValueOnce(Object.assign(new Error(name), { name }));

  test("a blocked microphone", async () => {
    rejectWith("NotAllowedError");
    const recorder = createVoiceRecorder();
    expect(await recorder.start()).toEqual({ ok: false, error: "permission" });
    expect(recorder.getSnapshot().phase).toBe(VOICE_PHASE.IDLE);
  });

  test("no microphone at all", async () => {
    rejectWith("NotFoundError");
    expect(await createVoiceRecorder().start()).toEqual({ ok: false, error: "no_device" });
  });

  test("a browser without microphone access", async () => {
    vi.stubGlobal("navigator", {});
    expect(await createVoiceRecorder().start()).toEqual({ ok: false, error: "unsupported" });
  });

  test("anything else", async () => {
    rejectWith("AbortError");
    expect(await createVoiceRecorder().start()).toEqual({ ok: false, error: "failed" });
  });

  test("voiceErrorCode maps the browser's error names", () => {
    expect(voiceErrorCode({ name: "SecurityError" })).toBe("permission");
    expect(voiceErrorCode({ name: "OverconstrainedError" })).toBe("no_device");
    expect(voiceErrorCode(null)).toBe("failed");
  });
});

describe("voice recorder: the microphone going away", () => {
  test("an unplugged microphone keeps what was captured and tells the owner", async () => {
    const onLost = vi.fn();
    const recorder = createVoiceRecorder({ onLost });
    await recorder.start();
    await vi.advanceTimersByTimeAsync(2000);
    // The browser ends the track and the recorder stops itself.
    recorders[0].stop();
    expect(onLost).toHaveBeenCalled();
    const result = await recorder.stop();
    expect(result.status).toBe("ok");
    expect(result.durationSeconds).toBe(2);
    expect(tracks.every((track) => track.stopped)).toBe(true);
  });

  test("a track that ends on its own while recording notifies the owner", async () => {
    const onLost = vi.fn();
    const recorder = createVoiceRecorder({ onLost });
    await recorder.start();
    tracks[0].onended();
    expect(onLost).toHaveBeenCalledTimes(1);
  });

  test("the length limit is reported once so a forgotten recording cannot run for hours", async () => {
    const onLimit = vi.fn();
    const recorder = createVoiceRecorder({ onLimit });
    await recorder.start();
    await vi.advanceTimersByTimeAsync(VOICE_MAX_MS - 1000);
    expect(onLimit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1500);
    expect(onLimit).toHaveBeenCalledTimes(1);
  });

  test("dispose lets go of everything", async () => {
    const recorder = createVoiceRecorder();
    await recorder.start();
    recorder.dispose();
    expect(tracks.every((track) => track.stopped)).toBe(true);
    expect(recorder.getSnapshot().phase).toBe(VOICE_PHASE.IDLE);
  });
});
