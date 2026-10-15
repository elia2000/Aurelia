// Turns a received encrypted video message into something a <video> can play.

import { decryptVideoNote, decryptVideoNotePoster } from "../e2ee/videoNoteCrypto.js";
import { normalizeContainer } from "./config.js";
import { getRememberedVideoNote, rememberVideoNote } from "./localCache.js";

const posterCache = new Map(); // messageKey -> Promise<string|null>

export const videoNoteKey = (msg) =>
  String(msg?.clientRequestId || msg?.client_request_id || msg?._clientId || msg?.id || "");

/** The bytes of the encrypted file for a message. */
export function ciphertextUrl(msg) {
  const file = Array.isArray(msg?.files) ? msg.files[0] : null;
  return file?.url || null;
}

/**
 * Decrypts just the poster frame (a few KB) to a blob URL. Cached per message.
 * Resolves null when there is no poster or it cannot be read.
 */
export function loadVideoNotePoster({ msg, user, services }) {
  const key = videoNoteKey(msg);
  const remembered = getRememberedVideoNote(key);
  if (remembered?.posterUrl) return Promise.resolve(remembered.posterUrl);
  if (!msg?.e2ee?.poster) return Promise.resolve(null);
  if (!posterCache.has(key)) {
    const promise = (async () => {
      try {
        const identity = await services.getIdentity(user.id);
        const bytes = await decryptVideoNotePoster({ envelope: msg.e2ee, identity });
        if (!bytes) return null;
        return URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
      } catch {
        return null;
      }
    })();
    posterCache.set(key, promise);
    // Do not cache failures forever.
    promise.then((value) => {
      if (!value) posterCache.delete(key);
    });
  }
  return posterCache.get(key);
}

/**
 * Downloads, verifies and decrypts a video message.
 * @returns {Promise<{url: string, posterUrl: string|null, durationMs: number}>}
 */
export async function loadVideoNote({ msg, user, services, fetchCiphertext, signal }) {
  const key = videoNoteKey(msg);
  const remembered = getRememberedVideoNote(key);
  if (remembered) return remembered;

  const url = ciphertextUrl(msg);
  if (!url) throw Object.assign(new Error("The video file is not available."), { code: "missing" });

  const [identity, ciphertext] = await Promise.all([
    services.getIdentity(user.id),
    fetchCiphertext(url, { signal }),
  ]);
  const envelope = msg.e2ee;
  // The author's device must belong to the person who appears as the sender.
  const senderUserId = msg.user_id || msg.userId;
  const senderDevice = senderUserId
    ? await services.directory.findDevice(senderUserId, envelope.senderDeviceId)
    : null;
  const result = await decryptVideoNote({ envelope, ciphertext, identity, senderDevice });

  const entry = {
    url: URL.createObjectURL(new Blob([result.media], { type: normalizeContainer(result.mime) })),
    posterUrl: result.poster ? URL.createObjectURL(new Blob([result.poster], { type: "image/jpeg" })) : null,
    durationMs: result.durationMs,
    mime: result.mime,
  };
  rememberVideoNote(key, entry);
  return entry;
}

export function friendlyDecryptError(error) {
  switch (error?.code) {
    case "no_key":
      return "This message was sent before this device was set up, so it can't be opened here.";
    case "bad_signature":
    case "unknown_sender":
      return "The sender could not be verified. This message may have been tampered with.";
    case "corrupt":
      return "This message could not be decrypted.";
    case "missing":
      return "The video is no longer available.";
    default:
      return error?.name === "AbortError" ? "" : "Could not load this video message.";
  }
}
