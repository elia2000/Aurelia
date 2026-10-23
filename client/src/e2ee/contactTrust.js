// What this device knows about one contact's security, in one place: the
// safety number screen, the shield in the chat header and the chat's own
// notices all ask the same question and must get the same answer.

import { computeSafetyNumber } from "./safetyNumber.js";

export const CONTACT_TRUST = Object.freeze({
  /** The number was compared and nothing has changed since. */
  VERIFIED: "verified",
  /** Never verified (nothing wrong, nothing proven). */
  UNVERIFIED: "unverified",
  /** Devices or keys changed: a new device not accepted yet, or a verified number that no longer holds. */
  CHANGED: "changed",
});

export const NO_DEVICES_MESSAGE = "Both people need at least one registered device.";

/**
 * Looks the contact up and computes the safety number.
 *
 * @param {object} args
 * @param {object} args.services      `getE2eeServices()`
 * @param {string} args.selfUserId
 * @param {string} args.peerUserId
 * @param {string} [args.chatId]      a chat both people are in
 * @param {boolean} [args.force]      skip the short-lived cache of the directory
 */
export async function loadContactTrust({ services, selfUserId, peerUserId, chatId, force = false }) {
  const [{ devices: mine }, theirs] = await Promise.all([
    services.api.listMyDevices(),
    services.directory.getUserDevices(peerUserId, { force, chatId }),
  ]);
  const { digits, groups } = await computeSafetyNumber({
    selfUserId,
    selfDevices: mine,
    peerUserId,
    peerDevices: theirs.devices,
  });
  const verified = await services.trust.isVerified(peerUserId, digits);
  return {
    digits,
    groups,
    verified,
    devices: theirs.devices,
    pending: theirs.devices.filter((device) => device.pending).length,
    wasVerified: Boolean(theirs.assessment?.verified),
  };
}

/**
 * verified / unverified / changed. A verified contact whose number no longer
 * matches what was verified (a device came or went, on either side) is
 * `changed`, and so is any contact with a device nobody accepted yet.
 */
export function classifyContactTrust(info) {
  if (!info) return CONTACT_TRUST.UNVERIFIED;
  if (info.pending > 0 || (info.wasVerified && !info.verified)) return CONTACT_TRUST.CHANGED;
  return info.verified ? CONTACT_TRUST.VERIFIED : CONTACT_TRUST.UNVERIFIED;
}

/** What goes wrong in `loadContactTrust`, in words for the person. */
export function describeContactTrustError(error) {
  if (error?.name === "KeyMismatchError") {
    return "This contact's security keys changed unexpectedly. Do not trust this conversation until you have checked with them in person.";
  }
  if (error?.message === NO_DEVICES_MESSAGE) return "This contact has not set up secure messaging yet.";
  return "Could not load the safety number.";
}
