import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { DesktopSettingsModal } from "../../../src/components/settings/modals/DesktopSettingsModal.jsx";
import { MobileSettingsPanel } from "../../../src/components/settings/panels/MobileSettingsPanel.jsx";
import { stubFetchRoutes } from "./fetchRoutes.js";

const SESSIONS = {
  sessions: [
    { id: "s1", current: true, device: "Firefox on Linux", browser: "Firefox", os: "Linux", method: "password", viaPassword: true, createdAt: "2026-03-01T08:00:00.000Z", lastSeenAt: new Date().toISOString() },
    { id: "s2", current: false, device: "Chrome on Android", browser: "Chrome", os: "Android", method: "password", viaPassword: true, createdAt: "2026-03-02T08:00:00.000Z", lastSeenAt: new Date(Date.now() - 3 * 3600_000).toISOString() },
  ],
};

const routes = (twoFactor = {}) => ({
  "GET /api/sessions": [200, SESSIONS],
  "GET /api/2fa": [200, { available: true, enabled: false, enabledAt: null, recoveryCodesRemaining: 0, ...twoFactor }],
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const baseProps = (over = {}) => ({
  settingsPanel: "security",
  setSettingsPanel: vi.fn(),
  profileForm: { nickname: "Alice", username: "alice" },
  setProfileForm: vi.fn(),
  passwordForm: { currentPassword: "", newPassword: "", confirmPassword: "", twoFactorCode: "", needsTwoFactor: false },
  setPasswordForm: vi.fn(),
  handlePasswordSave: vi.fn((event) => event.preventDefault()),
  passwordError: "",
  ...over,
});

describe("Settings -> Security (desktop dialog)", () => {
  test("keeps the password form and adds two-factor and active sessions under it", async () => {
    stubFetchRoutes(routes());
    render(<DesktopSettingsModal {...baseProps()} currentUser={{ username: "alice" }} />);
    await expect.element(page.getByRole("button", { name: "Update password" })).toBeInTheDocument();
    await expect.element(page.getByText("Two-factor authentication", { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText("Active sessions", { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText("Chrome on Android")).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Sign out Chrome on Android" })).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Turn on two-factor authentication" })).toBeInTheDocument();
  });

  test("no form is nested inside another (two-factor forms live outside the password form)", async () => {
    stubFetchRoutes(routes());
    render(<DesktopSettingsModal {...baseProps()} currentUser={{ username: "alice" }} />);
    await page.getByRole("button", { name: "Turn on two-factor authentication" }).click();
    await expect.element(page.getByLabelText("Current password").last()).toBeInTheDocument();
    expect(document.querySelectorAll("form form")).toHaveLength(0);
  });

  test("asks for the authentication code in the password form once the server wants one", async () => {
    stubFetchRoutes(routes());
    const props = baseProps({
      passwordForm: { currentPassword: "a", newPassword: "bbbbbb", confirmPassword: "bbbbbb", twoFactorCode: "", needsTwoFactor: true },
    });
    render(<DesktopSettingsModal {...props} currentUser={{ username: "alice" }} />);
    await expect.element(page.getByLabelText("Authentication code").first()).toBeInTheDocument();
    await expect.element(page.getByText(/recovery code/i).first()).toBeInTheDocument();
  });

  test("the code field is not there until needed", async () => {
    stubFetchRoutes(routes());
    render(<DesktopSettingsModal {...baseProps()} currentUser={{ username: "alice" }} />);
    await expect.element(page.getByText("Active sessions", { exact: true })).toBeInTheDocument();
    await expect.element(page.getByLabelText("Authentication code")).not.toBeInTheDocument();
  });

  test("the Profile panel is untouched: no security sections there", async () => {
    stubFetchRoutes(routes());
    render(<DesktopSettingsModal {...baseProps({ settingsPanel: "profile" })} currentUser={{ username: "alice" }} />);
    await expect.element(page.getByText("Active sessions", { exact: true })).not.toBeInTheDocument();
  });
});

describe("Settings -> Security (mobile panel)", () => {
  const mobileProps = (over = {}) => ({
    ...baseProps(over),
    user: { username: "alice", nickname: "Alice", role: "user" },
    displayName: "Alice",
    statusTextClass: "",
    statusValue: "online",
    handleLogout: vi.fn(),
    statusSelection: "online",
    setStatusSelection: vi.fn(),
    avatarPreview: "",
    handleProfileSave: vi.fn(),
    handleAvatarChange: vi.fn(),
    handleAvatarRemove: vi.fn(),
  });

  test("shows the same sessions and two-factor sections", async () => {
    stubFetchRoutes(routes({ enabled: true, enabledAt: "2026-03-10T10:00:00.000Z", recoveryCodesRemaining: 9 }));
    render(<MobileSettingsPanel {...mobileProps()} />);
    await expect.element(page.getByText("Active sessions", { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText("Chrome on Android")).toBeInTheDocument();
    await expect.element(page.getByTestId("recovery-remaining")).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Turn off" })).toBeInTheDocument();
    expect(document.querySelectorAll("form form")).toHaveLength(0);
  });

  test("asks for the authentication code in the password form once the server wants one", async () => {
    stubFetchRoutes(routes());
    render(
      <MobileSettingsPanel
        {...mobileProps({
          passwordForm: { currentPassword: "a", newPassword: "bbbbbb", confirmPassword: "bbbbbb", twoFactorCode: "", needsTwoFactor: true },
        })}
      />,
    );
    await expect.element(page.getByLabelText("Authentication code").first()).toBeInTheDocument();
  });
});
