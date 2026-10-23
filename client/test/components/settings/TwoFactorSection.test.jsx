import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { TwoFactorSection } from "../../../src/components/settings/security/TwoFactorSection.jsx";
import { stubFetchRoutes } from "./fetchRoutes.js";
import { textOf } from "./textOf.js";

const SECRET = "JBSWY3DPEHPK3PXP";
const SETUP = {
  secret: SECRET,
  otpauthUri: `otpauth://totp/Aurelle:alice?secret=${SECRET}&issuer=Aurelle&algorithm=SHA1&digits=6&period=30`,
  issuer: "Aurelle",
  account: "alice",
  digits: 6,
  period: 30,
};
const CODES = ["ABCDE-FGHJK", "KMNPQ-RSTUV", "WXYZ2-34567", "89ABC-DEFGH", "JKMNP-QRSTU", "VWXYZ-23456", "789AB-CDEFG", "HJKMN-PQRST", "UVWXY-Z2345", "6789A-BCDEF"];

afterEach(() => {
  vi.unstubAllGlobals();
});

const status = (over = {}) => [200, { available: true, enabled: false, enabledAt: null, recoveryCodesRemaining: 0, ...over }];
const typeInto = async (label, value) => {
  await page.getByLabelText(label).fill(value);
};

describe("TwoFactorSection - turning it on", () => {
  test("off by default, with an invitation to turn it on", async () => {
    stubFetchRoutes({ "GET /api/2fa": status() });
    render(<TwoFactorSection />);
    await expect.element(page.getByRole("button", { name: "Turn on two-factor authentication" })).toBeInTheDocument();
    await expect.element(page.getByText(/no email recovery/i)).toBeInTheDocument();
  });

  test("password, then the key and QR code, then one code, then the recovery codes (once)", async () => {
    const net = stubFetchRoutes({
      "GET /api/2fa": [status(), status({ enabled: true, enabledAt: "2026-03-10T10:00:00.000Z", recoveryCodesRemaining: 10 })],
      "POST /api/2fa/setup": [200, SETUP],
      "POST /api/2fa/enable": [200, { ok: true, enabled: true, recoveryCodes: CODES }],
    });
    render(<TwoFactorSection />);

    await page.getByRole("button", { name: "Turn on two-factor authentication" }).click();
    // step 1: the password again
    await typeInto("Current password", "secret123");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect.poll(() => net.called("POST /api/2fa/setup")[0]?.body).toEqual({ password: "secret123" });

    // step 2: the key (grouped), a QR code, the link, and the code field
    await expect.poll(textOf(page.getByTestId("totp-secret"))).toMatch(/JBSW Y3DP EHPK 3PXP/);
    await expect.element(page.getByRole("img", { name: /QR code/ })).toBeInTheDocument();
    await expect.element(page.getByRole("link", { name: "Open in authenticator app" })).toHaveAttribute("href", SETUP.otpauthUri);
    // Turn on stays disabled until six digits are typed
    await expect.element(page.getByRole("button", { name: "Turn on", exact: true })).toBeDisabled();
    await typeInto("2. Enter the 6-digit code it shows", "123 456");
    await page.getByRole("button", { name: "Turn on", exact: true }).click();
    await expect.poll(() => net.called("POST /api/2fa/enable")[0]?.body).toEqual({ code: "123456" });

    // step 3: the recovery codes, with a warning, and Done only after saying they were saved
    const box = page.getByTestId("recovery-codes");
    await expect.poll(textOf(box)).toMatch(/ABCDE-FGHJK/);
    await expect.poll(textOf(box)).toMatch(/6789A-BCDEF/);
    await expect.poll(textOf(box)).toMatch(/shown only once/i);
    await expect.element(page.getByRole("button", { name: "Done" })).toBeDisabled();
    await page.getByLabelText("I saved my recovery codes").click();
    await page.getByRole("button", { name: "Done" }).click();

    // back on the status view: on, with the count, and the codes are gone from the page
    await expect.element(page.getByText(/^On since/)).toBeInTheDocument();
    await expect.poll(textOf(page.getByTestId("recovery-remaining"))).toMatch(/10 recovery codes left/);
    await expect.element(page.getByText("ABCDE-FGHJK")).not.toBeInTheDocument();
    await expect.element(page.getByTestId("totp-secret")).not.toBeInTheDocument();
  });

  test("a wrong password stops at step one with the server's message", async () => {
    stubFetchRoutes({
      "GET /api/2fa": status(),
      "POST /api/2fa/setup": [401, { error: "Invalid credentials." }],
    });
    render(<TwoFactorSection />);
    await page.getByRole("button", { name: "Turn on two-factor authentication" }).click();
    await typeInto("Current password", "nope");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect.element(page.getByText("Invalid credentials.")).toBeInTheDocument();
    await expect.element(page.getByTestId("totp-secret")).not.toBeInTheDocument();
  });

  test("a wrong code keeps the setup open and says so", async () => {
    stubFetchRoutes({
      "GET /api/2fa": status(),
      "POST /api/2fa/setup": [200, SETUP],
      "POST /api/2fa/enable": [400, { error: "That code is not right. Check the time on your phone and try again." }],
    });
    render(<TwoFactorSection />);
    await page.getByRole("button", { name: "Turn on two-factor authentication" }).click();
    await typeInto("Current password", "secret123");
    await page.getByRole("button", { name: "Continue" }).click();
    await typeInto("2. Enter the 6-digit code it shows", "000000");
    await page.getByRole("button", { name: "Turn on", exact: true }).click();
    await expect.element(page.getByText(/That code is not right/)).toBeInTheDocument();
    await expect.element(page.getByTestId("totp-secret")).toBeInTheDocument();
  });

  test("cancelling the setup forgets the key", async () => {
    stubFetchRoutes({ "GET /api/2fa": status(), "POST /api/2fa/setup": [200, SETUP] });
    render(<TwoFactorSection />);
    await page.getByRole("button", { name: "Turn on two-factor authentication" }).click();
    await typeInto("Current password", "secret123");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect.element(page.getByTestId("totp-secret")).not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Turn on two-factor authentication" })).toBeInTheDocument();
  });

  test("a server that cannot offer it says so and shows no button", async () => {
    stubFetchRoutes({ "GET /api/2fa": status({ available: false }) });
    render(<TwoFactorSection />);
    await expect.element(page.getByText(/not available on this server/i)).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Turn on two-factor authentication" })).not.toBeInTheDocument();
  });
});

describe("TwoFactorSection - when it is on", () => {
  const on = (over = {}) => status({ enabled: true, enabledAt: "2026-03-10T10:00:00.000Z", recoveryCodesRemaining: 7, ...over });

  test("shows the state and how many recovery codes are left, warning when few remain", async () => {
    stubFetchRoutes({ "GET /api/2fa": on({ recoveryCodesRemaining: 1 }) });
    render(<TwoFactorSection />);
    await expect.poll(textOf(page.getByTestId("recovery-remaining"))).toMatch(/1 recovery code left/);
    await expect.element(page.getByRole("button", { name: "Turn off" })).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Get new recovery codes" })).toBeInTheDocument();
  });

  test("turning it off asks for the password and a code, then returns to the invitation", async () => {
    const net = stubFetchRoutes({
      "GET /api/2fa": [on(), status()],
      "POST /api/2fa/disable": [200, { ok: true, enabled: false }],
    });
    render(<TwoFactorSection />);
    await page.getByRole("button", { name: "Turn off" }).click();
    await expect.element(page.getByText(/only thing protecting this account/)).toBeInTheDocument();
    // the submit button is disabled until both are filled
    await expect.element(page.getByRole("button", { name: "Turn off" })).toBeDisabled();
    await typeInto("Current password", "secret123");
    await typeInto("Authentication code", "654 321");
    await page.getByRole("button", { name: "Turn off" }).click();
    await expect.poll(() => net.called("POST /api/2fa/disable")[0]?.body).toEqual({ password: "secret123", code: "654321" });
    await expect.element(page.getByRole("button", { name: "Turn on two-factor authentication" })).toBeInTheDocument();
  });

  test("a recovery code can be used instead of an authentication code", async () => {
    const net = stubFetchRoutes({
      "GET /api/2fa": [on(), status()],
      "POST /api/2fa/disable": [200, { ok: true }],
    });
    render(<TwoFactorSection />);
    await page.getByRole("button", { name: "Turn off" }).click();
    await page.getByRole("button", { name: "Use a recovery code instead" }).click();
    await typeInto("Current password", "secret123");
    await typeInto("Recovery code", "ABCDE-FGHJK");
    await page.getByRole("button", { name: "Turn off" }).click();
    await expect.poll(() => net.called("POST /api/2fa/disable")[0]?.body).toEqual({ password: "secret123", recoveryCode: "ABCDE-FGHJK" });
  });

  test("a wrong code keeps it on and shows the error", async () => {
    stubFetchRoutes({
      "GET /api/2fa": on(),
      "POST /api/2fa/disable": [401, { error: "Invalid code.", twoFactorRequired: true }],
    });
    render(<TwoFactorSection />);
    await page.getByRole("button", { name: "Turn off" }).click();
    await typeInto("Current password", "secret123");
    await typeInto("Authentication code", "000000");
    await page.getByRole("button", { name: "Turn off" }).click();
    await expect.element(page.getByText("Invalid code.")).toBeInTheDocument();
  });

  test("new recovery codes: password and code, then the new list once", async () => {
    const net = stubFetchRoutes({
      "GET /api/2fa": [on(), on({ recoveryCodesRemaining: 10 })],
      "POST /api/2fa/recovery-codes": [200, { ok: true, recoveryCodes: CODES }],
    });
    render(<TwoFactorSection />);
    await page.getByRole("button", { name: "Get new recovery codes" }).click();
    await expect.element(page.getByText(/Codes you saved before stop working/)).toBeInTheDocument();
    await typeInto("Current password", "secret123");
    await typeInto("Authentication code", "123456");
    await page.getByRole("button", { name: "Get new codes" }).click();
    await expect.poll(() => net.called("POST /api/2fa/recovery-codes")[0]?.body).toEqual({ password: "secret123", code: "123456" });
    await expect.element(page.getByText("Your new recovery codes")).toBeInTheDocument();
    await expect.poll(textOf(page.getByTestId("recovery-codes"))).toMatch(/ABCDE-FGHJK/);
  });

  test("mobile variant renders the same controls", async () => {
    stubFetchRoutes({ "GET /api/2fa": on() });
    render(<TwoFactorSection variant="mobile" />);
    await expect.element(page.getByRole("button", { name: "Turn off" })).toBeInTheDocument();
  });
});
