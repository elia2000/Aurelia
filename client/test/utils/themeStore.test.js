import { describe, test, expect, beforeEach, vi } from "vitest";
import {
  getThemeSnapshot,
  refreshThemeColor,
  resetThemeStore,
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
  test("starts with the built-in look and the built-in palette", () => {
    const snap = getThemeSnapshot();
    expect(snap.preference).toEqual({ mode: "default" });
    expect(snap.color).toBeNull();
    expect(snap.palette).toEqual(DEFAULT_PALETTE);
  });

  test("a chosen colour is remembered per person", () => {
    const storage = memory();
    setThemeUser("alice", { storage });
    setThemePreference({ mode: "custom", color: "#2563eb" }, { storage });
    expect(getThemeSnapshot().color).toBe("#2563eb");

    setThemeUser("bob", { storage });
    expect(getThemeSnapshot().color).toBeNull(); // bob never chose one
    setThemeUser("alice", { storage });
    expect(getThemeSnapshot().color).toBe("#2563eb"); // alice's choice came back
  });

  test("random follows the admin's palette and the person's day", () => {
    const storage = memory();
    const now = new Date(2026, 3, 2, 10, 0);
    setThemePalette(["#ff0000", "#00ff00", "#0000ff"]);
    setThemeUser("alice", { storage, now: () => now });
    setThemePreference({ mode: "random" }, { storage, now: () => now });
    expect(getThemeSnapshot().color).toBe(dailyColor(["#ff0000", "#00ff00", "#0000ff"], "alice", now));
  });

  test("a new palette from the server changes today's random colour", () => {
    const storage = memory();
    const now = new Date(2026, 3, 2, 10, 0);
    setThemeUser("alice", { storage, now: () => now });
    setThemePreference({ mode: "random" }, { storage, now: () => now });
    const before = getThemeSnapshot().color;
    setThemePalette(["#123456"], { now: () => now });
    expect(getThemeSnapshot().color).toBe("#123456");
    expect(before).not.toBe("#123456");
  });

  test("the colour moves on at midnight", () => {
    const storage = memory();
    let now = new Date(2026, 3, 2, 23, 59, 30);
    setThemeUser("alice", { storage, now: () => now });
    setThemePreference({ mode: "random" }, { storage, now: () => now });
    const tonight = getThemeSnapshot().color;
    now = new Date(2026, 3, 3, 0, 0, 5);
    refreshThemeColor({ now: () => now });
    expect(getThemeSnapshot().color).not.toBe(tonight);
    expect(msUntilNextDay(new Date(2026, 3, 2, 23, 59, 30))).toBe(30_000);
    expect(msUntilNextDay(new Date(2026, 3, 2, 0, 0, 0))).toBe(86_400_000);
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
    setThemePreference({ mode: "default" }, { storage: memory() });
    expect(listener).not.toHaveBeenCalled();
  });

  test("logging out goes back to the built-in look", () => {
    const storage = memory();
    setThemeUser("alice", { storage });
    setThemePreference({ mode: "custom", color: "#2563eb" }, { storage });
    setThemeUser(null, { storage });
    expect(getThemeSnapshot().color).toBeNull();
  });
});
