import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import AdminUserModal from "../../../src/components/admin/AdminUserModal.jsx";
import UsersTab from "../../../src/components/admin/UsersTab.jsx";
import { stubFetchRoutes } from "../settings/fetchRoutes.js";
import { textOf } from "../settings/textOf.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const USER_ID = "a0000000-0000-4000-8000-000000000001";
const user = (over = {}) => ({
  id: USER_ID,
  username: "bob",
  nickname: "Bob",
  avatar_url: null,
  color: "#3b82f6",
  role: "user",
  verified: false,
  banned: false,
  two_factor: 1,
  ...over,
});

describe("AdminUserModal - two-factor reset", () => {
  test("a user with 2FA offers a reset that asks first, calls the endpoint and then says it is off", async () => {
    const net = stubFetchRoutes({ [`POST /api/admin/users/${USER_ID}/reset-2fa`]: [200, { ok: true }] });
    const onSaved = vi.fn();
    render(<AdminUserModal mode="edit" user={user()} onClose={() => {}} onSaved={onSaved} />);

    const box = page.getByTestId("admin-two-factor");
    await expect.poll(textOf(box)).toMatch(/On\. If this user lost/);
    await page.getByRole("button", { name: "Reset two-factor" }).click();

    // nothing was sent yet: the confirmation explains the effect
    await expect.poll(textOf(page.getByRole("dialog"))).toMatch(/signed out of all sessions/);
    expect(net.called(`POST /api/admin/users/${USER_ID}/reset-2fa`)).toHaveLength(0);
    await page.getByRole("dialog").getByRole("button", { name: "Reset" }).click();

    await expect.poll(() => net.called(`POST /api/admin/users/${USER_ID}/reset-2fa`).length).toBe(1);
    await expect.poll(textOf(box)).toMatch(/Off\. This user signs in with their password only/);
    await expect.element(page.getByRole("button", { name: "Reset two-factor" })).not.toBeInTheDocument();
    expect(onSaved).toHaveBeenCalled();
  });

  test("a user without 2FA shows it as off and offers no reset", async () => {
    stubFetchRoutes({});
    render(<AdminUserModal mode="edit" user={user({ two_factor: 0 })} onClose={() => {}} onSaved={() => {}} />);
    await expect.poll(textOf(page.getByTestId("admin-two-factor"))).toMatch(/Off\./);
    await expect.element(page.getByRole("button", { name: "Reset two-factor" })).not.toBeInTheDocument();
  });

  test("a failed reset keeps it on and shows the server's reason", async () => {
    stubFetchRoutes({ [`POST /api/admin/users/${USER_ID}/reset-2fa`]: [403, { error: "Cannot reset the owner's two-factor authentication." }] });
    render(<AdminUserModal mode="edit" user={user()} onClose={() => {}} onSaved={() => {}} />);
    await page.getByRole("button", { name: "Reset two-factor" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Reset" }).click();
    await expect.element(page.getByText(/Cannot reset the owner/)).toBeInTheDocument();
    await expect.poll(textOf(page.getByTestId("admin-two-factor"))).toMatch(/On\./);
  });

  test("creating a user shows no two-factor section", async () => {
    stubFetchRoutes({});
    render(<AdminUserModal mode="create" onClose={() => {}} onSaved={() => {}} />);
    await expect.element(page.getByTestId("admin-two-factor")).not.toBeInTheDocument();
  });
});

describe("UsersTab - who has two-factor on", () => {
  test("shows a key icon next to people with 2FA only", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            users: [user({ id: "u-a", username: "withtf", nickname: "With", two_factor: 1 }), user({ id: "u-b", username: "without", nickname: "Without", two_factor: 0 })],
            total: 2,
          }),
      }),
    );
    render(<UsersTab currentUser={{ id: "me", username: "me", role: "owner" }} active onMutated={() => {}} onStatsChange={() => {}} />);
    await expect.element(page.getByText("With", { exact: true }).first()).toBeInTheDocument();
    // desktop table and mobile cards each render one icon for the person who has it
    const icons = document.querySelectorAll('[aria-label="Two-factor authentication on"]');
    expect(icons.length).toBeGreaterThan(0);
    expect(icons.length % 1).toBe(0);
    const names = [...document.querySelectorAll('[aria-label="Two-factor authentication on"]')].map(
      (icon) => icon.closest("div")?.textContent || "",
    );
    expect(names.some((text) => text.includes("Without"))).toBe(false);
  });
});
