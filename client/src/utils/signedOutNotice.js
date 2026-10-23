// A short note left for the sign-in page when the app was signed out by
// something other than the person pressing "Log out" on this device: another
// device ended this session, an admin acted, the password was changed.
// sessionStorage only (it is gone with the tab) and every access is guarded.

const KEY = "aurelle-signed-out-notice";

export const SIGNED_OUT_MESSAGES = Object.freeze({
  signed_out: "You were signed out from another device. Sign in again to continue.",
  password_changed: "Your password was changed, so this device was signed out. Sign in with the new password.",
  password_reset: "An administrator reset your password. Sign in with the new one.",
  two_factor_reset: "An administrator reset your two-factor authentication. Sign in again.",
  banned: "This account has been banned.",
  account_deleted: "This account was deleted.",
  default: "You were signed out. Sign in again to continue.",
});

export function noticeMessage(reason) {
  return SIGNED_OUT_MESSAGES[reason] || SIGNED_OUT_MESSAGES.default;
}

export function rememberSignedOutNotice(reason) {
  try {
    window.sessionStorage.setItem(KEY, String(reason || "default"));
  } catch {
    // no storage: the sign-in page simply shows no note
  }
}

/** The pending note as text (and forgets it), or "" when there is none. */
export function takeSignedOutNotice() {
  try {
    const reason = window.sessionStorage.getItem(KEY);
    if (!reason) return "";
    window.sessionStorage.removeItem(KEY);
    return noticeMessage(reason);
  } catch {
    return "";
  }
}
