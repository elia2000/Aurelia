import { describe, test, expect, afterEach } from "vitest";
import { defaultStorage } from "../../src/utils/safeStorage.js";
import { loadQuality, saveQuality } from "../../src/calls/callQuality.js";
import { loadFit, saveFit } from "../../src/calls/pictureFit.js";
import { loadOutputChoice, saveOutputChoice } from "../../src/calls/audioDevices.js";
import { loadThemePreference, saveThemePreference, loadServerTheme, saveServerTheme } from "../../src/utils/themeColor.js";

// A browser that blocks site data throws when the page merely touches localStorage.
const block = () =>
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new DOMException("The operation is insecure.", "SecurityError");
    },
  });

afterEach(() => {
  delete globalThis.localStorage;
});

describe("storage that the browser blocks", () => {
  test("is no storage, instead of an error", () => {
    block();
    expect(defaultStorage()).toBeNull();
  });

  test("the settings that are remembered fall back to their defaults and never throw", () => {
    block();
    expect(loadQuality()).toBe("auto");
    expect(loadFit()).toBe("auto");
    expect(loadOutputChoice()).toBe("default");
    expect(loadThemePreference("u")).toEqual({ mode: "inherit" });
    expect(loadServerTheme().themeDefault).toBe("random");
    expect(() => {
      saveQuality("hd");
      saveFit("fit");
      saveOutputChoice("x");
      saveThemePreference("u", { mode: "random" });
      saveServerTheme({ palette: [], themeDefault: "random" });
    }).not.toThrow();
  });
});
