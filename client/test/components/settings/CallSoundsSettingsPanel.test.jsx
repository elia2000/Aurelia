import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import { CallSoundsSettingsPanel } from "../../../src/components/settings/panels/CallSoundsSettingsPanel.jsx";
import { callSounds } from "../../../src/calls/callSounds.js";
import { CALL_SOUND_KEYS, getCallSoundPrefs, reloadCallSoundPrefs } from "../../../src/calls/callSoundPrefs.js";
import { CALL_SHORTCUT_KEY, getCallShortcutsEnabled, reloadCallShortcutsEnabled } from "../../../src/calls/callShortcutPrefs.js";

const sounds = () => page.getByRole("switch", { name: /^Call sounds/ });
const vibration = () => page.getByRole("switch", { name: /^Vibrate on incoming calls/ });
const volume = () => page.getByRole("slider", { name: "Ringtone volume" });
const testButton = () => page.getByRole("button", { name: "Play test sound" });
const keys = () => page.getByRole("switch", { name: /^Call keyboard shortcuts/ });

beforeEach(() => {
  localStorage.clear();
  reloadCallSoundPrefs();
  reloadCallShortcutsEnabled();
});
afterEach(() => {
  vi.restoreAllMocks();
  delete navigator.vibrate; // drops a stub placed on the instance; the browser's own stays
});

describe("the Call sounds settings", () => {
  test.each(["desktop", "mobile"])("the %s panel starts with sounds on, 70% and vibration on", async (variant) => {
    render(<CallSoundsSettingsPanel variant={variant} />);
    await expect.element(sounds()).toHaveAttribute("aria-checked", "true");
    await expect.element(volume()).toHaveValue("70");
    await expect.element(page.getByText("70%")).toBeInTheDocument();
    await expect.element(vibration()).toHaveAttribute("aria-checked", "true");
    await expect.element(testButton()).toBeEnabled();
  });

  test("switching sounds off is remembered on this device and greys out the volume and the test", async () => {
    render(<CallSoundsSettingsPanel />);
    await sounds().click();
    await expect.element(sounds()).toHaveAttribute("aria-checked", "false");
    expect(localStorage.getItem(CALL_SOUND_KEYS.enabled)).toBe("0");
    expect(getCallSoundPrefs().enabled).toBe(false);
    await expect.element(volume()).toBeDisabled();
    await expect.element(testButton()).toBeDisabled();

    await sounds().click();
    await expect.element(sounds()).toHaveAttribute("aria-checked", "true");
    await expect.element(volume()).toBeEnabled();
    expect(localStorage.getItem(CALL_SOUND_KEYS.enabled)).toBe("1");
  });

  test("the slider changes the ringtone volume at once and is remembered", async () => {
    render(<CallSoundsSettingsPanel />);
    await expect.element(volume()).toBeInTheDocument();
    volume().element().focus(); // a click would move the thumb to where it lands
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
    await expect.element(volume()).toHaveValue("60");
    await expect.element(page.getByText("60%")).toBeInTheDocument();
    expect(getCallSoundPrefs().volume).toBe(60);
    expect(localStorage.getItem(CALL_SOUND_KEYS.volume)).toBe("60");
  });

  test("the slider goes from 0 to 100", async () => {
    render(<CallSoundsSettingsPanel />);
    await expect.element(volume()).toHaveAttribute("min", "0");
    await expect.element(volume()).toHaveAttribute("max", "100");
  });

  test("vibration can be switched off on its own", async () => {
    render(<CallSoundsSettingsPanel />);
    await vibration().click();
    await expect.element(vibration()).toHaveAttribute("aria-checked", "false");
    expect(localStorage.getItem(CALL_SOUND_KEYS.vibrate)).toBe("0");
    expect(getCallSoundPrefs().enabled).toBe(true);
    await expect.element(sounds()).toHaveAttribute("aria-checked", "true");
  });

  test("no vibration switch where the device cannot vibrate", async () => {
    Object.defineProperty(navigator, "vibrate", { value: undefined, configurable: true });
    render(<CallSoundsSettingsPanel />);
    await expect.element(sounds()).toBeInTheDocument();
    // (Call sounds, and the call keyboard shortcuts: only the vibration switch is missing.)
    expect([...document.querySelectorAll('[role="switch"]')].map((el) => el.textContent.slice(0, 11))).toEqual(["Call sounds", "Call keyboa"]);
  });

  test("shows what was saved earlier", async () => {
    localStorage.setItem(CALL_SOUND_KEYS.enabled, "0");
    localStorage.setItem(CALL_SOUND_KEYS.volume, "25");
    localStorage.setItem(CALL_SOUND_KEYS.vibrate, "0");
    reloadCallSoundPrefs();
    render(<CallSoundsSettingsPanel />);
    await expect.element(sounds()).toHaveAttribute("aria-checked", "false");
    await expect.element(volume()).toHaveValue("25");
    await expect.element(vibration()).toHaveAttribute("aria-checked", "false");
  });

  test("Play test sound plays the ringtone once from the tap itself", async () => {
    const play = vi.spyOn(callSounds, "playTest").mockResolvedValue(true);
    render(<CallSoundsSettingsPanel />);
    await testButton().click();
    expect(play).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="status"]')).toBeNull();
  });

  test("says so when the browser would not play it", async () => {
    vi.spyOn(callSounds, "playTest").mockResolvedValue(false);
    render(<CallSoundsSettingsPanel />);
    await testButton().click();
    await expect.element(page.getByRole("status")).toBeInTheDocument();
    expect(page.getByRole("status").element().textContent).toContain("play a sound");
    vi.spyOn(callSounds, "playTest").mockResolvedValue(true);
    await testButton().click();
    await expect.poll(() => document.querySelector('[role="status"]')).toBeNull();
  });

  test("a volume of 0 on purpose is not reported as a failure", async () => {
    localStorage.setItem(CALL_SOUND_KEYS.volume, "0");
    reloadCallSoundPrefs();
    vi.spyOn(callSounds, "playTest").mockResolvedValue(false);
    render(<CallSoundsSettingsPanel />);
    await testButton().click();
    expect(document.querySelector('[role="status"]')).toBeNull();
  });

  test("Done closes the panel", async () => {
    const onDone = vi.fn();
    render(<CallSoundsSettingsPanel onDone={onDone} />);
    await page.getByRole("button", { name: "Done" }).click();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  test.each(["desktop", "mobile"])("the %s panel has a switch for the call's keyboard shortcuts, on by default", async (variant) => {
    render(<CallSoundsSettingsPanel variant={variant} />);
    await expect.element(keys()).toHaveAttribute("aria-checked", "true");
    // It says which keys it means and what it leaves alone.
    const text = keys().element().textContent;
    for (const part of ["M, V, S, P and F", "Esc, ? and Shift+H are not affected"]) expect(text).toContain(part);
  });

  test("it is a switch of its own: sounds and vibration are not touched", async () => {
    render(<CallSoundsSettingsPanel />);
    await keys().click();
    await expect.element(keys()).toHaveAttribute("aria-checked", "false");
    expect(localStorage.getItem(CALL_SHORTCUT_KEY)).toBe("0");
    expect(getCallShortcutsEnabled()).toBe(false);
    await expect.element(sounds()).toHaveAttribute("aria-checked", "true");
    await expect.element(volume()).toBeEnabled();
    expect(getCallSoundPrefs().enabled).toBe(true);
    await keys().click();
    await expect.element(keys()).toHaveAttribute("aria-checked", "true");
    expect(localStorage.getItem(CALL_SHORTCUT_KEY)).toBe("1");
  });

  test("and switching call sounds off leaves the shortcuts on", async () => {
    render(<CallSoundsSettingsPanel />);
    await sounds().click();
    await expect.element(keys()).toHaveAttribute("aria-checked", "true");
    await expect.element(keys()).toBeEnabled();
  });

  test("it shows what was saved earlier, and follows a change made elsewhere (the call's own settings)", async () => {
    localStorage.setItem(CALL_SHORTCUT_KEY, "0");
    reloadCallShortcutsEnabled();
    render(<CallSoundsSettingsPanel />);
    await expect.element(keys()).toHaveAttribute("aria-checked", "false");
    localStorage.setItem(CALL_SHORTCUT_KEY, "1");
    reloadCallShortcutsEnabled();
    await expect.element(keys()).toHaveAttribute("aria-checked", "true");
  });
});
