import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { AppearanceSettingsPanel } from "../../../src/components/settings/panels/AppearanceSettingsPanel.jsx";
import { useThemeColor } from "../../../src/hooks/useThemeColor.js";
import { resetThemeStore, setThemePalette, getThemeSnapshot } from "../../../src/utils/themeStore.js";
import { dailyColor } from "../../../src/utils/themeColor.js";

function App({ user = "alice", onDone }) {
  useThemeColor(user);
  return <AppearanceSettingsPanel onDone={onDone} />;
}

const accent = () => document.documentElement.style.getPropertyValue("--color-emerald-500");

beforeEach(() => {
  localStorage.clear();
  resetThemeStore();
  document.documentElement.removeAttribute("style");
});
afterEach(() => {
  document.documentElement.removeAttribute("style");
});

describe("AppearanceSettingsPanel", () => {
  test("offers Default, Random and one swatch for each colour of the palette", async () => {
    setThemePalette(["#ff0000", "#00ff00", "#0000ff"]);
    render(<App />);
    await expect.element(page.getByRole("button", { name: "Default" })).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: /Random/ })).toBeInTheDocument();
    expect(document.querySelectorAll('[role="group"] button')).toHaveLength(3);
    expect(accent()).toBe(""); // nothing chosen: the built-in look
  });

  test("choosing a colour re-themes the app at once and is remembered for this person", async () => {
    setThemePalette(["#ff0000", "#00ff00", "#2563eb"]);
    render(<App />);
    await page.getByRole("button", { name: "Use #2563eb" }).click();
    await expect.poll(accent).toBe("#2563eb");
    await expect.element(page.getByRole("button", { name: "Use #2563eb" })).toHaveAttribute("aria-pressed", "true");
    expect(JSON.parse(localStorage.getItem("aurelle-theme-color:alice"))).toEqual({ mode: "custom", color: "#2563eb" });
  });

  test("Random uses today's colour from the palette and says which it is", async () => {
    const palette = ["#ff0000", "#00ff00", "#0000ff"];
    setThemePalette(palette);
    render(<App />);
    await page.getByRole("button", { name: /Random/ }).click();
    const today = dailyColor(palette, "alice");
    await expect.poll(accent).toBe(today);
    await expect.element(page.getByText(new RegExp(`today ${today}`))).toBeInTheDocument();
    expect(getThemeSnapshot().preference.mode).toBe("random");
  });

  test("Default puts the built-in look back", async () => {
    setThemePalette(["#ff0000"]);
    render(<App />);
    await page.getByRole("button", { name: "Use #ff0000" }).click();
    await expect.poll(accent).toBe("#ff0000");
    await page.getByRole("button", { name: "Default" }).click();
    await expect.poll(accent).toBe("");
  });

  test("a colour of your own can be picked", async () => {
    render(<App />);
    const input = page.getByLabelText("Pick your own colour");
    await input.fill("#8844cc");
    await expect.poll(accent).toBe("#8844cc");
  });

  test("the choice is per person: bob does not inherit alice's colour", async () => {
    setThemePalette(["#ff0000"]);
    const { unmount } = await render(<App user="alice" />);
    await page.getByRole("button", { name: "Use #ff0000" }).click();
    await expect.poll(accent).toBe("#ff0000");
    unmount();
    render(<App user="bob" />);
    await expect.poll(accent).toBe("");
  });
});
