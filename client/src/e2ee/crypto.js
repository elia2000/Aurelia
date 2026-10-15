// Thin WebCrypto layer. All primitives are the ones every browser and every
// native platform ships: P-256 ECDH/ECDSA, HKDF-SHA-256, AES-256-GCM.
// Private keys are generated non-extractable, so script running in the page
// can use them but can never read them out.

import { concatBytes, randomBytes, utf8 } from "./encoding.js";

const subtle = () => {
  const api = globalThis.crypto?.subtle;
  if (!api) throw new Error("Secure cryptography is not available in this context.");
  return api;
};

export const isE2eeSupported = () =>
  Boolean(globalThis.crypto?.subtle) && typeof globalThis.indexedDB !== "undefined";

export async function generateDeviceKeys() {
  const ecdh = await subtle().generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const ecdsa = await subtle().generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  );
  return { ecdh, ecdsa };
}

/** Ephemeral ECDH pair (used once per call / message, then discarded). */
export function generateEphemeralEcdh() {
  return subtle().generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
    "deriveBits",
  ]);
}

export async function exportPublicRaw(publicKey) {
  return new Uint8Array(await subtle().exportKey("raw", publicKey));
}

export const importEcdhPublic = (raw) =>
  subtle().importKey("raw", raw, { name: "ECDH", namedCurve: "P-256" }, true, []);

export const importEcdsaPublic = (raw) =>
  subtle().importKey("raw", raw, { name: "ECDSA", namedCurve: "P-256" }, true, [
    "verify",
  ]);

export async function sha256(bytes) {
  return new Uint8Array(await subtle().digest("SHA-256", bytes));
}

export async function sha512(bytes) {
  return new Uint8Array(await subtle().digest("SHA-512", bytes));
}

export async function ecdhSharedBits(privateKey, peerPublicKey) {
  return new Uint8Array(
    await subtle().deriveBits({ name: "ECDH", public: peerPublicKey }, privateKey, 256),
  );
}

/** HKDF-SHA-256 -> `length` bytes. */
export async function hkdfBytes(ikm, salt, info, length = 32) {
  const base = await subtle().importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await subtle().deriveBits(
      { name: "HKDF", hash: "SHA-256", salt, info: utf8(info) },
      base,
      length * 8,
    ),
  );
}

export const importAesKey = (rawKey, usages = ["encrypt", "decrypt"]) =>
  subtle().importKey("raw", rawKey, { name: "AES-GCM" }, false, usages);

/** ECDH -> HKDF -> AES-256-GCM key. */
export async function deriveAesKeyFromEcdh(privateKey, peerPublicKey, salt, info) {
  const shared = await ecdhSharedBits(privateKey, peerPublicKey);
  return importAesKey(await hkdfBytes(shared, salt, info, 32));
}

export async function aesGcmEncrypt(key, plaintext, aad, iv = randomBytes(12)) {
  const ct = new Uint8Array(
    await subtle().encrypt(
      { name: "AES-GCM", iv, additionalData: aad, tagLength: 128 },
      key,
      plaintext,
    ),
  );
  return { iv, ct };
}

export async function aesGcmDecrypt(key, iv, ciphertext, aad) {
  return new Uint8Array(
    await subtle().decrypt(
      { name: "AES-GCM", iv, additionalData: aad, tagLength: 128 },
      key,
      ciphertext,
    ),
  );
}

/** Returns the 64-byte raw (r||s) ECDSA-P256-SHA256 signature. */
export async function signBytes(privateKey, bytes) {
  return new Uint8Array(
    await subtle().sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, bytes),
  );
}

export function verifyBytes(publicKey, signature, bytes) {
  return subtle().verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, signature, bytes);
}

export { concatBytes, randomBytes };
