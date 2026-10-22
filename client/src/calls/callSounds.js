// The sounds of a call, made with the Web Audio API: there is no audio file to
// download and nothing to license.
//
//   ringtone  an incoming call: a two-note bell melody, repeated every 3 s
//   ringback  an outgoing call whose other side is ringing: a soft double tone
//   connect   the call connected: a short rising blip
//   ended / declined / busy / failed   the call is over: short and each of its own
//
// Rules this file keeps:
//  - Browsers only let a page make sound after the person has touched it once.
//    The audio context is made and resumed at the first tap or key press
//    anywhere in the app (armUnlock), so a call that rings later can be heard.
//    Until then (or when the browser still says no) a ring stays silent and the
//    call screen and the system notification do their job; nothing throws.
//  - A ring stops at once (a short fade, no click) however the call ends.
//  - The context is separate from the call's own audio element, so the call's
//    sound and its speaker choice are never touched. The ringer follows the
//    speaker chosen for calls (audioDevices.js) where AudioContext.setSinkId
//    exists, and falls back to the default speaker when that one is gone.
//  - Vibration is its own switch: a ringing pattern for incoming calls, a
//    short buzz when a call connects or ends. It never runs on a hidden page
//    (the notification vibrates then).
//
// The phase names are plain strings on purpose: this file must stay light and
// must not pull the call engine in (see callContext.js).

import { loadOutputChoice, sinkIdFor } from "./audioDevices.js";
import { getCallSoundPrefs, subscribeCallSoundPrefs } from "./callSoundPrefs.js";

// ── what to play, and when ─────────────────────────────────────────────────

const NOTE = Object.freeze({
  A4: 440,
  C5: 523.25,
  E5: 659.25,
  G5: 783.99,
  A5: 880,
  C6: 1046.5,
  E6: 1318.51,
});

// Harmonics of a soft bell: a sine with a quiet 2nd and 3rd partial.
const BELL = [0, 1, 0.28, 0.1];

/**
 * Each sound is a list of voices. A voice starts `at` seconds in, lasts
 * `length` seconds and has a pitch (or several at once) and a loudness
 * (0..1, before the person's volume). `hold` voices swell and fade at the
 * ends and stay level in the middle; the others strike and die away like a
 * bell.
 */
export const SOUNDS = Object.freeze({
  ringtone: {
    period: 3000,
    vibration: [400, 200, 400, 200, 400],
    voices: [
      { at: 0.0, hz: NOTE.G5, length: 0.6, level: 0.6, partials: BELL },
      { at: 0.24, hz: NOTE.C6, length: 0.8, level: 0.6, partials: BELL },
      { at: 0.86, hz: NOTE.G5, length: 0.6, level: 0.6, partials: BELL },
      { at: 1.1, hz: NOTE.C6, length: 1.0, level: 0.6, partials: BELL },
    ],
  },
  ringback: {
    period: 4000,
    voices: [{ at: 0, hz: [440, 480], length: 1.4, level: 0.22, hold: true, attack: 0.08, release: 0.12 }],
  },
  connect: {
    buzz: [40],
    voices: [
      { at: 0.0, hz: NOTE.A5, length: 0.14, level: 0.45, partials: BELL },
      { at: 0.1, hz: NOTE.E6, length: 0.26, level: 0.45, partials: BELL },
    ],
  },
  ended: {
    buzz: [30, 60, 30],
    voices: [
      { at: 0.0, hz: NOTE.A5, length: 0.16, level: 0.45, partials: BELL },
      { at: 0.13, hz: NOTE.E5, length: 0.32, level: 0.45, partials: BELL },
    ],
  },
  declined: {
    buzz: [30, 60, 30],
    voices: [
      { at: 0.0, hz: NOTE.C5, length: 0.12, level: 0.35, hold: true, attack: 0.01, release: 0.03 },
      { at: 0.18, hz: NOTE.C5, length: 0.12, level: 0.35, hold: true, attack: 0.01, release: 0.03 },
    ],
  },
  busy: {
    buzz: [30, 60, 30],
    voices: [
      { at: 0.0, hz: [480, 620], length: 0.28, level: 0.3, hold: true, attack: 0.01, release: 0.03 },
      { at: 0.5, hz: [480, 620], length: 0.28, level: 0.3, hold: true, attack: 0.01, release: 0.03 },
    ],
  },
  failed: {
    buzz: [30, 60, 30],
    voices: [
      { at: 0.0, hz: NOTE.E5, length: 0.15, level: 0.45, partials: BELL },
      { at: 0.15, hz: NOTE.C5, length: 0.15, level: 0.45, partials: BELL },
      { at: 0.3, hz: NOTE.A4, length: 0.34, level: 0.45, partials: BELL },
    ],
  },
});

const LIVE_PHASES = new Set(["outgoing", "connecting", "connected"]);

/** Which sound plays on a loop in this phase of a call (null: none). */
export function loopSoundFor(phase, ringing) {
  if (!ringing) return null;
  if (phase === "incoming") return "ringtone";
  if (phase === "outgoing") return "ringback";
  return null;
}

// Reasons a call ended that mean "it did not work", as opposed to somebody
// choosing to end it. Mirrors callManager.js (which this file must not import).
const FAILURE_REASONS = new Set([
  "failed",
  "handshake_failed",
  "clock_skew",
  "relay_unavailable",
  "connection_lost",
  "key_mismatch",
  "permission_denied",
  "no_device",
  "e2ee_unavailable",
]);

/** The ending sound for the reason a call ended (null: silence). */
export function endSoundFor(reason) {
  if (reason === "busy") return "busy";
  if (reason === "busy_self") return null; // already in a call: never sound over it
  if (reason === "declined") return "declined";
  if (FAILURE_REASONS.has(reason) || String(reason || "").startsWith("connect_failed")) return "failed";
  return "ended";
}

/**
 * The one-off sounds for a change of phase: a blip when the call connects and
 * an ending sound when a call this device took part in is over. A call that
 * only rang here (missed, cancelled, answered elsewhere, declined by the
 * person themselves), one that is merely restored, and a reset to idle are
 * silent.
 */
export function transitionSoundFor(previousPhase, phase, endReason) {
  if (previousPhase === phase) return null;
  if (phase === "connected") return "connect";
  if (phase === "ended" && LIVE_PHASES.has(previousPhase)) return endSoundFor(endReason);
  return null;
}

/** How loud a volume setting (0..100) is: squared, so the low end is finer. */
export const volumeToGain = (volume) => {
  const fraction = Math.min(1, Math.max(0, Number(volume) / 100));
  return Number.isFinite(fraction) ? fraction * fraction : 0;
};

// ── the sound maker ────────────────────────────────────────────────────────

const START_DELAY = 0.03; // seconds between "now" and the first note, so nothing is clipped
const FADE_OUT = 0.03; // seconds to silence when a ring is stopped
const RELEASE_AFTER_MS = 80; // when the stopped oscillators are really let go
const UNLOCK_EVENTS = ["pointerdown", "pointerup", "keydown", "touchend", "click"];
const SILENT = 0.0001;

const noop = () => {};

const defaultContextClass = () => globalThis.AudioContext || globalThis.webkitAudioContext || null;

// `undefined` where the browser does not say (Firefox before 120): try anyway.
const defaultHasActivation = () => {
  try {
    return globalThis.navigator?.userActivation?.hasBeenActive ?? true;
  } catch (_) {
    return true;
  }
};

const defaultVibrate = (pattern) => {
  try {
    if (typeof globalThis.navigator?.vibrate !== "function") return false;
    // A hidden page cannot vibrate (the notification does it), and Chrome
    // refuses (with a console warning) before the first tap; cancelling is always fine.
    if (pattern !== 0 && (globalThis.document?.hidden || !defaultHasActivation())) return false;
    return Boolean(globalThis.navigator.vibrate(pattern));
  } catch (_) {
    return false;
  }
};

/**
 * @param {object} [options]  everything has a browser default; the options let tests (and nothing else) replace it
 * @param {() => {enabled: boolean, volume: number, vibrate: boolean}} [options.getPrefs]
 * @param {(listener: () => void) => () => void} [options.subscribePrefs]
 * @param {() => string} [options.getOutputId]       the speaker chosen for calls ("default" or a device id)
 * @param {() => (new () => AudioContext) | null} [options.getContextClass]
 * @param {() => boolean} [options.hasActivation]    whether the person has touched the page yet
 * @param {(pattern: number | number[]) => boolean} [options.vibrate]
 */
export function createCallSounds({
  getPrefs = getCallSoundPrefs,
  subscribePrefs = subscribeCallSoundPrefs,
  getOutputId = () => loadOutputChoice(),
  getContextClass = defaultContextClass,
  hasActivation = defaultHasActivation,
  vibrate = defaultVibrate,
} = {}) {
  let context = null;
  let master = null;
  let appliedSink = "";
  let failedSink = null;
  const waves = new Map();
  const sessions = new Set();
  let loop = null;
  let unlockTarget = null;
  let unlockArmed = false;
  let unlockHandler = null;

  // ── the audio context ──
  const gainNow = () => {
    const prefs = getPrefs();
    return prefs.enabled ? volumeToGain(prefs.volume) : 0;
  };

  const applyVolume = () => {
    if (!context || !master) return;
    try {
      master.gain.setValueAtTime(gainNow(), context.currentTime);
    } catch (_) {
      // a context that is closing
    }
  };

  const disarm = () => {
    if (!unlockArmed || !unlockTarget) return;
    unlockArmed = false;
    UNLOCK_EVENTS.forEach((name) => unlockTarget.removeEventListener(name, unlockHandler, true));
  };

  const arm = () => {
    if (unlockArmed || !unlockTarget) return;
    unlockArmed = true;
    UNLOCK_EVENTS.forEach((name) => unlockTarget.addEventListener(name, unlockHandler, { capture: true, passive: true }));
  };

  // The context stopped running (a phone call on iOS, a browser that suspends
  // it): the next tap puts it right.
  const onStateChange = () => {
    if (context && context.state !== "running" && context.state !== "closed") arm();
  };

  const syncSink = () => {
    const current = context;
    if (!current || typeof current.setSinkId !== "function") return;
    let wanted = "";
    try {
      wanted = sinkIdFor(getOutputId());
    } catch (_) {
      wanted = "";
    }
    if (wanted === appliedSink || wanted === failedSink) return;
    appliedSink = wanted;
    Promise.resolve()
      .then(() => current.setSinkId(wanted))
      .catch(() => {
        // That speaker is gone or refused: the default one it is.
        failedSink = wanted;
        appliedSink = "";
        if (wanted === "") return undefined;
        return Promise.resolve()
          .then(() => current.setSinkId(""))
          .catch(noop);
      });
  };

  /** The audio context, made on first need. `gesture`: called from a tap or key press. */
  const ensureContext = ({ gesture = false } = {}) => {
    if (context && context.state !== "closed") return context;
    context = null;
    master = null;
    appliedSink = "";
    failedSink = null;
    waves.clear();
    const ContextClass = getContextClass();
    if (!ContextClass) return null;
    // Nobody has touched the page yet: the browser would refuse (and print a warning).
    if (!gesture && !hasActivation()) return null;
    try {
      context = new ContextClass();
      master = context.createGain();
      master.connect(context.destination);
      context.addEventListener?.("statechange", onStateChange);
    } catch (_) {
      context = null;
      master = null;
      return null;
    }
    applyVolume();
    syncSink();
    return context;
  };

  /** Resolves to whether the context is running afterwards. Never rejects, never waits for ever. */
  const resumeContext = (current) => {
    if (current.state === "running") return Promise.resolve(true);
    if (current.state === "closed") return Promise.resolve(false);
    try {
      return Promise.resolve(current.resume())
        .then(() => current.state === "running")
        .catch(() => false);
    } catch (_) {
      return Promise.resolve(false);
    }
  };

  /** Called from a tap or key press: makes the context and gets it running (the one thing a browser asks of a page). */
  const unlock = () => {
    const current = ensureContext({ gesture: true });
    if (!current) return Promise.resolve(false);
    if (current.state === "running") return Promise.resolve(true);
    // A silent blip inside the gesture is what unlocks audio on iOS.
    try {
      const source = current.createBufferSource();
      source.buffer = current.createBuffer(1, 1, 22050);
      source.connect(current.destination);
      source.start(0);
    } catch (_) {
      // not needed elsewhere
    }
    return resumeContext(current);
  };

  unlockHandler = () => {
    unlock().then((running) => {
      if (!running) return;
      disarm();
      // A ring that has been silent so far (the call came in before anybody
      // touched the page) is heard from this tap on, not from its next round.
      if (loop && !loop.audible && !loop.stopped) {
        clearTimeout(loop.timer);
        loop.tick();
      }
    });
  };

  /**
   * Listens for the first tap or key press anywhere in the page and gets the
   * audio running then. The listeners go as soon as the context runs (and come
   * back if it stops). Returns the function that removes them.
   */
  const armUnlock = (target = globalThis.document) => {
    if (!target || typeof target.addEventListener !== "function") return noop;
    if (unlockTarget === target && unlockArmed) return () => stopListening(target);
    disarm();
    unlockTarget = target;
    // The person may have touched the page long before this (signing in is a
    // tap): browsers then let a context start without another one.
    if (hasActivation()) {
      const current = ensureContext();
      if (current && current.state !== "running") resumeContext(current);
    }
    if (!context || context.state !== "running") arm();
    return () => stopListening(target);
  };

  const stopListening = (target) => {
    if (unlockTarget !== target) return;
    disarm();
    unlockTarget = null;
  };

  // ── waves, voices and sessions ──
  const waveFor = (current, partials) => {
    if (!partials || typeof current.createPeriodicWave !== "function") return null;
    const key = partials.join(",");
    if (waves.has(key)) return waves.get(key);
    let wave = null;
    try {
      wave = current.createPeriodicWave(new Float32Array(partials.length), Float32Array.from(partials));
    } catch (_) {
      wave = null;
    }
    waves.set(key, wave);
    return wave;
  };

  const scheduleVoice = (session, current, voice, start) => {
    const at = start + voice.at;
    const end = at + voice.length;
    const pitches = [].concat(voice.hz);
    const peak = voice.level / Math.sqrt(pitches.length);
    const envelope = current.createGain();
    const level = envelope.gain;
    level.setValueAtTime(SILENT, at);
    if (voice.hold) {
      const attack = Math.min(voice.attack ?? 0.04, voice.length / 3);
      const release = Math.min(voice.release ?? 0.06, voice.length / 3);
      level.linearRampToValueAtTime(peak, at + attack);
      level.setValueAtTime(peak, end - release);
      level.linearRampToValueAtTime(SILENT, end);
    } else {
      // Struck, then dying away like a bell (about -50 dB by the end).
      level.linearRampToValueAtTime(peak, at + 0.01);
      level.setTargetAtTime(SILENT, at + 0.01, (voice.length - 0.01) / 6);
    }
    envelope.connect(session.bus);
    const wave = waveFor(current, voice.partials);
    pitches.forEach((hz) => {
      const oscillator = current.createOscillator();
      if (wave) oscillator.setPeriodicWave(wave);
      else oscillator.type = "sine";
      oscillator.frequency.value = hz;
      oscillator.connect(envelope);
      oscillator.onended = () => {
        session.voices.delete(oscillator);
        try {
          oscillator.disconnect();
        } catch (_) {
          // already gone
        }
      };
      session.voices.add(oscillator);
      oscillator.start(at);
      oscillator.stop(end + 0.02);
    });
  };

  const playVoices = (session, current, spec) => {
    if (session.stopped) return;
    applyVolume();
    syncSink();
    if (!session.bus) {
      session.bus = current.createGain();
      session.bus.connect(master);
    }
    const start = current.currentTime + START_DELAY;
    spec.voices.forEach((voice) => scheduleVoice(session, current, voice, start));
  };

  const soundAllowed = () => {
    const prefs = getPrefs();
    return prefs.enabled && prefs.volume > 0;
  };

  /** Schedules one run of a sound once the context is running (silently does nothing when it cannot). */
  const playCycle = (session, spec) => {
    if (!soundAllowed()) return Promise.resolve(false);
    const current = ensureContext({ gesture: session.gesture });
    if (!current) return Promise.resolve(false);
    syncSink();
    const token = ++session.cycle;
    const play = () => {
      try {
        playVoices(session, current, spec);
        session.audible = true;
        return true;
      } catch (_) {
        return false; // a context that is closing: nothing to hear, nothing to break
      }
    };
    if (current.state === "running") return Promise.resolve(play());
    return resumeContext(current).then((running) => {
      // Stopped, or a newer run took over, while the browser was making up its mind.
      if (!running || session.stopped || token !== session.cycle) return false;
      return play();
    });
  };

  const buzz = (pattern) => {
    if (!pattern || !getPrefs().vibrate) return false;
    return vibrate(pattern);
  };

  const release = (session) => {
    const current = context;
    const voices = [...session.voices];
    session.voices.clear();
    const bus = session.bus;
    session.bus = null;
    if (current && bus) {
      try {
        const now = current.currentTime;
        bus.gain.cancelScheduledValues(now);
        bus.gain.setValueAtTime(bus.gain.value, now);
        bus.gain.linearRampToValueAtTime(0, now + FADE_OUT);
      } catch (_) {
        // a context that is closing
      }
    }
    setTimeout(() => {
      voices.forEach((oscillator) => {
        try {
          oscillator.stop();
        } catch (_) {
          // already stopped
        }
      });
      try {
        bus?.disconnect();
      } catch (_) {
        // already gone
      }
    }, RELEASE_AFTER_MS);
  };

  const endSession = (session) => {
    if (session.stopped) return;
    session.stopped = true;
    clearTimeout(session.timer);
    sessions.delete(session);
    if (loop === session) loop = null;
    if (session.vibrated) vibrate(0);
    release(session);
  };

  const stopLoop = () => {
    if (loop) endSession(loop);
  };

  const newSession = (extra = {}) => {
    const session = {
      stopped: false,
      timer: null,
      tick: null,
      cycle: 0,
      audible: false, // has any of its notes been scheduled yet
      bus: null,
      voices: new Set(),
      vibrated: false,
      gesture: false,
      ...extra,
    };
    sessions.add(session);
    return session;
  };

  // ── what the app calls ──
  const startLoop = (name) => {
    stopLoop();
    const spec = SOUNDS[name];
    const session = newSession();
    loop = session;
    const tick = () => {
      if (session.stopped) return;
      if (spec.vibration && buzz(spec.vibration)) session.vibrated = true;
      playCycle(session, spec);
      session.timer = setTimeout(tick, spec.period);
    };
    session.tick = tick;
    tick();
    return () => endSession(session);
  };

  /** Rings for an incoming call until the returned function is called. */
  const startRingtone = () => startLoop("ringtone");

  /** Plays the tone a caller hears while the other side rings, until the returned function is called. */
  const startRingback = () => startLoop("ringback");

  // A tap (the Settings test button) makes the context itself; anything else only uses one that is there.
  const unlockFirst = (gesture) => (gesture ? unlock() : Promise.resolve(true));

  // A sound that plays once. The session only exists so that stopAll can cut it short.
  const playOnce = (name, { gesture = false } = {}) => {
    const spec = SOUNDS[name];
    const session = newSession({ gesture });
    buzz(spec.buzz ?? spec.vibration);
    const result = unlockFirst(gesture).then(() => playCycle(session, spec));
    const last = Math.max(...spec.voices.map((voice) => voice.at + voice.length));
    session.timer = setTimeout(() => {
      session.stopped = true;
      sessions.delete(session);
      release(session);
    }, (last + 0.5) * 1000);
    return result;
  };

  /** The short blip of a call that has just connected, and a buzz. */
  const playConnected = () => playOnce("connect");

  /** The ending sound: kind is "ended", "declined", "busy" or "failed". */
  const playEnded = (kind = "ended") => (SOUNDS[kind] && kind !== "connect" ? playOnce(kind) : Promise.resolve(false));

  /** One run of the ringtone (and one buzz), for the Settings button. Call it from the tap itself. */
  const playTest = () => playOnce("ringtone", { gesture: true });

  const stopAll = () => {
    [...sessions].forEach(endSession);
  };

  const unsubscribe = subscribePrefs(() => {
    applyVolume();
    if (!getPrefs().vibrate && loop?.vibrated) {
      vibrate(0);
      loop.vibrated = false;
    }
  });

  const dispose = () => {
    stopAll();
    disarm();
    unlockTarget = null;
    unsubscribe();
    const closing = context;
    context = null;
    master = null;
    try {
      closing?.removeEventListener?.("statechange", onStateChange);
      closing?.close?.();
    } catch (_) {
      // already closed
    }
  };

  return {
    armUnlock,
    unlock,
    startRingtone,
    startRingback,
    playConnected,
    playEnded,
    playTest,
    stopAll,
    dispose,
    /** For tests and diagnostics. */
    get context() {
      return context;
    },
    get isLooping() {
      return Boolean(loop);
    },
  };
}

/** The one sound maker of the app. */
export const callSounds = createCallSounds();
