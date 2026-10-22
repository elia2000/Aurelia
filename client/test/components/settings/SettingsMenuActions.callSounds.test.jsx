import { describe, test, expect, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { SettingsMenuActions } from "../../../src/components/settings/menus/SettingsMenuActions.jsx";
import { CallContext } from "../../../src/calls/callContext.js";

const menu = (supported, setSettingsPanel = vi.fn()) =>
  render(
    <CallContext.Provider value={{ supported }}>
      <SettingsMenuActions setSettingsPanel={setSettingsPanel} isDark={false} toggleTheme={() => {}} />
    </CallContext.Provider>,
  );

describe("the Call sounds entry of the settings menu", () => {
  test("is there where calls work, and opens the sounds panel", async () => {
    const setSettingsPanel = vi.fn();
    menu(true, setSettingsPanel);
    await page.getByRole("button", { name: "Call sounds" }).click();
    expect(setSettingsPanel).toHaveBeenCalledWith("sounds");
  });

  test("is not offered where calls are not available (nothing there could ring)", async () => {
    menu(false);
    await expect.element(page.getByRole("button", { name: "Edit profile" })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("Call sounds");
  });
});
