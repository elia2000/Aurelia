import { useCallback, useEffect, useRef, useState } from "react";
import {
  GESTURE_STATE,
  createRecordGesture,
} from "../../components/chat/messages/composer/recordGesture.js";
import { createStore } from "../../components/chat/messages/composer/miniStore.js";
import {
  RECORD_ERROR_TEXT,
  readRecordMode,
  vibrate,
  writeRecordMode,
} from "../../components/chat/messages/composer/recordPrefs.js";
import {
  RECORDER_PHASE,
  VIDEO_NOTE_ERROR_TEXT,
  useVideoNoteRecorder,
} from "../../videoNote/useVideoNoteRecorder.js";
import { useVoiceRecorder } from "./useVoiceRecorder.js";

const IDLE = Object.freeze({ phase: "idle", kind: null, locked: false });
const NO_PROGRESS = Object.freeze({ dx: 0, dy: 0, cancel: 0, lock: 0 });
// A click that follows the lift of the finger that just locked or sent a
// recording must not count as a press on the Send button that replaced it.
const CLICK_GUARD_MS = 450;

const VOICE_ERRORS = {
  permission: RECORD_ERROR_TEXT.micPermission,
  no_device: RECORD_ERROR_TEXT.micMissing,
  unsupported: RECORD_ERROR_TEXT.micUnsupported,
  failed: RECORD_ERROR_TEXT.micFailed,
};

/**
 * Everything behind the composer's record button: which kind of message a hold
 * records (voice or round video), the press / slide / lock gesture, the two
 * recorders, previewing a locked recording, and sending.
 *
 * ui.phase: "idle" -> "recording" (held, or locked) -> "preview" (stopped, for
 * review) or straight back to "idle" after a send; a video message passes
 * through "sending" while it is encrypted and uploaded.
 *
 * Voice messages are handed to `onVoiceReady(payload)` (the composer puts them
 * on the existing pending-voice path and submits). Video messages go to
 * `onSendVideoNote(clip, {acknowledgeChanges})`, which resolves to
 * {ok, error?, changes?, requiresVerification?}; a refused send keeps the clip
 * so it can be sent again, reviewed or deleted.
 */
export function useRecordingSession({
  chatId,
  recordDisabled = false,
  microphonePermissionStatus = "unknown",
  onRequestMicrophonePermission,
  onVoiceReady,
  onSendVideoNote = null,
  onBeforeRecord,
}) {
  const videoAvailable = typeof onSendVideoNote === "function";
  const [storedMode, setStoredMode] = useState(readRecordMode);
  const mode = videoAvailable ? storedMode : "voice";

  const [ui, setUiState] = useState(IDLE);
  const uiRef = useRef(IDLE);
  const [hint, setHint] = useState(null);
  const [announcement, setAnnouncement] = useState({ id: 0, text: "" });
  const [notice, setNotice] = useState(null);
  const [voicePreview, setVoicePreview] = useState(null);
  const [videoClip, setVideoClip] = useState(null);
  const [progress] = useState(() => createStore(NO_PROGRESS));
  const [gesture] = useState(() => createRecordGesture());
  const videoElementRef = useRef(null);

  const hintTimerRef = useRef(null);
  const voicePreviewRef = useRef(null);
  const videoIntentRef = useRef(null); // "send" | "preview" for the clip being finished
  const clipRef = useRef(null);
  const ownsClipUrlRef = useRef(false);
  const sendingRef = useRef(false);
  const finishingRef = useRef(false);
  const generationRef = useRef(0); // bumped when the chat changes or we unmount
  const sourceRef = useRef(null); // "pointer" | "keyboard"
  const detachRef = useRef(null);
  const clickGuardUntilRef = useRef(0);
  const mountedRef = useRef(true);

  const setUi = useCallback((next) => {
    uiRef.current = next;
    setUiState(next);
  }, []);

  const showHint = useCallback((text, tone = "info") => {
    clearTimeout(hintTimerRef.current);
    setHint({ id: `${Date.now()}-${Math.random()}`, text, tone });
    hintTimerRef.current = setTimeout(() => setHint(null), tone === "error" ? 5000 : 2800);
  }, []);

  const announce = useCallback((text) => {
    setAnnouncement((prev) => ({ id: prev.id + 1, text }));
  }, []);

  const resetProgress = useCallback(() => progress.set(NO_PROGRESS), [progress]);

  const revokeVoicePreview = useCallback(() => {
    const preview = voicePreviewRef.current;
    voicePreviewRef.current = null;
    if (preview?.url) URL.revokeObjectURL(preview.url);
    setVoicePreview(null);
  }, []);

  const revokeOwnedClip = useCallback(() => {
    if (ownsClipUrlRef.current && clipRef.current?.previewUrl) {
      URL.revokeObjectURL(clipRef.current.previewUrl);
    }
    ownsClipUrlRef.current = false;
    clipRef.current = null;
    setVideoClip(null);
  }, []);

  const voice = useVoiceRecorder();
  const video = useVideoNoteRecorder({
    open: ui.kind === "video" && ui.phase !== "idle",
    videoElementRef,
    autoStart: true,
    onShort: () => handleVideoShort(),
    onClip: (clip, reason) => handleVideoClip(clip, reason),
    onFail: (message) => handleVideoFail(message),
  });

  // ---- ending a recording --------------------------------------------------

  const sendVoice = (payload) => {
    onVoiceReady?.({
      file: payload.file,
      durationSeconds: payload.durationSeconds,
      mimeType: payload.mimeType,
    });
    announce("Voice message sent");
  };

  const sendVideo = async (clip, acknowledgeChanges = false) => {
    if (!videoAvailable || sendingRef.current) return;
    const generation = generationRef.current;
    clipRef.current = clip;
    // From here this session owns the preview URL (a failed send keeps the
    // clip); on success it passes to the message, which keeps it for replay.
    video.handOver();
    ownsClipUrlRef.current = true;
    sendingRef.current = true;
    setNotice(null);
    setUi({ phase: "sending", kind: "video", locked: true });
    let outcome;
    try {
      outcome = await onSendVideoNote(clip, { acknowledgeChanges });
    } catch (_) {
      outcome = { ok: false, error: "The video message could not be sent." };
    }
    sendingRef.current = false;
    if (outcome?.ok) {
      ownsClipUrlRef.current = false;
      clipRef.current = null;
      if (generation !== generationRef.current || !mountedRef.current) return;
      announce("Video message sent");
      setVideoClip(null);
      setUi(IDLE);
      return;
    }
    if (generation !== generationRef.current || !mountedRef.current) {
      revokeOwnedClip();
      return;
    }
    setNotice({
      error: outcome?.error || "The video message could not be sent.",
      changes: outcome?.changes || [],
      requiresVerification: Boolean(outcome?.requiresVerification),
    });
    setUi({ phase: "preview", kind: "video", locked: true });
  };

  const discardVideoCamera = () => {
    videoIntentRef.current = null;
    revokeOwnedClip();
    setNotice(null);
  };

  // Throw the recording away (trash button, slide to cancel, Escape).
  const discard = ({ message = "Recording deleted", buzz = true } = {}) => {
    const current = uiRef.current;
    if (current.phase === "idle" || sendingRef.current) return;
    if (current.kind === "voice") {
      voice.cancel();
      revokeVoicePreview();
    } else {
      discardVideoCamera();
    }
    finishingRef.current = false;
    resetProgress();
    gesture.reset();
    setUi(IDLE);
    if (buzz) vibrate([12, 40, 12]);
    announce(message);
  };

  // Stop the recording in progress. "send": deliver it. "preview": keep it for
  // review (Stop while locked, the page was hidden, the pointer was taken away,
  // the microphone/camera went away, the length limit).
  const finish = async (intent) => {
    const current = uiRef.current;
    if (current.phase !== "recording" || finishingRef.current) return;
    finishingRef.current = true;
    const generation = generationRef.current;
    if (current.kind === "voice") {
      const result = await voice.stop();
      finishingRef.current = false;
      if (generation !== generationRef.current || uiRef.current.phase !== "recording") return;
      resetProgress();
      gesture.reset();
      if (result.status === "ok") {
        if (intent === "send") {
          setUi(IDLE);
          sendVoice(result);
        } else {
          const url = URL.createObjectURL(result.file);
          const preview = { ...result, url };
          voicePreviewRef.current = preview;
          setVoicePreview(preview);
          setUi({ phase: "preview", kind: "voice", locked: true });
        }
        return;
      }
      setUi(IDLE);
      showHint(
        result.status === "short" ? RECORD_ERROR_TEXT.holdVoice : "Nothing was recorded.",
        result.status === "short" ? "info" : "error",
      );
      return;
    }
    // Video: the recorder hands the clip to handleVideoClip when it has built it.
    if (video.getPhase() === RECORDER_PHASE.RECORDING) {
      videoIntentRef.current = intent;
      video.stopRecording(); // finishingRef is cleared when the clip (or a failure) arrives
      return;
    }
    // The camera was not recording yet (still opening): nothing worth keeping.
    finishingRef.current = false;
    discardVideoCamera();
    resetProgress();
    gesture.reset();
    setUi(IDLE);
    showHint(RECORD_ERROR_TEXT.holdVideo);
  };

  function handleVideoClip(clip, reason) {
    finishingRef.current = false;
    const current = uiRef.current;
    if (current.kind !== "video" || current.phase !== "recording") return;
    const intent = videoIntentRef.current;
    videoIntentRef.current = null;
    clipRef.current = clip;
    setVideoClip(clip);
    resetProgress();
    gesture.reset();
    if (intent === "send") {
      void sendVideo(clip);
      return;
    }
    setUi({ phase: "preview", kind: "video", locked: true });
    if (reason === "limit") showHint("Maximum length reached. Review it, then send.");
    else if (reason === "lost") showHint(VIDEO_NOTE_ERROR_TEXT.interrupted, "error");
  }

  function handleVideoShort() {
    finishingRef.current = false;
    const current = uiRef.current;
    if (current.kind !== "video" || current.phase === "idle") return;
    discardVideoCamera();
    resetProgress();
    gesture.reset();
    setUi(IDLE);
    showHint(RECORD_ERROR_TEXT.holdVideo);
  }

  function handleVideoFail(message) {
    finishingRef.current = false;
    const current = uiRef.current;
    if (current.kind !== "video" || current.phase === "idle") return;
    discardVideoCamera();
    resetProgress();
    gesture.reset();
    setUi(IDLE);
    showHint(message, "error");
  }

  // ---- gesture callbacks ---------------------------------------------------

  const toggleMode = () => {
    if (!videoAvailable) {
      showHint(RECORD_ERROR_TEXT.holdVoice);
      return;
    }
    const next = mode === "voice" ? "video" : "voice";
    setStoredMode(next);
    writeRecordMode(next);
    announce(next === "video" ? "Video message mode" : "Voice message mode");
    // Like Telegram: switching also tells how to use the button.
    showHint(next === "video" ? RECORD_ERROR_TEXT.holdVideo : RECORD_ERROR_TEXT.holdVoice);
  };

  const startRecording = () => {
    if (recordDisabled || uiRef.current.phase !== "idle") return false;
    if (mode === "voice" && microphonePermissionStatus === "prompt") {
      // The first use asks for the microphone; recording starts on the next hold.
      Promise.resolve(onRequestMicrophonePermission?.()).catch(() => {});
      return false;
    }
    onBeforeRecord?.();
    clearTimeout(hintTimerRef.current);
    setHint(null);
    setNotice(null);
    resetProgress();
    vibrate(10);
    setUi({ phase: "recording", kind: mode, locked: false });
    announce(mode === "voice" ? "Recording voice message" : "Recording video message");
    if (mode === "voice") {
      const generation = generationRef.current;
      voice.start().then((result) => {
        if (result.ok || result.error === "aborted" || result.error === "busy") return;
        if (generation !== generationRef.current || !mountedRef.current) return;
        const current = uiRef.current;
        if (current.kind === "voice" && current.phase === "recording") {
          resetProgress();
          gesture.reset();
          setUi(IDLE);
        }
        // The person may have let go while the permission prompt was open;
        // the reason still has to reach them.
        showHint(VOICE_ERRORS[result.error] || RECORD_ERROR_TEXT.micFailed, "error");
      });
    }
    return true;
  };

  useEffect(() => {
    gesture.setHandlers({
      onTap: toggleMode,
      onHoldStart: startRecording,
      onProgress: (p) => progress.set(p),
      onRelease: () => void finish("send"),
      onCancel: () => discard({ message: "Recording cancelled" }),
      onLock: () => {
        if (uiRef.current.phase !== "recording") return;
        setUi({ ...uiRef.current, locked: true });
        progress.set({ dx: 0, dy: 0, cancel: 0, lock: 1 });
        vibrate(16);
        announce("Recording locked. Use the buttons to delete, stop or send.");
      },
      onInterrupt: () => void finish("preview"),
    });
  });

  useEffect(() => {
    voice.setHandlers({
      onLost: () => {
        if (uiRef.current.kind !== "voice" || uiRef.current.phase !== "recording") return;
        showHint("The microphone was interrupted. What was recorded is kept.", "error");
        void finish("preview");
      },
      onLimit: () => {
        if (uiRef.current.kind !== "voice" || uiRef.current.phase !== "recording") return;
        showHint("Maximum length reached. Review it, then send.");
        void finish("preview");
      },
    });
  });

  // ---- pointer + keyboard binding for the record button --------------------

  const guardClick = () => {
    clickGuardUntilRef.current = performance.now() + CLICK_GUARD_MS;
  };

  const endPointerSession = useCallback(() => {
    detachRef.current?.();
    detachRef.current = null;
  }, []);

  const attachGuards = (extra = {}) => {
    const onBlur = () => gesture.interrupt("blur");
    const onVisibility = () => {
      if (document.hidden) gesture.interrupt("hidden");
    };
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibility);
    const listeners = Object.entries(extra);
    listeners.forEach(([name, fn]) => window.addEventListener(name, fn));
    detachRef.current = () => {
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
      listeners.forEach(([name, fn]) => window.removeEventListener(name, fn));
    };
  };

  const onPointerDown = (event) => {
    if (recordDisabled || !event.isPrimary) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (gesture.state !== GESTURE_STATE.IDLE) return;
    event.preventDefault();
    const pointerId = event.pointerId;
    try {
      event.currentTarget.setPointerCapture(pointerId);
    } catch (_) {
      // the window listeners below still see the pointer
    }
    sourceRef.current = "pointer";
    endPointerSession();
    attachGuards({
      pointermove: (e) => {
        if (e.pointerId === pointerId) gesture.move({ x: e.clientX, y: e.clientY });
      },
      pointerup: (e) => {
        if (e.pointerId !== pointerId) return;
        endPointerSession();
        guardClick();
        gesture.release();
      },
      pointercancel: (e) => {
        if (e.pointerId !== pointerId) return;
        endPointerSession();
        guardClick();
        gesture.interrupt("pointercancel");
      },
      lostpointercapture: (e) => {
        if (e.pointerId !== pointerId) return;
        endPointerSession();
        gesture.interrupt("lostpointercapture");
      },
    });
    gesture.press({ x: event.clientX, y: event.clientY, source: "pointer" });
  };

  const onKeyDown = (event) => {
    if (sourceRef.current === "keyboard" && event.key === "ArrowUp" && gesture.state === GESTURE_STATE.HOLDING) {
      event.preventDefault();
      gesture.lock();
      return;
    }
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault(); // no native click: a hold must not also "press"
    if (event.repeat || recordDisabled) return;
    if (gesture.state !== GESTURE_STATE.IDLE) return;
    sourceRef.current = "keyboard";
    endPointerSession();
    attachGuards();
    gesture.press({ source: "keyboard" });
  };

  const onKeyUp = (event) => {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    if (sourceRef.current !== "keyboard") return;
    endPointerSession();
    gesture.release();
  };

  const onBlur = () => {
    if (sourceRef.current === "keyboard") gesture.interrupt("blur");
  };

  // Escape: cancel a press, a hold, a locked recording or a preview. It must
  // not also close the chat, which listens for Escape on the document.
  const escapeRef = useRef(null);
  useEffect(() => {
    escapeRef.current = (event) => {
      if (event.key !== "Escape") return;
      const current = uiRef.current;
      let handled = false;
      if (current.phase === "preview") {
        discard({ message: "Recording deleted" });
        handled = true;
      } else if (gesture.escape()) {
        handled = true;
      } else if (current.phase === "recording") {
        discard({ message: "Recording cancelled" });
        handled = true;
      }
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
  });
  useEffect(() => {
    const onEscape = (event) => escapeRef.current?.(event);
    window.addEventListener("keydown", onEscape, true);
    return () => window.removeEventListener("keydown", onEscape, true);
  }, []);

  // ---- locked / preview actions -------------------------------------------

  const send = () => {
    if (performance.now() < clickGuardUntilRef.current) return;
    const current = uiRef.current;
    if (current.phase === "recording") {
      void finish("send");
    } else if (current.phase === "preview") {
      if (current.kind === "voice") {
        const preview = voicePreviewRef.current;
        if (!preview) return;
        revokeVoicePreview();
        setUi(IDLE);
        sendVoice(preview);
      } else if (clipRef.current) {
        void sendVideo(clipRef.current);
      }
    }
  };

  const flipCamera = () => {
    if (video.getPhase() === RECORDER_PHASE.RECORDING) {
      showHint("Camera switched. The recording started over.");
    }
    video.switchCamera();
  };

  // ---- lifetime ------------------------------------------------------------

  // Leaving the chat or the page releases the microphone and camera and drops
  // whatever was in progress. Kept in a ref so the cleanup below always runs
  // the newest version.
  const abortAllRef = useRef(null);
  useEffect(() => {
    abortAllRef.current = () => {
      generationRef.current += 1;
      gesture.reset();
      endPointerSession();
      voice.cancel();
      revokeVoicePreview();
      if (!sendingRef.current) revokeOwnedClip();
      finishingRef.current = false;
      videoIntentRef.current = null;
      clearTimeout(hintTimerRef.current);
      resetProgress();
    };
  });

  useEffect(() => {
    return () => {
      abortAllRef.current?.();
      uiRef.current = IDLE;
      setUiState(IDLE);
      setHint(null);
      setNotice(null);
    };
  }, [chatId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  return {
    mode,
    videoAvailable,
    ui,
    phase: ui.phase,
    kind: ui.kind,
    locked: ui.locked,
    hint,
    announcement,
    notice,
    voice,
    voicePreview,
    video,
    videoClip,
    videoElementRef,
    progress,
    recordButtonProps: { onPointerDown, onKeyDown, onKeyUp, onBlur },
    actions: {
      toggleMode,
      stop: () => void finish("preview"),
      send,
      discard: () => discard(),
      sendAnyway: () => {
        if (clipRef.current) void sendVideo(clipRef.current, true);
      },
      dismissNotice: () => setNotice(null),
      flipCamera,
    },
  };
}
