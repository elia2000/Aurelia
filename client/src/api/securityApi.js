import { apiFetch } from "./chatApi.js";

const API_BASE = "";

// Every call resolves to the parsed JSON or throws an Error that carries the
// server's message, the HTTP status and the whole body (`error.data`), so the
// caller can react to { twoFactorRequired }, { restart } and { attemptsLeft }.
async function call(url, options = {}) {
  const hasBody = options.body !== undefined;
  const res = await apiFetch(`${API_BASE}${url}`, {
    method: options.method || "GET",
    ...(hasBody
      ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(options.body) }
      : {}),
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  if (!res.ok) {
    const error = new Error(data?.error || "Something went wrong. Try again.");
    error.status = res.status;
    error.data = data;
    throw error;
  }
  return data;
}

// ─── Active sessions ─────────────────────────────────────────────────────────

export const fetchSessions = () => call("/api/sessions");

export const revokeSession = (id) =>
  call(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });

export const revokeOtherSessions = () =>
  call("/api/sessions/revoke-others", { method: "POST" });

// ─── Two-factor sign-in ──────────────────────────────────────────────────────

export const fetchTwoFactorStatus = () => call("/api/2fa");

export const startTwoFactorSetup = ({ password }) =>
  call("/api/2fa/setup", { method: "POST", body: { password } });

export const confirmTwoFactor = ({ code }) =>
  call("/api/2fa/enable", { method: "POST", body: { code } });

export const regenerateRecoveryCodes = ({ password, code, recoveryCode }) =>
  call("/api/2fa/recovery-codes", { method: "POST", body: { password, code, recoveryCode } });

export const disableTwoFactor = ({ password, code, recoveryCode }) =>
  call("/api/2fa/disable", { method: "POST", body: { password, code, recoveryCode } });

/** Second step of a sign-in: the challenge from /api/login plus a code or a recovery code. */
export const completeTwoFactorLogin = ({ challenge, code, recoveryCode }) =>
  call("/api/login/2fa", { method: "POST", body: { challenge, code, recoveryCode } });

// ─── Admin ───────────────────────────────────────────────────────────────────

export const resetUserTwoFactor = (userId) =>
  call(`/api/admin/users/${encodeURIComponent(userId)}/reset-2fa`, { method: "POST", body: {} });
