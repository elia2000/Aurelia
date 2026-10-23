import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import { ActiveSessionsSection } from "../../../src/components/settings/security/ActiveSessionsSection.jsx";
import { stubFetchRoutes } from "./fetchRoutes.js";
import { textOf } from "./textOf.js";

const NOW = Date.parse("2026-03-10T12:00:00Z");
const minutesAgo = (n) => new Date(NOW - n * 60_000).toISOString();

const session = (over = {}) => ({
  id: "s-current",
  current: true,
  device: "Firefox on Linux",
  browser: "Firefox",
  os: "Linux",
  method: "password",
  viaPassword: true,
  createdAt: "2026-03-01T08:00:00.000Z",
  lastSeenAt: minutesAgo(0),
  ...over,
});
const phone = (over = {}) =>
  session({ id: "s-phone", current: false, device: "Chrome on Android", os: "Android", browser: "Chrome", lastSeenAt: minutesAgo(5), method: "password_2fa", ...over });
const ipad = (over = {}) =>
  session({ id: "s-ipad", current: false, device: "Safari on iOS", os: "iOS", browser: "Safari", lastSeenAt: minutesAgo(60 * 30), ...over });

afterEach(() => {
  vi.unstubAllGlobals();
});

const renderSection = (props = {}) => render(<ActiveSessionsSection now={() => NOW} {...props} />);

describe("ActiveSessionsSection", () => {
  test("lists this device first with a badge and no sign-out button, then the others with when they were last active", async () => {
    stubFetchRoutes({ "GET /api/sessions": [200, { sessions: [session(), phone(), ipad()] }] });
    renderSection();

    const rows = page.getByTestId("session-row");
    await expect.poll(textOf(rows.first())).toMatch(/Firefox on Linux/);
    await expect.poll(textOf(rows.first())).toMatch(/This device/);
    await expect.poll(textOf(rows.first())).toMatch(/Active now/);
    await expect.poll(textOf(rows.nth(1))).toMatch(/Chrome on Android/);
    await expect.poll(textOf(rows.nth(1))).toMatch(/Last active 5 minutes ago/);
    await expect.poll(textOf(rows.nth(1))).toMatch(/Signed in with a password and a code/);
    await expect.poll(textOf(rows.nth(2))).toMatch(/Last active yesterday/);

    await expect.element(page.getByRole("button", { name: "Sign out Chrome on Android" })).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Sign out Safari on iOS" })).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Sign out Firefox on Linux" })).not.toBeInTheDocument();
  });

  test("says what is and is not kept (no IP address)", async () => {
    stubFetchRoutes({ "GET /api/sessions": [200, { sessions: [session()] }] });
    renderSection();
    await expect.element(page.getByText(/never an IP address/i)).toBeInTheDocument();
  });

  test("signing out one device asks the server and drops the row", async () => {
    const net = stubFetchRoutes({
      "GET /api/sessions": [200, { sessions: [session(), phone()] }],
      "DELETE /api/sessions/s-phone": [200, { ok: true }],
    });
    renderSection();
    await page.getByRole("button", { name: "Sign out Chrome on Android" }).click();
    await expect.poll(() => net.called("DELETE /api/sessions/s-phone").length).toBe(1);
    await expect.element(page.getByText("Chrome on Android")).not.toBeInTheDocument();
    await expect.element(page.getByText("Firefox on Linux")).toBeInTheDocument();
  });

  test("a device that is already gone (404) just disappears", async () => {
    stubFetchRoutes({
      "GET /api/sessions": [200, { sessions: [session(), phone()] }],
      "DELETE /api/sessions/s-phone": [404, { error: "Session not found." }],
    });
    renderSection();
    await page.getByRole("button", { name: "Sign out Chrome on Android" }).click();
    await expect.element(page.getByText("Chrome on Android")).not.toBeInTheDocument();
    await expect.element(page.getByText("Session not found.")).not.toBeInTheDocument();
  });

  test("a failed sign-out shows the server's message and keeps the row", async () => {
    stubFetchRoutes({
      "GET /api/sessions": [200, { sessions: [session(), phone()] }],
      "DELETE /api/sessions/s-phone": [500, { error: "Database busy." }],
    });
    renderSection();
    await page.getByRole("button", { name: "Sign out Chrome on Android" }).click();
    await expect.element(page.getByText("Database busy.")).toBeInTheDocument();
    await expect.element(page.getByText("Chrome on Android")).toBeInTheDocument();
  });

  test("'Sign out all other devices' asks first, then signs them all out and keeps this one", async () => {
    const net = stubFetchRoutes({
      "GET /api/sessions": [200, { sessions: [session(), phone(), ipad()] }],
      "POST /api/sessions/revoke-others": [200, { ok: true, revoked: 2 }],
    });
    renderSection();
    await page.getByRole("button", { name: "Sign out all other devices" }).click();

    // nothing happened yet: the confirm dialog says how many
    await expect.poll(textOf(page.getByRole("dialog"))).toMatch(/2 other devices/);
    expect(net.called("POST /api/sessions/revoke-others")).toHaveLength(0);

    await page.getByRole("dialog").getByRole("button", { name: "Sign out" }).click();
    await expect.poll(() => net.called("POST /api/sessions/revoke-others").length).toBe(1);
    await expect.element(page.getByText("Chrome on Android")).not.toBeInTheDocument();
    await expect.element(page.getByText("Safari on iOS")).not.toBeInTheDocument();
    await expect.element(page.getByText("Firefox on Linux")).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Sign out all other devices" })).not.toBeInTheDocument();
  });

  test("cancelling the confirmation changes nothing", async () => {
    const net = stubFetchRoutes({ "GET /api/sessions": [200, { sessions: [session(), phone()] }] });
    renderSection();
    await page.getByRole("button", { name: "Sign out all other devices" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    expect(net.called("POST /api/sessions/revoke-others")).toHaveLength(0);
    await expect.element(page.getByText("Chrome on Android")).toBeInTheDocument();
  });

  test("with only this device there is no 'sign out all' button", async () => {
    stubFetchRoutes({ "GET /api/sessions": [200, { sessions: [session()] }] });
    renderSection();
    await expect.element(page.getByText("This device")).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Sign out all other devices" })).not.toBeInTheDocument();
  });

  test("a list that fails to load says so", async () => {
    stubFetchRoutes({ "GET /api/sessions": [500, { error: "Unable to load." }] });
    renderSection();
    await expect.element(page.getByText("Unable to load.")).toBeInTheDocument();
  });

  test("refreshes when the window gets focus again (a device may have been signed out meanwhile)", async () => {
    const net = stubFetchRoutes({
      "GET /api/sessions": [
        [200, { sessions: [session(), phone()] }],
        [200, { sessions: [session()] }],
      ],
    });
    renderSection();
    await expect.element(page.getByText("Chrome on Android")).toBeInTheDocument();
    window.dispatchEvent(new Event("focus"));
    await expect.poll(() => net.called("GET /api/sessions").length).toBe(2);
    await expect.element(page.getByText("Chrome on Android")).not.toBeInTheDocument();
  });

  test("mobile variant renders the same list", async () => {
    stubFetchRoutes({ "GET /api/sessions": [200, { sessions: [session(), phone()] }] });
    renderSection({ variant: "mobile" });
    await expect.element(page.getByText("Chrome on Android")).toBeInTheDocument();
    await userEvent.tab();
  });
});
