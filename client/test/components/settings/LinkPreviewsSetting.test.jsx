import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import { AppearanceSettingsPanel } from "../../../src/components/settings/panels/AppearanceSettingsPanel.jsx";
import LinkPreviewsSetting from "../../../src/components/settings/common/LinkPreviewsSetting.jsx";
import {
  LINK_PREVIEW_PREF_KEY,
  getLinkPreviewPrefs,
  setLinkPreviewChoice,
  setLinkPreviewsServerEnabled,
} from "../../../src/utils/linkPreviewPrefs.js";

beforeEach(() => {
  localStorage.clear();
  setLinkPreviewChoice(null);
  setLinkPreviewsServerEnabled(true);
});
afterEach(() => {
  localStorage.clear();
  setLinkPreviewChoice(null);
  setLinkPreviewsServerEnabled(false);
});

const switchEl = () => page.getByRole("switch", { name: /Show link previews/ });

describe("the 'Show link previews' switch", () => {
  test.each(["desktop", "mobile"])("the %s Appearance panel has it, on to begin with (it follows the server)", async (variant) => {
    render(<AppearanceSettingsPanel variant={variant} />);
    await expect.element(switchEl()).toBeInTheDocument();
    await expect.element(switchEl()).toHaveAttribute("aria-checked", "true");
    expect(localStorage.getItem(LINK_PREVIEW_PREF_KEY)).toBeNull();
  });

  test("says what it does in a line", async () => {
    render(<LinkPreviewsSetting />);
    await expect.element(page.getByText(/your device never contacts that site/)).toBeVisible();
  });

  test("is not there when the server has link previews off (nothing to choose)", async () => {
    setLinkPreviewsServerEnabled(false);
    render(<AppearanceSettingsPanel />);
    await expect.element(page.getByRole("radio", { name: "Large" })).toBeInTheDocument(); // the panel itself is there
    expect(document.querySelector('[role="switch"]')).toBeNull();
  });

  test("turning it off applies at once and is remembered on this device", async () => {
    render(<LinkPreviewsSetting />);
    await switchEl().click();
    await expect.element(switchEl()).toHaveAttribute("aria-checked", "false");
    expect(getLinkPreviewPrefs().enabled).toBe(false);
    expect(localStorage.getItem(LINK_PREVIEW_PREF_KEY)).toBe("0");
    await switchEl().click();
    await expect.element(switchEl()).toHaveAttribute("aria-checked", "true");
    expect(getLinkPreviewPrefs().enabled).toBe(true);
    expect(localStorage.getItem(LINK_PREVIEW_PREF_KEY)).toBe("1");
  });

  test("opens as it was left", async () => {
    setLinkPreviewChoice(false);
    render(<LinkPreviewsSetting />);
    await expect.element(switchEl()).toHaveAttribute("aria-checked", "false");
  });

  test("appears when the server's answer arrives after the panel is open", async () => {
    setLinkPreviewsServerEnabled(false);
    render(<LinkPreviewsSetting />);
    expect(document.querySelector('[role="switch"]')).toBeNull();
    setLinkPreviewsServerEnabled(true);
    await expect.element(switchEl()).toBeInTheDocument();
  });

  test("can be reached and used with the keyboard", async () => {
    await render(<LinkPreviewsSetting />);
    await userEvent.tab();
    await expect.element(switchEl()).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect.element(switchEl()).toHaveAttribute("aria-checked", "false");
    await userEvent.keyboard(" ");
    await expect.element(switchEl()).toHaveAttribute("aria-checked", "true");
  });
});
