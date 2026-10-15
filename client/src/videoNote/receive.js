// Turns a received encrypted video message into something a <video> can play.

import { decryptVideoNote, decryptVideoNotePoster, E2eeDecryptError } from "../e2ee/videoNoteCrypto.js";
import { normalizeContainer } from "./config.js";
import { clearRememberedVideoNotes, getRememberedVideoNote, rememberVideoNote } from "./localCache.js";

const MAX_POSTERS = 60;
const posterCache = new Map(); // key -> Promise<string|null> (insertion order = age)

function trimPosterCache() {
  while (posterCache.size > MAX_POSTERS) {
    const [oldKey, promise] = posterCache.entries().next().value;
    posterCache.delete(oldKey);
    promise.then((url) => url && URL.revokeObjectURL(url)).catch(() => {});
  }
}

/**
 * Cache key of a message's decrypted media. It is derived from the sender's
 * account and the envelope signature, NOT from anything a sender can pick
 * freely (such as the client request id): otherwise one chat member could
 * choose an id that collides with somebody else's message and have their own
 * video shown in its place, without any signature check.
 */
export const videoNoteKey = (msg) => {
  const sig = msg?.e2ee?.sig;
  const sender = msg?.user_id || msg?.userId;
  return sig && sender ? `${sender}:${sig}` : "";
};

/** What the message's envelope is bound to; taken from the message, never the envelope. */
export const videoNoteContext = (msg) => ({
  chatId: msg?.chat_id || msg?.chatId || "",
  clientRequestId: msg?.client_request_id || msg?.clientRequestId || "",
  senderUserId: msg?.user_id || msg?.userId || "",
});

/** The bytes of the encrypted file for a message. */
export function ciphertextUrl(msg) {
  const file = Array.isArray(msg?.files) ? msg.files[0] : null;
  return file?.url || null;
}

/** Forget every decrypted note and preview (logout, account switch). */
export function clearVideoNoteCaches() {
  posterCache.forEach((promise) => {
    promise.then((url) => url && URL.revokeObjectURL(url)).catch(() => {});
  });
  posterCache.clear();
  clearRememberedVideoNotes();
}

/**
 * Decrypts just the poster frame (a few KB) to a blob URL. Cached per message.
 * Resolves null when there is no poster or it cannot be read.
 */
export function loadVideoNotePoster({ msg, user, services }) {
  const key = videoNoteKey(msg);
  if (!key) return Promise.resolve(null);
  const remembered = getRememberedVideoNote(key);
  if (remembered?.posterUrl) return Promise.resolve(remembered.posterUrl);
  if (!msg?.e2ee?.poster) return Promise.resolve(null);
  if (!posterCache.has(key)) {
    const promise = (async () => {
      try {
        const identity = await services.getIdentity(user.id);
        const bytes = await decryptVideoNotePoster({
          envelope: msg.e2ee,
          identity,
          context: videoNoteContext(msg),
        });
        if (!bytes) return null;
        return URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
      } catch {
        return null;
      }
    })();
    posterCache.set(key, promise);
    trimPosterCache();
    // Do not cache failures forever.
    promise.then((value) => {
      if (!value) posterCache.delete(key);
    });
  }
  return posterCache.get(key);
}

/**
 * Downloads, verifies and decrypts a video message.
 * @returns {Promise<{url: string, posterUrl: string|null, durationMs: number, senderPending: boolean}>}
 *   `senderPending`: it was signed by a device of the sender that this device
 *   has not acknowledged (a new device). For people you verified that blocks
 *   playback instead.
 */
export async function loadVideoNote({ msg, user, services, fetchCiphertext, signal }) {
  const key = videoNoteKey(msg);
  const remembered = key ? getRememberedVideoNote(key) : null;
  if (remembered) return remembered;

  const url = ciphertextUrl(msg);
  if (!url) throw Object.assign(new Error("The video file is not available."), { code: "missing" });
  const context = videoNoteContext(msg);
  if (!key || !context.chatId || !context.clientRequestId || !context.senderUserId) {
    throw new E2eeDecryptError("corrupt", "The message is missing its context.");
  }

  const [identity, ciphertext] = await Promise.all([
    services.getIdentity(user.id),
    fetchCiphertext(url, { signal }),
  ]);
  const envelope = msg.e2ee;
  // The author's device must belong to the person who appears as the sender.
  // Group members usually have no direct chat with each other, so the lookup
  // names the chat they share; a revoked device can still prove what it signed.
  let senderDevice;
  try {
    senderDevice = await services.directory.findDevice(context.senderUserId, envelope.senderDeviceId, {
      chatId: context.chatId,
      allowRevoked: true,
    });
  } catch (error) {
    // The server will not vouch for keys of somebody who shares nothing with
    // us: the message names an author we cannot verify.
    if (error?.status === 403 || error?.status === 404) {
      throw new E2eeDecryptError("unknown_sender", "The sender's device is unknown.");
    }
    throw error;
  }
  const senderPending = Boolean(senderDevice?.pending);
  if (senderPending && (await services.trust.wasVerified(context.senderUserId))) {
    throw new E2eeDecryptError(
      "sender_changed",
      "The sender has a new device and you verified them before.",
    );
  }
  const result = await decryptVideoNote({ envelope, ciphertext, identity, senderDevice, context });

  const entry = {
    url: URL.createObjectURL(new Blob([result.media], { type: normalizeContainer(result.mime) })),
    posterUrl: result.poster ? URL.createObjectURL(new Blob([result.poster], { type: "image/jpeg" })) : null,
    durationMs: result.durationMs,
    mime: result.mime,
    senderPending,
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
    case "sender_changed":
      return "This contact's security keys changed since you verified them. Check their safety number to watch this message.";
    case "unsupported":
      return "This message was sent with an older version and can't be opened any more.";
    case "corrupt":
      return "This message could not be decrypted.";
    case "missing":
      return "The video is no longer available.";
    default:
      return error?.name === "AbortError" ? "" : "Could not load this video message.";
  }
}
