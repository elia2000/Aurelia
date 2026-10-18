import { afterEach, describe, expect, test, vi } from "vitest";
import {
  RECORD_MODE_KEY,
  formatClock,
  formatRecordingTime,
  readRecordMode,
  vibrate,
  writeRecordMode,
} from "../../src/components/chat/messages/composer/recordPrefs.js";

afterEach(() => vi.unstubAllGlobals());

const memoryStorage = () => {
  const data = new Map();
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
  };
};

describe("record mode preference", () => {
  test("is voice until the person switches, and is remembered under aurelle-record-mode", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    expect(RECORD_MODE_KEY).toBe("aurelle-record-mode");
    expect(readRecordMode()).toBe("voice");
    writeRecordMode("video");
    expect(storage.data.get("aurelle-record-mode")).toBe("video");
    expect(readRecordMode()).toBe("video");
    writeRecordMode("voice");
    expect(readRecordMode()).toBe("voice");
  });

  test("anything unexpected in storage means voice", () => {
    const storage = memoryStorage();
    storage.data.set(RECORD_MODE_KEY, "hologram");
    vi.stubGlobal("localStorage", storage);
    expect(readRecordMode()).toBe("voice");
  });

  test("blocked storage never throws: reading gives voice, writing is skipped", () => {
    const blocked = {
      getItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("blocked", "QuotaExceededError");
      },
    };
    vi.stubGlobal("localStorage", blocked);
    expect(readRecordMode()).toBe("voice");
    expect(() => writeRecordMode("video")).not.toThrow();
  });

  test("no storage at all", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(readRecordMode()).toBe("voice");
    expect(() => writeRecordMode("video")).not.toThrow();
  });
});

describe("vibrate", () => {
  test("buzzes where the browser can, and is silent where it cannot or refuses", () => {
    const buzz = vi.fn();
    vi.stubGlobal("navigator", { vibrate: buzz });
    vibrate([12, 40, 12]);
    expect(buzz).toHaveBeenCalledWith([12, 40, 12]);

    vi.stubGlobal("navigator", {});
    expect(() => vibrate()).not.toThrow();

    vi.stubGlobal("navigator", {
      vibrate: () => {
        throw new Error("needs a recent tap");
      },
    });
    expect(() => vibrate()).not.toThrow();
  });
});

describe("recording clock", () => {
  test("shows minutes, seconds and tenths while recording", () => {
    expect(formatRecordingTime(0)).toBe("0:00.0");
    expect(formatRecordingTime(1234)).toBe("0:01.2");
    expect(formatRecordingTime(61_900)).toBe("1:01.9");
    expect(formatRecordingTime(-5)).toBe("0:00.0");
    expect(formatRecordingTime("nonsense")).toBe("0:00.0");
  });

  test("shows whole seconds for a finished clip", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(4600)).toBe("0:05");
    expect(formatClock(125_000)).toBe("2:05");
  });
});
