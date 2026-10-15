// Turns a finished recording into an end-to-end encrypted upload.

import { encryptVideoNote } from "../e2ee/videoNoteCrypto.js";
import { KeyMismatchError } from "../e2ee/directory.js";
import { normalizeContainer } from "./config.js";

// The server refuses envelopes that wrap the key for more devices than this.
export const MAX_RECIPIENT_DEVICES = 128;

/**
 * Somebody in the chat has a device this device has not acknowledged yet, and
 * the message was not sent. `changes` is [{userId, username, added, verified}];
 * when any person is `verified` the message can only be sent after their new
 * safety number has been reviewed.
 */
export class DevicesChangedError extends Error {
  constructor(changes = []) {
    super("A contact's security keys changed. Review them before sending.");
    this.name = "DevicesChangedError";
    this.changes = changes;
    this.requiresVerification = changes.some((c) => c.verified);
  }
}

export class TooManyRecipientsError extends Error {
  constructor(count) {
    super("This chat has too many devices for an encrypted video message.");
    this.name = "TooManyRecipientsError";
    this.count = count;
  }
}

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
 * @param {string} args.clientRequestId     the id the message will be uploaded with (signed into the envelope)
 * @param {{id: string}} args.user          the signed-in user
 * @param {{blob: Blob, mime: string, durationMs: number, posterBlob?: Blob|null}} args.note
 * @param {{getIdentity: Function, directory: object}} args.services
 * @param {boolean} [args.isSavedChat]      a chat with yourself needs no other recipient
 * @param {boolean} [args.acknowledgeChanges] the person chose to send to newly added devices of
 *                                          people who were never verified
 * @returns {Promise<{ciphertext: Blob, envelope: object, warnings: string[]}>}
 */
export async function prepareVideoNoteUpload({
  chatId,
  clientRequestId,
  user,
  note,
  services,
  isSavedChat = false,
  acknowledgeChanges = false,
}) {
  const identity = await services.getIdentity(user.id);
  const { devices, membersWithoutDevice, changes: reported = [] } =
    await services.directory.getChatDevices(chatId);
  // This device is trusted by definition (it is the one holding the keys).
  const changes = reported
    .map((change) =>
      change.userId === user.id
        ? { ...change, added: change.added.filter((id) => id !== identity.deviceId) }
        : change,
    )
    .filter((change) => change.added.length > 0);

  // A device nobody here has seen before would receive this video. For people
  // you verified that is never done silently; for everybody else it needs an
  // explicit "send anyway".
  if (changes.length) {
    const mustReview = changes.some((change) => change.verified);
    if (!acknowledgeChanges || mustReview) throw new DevicesChangedError(changes);
    for (const change of changes) {
      await services.directory.acknowledge(
        change.userId,
        devices.filter((d) => d.userId === change.userId),
      );
    }
  }

  const others = devices.filter((d) => d.userId !== user.id);
  if (!others.length && !isSavedChat) {
    throw new NoRecipientsError(membersWithoutDevice.map((m) => m.username));
  }
  // Always include this device even if the directory response raced a revoke.
  const recipients = devices.some((d) => d.id === identity.deviceId)
    ? devices
    : [...devices, { id: identity.deviceId, userId: user.id, ecdhPublic: identity.ecdhPublic }];

  if (recipients.length > MAX_RECIPIENT_DEVICES) {
    throw new TooManyRecipientsError(recipients.length);
  }

  const mediaBytes = new Uint8Array(await note.blob.arrayBuffer());
  const posterBytes = note.posterBlob ? new Uint8Array(await note.posterBlob.arrayBuffer()) : null;
  const { ciphertext, envelope } = await encryptVideoNote({
    media: mediaBytes,
    mime: normalizeContainer(note.mime || note.blob.type),
    durationMs: note.durationMs,
    poster: posterBytes,
    identity,
    recipients: recipients.map((d) => ({ id: d.id, ecdhPublic: d.ecdhPublic })),
    context: { chatId, clientRequestId, senderUserId: user.id },
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
  if (error instanceof TooManyRecipientsError) {
    return "This chat has too many registered devices for an encrypted video message.";
  }
  if (error instanceof DevicesChangedError) {
    return error.requiresVerification
      ? "A verified contact has a new device. Check their safety number before sending."
      : "A contact has a new device. Review it before sending.";
  }
  if (error?.name === "E2eeUnavailableError") {
    return "Secure messaging is not available in this browser.";
  }
  return "Could not prepare the encrypted video message.";
}
