import { describe, expect, test } from "vitest";
import { AUTOPLAY_MAX_BYTES, autoplayBlocker, readAutoplayEnvironment } from "../../src/videoNote/autoplay.js";

describe("autoplayBlocker", () => {
  test("nothing stops a normal phone or computer", () => {
    expect(autoplayBlocker({ online: true, effectiveType: "4g", sizeBytes: 2_000_000 })).toBe("");
    expect(autoplayBlocker()).toBe("");
  });

  test("less motion, less data, no network and slow networks each stop it", () => {
    expect(autoplayBlocker({ reducedMotion: true })).toBe("reduced-motion");
    expect(autoplayBlocker({ saveData: true })).toBe("data-saver");
    expect(autoplayBlocker({ online: false })).toBe("offline");
    expect(autoplayBlocker({ effectiveType: "2g" })).toBe("slow-network");
    expect(autoplayBlocker({ effectiveType: "slow-2g" })).toBe("slow-network");
  });

  test("3g is fast enough for a clip of a few megabytes", () => {
    expect(autoplayBlocker({ effectiveType: "3g", sizeBytes: 3_000_000 })).toBe("");
  });

  test("a file bigger than a round video message normally is does not start by itself", () => {
    expect(autoplayBlocker({ sizeBytes: AUTOPLAY_MAX_BYTES })).toBe("");
    expect(autoplayBlocker({ sizeBytes: AUTOPLAY_MAX_BYTES + 1 })).toBe("too-big");
  });

  test("the person's wish for less motion wins over everything else", () => {
    expect(autoplayBlocker({ reducedMotion: true, saveData: true, online: false })).toBe("reduced-motion");
  });
});

describe("readAutoplayEnvironment", () => {
  const media = (reduce) => (query) => ({ matches: reduce && query.includes("reduce") });

  test("reads the motion preference and the network settings", () => {
    const env = readAutoplayEnvironment({
      matchMedia: media(true),
      navigator: { onLine: true, connection: { saveData: true, effectiveType: "3g" } },
    });
    expect(env).toEqual({ reducedMotion: true, saveData: true, effectiveType: "3g", online: true });
  });

  test("a browser that tells nothing is treated as a normal one", () => {
    const env = readAutoplayEnvironment({ matchMedia: media(false), navigator: {} });
    expect(env).toEqual({ reducedMotion: false, saveData: false, effectiveType: "", online: true });
    expect(autoplayBlocker(env)).toBe("");
  });

  test("offline is read from the navigator", () => {
    expect(readAutoplayEnvironment({ matchMedia: media(false), navigator: { onLine: false } }).online).toBe(false);
  });

  test("a broken media query does not throw", () => {
    const env = readAutoplayEnvironment({
      matchMedia: () => {
        throw new Error("nope");
      },
      navigator: {},
    });
    expect(env.reducedMotion).toBe(false);
  });
});
