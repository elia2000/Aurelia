// App-wide singletons for the E2EE layer: one key store, one trust tracker and
// one device directory shared by calls, encrypted video messages and the
// safety-number screen.

import * as e2eeApi from "../api/e2eeApi.js";
import { createDirectory } from "./directory.js";
import { clearIdentityCache, getIdentity } from "./identity.js";
import { getSharedKeyStore } from "./keyStore.js";
import { createTrustTracker } from "./trust.js";

export { isE2eeSupported } from "./support.js";

let services = null;

export function getE2eeServices() {
  if (!services) {
    const store = getSharedKeyStore();
    const trust = createTrustTracker(store);
    const directory = createDirectory({ api: e2eeApi, trust });
    services = {
      api: e2eeApi,
      store,
      trust,
      directory,
      getIdentity: (userId) => getIdentity({ userId, api: e2eeApi, store }),
    };
  }
  return services;
}

/** Forgets everything held in memory for the signed-in person (logout, account switch). */
export function clearE2eeSession() {
  clearIdentityCache();
  services?.directory.clear();
}

/** True when the browser can do secure calling (HTTPS, WebRTC, media, crypto). */
export function isCallingSupported() {
  if (typeof window === "undefined") return false;
  return Boolean(
    window.isSecureContext &&
      globalThis.crypto?.subtle &&
      typeof indexedDB !== "undefined" &&
      typeof RTCPeerConnection !== "undefined" &&
      navigator.mediaDevices?.getUserMedia,
  );
}

/** True when the browser can record and encrypt a round video message. */
export function isVideoNoteSupported() {
  if (typeof window === "undefined") return false;
  return Boolean(
    window.isSecureContext &&
      globalThis.crypto?.subtle &&
      typeof indexedDB !== "undefined" &&
      typeof MediaRecorder !== "undefined" &&
      navigator.mediaDevices?.getUserMedia,
  );
}
