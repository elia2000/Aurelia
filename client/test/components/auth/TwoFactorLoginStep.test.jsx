import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import TwoFactorLoginStep from "../../../src/components/auth/TwoFactorLoginStep.jsx";
import AuthPage from "../../../src/pages/AuthPage.jsx";
import { stubFetchRoutes } from "../settings/fetchRoutes.js";
import { textOf } from "../settings/textOf.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const USER = { id: "u1", username: "alice", nickname: "Alice" };

function setup(extra = {}) {
  const props = { challenge: "chal.enge", onSuccess: vi.fn(), onRestart: vi.fn(), onCancel: vi.fn() };
  render(<TwoFactorLoginStep {...props} {...extra} />);
  return props;
}

describe("TwoFactorLoginStep", () => {
  test("sends the challenge and the code, then hands over the signed-in user", async () => {
    const net = stubFetchRoutes({ "POST /api/login/2fa": [200, USER] });
    const props = setup();
    await expect.element(page.getByLabelText("Authentication code")).toHaveFocus();
    await page.getByLabelText("Authentication code").fill("123 456");
    await page.getByRole("button", { name: "Verify" }).click();
    await expect.poll(() => net.called("POST /api/login/2fa")[0]?.body).toEqual({ challenge: "chal.enge", code: "123456" });
    await expect.poll(() => props.onSuccess.mock.calls.length).toBe(1);
    expect(props.onSuccess).toHaveBeenCalledWith(USER);
  });

  test("Verify stays disabled until something is typed", async () => {
    stubFetchRoutes({});
    setup();
    await expect.element(page.getByRole("button", { name: "Verify" })).toBeDisabled();
  });

  test("a wrong code shows the error and how many tries are left, and clears the box", async () => {
    stubFetchRoutes({ "POST /api/login/2fa": [401, { error: "Invalid code.", attemptsLeft: 3 }] });
    const props = setup();
    await page.getByLabelText("Authentication code").fill("000000");
    await page.getByRole("button", { name: "Verify" }).click();
    await expect.poll(textOf(page.getByRole("alert"))).toMatch(/Invalid code\. 3 tries left\./);
    await expect.element(page.getByLabelText("Authentication code")).toHaveValue("");
    expect(props.onSuccess).not.toHaveBeenCalled();
    expect(props.onRestart).not.toHaveBeenCalled();
  });

  test("the last try says '1 try left'", async () => {
    stubFetchRoutes({ "POST /api/login/2fa": [401, { error: "Invalid code.", attemptsLeft: 1 }] });
    setup();
    await page.getByLabelText("Authentication code").fill("000000");
    await page.getByRole("button", { name: "Verify" }).click();
    await expect.poll(textOf(page.getByRole("alert"))).toMatch(/1 try left/);
  });

  test("a locked or expired challenge sends the person back to the password", async () => {
    stubFetchRoutes({
      "POST /api/login/2fa": [429, { error: "Too many wrong codes. Enter your password again.", restart: true }],
    });
    const props = setup();
    await page.getByLabelText("Authentication code").fill("000000");
    await page.getByRole("button", { name: "Verify" }).click();
    await expect.poll(() => props.onRestart.mock.calls.length).toBe(1);
    expect(props.onRestart).toHaveBeenCalledWith("Too many wrong codes. Enter your password again.");
  });

  test("a recovery code is sent as a recovery code", async () => {
    const net = stubFetchRoutes({ "POST /api/login/2fa": [200, { ...USER, usedRecoveryCode: true, recoveryCodesRemaining: 9 }] });
    setup();
    await page.getByRole("button", { name: "Use a recovery code" }).click();
    await expect.element(page.getByLabelText("Recovery code")).toBeInTheDocument();
    await page.getByLabelText("Recovery code").fill("ABCDE-FGHJK");
    await page.getByRole("button", { name: "Verify" }).click();
    await expect.poll(() => net.called("POST /api/login/2fa")[0]?.body).toEqual({ challenge: "chal.enge", recoveryCode: "ABCDE-FGHJK" });
  });

  test("'Back to sign in' cancels", async () => {
    stubFetchRoutes({});
    const props = setup();
    await page.getByRole("button", { name: "Back to sign in" }).click();
    expect(props.onCancel).toHaveBeenCalled();
  });

  test("works inside the sign-in card with the step's own title", async () => {
    stubFetchRoutes({});
    render(
      <AuthPage mode="login" isDark={false} onToggleTheme={() => {}} onSubmit={() => {}} onSwitchMode={() => {}} status="" title="Two-step verification" subtitle="Second proof">
        <TwoFactorLoginStep challenge="c" onSuccess={() => {}} onRestart={() => {}} onCancel={() => {}} />
      </AuthPage>,
    );
    await expect.element(page.getByText("Two-step verification")).toBeInTheDocument();
    await expect.element(page.getByLabelText("Authentication code")).toBeInTheDocument();
    // no password field, no 'Create account' link while the second step is open
    await expect.element(page.getByLabelText("Password")).not.toBeInTheDocument();
  });

  test("the sign-in page can carry a short notice (signed out from another device)", async () => {
    render(
      <AuthPage mode="login" isDark={false} onToggleTheme={() => {}} onSubmit={() => {}} onSwitchMode={() => {}} status="" notice="You were signed out from another device. Sign in again to continue." />,
    );
    await expect.poll(textOf(page.getByTestId("auth-notice"))).toMatch(/signed out from another device/);
  });
});
