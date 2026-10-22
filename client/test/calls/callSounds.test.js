import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import {
  SOUNDS,
  createCallSounds,
  endSoundFor,
  loopSoundFor,
  transitionSoundFor,
  volumeToGain,
} from "../../src/calls/callSounds.js";
import { makeFakeAudio } from "./fakeAudio.js";

const flush = () => vi.advanceTimersByTimeAsync(0);

// A page-like target that records its listeners, so "listens once" can be asserted.
function makeTarget() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(name, handler) {
      listeners.set(name, [...(listeners.get(name) || []), handler]);
    },
    removeEventListener(name, handler) {
      listeners.set(name, (listeners.get(name) || []).filter((h) => h !== handler));
    },
    fire(name) {
      (listeners.get(name) || []).slice().forEach((handler) => handler({ type: name }));
    },
    get armed() {
      return [...listeners.values()].some((list) => list.length > 0);
    },
  };
}

function setup({ audio = {}, prefs = {}, activation = true, output = "default" } = {}) {
  const env = makeFakeAudio(audio);
  const state = { enabled: true, volume: 70, vibrate: true, ...prefs };
  const listeners = new Set();
  const vibrate = vi.fn(() => true);
  const sounds = createCallSounds({
    getPrefs: () => state,
    subscribePrefs: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getOutputId: () => output,
    getContextClass: () => env.Context,
    hasActivation: () => activation,
    vibrate,
  });
  const change = (patch) => {
    Object.assign(state, patch);
    listeners.forEach((listener) => listener());
  };
  return { env, sounds, state, vibrate, change };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("which sound goes with which phase of a call", () => {
  test("an incoming call that rings here plays the ringtone, and nothing else does", () => {
    expect(loopSoundFor("incoming", true)).toBe("ringtone");
    expect(loopSoundFor("incoming", false)).toBeNull();
  });

  test("an outgoing call plays the ringback tone only once the other side is ringing", () => {
    expect(loopSoundFor("outgoing", true)).toBe("ringback");
    expect(loopSoundFor("outgoing", false)).toBeNull(); // Calling... / Waiting...
  });

  test.each(["idle", "connecting", "connected", "ended"])("the %s phase plays no loop", (phase) => {
    expect(loopSoundFor(phase, true)).toBeNull();
  });

  test("a call that connects blips; a restored or reset one stays silent", () => {
    expect(transitionSoundFor("connecting", "connected")).toBe("connect");
    expect(transitionSoundFor("connected", "connected")).toBeNull();
    expect(transitionSoundFor("connected", "idle")).toBeNull();
    expect(transitionSoundFor("idle", "ended", "hangup")).toBeNull();
    expect(transitionSoundFor("ended", "ended", "hangup")).toBeNull();
  });

  test("a call this device took part in ends with a sound that says how", () => {
    expect(transitionSoundFor("connected", "ended", "hangup")).toBe("ended");
    expect(transitionSoundFor("connected", "ended", "local_hangup")).toBe("ended");
    expect(transitionSoundFor("outgoing", "ended", "declined")).toBe("declined");
    expect(transitionSoundFor("outgoing", "ended", "busy")).toBe("busy");
    expect(transitionSoundFor("outgoing", "ended", "no_answer")).toBe("ended");
    expect(transitionSoundFor("connecting", "ended", "permission_denied")).toBe("failed");
    expect(transitionSoundFor("connected", "ended", "connection_lost")).toBe("failed");
    expect(transitionSoundFor("connecting", "ended", "connect_failed_no_relay")).toBe("failed");
  });

  test("a call that only rang here ends in silence (the ring just stops)", () => {
    for (const reason of ["missed", "cancelled", "declined_local", "failed"]) {
      expect(transitionSoundFor("incoming", "ended", reason)).toBeNull();
    }
  });

  test("being in another call is never sounded over", () => {
    expect(endSoundFor("busy_self")).toBeNull();
    expect(transitionSoundFor("outgoing", "ended", "busy_self")).toBeNull();
  });

  test("the ending sounds are four different ones", () => {
    const shape = (name) => JSON.stringify(SOUNDS[name].voices.map((v) => [v.at, v.hz]));
    expect(new Set(["ended", "declined", "busy", "failed"].map(shape)).size).toBe(4);
  });

  test("volume is squared, from silence to full", () => {
    expect(volumeToGain(0)).toBe(0);
    expect(volumeToGain(100)).toBe(1);
    expect(volumeToGain(50)).toBeCloseTo(0.25);
    expect(volumeToGain(250)).toBe(1);
    expect(volumeToGain("nope")).toBe(0);
  });
});

describe("the ringtone", () => {
  test("starts at once with a two-note melody and repeats about every 3 seconds", async () => {
    const { env, sounds } = setup();
    sounds.startRingtone();
    await flush();
    expect(env.frequencies()).toEqual([783.99, 1046.5, 783.99, 1046.5]);
    expect(new Set(env.frequencies()).size).toBe(2);
    expect(env.oscillators().every((o) => o.wave)).toBe(true);

    await vi.advanceTimersByTimeAsync(3000);
    expect(env.oscillators()).toHaveLength(8);
    await vi.advanceTimersByTimeAsync(3000);
    expect(env.oscillators()).toHaveLength(12);
  });

  test("schedules the notes ahead on the audio clock, in order", async () => {
    const { env, sounds } = setup();
    sounds.startRingtone();
    await flush();
    const starts = env.oscillators().map((o) => o.startedAt);
    expect(starts[0]).toBeGreaterThan(env.context.currentTime);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });

  test("stops at once: no further notes, the sound is faded and every oscillator let go", async () => {
    const { env, sounds, vibrate } = setup();
    const stop = sounds.startRingtone();
    await flush();
    const bus = env.context.gains[1];
    stop();

    // The fade starts right away...
    const fade = bus.gain.events.filter((event) => event.type === "linear").pop();
    expect(fade.value).toBe(0);
    // ...no note is scheduled after that, however long we wait...
    await vi.advanceTimersByTimeAsync(10_000);
    expect(env.oscillators()).toHaveLength(4);
    // ...and the oscillators that were still queued are stopped.
    expect(env.oscillators().every((o) => o.stoppedNow)).toBe(true);
    expect(bus.disconnected).toBe(true);
    expect(sounds.isLooping).toBe(false);
    expect(vibrate).toHaveBeenLastCalledWith(0);
  });

  test("stopping twice, or after another ring replaced it, is harmless", async () => {
    const { env, sounds } = setup();
    const first = sounds.startRingtone();
    await flush();
    const second = sounds.startRingtone();
    await flush();
    first();
    first();
    expect(sounds.isLooping).toBe(true); // the second one is still going
    await vi.advanceTimersByTimeAsync(3000);
    expect(env.oscillators().length).toBeGreaterThan(8);
    second();
    expect(sounds.isLooping).toBe(false);
  });

  test("the master volume follows the setting, squared, and a change applies to a ring in progress", async () => {
    const { env, sounds, change } = setup({ prefs: { volume: 70 } });
    sounds.startRingtone();
    await flush();
    expect(env.masterGain()).toBeCloseTo(0.49);
    change({ volume: 20 });
    expect(env.masterGain()).toBeCloseTo(0.04);
    change({ enabled: false });
    expect(env.masterGain()).toBe(0);
  });

  test("with sounds off, or the volume at 0, nothing is made (not even an audio context)", async () => {
    const off = setup({ prefs: { enabled: false } });
    off.sounds.startRingtone();
    await flush();
    expect(off.env.oscillators()).toHaveLength(0);

    const quiet = setup({ prefs: { volume: 0 } });
    quiet.sounds.startRingtone();
    await flush();
    expect(quiet.env.oscillators()).toHaveLength(0);
  });

  test("a ring in progress goes silent when sounds are switched off from elsewhere", async () => {
    const { env, sounds, change } = setup();
    sounds.startRingtone();
    await flush();
    change({ enabled: false });
    await vi.advanceTimersByTimeAsync(3000);
    expect(env.oscillators()).toHaveLength(4); // nothing new
  });
});

describe("autoplay rules", () => {
  test("before anyone has touched the page it stays silent: no context, no error", async () => {
    const { env, sounds } = setup({ activation: false });
    expect(() => sounds.startRingtone()).not.toThrow();
    await vi.advanceTimersByTimeAsync(7000);
    expect(env.contexts).toHaveLength(0);
  });

  test("a browser that still refuses to start sound leaves the ring silent and does not break it", async () => {
    const { env, sounds } = setup({ audio: { allowed: false } });
    sounds.startRingtone();
    await vi.advanceTimersByTimeAsync(7000);
    expect(env.contexts).toHaveLength(1);
    expect(env.oscillators()).toHaveLength(0);
    expect(sounds.isLooping).toBe(true);
  });

  test("when the browser lets go, the next run of the ring is heard", async () => {
    const { env, sounds } = setup({ audio: { allowed: false } });
    sounds.startRingtone();
    await vi.advanceTimersByTimeAsync(1000);
    expect(env.oscillators()).toHaveLength(0);
    env.allow();
    await vi.advanceTimersByTimeAsync(2100);
    expect(env.oscillators()).toHaveLength(4);
  });

  test("the first tap anywhere makes the context and starts it, and the listeners go", async () => {
    const { env, sounds } = setup({ audio: { allowed: false }, activation: false });
    const target = makeTarget();
    sounds.armUnlock(target);
    expect(target.armed).toBe(true);
    expect(env.contexts).toHaveLength(0);

    env.allow(); // the tap is what the browser was waiting for
    target.fire("pointerdown");
    await flush();
    expect(env.contexts).toHaveLength(1);
    expect(env.context.state).toBe("running");
    expect(target.armed).toBe(false);
  });

  test("listens for taps, key presses and touches", () => {
    const { sounds } = setup({ activation: false });
    const target = makeTarget();
    sounds.armUnlock(target);
    expect([...target.listeners.keys()]).toEqual(expect.arrayContaining(["pointerdown", "keydown", "touchend", "click"]));
  });

  test("the context is resumed once per gesture: later taps do nothing once it runs", async () => {
    const { env, sounds } = setup({ audio: { allowed: false, startSuspended: true }, activation: false });
    const target = makeTarget();
    sounds.armUnlock(target);
    env.allow();
    target.fire("pointerdown");
    await flush();
    const resumed = env.resumeCalls;
    expect(resumed).toBe(1);
    target.fire("pointerdown");
    target.fire("keydown");
    target.fire("click");
    await flush();
    expect(env.resumeCalls).toBe(resumed);
    expect(env.contexts).toHaveLength(1);
  });

  test("a tap the browser does not count keeps the listeners for the next one", async () => {
    const { env, sounds } = setup({ audio: { allowed: false }, activation: false });
    const target = makeTarget();
    sounds.armUnlock(target);
    target.fire("pointerdown"); // resume() stays pending
    await flush();
    expect(target.armed).toBe(true);
    env.allow();
    target.fire("click");
    await flush();
    expect(env.context.state).toBe("running");
    expect(target.armed).toBe(false);
  });

  test("a context the system interrupts (a phone call) is put right by the next tap", async () => {
    const { env, sounds } = setup({ activation: false });
    const target = makeTarget();
    sounds.armUnlock(target);
    target.fire("pointerdown");
    await flush();
    expect(target.armed).toBe(false);

    env.context.setState("interrupted");
    expect(target.armed).toBe(true);
    target.fire("pointerdown");
    await flush();
    expect(env.context.state).toBe("running");
    expect(target.armed).toBe(false);
  });

  test("a page that was touched long ago (signing in) gets its context straight away", async () => {
    const { env, sounds } = setup({ activation: true });
    const target = makeTarget();
    sounds.armUnlock(target);
    await flush();
    expect(env.contexts).toHaveLength(1);
    expect(env.context.state).toBe("running");
    expect(target.armed).toBe(false);
  });

  test("the listeners can be removed", () => {
    const { sounds } = setup({ audio: { allowed: false }, activation: false });
    const target = makeTarget();
    const off = sounds.armUnlock(target);
    expect(target.armed).toBe(true);
    off();
    expect(target.armed).toBe(false);
  });

  test("a browser without Web Audio simply has no sound", async () => {
    const sounds = createCallSounds({
      getPrefs: () => ({ enabled: true, volume: 70, vibrate: false }),
      subscribePrefs: () => () => {},
      getContextClass: () => null,
      vibrate: () => false,
    });
    expect(() => sounds.startRingtone()()).not.toThrow();
    await expect(sounds.playConnected()).resolves.toBe(false);
  });
});

describe("the ringback tone", () => {
  test("is a soft double tone that repeats every 4 seconds", async () => {
    const { env, sounds } = setup();
    sounds.startRingback();
    await flush();
    expect(env.frequencies().sort()).toEqual([440, 480]);
    await vi.advanceTimersByTimeAsync(4000);
    expect(env.oscillators()).toHaveLength(4);
  });

  test("is quieter than the ringtone and never vibrates", async () => {
    const { env, sounds, vibrate } = setup();
    sounds.startRingback();
    await flush();
    expect(vibrate).not.toHaveBeenCalled();
    const ringback = SOUNDS.ringback.voices[0].level;
    expect(ringback).toBeLessThan(SOUNDS.ringtone.voices[0].level);
    expect(env.oscillators()).toHaveLength(2);
  });

  test("stops at once", async () => {
    const { env, sounds } = setup();
    const stop = sounds.startRingback();
    await flush();
    stop();
    await vi.advanceTimersByTimeAsync(9000);
    expect(env.oscillators()).toHaveLength(2);
    expect(env.oscillators().every((o) => o.stoppedNow)).toBe(true);
  });

  test("starting the ringtone replaces it", async () => {
    const { env, sounds } = setup();
    sounds.startRingback();
    await flush();
    sounds.startRingtone();
    await flush();
    await vi.advanceTimersByTimeAsync(4100);
    // only the ringtone's notes were added after the switch
    expect(env.frequencies().filter((hz) => hz === 440 || hz === 480)).toHaveLength(2);
  });
});

describe("vibration", () => {
  test("an incoming call vibrates with a ringing pattern every cycle, and stops with the ring", async () => {
    const { sounds, vibrate } = setup();
    const stop = sounds.startRingtone();
    await flush();
    expect(vibrate).toHaveBeenCalledTimes(1);
    expect(vibrate.mock.calls[0][0]).toEqual(SOUNDS.ringtone.vibration);
    await vi.advanceTimersByTimeAsync(3000);
    expect(vibrate).toHaveBeenCalledTimes(2);
    stop();
    expect(vibrate).toHaveBeenLastCalledWith(0);
  });

  test("turned off, it does not vibrate but the ring still sounds", async () => {
    const { env, sounds, vibrate } = setup({ prefs: { vibrate: false } });
    sounds.startRingtone();
    await flush();
    expect(vibrate).not.toHaveBeenCalled();
    expect(env.oscillators()).toHaveLength(4);
  });

  test("with sounds off the phone can still vibrate", async () => {
    const { env, sounds, vibrate } = setup({ prefs: { enabled: false } });
    sounds.startRingtone();
    await flush();
    expect(vibrate).toHaveBeenCalledTimes(1);
    expect(env.oscillators()).toHaveLength(0);
  });

  test("works while the browser has not allowed sound yet", async () => {
    const { vibrate, sounds } = setup({ audio: { allowed: false }, activation: false });
    sounds.startRingtone();
    await flush();
    expect(vibrate).toHaveBeenCalledTimes(1);
  });

  test("switching it off in Settings during a ring cuts the buzzing", async () => {
    const { sounds, vibrate, change } = setup();
    sounds.startRingtone();
    await flush();
    change({ vibrate: false });
    expect(vibrate).toHaveBeenLastCalledWith(0);
  });

  test("a short buzz when the call connects and when it ends", async () => {
    const { sounds, vibrate } = setup();
    await sounds.playConnected();
    expect(vibrate).toHaveBeenLastCalledWith(SOUNDS.connect.buzz);
    await sounds.playEnded("ended");
    expect(vibrate).toHaveBeenLastCalledWith(SOUNDS.ended.buzz);
  });

  test("a ringing phone that is not vibrating (no support) is fine", async () => {
    const env = makeFakeAudio();
    const sounds = createCallSounds({
      getPrefs: () => ({ enabled: true, volume: 70, vibrate: true }),
      subscribePrefs: () => () => {},
      getContextClass: () => env.Context,
      hasActivation: () => true,
      vibrate: () => false,
    });
    sounds.startRingtone()();
    expect(env.contexts).toHaveLength(1);
  });
});

describe("the short sounds", () => {
  test("the connect blip is two quick rising notes", async () => {
    const { env, sounds } = setup();
    await sounds.playConnected();
    const [first, second] = env.frequencies();
    expect(second).toBeGreaterThan(first);
    expect(env.oscillators()).toHaveLength(2);
  });

  test("each ending sound plays its own notes", async () => {
    const heard = {};
    for (const kind of ["ended", "declined", "busy", "failed"]) {
      const { env, sounds } = setup();
      await sounds.playEnded(kind);
      heard[kind] = JSON.stringify(env.frequencies());
    }
    expect(new Set(Object.values(heard)).size).toBe(4);
  });

  test("busy is the classic two-tone beep, twice", async () => {
    const { env, sounds } = setup();
    await sounds.playEnded("busy");
    expect(env.frequencies()).toEqual([480, 620, 480, 620]);
  });

  test("a short sound ends any ring that is still going, and an unknown kind is ignored", async () => {
    const { env, sounds } = setup();
    sounds.startRingtone();
    await flush();
    await expect(sounds.playEnded("nonsense")).resolves.toBe(false);
    await expect(sounds.playEnded(null)).resolves.toBe(false);
    const before = env.oscillators().length;
    await vi.advanceTimersByTimeAsync(3000);
    expect(env.oscillators().length).toBeGreaterThan(before); // the ring is still ringing: it is the app that stops it
  });

  test("they are silent with sounds off", async () => {
    const { env, sounds } = setup({ prefs: { enabled: false } });
    await sounds.playConnected();
    await sounds.playEnded("busy");
    expect(env.oscillators()).toHaveLength(0);
  });

  test("they are cleaned up once played", async () => {
    const { env, sounds } = setup();
    await sounds.playEnded("ended");
    await vi.advanceTimersByTimeAsync(2000);
    expect(env.oscillators().every((o) => o.stoppedNow)).toBe(true);
  });

  test("the test sound plays one run of the ringtone from a tap, even before the audio was unlocked", async () => {
    const { env, sounds, vibrate } = setup({ audio: { allowed: false }, activation: false });
    env.allow(); // the tap
    await expect(sounds.playTest()).resolves.toBe(true);
    expect(env.frequencies()).toEqual([783.99, 1046.5, 783.99, 1046.5]);
    expect(vibrate).toHaveBeenCalledWith(SOUNDS.ringtone.vibration);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(env.oscillators()).toHaveLength(4); // it does not repeat
  });
});

describe("the speaker", () => {
  test("follows the speaker chosen for calls when the browser can route a context", async () => {
    const { env, sounds } = setup({ audio: { sinkId: true }, output: "usb-speakers" });
    sounds.startRingtone();
    await flush();
    expect(env.sinkCalls).toEqual(["usb-speakers"]);
    await vi.advanceTimersByTimeAsync(6000);
    expect(env.sinkCalls).toEqual(["usb-speakers"]); // once, not every cycle
  });

  test("the default speaker needs no routing", async () => {
    const { env, sounds } = setup({ audio: { sinkId: true }, output: "default" });
    sounds.startRingtone();
    await flush();
    expect(env.sinkCalls).toEqual([]);
  });

  test("a speaker that is gone falls back to the default one, and is not retried every cycle", async () => {
    const { env, sounds } = setup({ audio: { sinkId: true }, output: "unplugged" });
    env.badSinks.add("unplugged");
    sounds.startRingtone();
    await flush();
    expect(env.sinkCalls).toEqual(["unplugged", ""]);
    expect(env.oscillators()).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(6000);
    expect(env.sinkCalls).toEqual(["unplugged", ""]);
    expect(env.oscillators()).toHaveLength(12);
  });

  test("a browser that cannot route a context rings through the default speaker", async () => {
    const { env, sounds } = setup({ audio: { sinkId: false }, output: "usb-speakers" });
    sounds.startRingtone();
    await flush();
    expect(env.sinkCalls).toEqual([]);
    expect(env.oscillators()).toHaveLength(4);
  });
});

describe("cleaning up", () => {
  test("dispose stops everything and closes the context", async () => {
    const { env, sounds } = setup();
    sounds.startRingtone();
    await flush();
    sounds.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(env.context.closed).toBe(true);
    expect(env.oscillators()).toHaveLength(4);
  });

  test("stopAll ends a ring and a short sound alike", async () => {
    const { env, sounds } = setup();
    sounds.startRingtone();
    await sounds.playConnected();
    sounds.stopAll();
    await vi.advanceTimersByTimeAsync(5000);
    expect(sounds.isLooping).toBe(false);
    expect(env.oscillators().every((o) => o.stoppedNow)).toBe(true);
  });
});
