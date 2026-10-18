import { useCallback, useEffect, useRef, useState } from "react";
import {
  VIDEO_NOTE_CONSTRAINTS,
  VIDEO_NOTE_MAX_MS,
  VIDEO_NOTE_MIN_MS,
  normalizeContainer,
  pickRecorderFormat,
} from "./config.js";
import { captureVideoPoster } from "./poster.js";

export const RECORDER_PHASE = Object.freeze({
  IDLE: "idle",
  STARTING: "starting",
  PREVIEW: "preview",
  RECORDING: "recording",
  REVIEW: "review",
  ERROR: "error",
});

export const VIDEO_NOTE_ERROR_TEXT = {
  permission: "Camera or microphone access was blocked. Allow it in your browser settings to record.",
  no_device: "No camera or microphone was found.",
  unsupported: "Video recording is not supported in this browser.",
  interrupted: "The camera was interrupted, so the recording stopped early. What was captured is kept.",
  failed: "The camera could not be started.",
};

/**
 * Camera + MediaRecorder lifecycle for one round video message.
 *
 * Battery and privacy: the camera is only on while the recorder is open, it is
 * released the moment recording finishes (the review step plays the recorded
 * file, not the live camera), and it is also released if the page is hidden.
 *
 * Options:
 *  - autoStart: start recording as soon as the camera is ready (press-and-hold
 *    recording has no separate "record" step).
 *  - onShort: a clip shorter than VIDEO_NOTE_MIN_MS is dropped and this is called.
 *  - onClip(clip, reason): a clip is ready (reason: "user", "limit", "hidden"
 *    or "lost"), called right after the phase becomes REVIEW.
 *  - onFail(message): the camera could not be used (the phase becomes ERROR).
 *  - initialFacing: "user" (front) or "environment" (rear).
 */
export function useVideoNoteRecorder({
  open,
  videoElementRef,
  autoStart = false,
  onShort = null,
  onClip = null,
  onFail = null,
  initialFacing = "user",
}) {
  const [phase, setPhase] = useState(RECORDER_PHASE.IDLE);
  const [stream, setStream] = useState(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [facing, setFacing] = useState(initialFacing);
  const [cameraCount, setCameraCount] = useState(0);

  const streamRef = useRef(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const startedAtRef = useRef(0);
  const tickRef = useRef(null);
  const limitRef = useRef(null);
  const resultRef = useRef(null);
  const mountedRef = useRef(true);
  const phaseRef = useRef(RECORDER_PHASE.IDLE);
  const stopReasonRef = useRef(null);
  const posterRef = useRef(null);
  const facingRef = useRef(initialFacing);
  const autoStartRef = useRef(autoStart);
  const restartRef = useRef(false); // a camera flip while recording starts over
  const onShortRef = useRef(onShort);
  const onClipRef = useRef(onClip);
  const onFailRef = useRef(onFail);
  const startRecordingRef = useRef(null);

  // Read at the moment the camera is ready / a clip ends, not when it was requested.
  useEffect(() => {
    autoStartRef.current = autoStart;
    onShortRef.current = onShort;
    onClipRef.current = onClip;
    onFailRef.current = onFail;
  });

  const setPhaseBoth = useCallback((next) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch (_) {}
    });
    streamRef.current = null;
    setStream(null);
  }, []);

  const clearTimers = useCallback(() => {
    clearInterval(tickRef.current);
    clearTimeout(limitRef.current);
    tickRef.current = null;
    limitRef.current = null;
  }, []);

  const revokeResult = useCallback(() => {
    const r = resultRef.current;
    if (r?.previewUrl) URL.revokeObjectURL(r.previewUrl);
    resultRef.current = null;
    setResult(null);
  }, []);

  const fail = useCallback(
    (code) => {
      clearTimers();
      stopStream();
      const message = VIDEO_NOTE_ERROR_TEXT[code] || VIDEO_NOTE_ERROR_TEXT.failed;
      setError(message);
      setPhaseBoth(RECORDER_PHASE.ERROR);
      onFailRef.current?.(message);
    },
    [clearTimers, setPhaseBoth, stopStream],
  );

  const openCamera = useCallback(
    async (facingMode) => {
      setError("");
      setPhaseBoth(RECORDER_PHASE.STARTING);
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
        return fail("unsupported");
      }
      try {
        const media = await navigator.mediaDevices.getUserMedia({
          audio: VIDEO_NOTE_CONSTRAINTS.audio,
          video: { ...VIDEO_NOTE_CONSTRAINTS.video, facingMode },
        });
        if (!mountedRef.current || phaseRef.current !== RECORDER_PHASE.STARTING) {
          media.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = media;
        setStream(media);
        setPhaseBoth(RECORDER_PHASE.PREVIEW);
        navigator.mediaDevices
          .enumerateDevices?.()
          .then((devices) => {
            if (mountedRef.current) setCameraCount(devices.filter((d) => d.kind === "videoinput").length);
          })
          .catch(() => {});
        if (autoStartRef.current || restartRef.current) {
          restartRef.current = false;
          startRecordingRef.current?.();
        }
      } catch (e) {
        const name = String(e?.name || "");
        if (name === "NotAllowedError" || name === "SecurityError") fail("permission");
        else if (name === "NotFoundError" || name === "OverconstrainedError") fail("no_device");
        else fail("failed");
      }
    },
    [fail, setPhaseBoth],
  );

  // Builds the clip once the MediaRecorder has stopped, whatever stopped it:
  // the person, the length limit, the page being hidden, or the camera being
  // taken away (another app, a phone call, an unplugged webcam).
  const finalizeRecording = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    recorderRef.current = null;
    clearTimers();
    const reason = stopReasonRef.current || "lost";
    stopReasonRef.current = null;
    const durationMs = Math.min(VIDEO_NOTE_MAX_MS, Math.round(performance.now() - startedAtRef.current));
    const posterBlob = posterRef.current;
    posterRef.current = null;
    const mime = normalizeContainer(recorder.mimeType || chunksRef.current[0]?.type);
    const blob = new Blob(chunksRef.current, { type: mime });
    chunksRef.current = [];
    stopStream(); // camera off as soon as the clip exists
    if (!mountedRef.current) return;
    if (durationMs < VIDEO_NOTE_MIN_MS || blob.size === 0) {
      // A slip of the finger: nothing is kept, the camera stays off.
      setElapsedMs(0);
      setPhaseBoth(RECORDER_PHASE.IDLE);
      onShortRef.current?.();
      return;
    }
    const next = { blob, mime, durationMs, posterBlob, previewUrl: URL.createObjectURL(blob) };
    resultRef.current = next;
    setResult(next);
    setElapsedMs(durationMs);
    setError(reason === "lost" ? VIDEO_NOTE_ERROR_TEXT.interrupted : "");
    setPhaseBoth(RECORDER_PHASE.REVIEW);
    onClipRef.current?.(next, reason);
  }, [clearTimers, setPhaseBoth, stopStream]);

  const finishRecording = useCallback(
    async (reason) => {
      const recorder = recorderRef.current;
      if (!recorder) return;
      stopReasonRef.current = stopReasonRef.current || reason;
      clearTimers();
      if (recorder.state === "inactive") {
        // It stopped by itself already (its tracks ended).
        finalizeRecording();
        return;
      }
      posterRef.current =
        reason === "hidden" ? null : await captureVideoPoster(videoElementRef?.current);
      if (recorder.state !== "inactive") recorder.stop(); // -> onstop -> finalizeRecording
    },
    [clearTimers, finalizeRecording, videoElementRef],
  );

  const startRecording = useCallback(() => {
    const media = streamRef.current;
    if (!media || phaseRef.current !== RECORDER_PHASE.PREVIEW) return;
    const format = pickRecorderFormat((m) => MediaRecorder.isTypeSupported(m));
    let recorder;
    try {
      recorder = format
        ? new MediaRecorder(media, {
            mimeType: format.mimeType,
            videoBitsPerSecond: format.videoBitsPerSecond,
            audioBitsPerSecond: format.audioBitsPerSecond,
          })
        : new MediaRecorder(media);
    } catch (_) {
      return fail("unsupported");
    }
    chunksRef.current = [];
    recorder.ondataavailable = (e) => {
      if (e.data?.size) chunksRef.current.push(e.data);
    };
    recorder.onerror = () => fail("failed");
    recorder.onstop = () => finalizeRecording();
    recorderRef.current = recorder;
    stopReasonRef.current = null;
    posterRef.current = null;
    // If the camera or microphone is taken away mid-recording the recorder
    // stops on its own; keep what was captured instead of hanging in
    // "recording" with a Stop button that does nothing.
    media.getTracks().forEach((track) => {
      track.onended = () => {
        if (phaseRef.current !== RECORDER_PHASE.RECORDING) return;
        stopReasonRef.current = stopReasonRef.current || "lost";
        const active = recorderRef.current;
        if (active && active.state !== "inactive") {
          try {
            active.stop();
          } catch (_) {}
        }
      };
    });
    setError("");
    setElapsedMs(0);
    startedAtRef.current = performance.now();
    // No timeslice: the data is delivered once at stop, so the encoder does
    // not wake the main thread every second.
    recorder.start();
    setPhaseBoth(RECORDER_PHASE.RECORDING);
    tickRef.current = setInterval(() => {
      setElapsedMs(Math.min(VIDEO_NOTE_MAX_MS, performance.now() - startedAtRef.current));
    }, 250);
    limitRef.current = setTimeout(() => finishRecording("limit"), VIDEO_NOTE_MAX_MS);
  }, [fail, finalizeRecording, finishRecording, setPhaseBoth]);

  useEffect(() => {
    startRecordingRef.current = startRecording;
  }, [startRecording]);

  const stopRecording = useCallback(() => finishRecording("user"), [finishRecording]);

  // The phase right now, for event handlers that must not read a stale render.
  const getPhase = useCallback(() => phaseRef.current, []);

  // Before recording: reopen on the other camera. While recording a camera
  // cannot be swapped under a MediaRecorder, so the clip starts over on the
  // other one (the caller says so); nothing is sent.
  const switchCamera = useCallback(() => {
    const current = phaseRef.current;
    if (current !== RECORDER_PHASE.PREVIEW && current !== RECORDER_PHASE.RECORDING) return;
    const next = facingRef.current === "user" ? "environment" : "user";
    if (current === RECORDER_PHASE.RECORDING) {
      clearTimers();
      const recorder = recorderRef.current;
      recorderRef.current = null;
      if (recorder && recorder.state !== "inactive") {
        recorder.onstop = null;
        try {
          recorder.stop();
        } catch (_) {}
      }
      chunksRef.current = [];
      stopReasonRef.current = null;
      posterRef.current = null;
      setElapsedMs(0);
      restartRef.current = true;
    }
    facingRef.current = next;
    setFacing(next);
    stopStream();
    openCamera(next);
  }, [clearTimers, openCamera, stopStream]);

  /**
   * The clip was delivered and its preview URL now belongs to the caller (it
   * keeps it for replaying our own message). Closing the recorder afterwards
   * must not revoke it. The clip stays on screen until the recorder closes.
   */
  const handOver = useCallback(() => {
    resultRef.current = null;
  }, []);

  const reset = useCallback(() => {
    clearTimers();
    try {
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.onstop = null;
        recorder.stop();
      }
    } catch (_) {}
    recorderRef.current = null;
    stopReasonRef.current = null;
    posterRef.current = null;
    chunksRef.current = [];
    stopStream();
    revokeResult();
    setElapsedMs(0);
    setError("");
    setPhaseBoth(RECORDER_PHASE.IDLE);
  }, [clearTimers, revokeResult, setPhaseBoth, stopStream]);

  // Open / close.
  useEffect(() => {
    mountedRef.current = true;
    if (open) openCamera(facingRef.current);
    else reset();
    return () => {
      mountedRef.current = false;
      reset();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Release the camera when the page is hidden.
  useEffect(() => {
    if (!open) return undefined;
    const onVisibility = () => {
      if (document.hidden) {
        if (phaseRef.current === RECORDER_PHASE.RECORDING) finishRecording("hidden");
        else if (phaseRef.current === RECORDER_PHASE.PREVIEW) {
          stopStream();
          setPhaseBoth(RECORDER_PHASE.IDLE);
        }
      } else if (phaseRef.current === RECORDER_PHASE.IDLE) {
        openCamera(facingRef.current);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [open, finishRecording, openCamera, setPhaseBoth, stopStream]);

  return {
    phase,
    stream,
    elapsedMs,
    result,
    error,
    facing,
    cameraCount,
    getPhase,
    startRecording,
    stopRecording,
    switchCamera,
    handOver,
    reset,
  };
}
