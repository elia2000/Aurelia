import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  CALL_SOUND_KEYS,
  DEFAULT_CALL_SOUND_PREFS,
  clampVolume,
  getCallSoundPrefs,
  loadCallSoundPrefs,
  reloadCallSoundPrefs,
  saveCallSoundPrefs,
  setCallSoundPrefs,
  subscribeCallSoundPrefs,
} from "../../src/calls/callSoundPrefs.js";

const memory = (initial = {}) => {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
  };
};

describe("loading the call sound preferences of this device", () => {
  test("sounds on, 70% and vibration on until the person says otherwise", () => {
    expect(DEFAULT_CALL_SOUND_PREFS).toEqual({ enabled: true, volume: 70, vibrate: true });
    expect(loadCallSoundPrefs(memory())).toEqual({ enabled: true, volume: 70, vibrate: true });
    expect(loadCallSoundPrefs(null)).toEqual({ enabled: true, volume: 70, vibrate: true });
  });

  test("reads back what was saved", () => {
    const storage = memory();
    saveCallSoundPrefs({ enabled: false, volume: 35, vibrate: false }, storage);
    expect(loadCallSoundPrefs(storage)).toEqual({ enabled: false, volume: 35, vibrate: false });
    expect(storage.data.get(CALL_SOUND_KEYS.enabled)).toBe("0");
    expect(storage.data.get(CALL_SOUND_KEYS.volume)).toBe("35");
  });

  test("a volume of 0 is a real choice, not 'missing'", () => {
    expect(loadCallSoundPrefs(memory({ [CALL_SOUND_KEYS.volume]: "0" })).volume).toBe(0);
  });

  test("rubbish in storage falls back to the defaults and a volume is kept within 0..100", () => {
    const storage = memory({
      [CALL_SOUND_KEYS.enabled]: "maybe",
      [CALL_SOUND_KEYS.volume]: "loud",
      [CALL_SOUND_KEYS.vibrate]: "yes",
    });
    expect(loadCallSoundPrefs(storage)).toEqual(DEFAULT_CALL_SOUND_PREFS);
    expect(clampVolume(250)).toBe(100);
    expect(clampVolume(-4)).toBe(0);
    expect(clampVolume("42.4")).toBe(42);
  });

  test("a storage that throws changes nothing and breaks nothing", () => {
    const broken = {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
    };
    expect(loadCallSoundPrefs(broken)).toEqual(DEFAULT_CALL_SOUND_PREFS);
    expect(() => saveCallSoundPrefs({ enabled: true, volume: 10, vibrate: true }, broken)).not.toThrow();
  });
});

describe("the shared store", () => {
  beforeEach(() => {
    setCallSoundPrefs({ ...DEFAULT_CALL_SOUND_PREFS }, { storage: memory() });
  });

  test("a change reaches everyone listening, once, and is saved on this device", () => {
    const storage = memory();
    const listener = vi.fn();
    const off = subscribeCallSoundPrefs(listener);
    setCallSoundPrefs({ volume: 20 }, { storage });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getCallSoundPrefs().volume).toBe(20);
    expect(storage.data.get(CALL_SOUND_KEYS.volume)).toBe("20");
    off();
    setCallSoundPrefs({ volume: 30 }, { storage });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("setting what already is makes no noise and keeps the same object", () => {
    const before = getCallSoundPrefs();
    const listener = vi.fn();
    const off = subscribeCallSoundPrefs(listener);
    setCallSoundPrefs({ volume: before.volume }, { storage: memory() });
    expect(listener).not.toHaveBeenCalled();
    expect(getCallSoundPrefs()).toBe(before);
    off();
  });

  test("only what is named changes", () => {
    setCallSoundPrefs({ enabled: false }, { storage: memory() });
    expect(getCallSoundPrefs()).toEqual({ enabled: false, volume: 70, vibrate: true });
    setCallSoundPrefs({ vibrate: false, volume: 150 }, { storage: memory() });
    expect(getCallSoundPrefs()).toEqual({ enabled: false, volume: 100, vibrate: false });
  });

  test("a change made in another tab is followed", () => {
    const storage = memory({ [CALL_SOUND_KEYS.volume]: "55", [CALL_SOUND_KEYS.enabled]: "0" });
    reloadCallSoundPrefs(storage);
    expect(getCallSoundPrefs()).toEqual({ enabled: false, volume: 55, vibrate: true });
  });
});
