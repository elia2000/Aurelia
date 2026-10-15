// Trust-on-first-use tracking of other people's device keys.
//
//  - the first time we see a device we remember its key fingerprint;
//  - a known device id that now shows DIFFERENT keys is a hard mismatch (the
//    server never lets a device id change keys, so this means tampering or a
//    server bug) and must block the operation;
//  - a previously unseen device of a known person is reported once as "added";
//  - the user can additionally mark a person "verified" by comparing the
//    safety number; any later change to that number clears the mark.

import { deviceFingerprint } from "./safetyNumber.js";

export const TRUST = Object.freeze({
  NEW: "new",
  OK: "ok",
  DEVICES_ADDED: "devices_added",
  KEY_MISMATCH: "key_mismatch",
});

export function createTrustTracker(store) {
  async function assess(userId, devices) {
    const pin = (await store.getPeer(userId)) || null;
    const known = pin?.devices || {};
    const next = { ...known };
    const added = [];
    const mismatched = [];

    for (const device of devices) {
      const fp = await deviceFingerprint(device);
      if (!(device.id in known)) {
        next[device.id] = fp;
        added.push(device.id);
      } else if (known[device.id] !== fp) {
        mismatched.push(device.id);
      }
    }

    if (mismatched.length) {
      return { status: TRUST.KEY_MISMATCH, added, mismatched };
    }
    // Forget devices that were revoked server-side so the list stays tidy.
    Object.keys(next).forEach((id) => {
      if (!devices.some((d) => d.id === id)) delete next[id];
    });

    const status = !pin ? TRUST.NEW : added.length ? TRUST.DEVICES_ADDED : TRUST.OK;
    if (!pin || added.length || Object.keys(next).length !== Object.keys(known).length) {
      await store.putPeer(userId, {
        devices: next,
        verifiedNumber: pin?.verifiedNumber || null,
        updatedAt: Date.now(),
      });
    }
    return { status, added, mismatched };
  }

  async function isVerified(userId, safetyNumberDigits) {
    const pin = await store.getPeer(userId);
    return Boolean(pin?.verifiedNumber) && pin.verifiedNumber === safetyNumberDigits;
  }

  async function setVerified(userId, safetyNumberDigits, verified = true) {
    const pin = (await store.getPeer(userId)) || { devices: {} };
    await store.putPeer(userId, {
      ...pin,
      verifiedNumber: verified ? safetyNumberDigits : null,
      updatedAt: Date.now(),
    });
  }

  return { assess, isVerified, setVerified };
}
