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

const ERROR_TEXT = {
  permission: "Camera or microphone access was blocked. Allow it in your browser settings to record.",
  no_device: "No camera or microphone was found.",
  unsupported: "Video recording is not supported in this browser.",
  too_short: "That was too short. Hold the button a little longer.",
  failed: "The camera could not be started.",
};

/**
 * Camera + MediaRecorder lifecycle for one round video message.
 *
 * Battery and privacy: the camera is only on while the recorder is open, it is
 * released the moment recording finishes (the review step plays the recorded
 * file, not the live camera), and it is also released if the page is hidden.
 */
export function useVideoNoteRecorder({ open, videoElementRef }) {
  const [phase, setPhase] = useState(RECORDER_PHASE.IDLE);
  const [stream, setStream] = useState(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [facing, setFacing] = useState("user");

  const streamRef = useRef(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const startedAtRef = useRef(0);
  const tickRef = useRef(null);
  const limitRef = useRef(null);
  const resultRef = useRef(null);
  const mountedRef = useRef(true);
  const phaseRef = useRef(RECORDER_PHASE.IDLE);

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
      setError(ERROR_TEXT[code] || ERROR_TEXT.failed);
      setPhaseBoth(RECORDER_PHASE.ERROR);
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
      } catch (e) {
        const name = String(e?.name || "");
        if (name === "NotAllowedError" || name === "SecurityError") fail("permission");
        else if (name === "NotFoundError" || name === "OverconstrainedError") fail("no_device");
        else fail("failed");
      }
    },
    [fail, setPhaseBoth],
  );

  const finishRecording = useCallback(
    async (reason) => {
      const recorder = recorderRef.current;
      if (!recorder || recorder.state === "inactive") return;
      const durationMs = Math.min(VIDEO_NOTE_MAX_MS, Math.round(performance.now() - startedAtRef.current));
      clearTimers();
      const posterBlob = reason === "hidden" ? null : await captureVideoPoster(videoElementRef?.current);
      recorder.onstop = () => {
        recorderRef.current = null;
        const mime = normalizeContainer(recorder.mimeType || chunksRef.current[0]?.type);
        const blob = new Blob(chunksRef.current, { type: mime });
        chunksRef.current = [];
        stopStream(); // camera off as soon as the clip exists
        if (!mountedRef.current) return;
        if (durationMs < VIDEO_NOTE_MIN_MS || blob.size === 0) {
          setElapsedMs(0);
          setError(ERROR_TEXT.too_short);
          return void openCamera(facing);
        }
        const next = { blob, mime, durationMs, posterBlob, previewUrl: URL.createObjectURL(blob) };
        resultRef.current = next;
        setResult(next);
        setElapsedMs(durationMs);
        setPhaseBoth(RECORDER_PHASE.REVIEW);
      };
      recorder.stop();
    },
    [clearTimers, facing, openCamera, setPhaseBoth, stopStream, videoElementRef],
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
    recorderRef.current = recorder;
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
  }, [fail, finishRecording, setPhaseBoth]);

  const stopRecording = useCallback(() => finishRecording("user"), [finishRecording]);

  const retake = useCallback(() => {
    revokeResult();
    setElapsedMs(0);
    openCamera(facing);
  }, [facing, openCamera, revokeResult]);

  const switchCamera = useCallback(() => {
    if (phaseRef.current !== RECORDER_PHASE.PREVIEW) return;
    const next = facing === "user" ? "environment" : "user";
    setFacing(next);
    stopStream();
    openCamera(next);
  }, [facing, openCamera, stopStream]);

  /** Hands the recorded file to the caller, which then owns (and revokes) its preview URL. */
  const release = useCallback(() => {
    const r = resultRef.current;
    resultRef.current = null;
    setResult(null);
    return r;
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
    if (open) openCamera("user");
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
        openCamera(facing);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [open, facing, finishRecording, openCamera, setPhaseBoth, stopStream]);

  return {
    phase,
    stream,
    elapsedMs,
    result,
    error,
    facing,
    startRecording,
    stopRecording,
    retake,
    switchCamera,
    release,
    reset,
  };
}
