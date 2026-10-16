import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { AppearanceSettingsPanel } from "../../../src/components/settings/panels/AppearanceSettingsPanel.jsx";
import { useThemeColor } from "../../../src/hooks/useThemeColor.js";
import { resetThemeStore, setThemeDefault, setThemePalette, getThemeSnapshot } from "../../../src/utils/themeStore.js";
import { colorScale, dailyColor } from "../../../src/utils/themeColor.js";

function App({ user = "alice", onDone }) {
  useThemeColor(user);
  return <AppearanceSettingsPanel onDone={onDone} />;
}

const accent = () => document.documentElement.style.getPropertyValue("--color-emerald-500");
// What the app's accent becomes for a colour (a colour too light or too dark is eased a little, so it is not always the colour itself).
const accentOf = (color) => colorScale(color)[500];

beforeEach(() => {
  localStorage.clear();
  resetThemeStore();
  document.documentElement.removeAttribute("style");
});
afterEach(() => {
  document.documentElement.removeAttribute("style");
});

describe("AppearanceSettingsPanel", () => {
  test("offers Default, Random, the built-in green and one swatch for each colour of the palette", async () => {
    setThemePalette(["#ff0000", "#00ff00", "#0000ff"]);
    render(<App />);
    await expect.element(page.getByRole("button", { name: /^Default/ })).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: /^Random/ })).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Built-in green" })).toBeInTheDocument();
    expect(document.querySelectorAll('[role="group"] button')).toHaveLength(3);
  });

  test("nothing chosen means the server's default, which is Random: today's colour", async () => {
    setThemePalette(["#ff0000", "#00ff00", "#0000ff"]);
    render(<App />);
    await expect.poll(accent).toBe(accentOf(dailyColor(["#ff0000", "#00ff00", "#0000ff"])));
    await expect.element(page.getByRole("button", { name: /^Default/ })).toHaveAttribute("aria-pressed", "true");
    await expect.element(page.getByText(/A new colour every day · today/)).toBeInTheDocument();
  });

  test("a colour too bright for white text is eased, whichever day it is", async () => {
    setThemePalette(["#00ff00"]); // every day is #00ff00
    render(<App />);
    await expect.poll(accent).toBe(accentOf("#00ff00"));
    expect(accentOf("#00ff00")).not.toBe("#00ff00");
  });

  test("when the server's default is one colour, Default says so and uses it", async () => {
    setThemeDefault("#2563eb");
    render(<App />);
    await expect.poll(accent).toBe(accentOf("#2563eb"));
    await expect.element(page.getByRole("button", { name: /^Default.*#2563eb/ })).toBeInTheDocument();
  });

  test("choosing a colour re-themes the app at once and is remembered for this person", async () => {
    setThemePalette(["#ff0000", "#00ff00", "#2563eb"]);
    render(<App />);
    await page.getByRole("button", { name: "Use #2563eb" }).click();
    await expect.poll(accent).toBe(accentOf("#2563eb"));
    await expect.element(page.getByRole("button", { name: "Use #2563eb" })).toHaveAttribute("aria-pressed", "true");
    expect(JSON.parse(localStorage.getItem("aurelle-theme-color:alice"))).toEqual({ mode: "custom", color: "#2563eb" });
  });

  test("Random uses today's colour from the palette and says which it is", async () => {
    const palette = ["#ff0000", "#00ff00", "#0000ff"];
    setThemePalette(palette);
    render(<App />);
    await page.getByRole("button", { name: /Random/ }).click();
    const today = dailyColor(palette);
    await expect.poll(accent).toBe(accentOf(today));
    await expect.element(page.getByRole("button", { name: new RegExp(`^Random.*today ${today}`) })).toBeInTheDocument();
    expect(getThemeSnapshot().preference.mode).toBe("random");
  });

  test("Default goes back to the server's default and Built-in green is a choice of its own", async () => {
    const palette = ["#ff0000"];
    setThemePalette(palette);
    setThemeDefault("#2563eb");
    render(<App />);
    await page.getByRole("button", { name: "Use #ff0000" }).click();
    await expect.poll(accent).toBe(accentOf("#ff0000"));
    await page.getByRole("button", { name: /^Default/ }).click();
    await expect.poll(accent).toBe(accentOf("#2563eb"));
    await page.getByRole("button", { name: "Built-in green" }).click();
    await expect.poll(accent).toBe("");
    expect(JSON.parse(localStorage.getItem("aurelle-theme-color:alice"))).toEqual({ mode: "default" });
  });

  test("a colour of your own can be picked", async () => {
    render(<App />);
    const input = page.getByLabelText("Pick your own colour");
    await input.fill("#8844cc");
    await expect.poll(accent).toBe(accentOf("#8844cc"));
  });

  test("the choice is per person: bob does not inherit alice's colour", async () => {
    setThemePalette(["#ff0000"]);
    const { unmount } = await render(<App user="alice" />);
    await page.getByRole("button", { name: "Use #ff0000" }).click();
    await expect.poll(accent).toBe(accentOf("#ff0000"));
    unmount();
    render(<App user="bob" />);
    await expect.poll(accent).toBe(accentOf(dailyColor(["#ff0000"]))); // bob never chose: he gets the default
  });
});
