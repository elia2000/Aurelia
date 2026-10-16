import { describe, test, expect, beforeEach, vi } from "vitest";
import {
  getThemeSnapshot,
  refreshThemeColor,
  resetThemeStore,
  setThemeDefault,
  setThemePalette,
  setThemePreference,
  setThemeUser,
  subscribeTheme,
  msUntilNextDay,
} from "../../src/utils/themeStore.js";
import { dailyColor, DEFAULT_PALETTE } from "../../src/utils/themeColor.js";

const memory = () => {
  const data = new Map();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)), data };
};

beforeEach(() => resetThemeStore());

describe("theme store", () => {
  test("starts on the default, which is Random, with the built-in palette", () => {
    const snap = getThemeSnapshot();
    expect(snap.preference).toEqual({ mode: "inherit" });
    expect(snap.themeDefault).toBe("random");
    expect(snap.color).toBe(dailyColor(DEFAULT_PALETTE));
    expect(snap.daily).toBe(true);
    expect(snap.palette).toEqual(DEFAULT_PALETTE);
  });

  test("people who never chose get the server's default, and follow it when it changes", () => {
    const storage = memory();
    const now = new Date(Date.UTC(2026, 3, 2, 10, 0));
    setThemeUser("alice", { storage, now: () => now });
    setThemeDefault("#2563EB", { now: () => now, storage });
    expect(getThemeSnapshot().color).toBe("#2563eb");
    expect(getThemeSnapshot().daily).toBe(false);
    setThemeDefault("default", { now: () => now, storage });
    expect(getThemeSnapshot().color).toBeNull();
    setThemeDefault("random", { now: () => now, storage });
    expect(getThemeSnapshot().color).toBe(dailyColor(DEFAULT_PALETTE, now));
  });

  test("everybody on Random has the same colour on the same day", () => {
    const storage = memory();
    const now = new Date(Date.UTC(2026, 3, 2, 10, 0));
    setThemePalette(["#ff0000", "#00ff00", "#0000ff", "#ffff00"], { storage, now: () => now });
    const colours = ["alice", "bob", "carol", "dave", "erin"].map((who) => {
      setThemeUser(who, { storage, now: () => now });
      setThemePreference({ mode: "random" }, { storage, now: () => now });
      return getThemeSnapshot().color;
    });
    expect(new Set(colours).size).toBe(1);
    // ... and so do people who simply kept the default.
    const defaults = ["frank", "gina"].map((who) => {
      setThemeUser(who, { storage, now: () => now });
      return getThemeSnapshot().color;
    });
    expect(new Set([...colours, ...defaults]).size).toBe(1);
  });

  test("the built-in green stays a choice of its own", () => {
    const storage = memory();
    setThemeUser("alice", { storage });
    setThemePreference({ mode: "default" }, { storage });
    expect(getThemeSnapshot().color).toBeNull();
    setThemeUser("alice", { storage });
    expect(getThemeSnapshot().preference).toEqual({ mode: "default" });
  });

  test("what the server said is remembered for the next start", () => {
    const storage = memory();
    setThemePalette(["#123456", "#654321"], { storage });
    setThemeDefault("#2563eb", { storage });
    expect(JSON.parse(storage.data.get("aurelle-theme-server"))).toEqual({
      palette: ["#123456", "#654321"],
      themeDefault: "#2563eb",
    });
  });

  test("a chosen colour is remembered per person", () => {
    const storage = memory();
    setThemeUser("alice", { storage });
    setThemePreference({ mode: "custom", color: "#2563eb" }, { storage });
    expect(getThemeSnapshot().color).toBe("#2563eb");

    setThemeUser("bob", { storage });
    expect(getThemeSnapshot().preference.mode).toBe("inherit"); // bob never chose one
    expect(getThemeSnapshot().color).toBe(dailyColor(DEFAULT_PALETTE)); // so he gets the default
    setThemeUser("alice", { storage });
    expect(getThemeSnapshot().color).toBe("#2563eb"); // alice's choice came back
  });

  test("random follows the admin's palette and today's date", () => {
    const storage = memory();
    const now = new Date(Date.UTC(2026, 3, 2, 10, 0));
    setThemePalette(["#ff0000", "#00ff00", "#0000ff"], { storage });
    setThemeUser("alice", { storage, now: () => now });
    setThemePreference({ mode: "random" }, { storage, now: () => now });
    expect(getThemeSnapshot().color).toBe(dailyColor(["#ff0000", "#00ff00", "#0000ff"], now));
  });

  test("a new palette from the server changes today's random colour", () => {
    const storage = memory();
    const now = new Date(Date.UTC(2026, 3, 2, 10, 0));
    setThemeUser("alice", { storage, now: () => now });
    setThemePreference({ mode: "random" }, { storage, now: () => now });
    const before = getThemeSnapshot().color;
    setThemePalette(["#123456"], { now: () => now, storage });
    expect(getThemeSnapshot().color).toBe("#123456");
    expect(before).not.toBe("#123456");
  });

  test("the colour moves on at UTC midnight", () => {
    const storage = memory();
    let now = new Date("2026-04-02T23:59:30Z");
    setThemeUser("alice", { storage, now: () => now });
    setThemePreference({ mode: "random" }, { storage, now: () => now });
    const tonight = getThemeSnapshot().color;
    now = new Date("2026-04-03T00:00:05Z");
    refreshThemeColor({ now: () => now });
    expect(getThemeSnapshot().color).not.toBe(tonight);
    expect(msUntilNextDay(new Date("2026-04-02T23:59:30Z"))).toBe(30_000);
  });

  test("subscribers hear about changes, and the snapshot only changes when something did", () => {
    const listener = vi.fn();
    const stop = subscribeTheme(listener);
    const first = getThemeSnapshot();
    expect(getThemeSnapshot()).toBe(first);
    setThemePreference({ mode: "custom", color: "#2563eb" }, { storage: memory() });
    expect(listener).toHaveBeenCalled();
    expect(getThemeSnapshot()).not.toBe(first);
    stop();
    listener.mockClear();
    setThemePreference({ mode: "custom", color: "#2563eb" }, { storage: memory() });
    expect(listener).not.toHaveBeenCalled();
  });

  test("logging out goes back to the server's default", () => {
    const storage = memory();
    setThemeUser("alice", { storage });
    setThemePreference({ mode: "custom", color: "#2563eb" }, { storage });
    setThemeUser(null, { storage });
    expect(getThemeSnapshot().preference.mode).toBe("inherit");
    expect(getThemeSnapshot().color).toBe(dailyColor(DEFAULT_PALETTE));
  });
});
