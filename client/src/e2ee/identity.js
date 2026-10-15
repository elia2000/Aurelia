// This device's identity: two P-256 key pairs (ECDH for key agreement, ECDSA
// for signatures) generated once, kept non-extractable in IndexedDB, with the
// public halves registered in the server directory.

import { randomUuid, toB64u } from "./encoding.js";
import { exportPublicRaw, generateDeviceKeys } from "./crypto.js";
import { getSharedKeyStore } from "./keyStore.js";

export function describeThisDevice() {
  if (typeof navigator === "undefined") return "Device";
  const ua = navigator.userAgent || "";
  const browser =
    /Edg\//.test(ua) ? "Edge"
    : /OPR\//.test(ua) ? "Opera"
    : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari"
    : "Browser";
  const os =
    /Android/.test(ua) ? "Android"
    : /iPhone|iPad|iPod/.test(ua) ? "iOS"
    : /Windows/.test(ua) ? "Windows"
    : /Mac OS X/.test(ua) ? "macOS"
    : /Linux/.test(ua) ? "Linux"
    : "";
  return os ? `${browser} on ${os}` : browser;
}

/**
 * Loads (or creates) this browser's identity for `userId` and makes sure the
 * server knows its public keys. Idempotent and safe to call on every start.
 *
 * @param {{userId: string, api: {registerDevice: Function}, store?: object, label?: string}} args
 */
export async function loadOrCreateIdentity({ userId, api, store = getSharedKeyStore(), label }) {
  let record = await store.getIdentity(userId);
  if (!record?.keys) {
    record = { deviceId: null, keys: await generateDeviceKeys(), createdAt: Date.now() };
    // Persist the keys BEFORE registering so a failed request never orphans
    // a registered public key whose private half was lost.
    await store.putIdentity(userId, record);
  }
  const ecdhPublic = toB64u(await exportPublicRaw(record.keys.ecdh.publicKey));
  const ecdsaPublic = toB64u(await exportPublicRaw(record.keys.ecdsa.publicKey));

  let device;
  try {
    ({ device } = await api.registerDevice({
      deviceId: record.deviceId || undefined,
      ecdhPublic,
      ecdsaPublic,
      label: label || describeThisDevice(),
    }));
  } catch (error) {
    // Re-confirming a device the server already knows only refreshes its
    // "last seen" time. If that request fails (offline, throttled) the device
    // is still perfectly usable, so do not take calls and video messages down
    // with it. A device that was never registered has nothing to fall back on.
    if (!record.deviceId) throw error;
    device = { id: record.deviceId };
  }
  if (device.id !== record.deviceId) {
    record = { ...record, deviceId: device.id };
    await store.putIdentity(userId, record);
  }
  return {
    userId,
    deviceId: device.id,
    keys: record.keys,
    ecdhPublic,
    ecdsaPublic,
  };
}

const cache = new Map(); // userId -> Promise<identity>

/** Memoised per user so concurrent callers share one registration. */
export function getIdentity({ userId, api, store, label }) {
  const key = String(userId);
  if (!cache.has(key)) {
    const promise = loadOrCreateIdentity({ userId: key, api, store, label }).catch((error) => {
      cache.delete(key);
      throw error;
    });
    cache.set(key, promise);
  }
  return cache.get(key);
}

export const clearIdentityCache = () => cache.clear();

export { randomUuid };
