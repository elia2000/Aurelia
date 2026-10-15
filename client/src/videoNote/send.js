// Turns a finished recording into an end-to-end encrypted upload.

import { encryptVideoNote } from "../e2ee/videoNoteCrypto.js";
import { KeyMismatchError } from "../e2ee/directory.js";
import { normalizeContainer } from "./config.js";

export class NoRecipientsError extends Error {
  constructor(usernames = []) {
    super("Nobody in this chat can receive encrypted video messages yet.");
    this.name = "NoRecipientsError";
    this.usernames = usernames;
  }
}

/**
 * @param {object} args
 * @param {string} args.chatId
 * @param {{id: string}} args.user          the signed-in user
 * @param {{blob: Blob, mime: string, durationMs: number, posterBlob?: Blob|null}} args.note
 * @param {{getIdentity: Function, directory: object}} args.services
 * @param {boolean} [args.isSavedChat]      a chat with yourself needs no other recipient
 * @returns {Promise<{ciphertext: Blob, envelope: object, warnings: string[]}>}
 */
export async function prepareVideoNoteUpload({ chatId, user, note, services, isSavedChat = false }) {
  const identity = await services.getIdentity(user.id);
  const { devices, membersWithoutDevice } = await services.directory.getChatDevices(chatId);

  const others = devices.filter((d) => d.userId !== user.id);
  if (!others.length && !isSavedChat) {
    throw new NoRecipientsError(membersWithoutDevice.map((m) => m.username));
  }
  // Always include this device even if the directory response raced a revoke.
  const recipients = devices.some((d) => d.id === identity.deviceId)
    ? devices
    : [...devices, { id: identity.deviceId, userId: user.id, ecdhPublic: identity.ecdhPublic }];

  const mediaBytes = new Uint8Array(await note.blob.arrayBuffer());
  const posterBytes = note.posterBlob ? new Uint8Array(await note.posterBlob.arrayBuffer()) : null;
  const { ciphertext, envelope } = await encryptVideoNote({
    media: mediaBytes,
    mime: normalizeContainer(note.mime || note.blob.type),
    durationMs: note.durationMs,
    poster: posterBytes,
    identity,
    recipients: recipients.map((d) => ({ id: d.id, ecdhPublic: d.ecdhPublic })),
  });

  const warnings = [];
  const missing = membersWithoutDevice.filter((m) => m.userId !== user.id);
  if (missing.length) {
    warnings.push(
      `${missing.length === 1 ? missing[0].username : `${missing.length} members`} cannot watch this yet: secure messaging is not set up on their account.`,
    );
  }
  return {
    ciphertext: new Blob([ciphertext], { type: "application/octet-stream" }),
    envelope,
    warnings,
  };
}

export function friendlyVideoNoteError(error) {
  if (error instanceof NoRecipientsError) {
    const who = error.usernames?.length ? ` ${error.usernames.join(", ")} must open Aurelle once to enable it.` : "";
    return `Encrypted video messages need the other person to have secure messaging enabled.${who}`;
  }
  if (error instanceof KeyMismatchError) {
    return "A contact's security keys changed unexpectedly, so the message was not sent. Verify their safety number first.";
  }
  if (error?.name === "E2eeUnavailableError") {
    return "Secure messaging is not available in this browser.";
  }
  return "Could not prepare the encrypted video message.";
}
