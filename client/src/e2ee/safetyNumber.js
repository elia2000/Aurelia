// Safety numbers: a 60-digit code both people can compare out of band (read
// it aloud, compare screens, or scan it) to confirm nobody — including the
// server — swapped the keys they are talking to.
//
// The number covers the identity keys of ALL registered devices of both
// people. Adding or removing a device changes it, which is intended: it resets
// "verified" so a newly added (possibly hostile) device cannot ride on an old
// verification.

import { concatBytes, utf8 } from "./encoding.js";
import { fromB64u } from "./encoding.js";
import { sha256, sha512 } from "./crypto.js";

const ITERATIONS = 1024;
const DIGITS_PER_USER = 30;

const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/** SHA-256 over both public keys of a device, as lowercase hex. */
export async function deviceFingerprint(device) {
  return toHex(
    await sha256(concatBytes(fromB64u(device.ecdhPublic), fromB64u(device.ecdsaPublic))),
  );
}

async function userDigits(userId, devices) {
  const fps = (await Promise.all(devices.map(deviceFingerprint))).sort();
  const input = concatBytes(utf8(`aurelle-safety-v1:${userId}:`), utf8(fps.join(",")));
  let hash = await sha512(input);
  for (let i = 0; i < ITERATIONS; i += 1) {
    hash = await sha512(concatBytes(hash, input));
  }
  let digits = "";
  for (let i = 0; i < DIGITS_PER_USER / 5; i += 1) {
    let value = 0;
    for (let j = 0; j < 5; j += 1) value = value * 256 + hash[i * 5 + j];
    digits += String(value % 100000).padStart(5, "0");
  }
  return digits;
}

/**
 * @param {{selfUserId: string, selfDevices: Array, peerUserId: string, peerDevices: Array}} args
 *        devices are `{ecdhPublic, ecdsaPublic}` (base64url)
 * @returns {Promise<{digits: string, groups: string[]}>} identical on both sides
 */
export async function computeSafetyNumber({ selfUserId, selfDevices, peerUserId, peerDevices }) {
  if (!selfDevices?.length || !peerDevices?.length) {
    throw new Error("Both people need at least one registered device.");
  }
  const [mine, theirs] = await Promise.all([
    userDigits(selfUserId, selfDevices),
    userDigits(peerUserId, peerDevices),
  ]);
  const digits = [mine, theirs].sort().join("");
  return { digits, groups: digits.match(/.{5}/g) };
}
