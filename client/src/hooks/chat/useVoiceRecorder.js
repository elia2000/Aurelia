import { useEffect, useState, useSyncExternalStore } from "react";

// A clip shorter than this is treated as a slip of the finger and discarded
// (the composer shows a "hold to record" hint instead of sending silence).
export const VOICE_MIN_MS = 1000;
// Nothing in the app limited voice messages before; this only stops a locked,
// forgotten recording from running for hours. The clip is kept for review.
export const VOICE_MAX_MS = 30 * 60 * 1000;

const LEVEL_TICK_MS = 80;
const TIMER_TICK_MS = 100;
const LIVE_LEVELS = 40;
const MAX_HISTORY = Math.ceil(VOICE_MAX_MS / LEVEL_TICK_MS);

export const VOICE_PHASE = Object.freeze({
  IDLE: "idle",
  STARTING: "starting",
  RECORDING: "recording",
});

const PREFERRED_TYPES = [
  "audio/webm;codecs=opus",
  "audio/ogg;codecs=opus",
  "audio/webm",
  "audio/ogg",
];

const supportsType = (type) => {
  try {
    return typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type);
  } catch (_) {
    return false;
  }
};

const extensionFor = (mimeType) => {
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("mp4") || mimeType.includes("aac")) return "m4a";
  return "webm";
};

/** Turns the recorded chunks into the file the upload pipeline expects. */
export function createVoiceFileFromChunks(chunks, durationSeconds) {
  if (!chunks.length) return null;
  const mimeType = PREFERRED_TYPES.find(supportsType) || chunks[0].type || "audio/webm";
  const blob = new Blob(chunks, { type: mimeType });
  const filename = `voice-message-${Date.now()}.${extensionFor(mimeType)}`;
  let file = blob;
  try {
    if (typeof File !== "undefined") file = new File([blob], filename, { type: mimeType });
  } catch (_) {
    file = blob;
  }
  if (file && !file.name) {
    Object.defineProperty(file, "name", { value: filename, configurable: true });
  }
  return { file, durationSeconds, mimeType };
}

/** getUserMedia failure -> a short code the composer turns into a sentence. */
export function voiceErrorCode(error) {
  const name = String(error?.name || "");
  if (name === "NotAllowedError" || name === "SecurityError") return "permission";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "no_device";
  if (error?.code === "unsupported") return "unsupported";
  return "failed";
}

function requestMicrophoneStream() {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw Object.assign(new Error("Microphone access is not supported in this browser."), {
      code: "unsupported",
    });
  }
  return navigator.mediaDevices.getUserMedia({ audio: true });
}

/**
 * Microphone + MediaRecorder for one voice message at a time, with a live
 * level meter. Plain object (no React) so it is easy to test; the hook below
 * ties its lifetime to a component.
 *
 * start()  -> {ok: true} | {ok: false, error: "permission"|"no_device"|"unsupported"|"failed"|"aborted"|"busy"}
 * stop()   -> {status: "ok", file, durationSeconds, durationMs, mimeType, levels}
 *             | {status: "short"} (under VOICE_MIN_MS, or stopped before the microphone opened)
 *             | {status: "empty"} (nothing was captured)
 * cancel() throws the recording away. dispose() does that and lets go of the devices.
 *
 * handlers.onLost() runs when the microphone goes away mid-recording and
 * handlers.onLimit() when VOICE_MAX_MS is reached; the owner then calls
 * stop(), which also returns what a recorder that stopped by itself captured.
 * onLost can run more than once for the same loss; handle it idempotently.
 */
export function createVoiceRecorder(initialHandlers = {}) {
  let handlers = initialHandlers;
  const getHandlers = () => handlers || {};
  let snapshot = { phase: VOICE_PHASE.IDLE, elapsedMs: 0, levels: [] };
  const listeners = new Set();
  const publish = (patch) => {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((listener) => listener());
  };

  let generation = 0; // bumped by stop/cancel so a late microphone is dropped
  let stream = null;
  let current = null; // the recording in progress
  let orphan = null; // the result of a recording that ended by itself
  let timerId = null;
  let levelId = null;
  let limitId = null;
  let audioContext = null;
  let analyser = null;

  const stopMeter = () => {
    clearInterval(levelId);
    levelId = null;
    try {
      audioContext?.close?.();
    } catch (_) {
      // already closed
    }
    audioContext = null;
    analyser = null;
  };

  const releaseStream = () => {
    clearInterval(timerId);
    clearTimeout(limitId);
    timerId = null;
    limitId = null;
    stopMeter();
    stream?.getTracks?.().forEach((track) => {
      track.onended = null;
      try {
        track.stop();
      } catch (_) {
        // already stopped
      }
    });
    stream = null;
  };

  const startMeter = (session) => {
    try {
      const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!Ctx) return;
      audioContext = new Ctx();
      audioContext.resume?.().catch?.(() => {});
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      audioContext.createMediaStreamSource(stream).connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      levelId = setInterval(() => {
        if (!analyser) return;
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (let i = 0; i < samples.length; i += 1) {
          const centred = (samples[i] - 128) / 128;
          sum += centred * centred;
        }
        const level = Math.min(1, Math.sqrt(sum / samples.length) * 3.2);
        session.levels.push(level);
        if (session.levels.length > MAX_HISTORY) session.levels.shift();
        publish({ levels: session.levels.slice(-LIVE_LEVELS) });
      }, LEVEL_TICK_MS);
    } catch (_) {
      stopMeter(); // no meter; the recording itself is unaffected
    }
  };

  // Ends a recording exactly once, whichever way it ended.
  const finish = (session) => {
    if (session.done) return;
    session.done = true;
    const durationMs = Math.round((session.stopRequestedAt ?? performance.now()) - session.startedAt);
    releaseStream();
    if (current === session) current = null;
    let result;
    if (session.discard) result = { status: "short" };
    else if (!session.chunks.length) result = { status: "empty" };
    else if (durationMs < VOICE_MIN_MS) result = { status: "short" };
    else {
      const payload = createVoiceFileFromChunks(
        session.chunks,
        Math.max(1, Math.round(durationMs / 1000)),
      );
      result = payload
        ? { status: "ok", ...payload, durationMs, levels: session.levels }
        : { status: "empty" };
    }
    session.chunks = [];
    publish({ phase: VOICE_PHASE.IDLE, elapsedMs: 0, levels: [] });
    if (session.waiters.length) {
      session.waiters.forEach((resolve) => resolve(result));
    } else if (!session.discard) {
      // It ended by itself (the microphone went away): keep what it captured
      // for the owner's stop() and tell the owner.
      orphan = result;
      getHandlers().onLost?.();
    }
  };

  const lost = (session) => {
    if (session.done || current !== session) return;
    getHandlers().onLost?.();
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    setHandlers(next) {
      handlers = next || {};
    },

    async start() {
      if (snapshot.phase !== VOICE_PHASE.IDLE) return { ok: false, error: "busy" };
      orphan = null;
      const mine = ++generation;
      publish({ phase: VOICE_PHASE.STARTING, elapsedMs: 0, levels: [] });
      let media;
      try {
        media = await requestMicrophoneStream();
      } catch (error) {
        if (mine === generation) publish({ phase: VOICE_PHASE.IDLE });
        return { ok: false, error: voiceErrorCode(error) };
      }
      if (mine !== generation) {
        // Released or cancelled while the permission prompt / device opened.
        media.getTracks?.().forEach((track) => track.stop());
        return { ok: false, error: "aborted" };
      }
      stream = media;
      const options = {};
      if (supportsType("audio/webm;codecs=opus")) options.mimeType = "audio/webm;codecs=opus";
      else if (supportsType("audio/ogg;codecs=opus")) options.mimeType = "audio/ogg;codecs=opus";
      let recorder;
      try {
        recorder = new MediaRecorder(media, options);
      } catch (_) {
        releaseStream();
        publish({ phase: VOICE_PHASE.IDLE });
        return { ok: false, error: "unsupported" };
      }
      const session = {
        recorder,
        chunks: [],
        levels: [],
        startedAt: performance.now(),
        stopRequestedAt: null,
        discard: false,
        done: false,
        waiters: [],
      };
      current = session;
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) session.chunks.push(event.data);
      };
      recorder.onerror = () => lost(session);
      recorder.onstop = () => finish(session);
      media.getTracks().forEach((track) => {
        track.onended = () => lost(session); // unplugged, or taken by another app
      });
      recorder.start(250);
      publish({ phase: VOICE_PHASE.RECORDING, elapsedMs: 0, levels: [] });
      timerId = setInterval(() => {
        publish({ elapsedMs: Math.round(performance.now() - session.startedAt) });
      }, TIMER_TICK_MS);
      limitId = setTimeout(() => getHandlers().onLimit?.(), VOICE_MAX_MS);
      startMeter(session);
      return { ok: true };
    },

    /** Stops and returns the clip (see the contract above). */
    stop() {
      if (snapshot.phase === VOICE_PHASE.STARTING) {
        generation += 1; // the microphone that is still opening is dropped
        publish({ phase: VOICE_PHASE.IDLE });
        return Promise.resolve({ status: "short" });
      }
      const session = current;
      if (!session) {
        const result = orphan || { status: "empty" };
        orphan = null;
        return Promise.resolve(result);
      }
      return new Promise((resolve) => {
        session.waiters.push(resolve);
        session.stopRequestedAt = session.stopRequestedAt ?? performance.now();
        const { recorder } = session;
        try {
          if (recorder.state === "recording") recorder.requestData?.();
        } catch (_) {
          // a recorder that cannot flush still stops below
        }
        try {
          if (recorder.state !== "inactive") recorder.stop();
          else finish(session); // it had already stopped by itself
        } catch (_) {
          finish(session);
        }
      });
    },

    cancel() {
      generation += 1;
      orphan = null;
      if (snapshot.phase === VOICE_PHASE.STARTING) {
        publish({ phase: VOICE_PHASE.IDLE });
        return;
      }
      const session = current;
      if (!session) return;
      session.discard = true;
      const { recorder } = session;
      recorder.ondataavailable = null;
      recorder.onerror = null;
      recorder.onstop = null;
      try {
        if (recorder.state !== "inactive") recorder.stop();
      } catch (_) {
        // nothing left to stop
      }
      finish(session);
    },

    dispose() {
      this.cancel();
      releaseStream();
    },
  };
}

/**
 * One voice recorder for the lifetime of the component. Returns the recorder
 * object (stable); read its live state with useRecorderSnapshot so the parent
 * does not re-render every 100 ms.
 */
export function useVoiceRecorder(handlers) {
  const [recorder] = useState(() => createVoiceRecorder(handlers));
  useEffect(() => {
    recorder.setHandlers(handlers);
  });
  useEffect(() => () => recorder.dispose(), [recorder]);
  return recorder;
}

export function useRecorderSnapshot(recorder) {
  return useSyncExternalStore(recorder.subscribe, recorder.getSnapshot, recorder.getSnapshot);
}
