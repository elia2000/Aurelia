import { ActiveSessionsSection } from "./ActiveSessionsSection.jsx";
import { TwoFactorSection } from "./TwoFactorSection.jsx";

/**
 * Account protection beyond the password: where you are signed in and
 * two-factor authentication. Shown under the password form in Settings ->
 * Security, in the desktop dialog and the mobile panel alike.
 */
export function SecuritySettingsPanel({ variant = "desktop" }) {
  return (
    <div
      className={`${variant === "mobile" ? "space-y-5" : "space-y-6"} border-t border-emerald-100/70 pt-5 dark:border-emerald-500/20`}
      data-testid="security-extras"
    >
      <TwoFactorSection variant={variant} />
      <ActiveSessionsSection variant={variant} />
    </div>
  );
}
