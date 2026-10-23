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
//
// The tracker also says what it saw to whoever listens (`subscribe`): the chat
// uses that to write "Bob added a new device" into the conversation. Listening
// changes no answer, and a listener that throws is ignored.

import { deviceFingerprint } from "./safetyNumber.js";

export const TRUST = Object.freeze({
  NEW: "new",
  OK: "ok",
  DEVICES_ADDED: "devices_added",
  KEY_MISMATCH: "key_mismatch",
});

const MAX_RETIRED = 64;

/** What a listener gets: its own copy, so one listener cannot change what the next one sees. */
const copyEvent = (event) =>
  Object.fromEntries(Object.entries(event).map(([key, value]) => [key, Array.isArray(value) ? [...value] : value]));

export function createTrustTracker(store) {
  const listeners = new Set();

  /**
   * Events, all with the `userId` they are about:
   *  - `assessed`     {status, added, removed, mismatched, listed, known, verified}: every lookup.
   *                   `removed` lists devices dropped by THIS lookup (they are reported once),
   *                   `listed` every device id the server listed, `known` how many
   *                   devices were pinned before it.
   *  - `acknowledged` the person accepted the devices listed at that moment
   *  - `verified`     {verified: boolean} the safety number was marked / unmarked
   */
  function emit(event) {
    for (const listener of [...listeners]) {
      try {
        const result = listener(copyEvent(event));
        if (result && typeof result.catch === "function") result.catch(() => {});
      } catch {
        // A broken listener must never break a trust check.
      }
    }
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  // Device ids come from the server. Plain-object lookups would treat names
  // like "__proto__" or "constructor" as already known, so every lookup is an
  // own-property check and the maps carry no prototype.
  const has = (map, id) => Object.hasOwn(map, id);

  async function fingerprints(devices) {
    const map = Object.create(null);
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
    const knownCount = Object.keys(known).length;
    const added = [];
    const mismatched = [];

    const current = await fingerprints(devices);
    const listed = devices.map((device) => device.id);
    for (const device of devices) {
      if (!has(known, device.id)) added.push(device.id);
      else if (known[device.id] !== current[device.id]) mismatched.push(device.id);
    }
    if (mismatched.length) {
      emit({ type: "assessed", userId, status: TRUST.KEY_MISMATCH, added, removed: [], mismatched, listed, known: knownCount, verified });
      return { status: TRUST.KEY_MISMATCH, added, mismatched, verified };
    }

    if (!pin) {
      // First contact: take what we see as the baseline.
      await store.putPeer(userId, { devices: current, verifiedNumber: null, updatedAt: Date.now() });
      emit({ type: "assessed", userId, status: TRUST.NEW, added: [], removed: [], mismatched: [], listed, known: 0, verified: false });
      return { status: TRUST.NEW, added: [], mismatched: [], verified: false };
    }

    // Stop trusting devices the server no longer lists (revoked), but remember
    // what their keys were: that is the only way to tell an old message from a
    // retired device of this person from one signed with a key the server made
    // up for the occasion. Never pin new ones here.
    const stillListed = Object.fromEntries(
      Object.entries(known).filter(([id]) => has(current, id)),
    );
    const removed = [];
    if (Object.keys(stillListed).length !== Object.keys(known).length) {
      const retired = { ...(pin.retired || {}) };
      for (const [id, fingerprint] of Object.entries(known)) {
        if (!has(current, id)) {
          retired[id] = fingerprint;
          removed.push(id);
        }
      }
      await store.putPeer(userId, {
        ...pin,
        devices: stillListed,
        retired: Object.fromEntries(Object.entries(retired).slice(-MAX_RETIRED)),
        updatedAt: Date.now(),
      });
    }
    const status = added.length ? TRUST.DEVICES_ADDED : TRUST.OK;
    emit({ type: "assessed", userId, status, added, removed, mismatched: [], listed, known: knownCount, verified });
    return { status, added, mismatched: [], verified };
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
    emit({ type: "acknowledged", userId });
  }

  /**
   * True when `device` is one this person used to have and we had pinned, with
   * the very keys we pinned. A revoked device the server now claims for them
   * with any other keys (or one we never saw) is not vouched for.
   */
  async function wasRetiredDevice(userId, device) {
    const pin = await store.getPeer(userId);
    const retired = pin?.retired;
    if (!retired || !has(retired, device.id)) return false;
    return retired[device.id] === (await deviceFingerprint(device));
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
    emit({ type: "verified", userId, verified: Boolean(verified) });
  }

  return { assess, acknowledge, isVerified, wasVerified, wasRetiredDevice, setVerified, subscribe };
}
