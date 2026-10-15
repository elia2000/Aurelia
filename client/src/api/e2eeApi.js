// HTTP client for the end-to-end encryption device directory, call signaling
// and encrypted media download. All requests go through `apiFetch`.

import { apiFetch } from "./chatApi.js";

export class ApiError extends Error {
  constructor(message, { status = 0, code = null } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

const jsonHeaders = { "Content-Type": "application/json" };

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function request(url, options) {
  let res;
  try {
    res = await apiFetch(url, options);
  } catch (error) {
    throw new ApiError(String(error?.message || "Network error"), { status: 0, code: "network" });
  }
  const data = await readJson(res);
  if (!res.ok) {
    throw new ApiError(data?.error || `Request failed (${res.status})`, {
      status: res.status,
      code: data?.code || null,
    });
  }
  return data;
}

const post = (url, body) =>
  request(url, { method: "POST", headers: jsonHeaders, body: JSON.stringify(body ?? {}) });

// ── Device directory ────────────────────────────────────────────────────────
export const registerDevice = ({ deviceId, ecdhPublic, ecdsaPublic, label }) =>
  post("/api/e2ee/devices", { deviceId, ecdhPublic, ecdsaPublic, label });

export const listMyDevices = () => request("/api/e2ee/devices");

export const revokeDevice = (deviceId) =>
  request(`/api/e2ee/devices/${encodeURIComponent(deviceId)}`, { method: "DELETE" });

export const fetchUserDevices = (userId) =>
  request(`/api/e2ee/users/${encodeURIComponent(userId)}/devices`);

export const fetchChatDevices = (chatId) =>
  request(`/api/e2ee/chats/${encodeURIComponent(chatId)}/devices`);

// ── Call signaling ──────────────────────────────────────────────────────────
export const fetchIceConfig = () => request("/api/calls/ice-config");

export const fetchPendingCall = () => request("/api/calls/pending");

export const startCall = ({ callId, chatId, kind, invite }) =>
  post("/api/calls", { callId, chatId, kind, invite });

export const acceptCall = (callId, accept) =>
  post(`/api/calls/${encodeURIComponent(callId)}/accept`, { accept });

export const sendCallSignal = (callId, { kind, blob, seq }) =>
  post(`/api/calls/${encodeURIComponent(callId)}/signal`, { kind, blob, seq });

export const markCallConnected = (callId) =>
  post(`/api/calls/${encodeURIComponent(callId)}/connected`, {});

export const endCall = (callId, reason) =>
  post(`/api/calls/${encodeURIComponent(callId)}/end`, { reason });

/**
 * Best-effort hang-up for page unload, where a normal fetch may be cancelled.
 * `sendBeacon` cannot set headers; a JSON Blob keeps the content type.
 */
export function endCallBeacon(callId) {
  try {
    if (typeof navigator === "undefined" || !navigator.sendBeacon) return false;
    const body = new Blob([JSON.stringify({ reason: "hangup" })], {
      type: "application/json",
    });
    return navigator.sendBeacon(`/api/calls/${encodeURIComponent(callId)}/end`, body);
  } catch {
    return false;
  }
}

// ── Encrypted media ─────────────────────────────────────────────────────────
const isCrossOrigin = (url) => {
  try {
    return new URL(url, window.location.href).origin !== window.location.origin;
  } catch {
    return true;
  }
};

/** Downloads an opaque ciphertext file (same-origin or presigned object storage). */
export async function fetchCiphertext(url, { signal } = {}) {
  const target = String(url || "");
  if (!target) throw new ApiError("Missing media URL.");
  const res = isCrossOrigin(target)
    ? await fetch(target, { credentials: "omit", mode: "cors", signal })
    : await apiFetch(target, { signal });
  if (!res.ok) throw new ApiError(`Download failed (${res.status})`, { status: res.status });
  return new Uint8Array(await res.arrayBuffer());
}
