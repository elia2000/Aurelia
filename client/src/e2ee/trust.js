// Trust-on-first-use tracking of other people's device keys.
//
//  - the first time we meet a person we remember the key fingerprint of every
//    device they have (that is the one moment we have to take on trust);
//  - a known device id that now shows DIFFERENT keys is a hard mismatch (the
//    server never lets a device id change keys, so this means tampering or a
//    server bug) and must block the operation;
//  - a previously unseen device of a known person is "added". It is NOT
//    trusted until the person on this device acknowledges it, so the warning
//    cannot be swallowed by whichever code path happens to look first: it is
//    reported on every lookup until it is acknowledged;
//  - the user can additionally mark a person "verified" by comparing the
//    safety number. A verified person who gains a device must be re-verified:
//    callers refuse to send to or accept calls from unacknowledged devices of
//    verified people.

import { deviceFingerprint } from "./safetyNumber.js";

export const TRUST = Object.freeze({
  NEW: "new",
  OK: "ok",
  DEVICES_ADDED: "devices_added",
  KEY_MISMATCH: "key_mismatch",
});

export function createTrustTracker(store) {
  async function fingerprints(devices) {
    const map = {};
    for (const device of devices) map[device.id] = await deviceFingerprint(device);
    return map;
  }

  /**
   * @returns {Promise<{status: string, added: string[], mismatched: string[], verified: boolean}>}
   *   `added` lists unacknowledged device ids; `verified` says the person was
   *   marked verified before (it stays true while they have unacknowledged devices).
   */
  async function assess(userId, devices) {
    const pin = (await store.getPeer(userId)) || null;
    const known = pin?.devices || {};
    const verified = Boolean(pin?.verifiedNumber);
    const added = [];
    const mismatched = [];

    const current = await fingerprints(devices);
    for (const device of devices) {
      if (!(device.id in known)) added.push(device.id);
      else if (known[device.id] !== current[device.id]) mismatched.push(device.id);
    }
    if (mismatched.length) return { status: TRUST.KEY_MISMATCH, added, mismatched, verified };

    if (!pin) {
      // First contact: take what we see as the baseline.
      await store.putPeer(userId, { devices: current, verifiedNumber: null, updatedAt: Date.now() });
      return { status: TRUST.NEW, added: [], mismatched: [], verified: false };
    }

    // Forget devices the server no longer lists (revoked), but never pin new ones.
    const stillListed = Object.fromEntries(
      Object.entries(known).filter(([id]) => id in current),
    );
    if (Object.keys(stillListed).length !== Object.keys(known).length) {
      await store.putPeer(userId, { ...pin, devices: stillListed, updatedAt: Date.now() });
    }
    return {
      status: added.length ? TRUST.DEVICES_ADDED : TRUST.OK,
      added,
      mismatched: [],
      verified,
    };
  }

  /**
   * The person on this device accepts the devices currently listed for
   * `userId`. Any earlier "verified" mark no longer applies to the new set.
   */
  async function acknowledge(userId, devices) {
    const pin = (await store.getPeer(userId)) || { devices: {} };
    await store.putPeer(userId, {
      ...pin,
      devices: await fingerprints(devices),
      verifiedNumber: null,
      updatedAt: Date.now(),
    });
  }

  async function wasVerified(userId) {
    const pin = await store.getPeer(userId);
    return Boolean(pin?.verifiedNumber);
  }

  async function isVerified(userId, safetyNumberDigits) {
    const pin = await store.getPeer(userId);
    return Boolean(pin?.verifiedNumber) && pin.verifiedNumber === safetyNumberDigits;
  }

  /**
   * Marks the safety number as verified (or clears it). Verifying a number
   * computed from `devices` also accepts those devices.
   */
  async function setVerified(userId, safetyNumberDigits, verified = true, devices = null) {
    const pin = (await store.getPeer(userId)) || { devices: {} };
    await store.putPeer(userId, {
      ...pin,
      ...(verified && devices ? { devices: await fingerprints(devices) } : {}),
      verifiedNumber: verified ? safetyNumberDigits : null,
      updatedAt: Date.now(),
    });
  }

  return { assess, acknowledge, isVerified, wasVerified, setVerified };
}
