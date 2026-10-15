// End-to-end encryption of round video messages.
//
//   media  --AES-256-GCM(content key K, random IV)-->  ciphertext (uploaded as an opaque file)
//   K      --wrapped separately for EVERY recipient device-->  envelope.keys[]
//             wrap key = HKDF(ECDH(ephemeral, device ECDH key))
//   the envelope + ciphertext hash are signed with the sender device's ECDSA key
//
// The server stores the ciphertext and the envelope. It can see who sent a
// message, when, to which chat, its size and its duration — never the video or
// the poster frame. Metadata that matters for decryption (container type,
// duration, sender device) is bound into the AES-GCM associated data and the
// signature, so it cannot be altered without detection.

import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  deriveAesKeyFromEcdh,
  exportPublicRaw,
  generateEphemeralEcdh,
  importAesKey,
  importEcdhPublic,
  importEcdsaPublic,
  sha256,
  signBytes,
  verifyBytes,
} from "./crypto.js";
import { encodeFields, fromB64u, randomBytes, toB64u, utf8 } from "./encoding.js";

const V = "AURELLE-VN-V1";
export const VIDEO_NOTE_VERSION = 1;
export const VIDEO_NOTE_KIND = "video_note";

export class E2eeDecryptError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "E2eeDecryptError";
    this.code = code; // "no_key" | "bad_signature" | "corrupt" | "unknown_sender"
  }
}

const mediaAad = (env) =>
  encodeFields(`${V}/media`, [env.senderDeviceId, env.mime, String(env.durationMs)]);
const posterAad = (env) =>
  encodeFields(`${V}/poster`, [env.senderDeviceId, env.mime, String(env.durationMs)]);
const wrapAad = (deviceId, mediaIv) => encodeFields(`${V}/wrap`, [deviceId, mediaIv]);
const wrapSalt = (deviceId) => sha256(utf8(deviceId));

function signatureInput(env, ciphertextHash) {
  const poster = env.poster ? `${env.poster.iv}.${env.poster.ct}` : "";
  const keyFields = env.keys.flatMap((k) => [k.deviceId, k.epk, k.iv, k.ct]);
  return encodeFields(`${V}/signature`, [
    String(env.v),
    env.kind,
    env.senderDeviceId,
    env.mime,
    String(env.durationMs),
    env.iv,
    toB64u(ciphertextHash),
    poster,
    ...keyFields,
  ]);
}

/**
 * @param {object} args
 * @param {Uint8Array} args.media          the recorded video bytes
 * @param {string} args.mime               "video/mp4" | "video/webm"
 * @param {number} args.durationMs
 * @param {Uint8Array|null} args.poster    small JPEG, encrypted alongside
 * @param {object} args.identity           this device ({deviceId, keys})
 * @param {Array<{id: string, ecdhPublic: string}>} args.recipients  every device that may read it (including this one)
 * @returns {Promise<{ciphertext: Uint8Array, envelope: object}>}
 */
export async function encryptVideoNote({ media, mime, durationMs, poster = null, identity, recipients }) {
  if (!recipients?.some((r) => r.id === identity.deviceId)) {
    throw new Error("The sending device must be among the recipients.");
  }
  const envelope = {
    v: VIDEO_NOTE_VERSION,
    kind: VIDEO_NOTE_KIND,
    senderDeviceId: identity.deviceId,
    iv: "",
    durationMs: Math.round(durationMs),
    mime: String(mime).toLowerCase(),
    keys: [],
    sig: "",
  };

  const contentKeyRaw = randomBytes(32);
  const contentKey = await importAesKey(contentKeyRaw);
  const mediaIv = randomBytes(12);
  envelope.iv = toB64u(mediaIv);
  const { ct: ciphertext } = await aesGcmEncrypt(contentKey, media, mediaAad(envelope), mediaIv);

  if (poster?.length) {
    const sealed = await aesGcmEncrypt(contentKey, poster, posterAad(envelope));
    envelope.poster = { iv: toB64u(sealed.iv), ct: toB64u(sealed.ct) };
  }

  // One ephemeral key per message; its private half is discarded on return.
  const ephemeral = await generateEphemeralEcdh();
  const epk = toB64u(await exportPublicRaw(ephemeral.publicKey));
  for (const recipient of recipients) {
    const wrapKey = await deriveAesKeyFromEcdh(
      ephemeral.privateKey,
      await importEcdhPublic(fromB64u(recipient.ecdhPublic)),
      await wrapSalt(recipient.id),
      `${V}/wrap`,
    );
    const wrapped = await aesGcmEncrypt(wrapKey, contentKeyRaw, wrapAad(recipient.id, envelope.iv));
    envelope.keys.push({
      deviceId: recipient.id,
      epk,
      iv: toB64u(wrapped.iv),
      ct: toB64u(wrapped.ct),
    });
  }

  const signature = await signBytes(
    identity.keys.ecdsa.privateKey,
    signatureInput(envelope, await sha256(ciphertext)),
  );
  envelope.sig = toB64u(signature);
  return { ciphertext, envelope };
}

async function unwrapContentKey(envelope, entry, identity) {
  const wrapKey = await deriveAesKeyFromEcdh(
    identity.keys.ecdh.privateKey,
    await importEcdhPublic(fromB64u(entry.epk)),
    await wrapSalt(identity.deviceId),
    `${V}/wrap`,
  );
  const contentKeyRaw = await aesGcmDecrypt(
    wrapKey,
    fromB64u(entry.iv),
    fromB64u(entry.ct),
    wrapAad(identity.deviceId, envelope.iv),
  );
  return importAesKey(contentKeyRaw);
}

/**
 * Decrypts only the small poster frame, so a bubble can show a preview before
 * the (much larger) video is downloaded. The poster is authenticated by the
 * content key, but the sender's signature can only be checked together with
 * the full ciphertext, which happens when the video is opened.
 * @returns {Promise<Uint8Array|null>} null when there is no poster
 */
export async function decryptVideoNotePoster({ envelope, identity }) {
  if (!envelope?.poster) return null;
  const entry = envelope.keys?.find((k) => k.deviceId === identity.deviceId);
  if (!entry) {
    throw new E2eeDecryptError("no_key", "This message was not encrypted for this device.");
  }
  try {
    const contentKey = await unwrapContentKey(envelope, entry, identity);
    return await aesGcmDecrypt(
      contentKey,
      fromB64u(envelope.poster.iv),
      fromB64u(envelope.poster.ct),
      posterAad(envelope),
    );
  } catch {
    return null;
  }
}

/**
 * @param {object} args
 * @param {object} args.envelope
 * @param {Uint8Array} args.ciphertext
 * @param {object} args.identity       this device
 * @param {{ecdsaPublic: string}|null} args.senderDevice  sender's device record from the directory
 */
export async function decryptVideoNote({ envelope, ciphertext, identity, senderDevice }) {
  if (!senderDevice) {
    throw new E2eeDecryptError("unknown_sender", "The sender's device is unknown.");
  }
  const entry = envelope?.keys?.find((k) => k.deviceId === identity.deviceId);
  if (!entry) {
    throw new E2eeDecryptError(
      "no_key",
      "This message was not encrypted for this device.",
    );
  }

  let signatureOk = false;
  try {
    signatureOk = await verifyBytes(
      await importEcdsaPublic(fromB64u(senderDevice.ecdsaPublic)),
      fromB64u(envelope.sig),
      signatureInput(envelope, await sha256(ciphertext)),
    );
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) {
    throw new E2eeDecryptError("bad_signature", "The message signature is invalid.");
  }

  try {
    const contentKey = await unwrapContentKey(envelope, entry, identity);
    const media = await aesGcmDecrypt(contentKey, fromB64u(envelope.iv), ciphertext, mediaAad(envelope));

    let poster = null;
    if (envelope.poster) {
      try {
        poster = await aesGcmDecrypt(
          contentKey,
          fromB64u(envelope.poster.iv),
          fromB64u(envelope.poster.ct),
          posterAad(envelope),
        );
      } catch {
        poster = null; // a broken poster must not block playback
      }
    }
    return { media, poster, mime: envelope.mime, durationMs: envelope.durationMs };
  } catch (error) {
    if (error instanceof E2eeDecryptError) throw error;
    throw new E2eeDecryptError("corrupt", "The message could not be decrypted.");
  }
}
