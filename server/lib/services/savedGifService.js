/**
 * Saved GIFs Domain Service
 *
 * A person keeps a private collection of GIFs. This service authorises each
 * request, applies it and works out its effects: the answer for the caller, the
 * realtime events for the caller's own sessions and, when a saved GIF is sent,
 * the chat message. It returns plain `{ ok, status, body }` results for the
 * thin route layer.
 *
 * Privacy: every lookup names the caller (`user.id`); a GIF of somebody else is
 * simply "not found", the same answer as for an id that never existed. The
 * events go to the caller's sessions only (emitSseEvent), never to a chat. When
 * a saved GIF is sent, the recipients get an ordinary attachment: a copy under
 * the message's own storage and retention, with nothing that names the saved GIF.
 *
 * The bytes are always checked (lib/savedGifs.js evaluateGifBytes): what a
 * client calls a file decides nothing.
 */

import crypto from "node:crypto";
import { generateUuid } from "../uuidUtils.js";
import { isAnimationCandidate } from "../animatedImage.js";
import {
  SAVED_GIF_MAX_BYTES,
  buildSavedGifKey,
  clampMaxSavedGifs,
  evaluateGifBytes,
  serializeSavedGif,
} from "../savedGifs.js";

const maybe = async (value) =>
  value && typeof value.then === "function" ? await value : value;

const fail = (status, error, extra = {}) => ({ ok: false, status, body: { error, ...extra } });
const ok = (status, body) => ({ ok: true, status, body });

const FILE_NOT_FOUND = "File not found.";
const UNSUPPORTED = "Only animated GIF, WebP or PNG images can be saved.";
const ALLOWED_SERVED_MIME = new Set(["image/gif", "image/webp", "image/png"]);

const isRemoteType = (type) => type === "remote" || type === "s3";

export function createSavedGifService(deps) {
  const { getSetting } = deps;
  // Looked up at call time: the storage object is the one place that touches bytes.
  const storage = () => deps.savedGifStorage;

  // The largest GIF: 20 MB, or less if the server's own per-file limit is lower,
  // so nothing can be saved that could not be sent again.
  const maxBytes = () => {
    const serverLimit = Number(deps.MESSAGE_FILE_LIMITS?.maxFileSizeBytes) || 0;
    return serverLimit > 0 ? Math.min(SAVED_GIF_MAX_BYTES, serverLimit) : SAVED_GIF_MAX_BYTES;
  };
  const tooLarge = (cap) =>
    fail(400, `A GIF can be at most ${Math.max(1, Math.round(cap / (1024 * 1024)))} MB.`, {
      code: "gif_too_large",
    });

  const limit = () =>
    clampMaxSavedGifs(typeof getSetting === "function" ? getSetting("MAX_SAVED_GIFS") : null);
  const uploadsEnabled = () => (typeof getSetting === "function" ? Boolean(getSetting("FILE_UPLOAD")) : true);
  const uploadsDisabled = () => fail(503, "File uploads are disabled on this server.");

  // A broken realtime hub must never undo a change that is already stored.
  const emitToSessions = (username, payload) => {
    if (typeof deps.emitSseEvent !== "function" || !username) return;
    try {
      deps.emitSseEvent(String(username).toLowerCase(), payload);
    } catch (error) {
      console.error("saved gifs: realtime event failed:", error);
    }
  };

  // Deleting files is clean-up: it must never fail the request that caused it.
  async function removeFilesQuietly(rows) {
    if (!rows?.length) return;
    try {
      await storage().removeGifs(rows);
    } catch (error) {
      console.error("saved gifs: unable to remove stored files:", error?.message || error);
    }
  }

  const sha256Of = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

  async function existingResponse(user, row, max) {
    const count = Number(await maybe(deps.countSavedGifs(user.id))) || 0;
    return ok(200, { gif: serializeSavedGif(row), evicted: [], limit: max, count, existing: true });
  }

  /**
   * Checks the bytes, stores them under the person's own key and adds the row,
   * evicting the oldest GIFs if the person is over their limit. The same bytes
   * again are the same GIF: nothing is stored or evicted.
   */
  async function store({ user, bytes, source = null }) {
    const verdict = evaluateGifBytes(bytes, { maxBytes: maxBytes() });
    if (!verdict.ok) return fail(verdict.status, verdict.error, { code: verdict.code });

    const max = limit();
    const sha256 = sha256Of(bytes);
    const duplicate = await maybe(deps.findSavedGifByHash(user.id, sha256));
    if (duplicate) return existingResponse(user, duplicate, max);

    const id = generateUuid();
    const storageKey = buildSavedGifKey(user.id, id, verdict.type);
    let written;
    try {
      written = await storage().writeGif({ key: storageKey, bytes, mime: verdict.mime });
    } catch (error) {
      console.error("saved gifs: unable to store the file:", error?.message || error);
      return fail(500, "Unable to save the GIF.");
    }
    const ownRow = {
      id,
      user_id: user.id,
      storage_key: storageKey,
      storage_driver: written?.storageDriver || "local",
    };

    let result;
    try {
      result = await maybe(
        deps.insertSavedGif({
          id,
          userId: user.id,
          storageKey,
          storageDriver: ownRow.storage_driver,
          mime: verdict.mime,
          width: verdict.width,
          height: verdict.height,
          frames: verdict.frames,
          sizeBytes: bytes.length,
          sha256,
          sourceMessageId: source?.messageId ?? null,
          sourceFileId: source?.fileId ?? null,
          limit: max,
        }),
      );
    } catch (error) {
      console.error("saved gifs: unable to save the GIF:", error?.message || error);
      await removeFilesQuietly([ownRow]);
      return fail(500, "Unable to save the GIF.");
    }

    if (result.status === "existing") {
      // Another request stored these bytes first; ours is a stray copy.
      await removeFilesQuietly([ownRow]);
      return existingResponse(user, result.gif, max);
    }

    await removeFilesQuietly(result.evicted);
    const body = {
      gif: serializeSavedGif(result.gif),
      evicted: result.evicted.map((row) => ({ id: row.id })),
      limit: max,
      count: result.count,
    };
    emitToSessions(user.username, { type: "saved_gif_added", ...body });
    return ok(201, body);
  }

  /** GET /api/gifs */
  async function list({ user }) {
    const rows = (await maybe(deps.listSavedGifs(user.id))) || [];
    return ok(200, { gifs: rows.map(serializeSavedGif), limit: limit(), count: rows.length });
  }

  /** POST /api/gifs: save a picture from a message the caller can see. */
  async function saveFromMessage({ user, messageId, fileId, fileIndex }) {
    if (!uploadsEnabled()) return uploadsDisabled();

    // Not a member, no such message, deleted for everyone or for the caller:
    // one answer for all of them, so nothing leaks about other people's chats.
    const notFound = () => fail(404, "Message not found.");
    const message = await maybe(deps.findMessageById(messageId));
    if (!message || !message.chat_id || message.hidden_everyone_at) return notFound();
    if (!(await maybe(deps.isMember(message.chat_id, user.id)))) return notFound();
    if (
      typeof deps.isMessageHiddenForUser === "function" &&
      (await maybe(deps.isMessageHiddenForUser(messageId, user.id)))
    ) {
      return notFound();
    }
    if (message.e2ee_envelope) {
      // An opaque encrypted blob: nothing the server can read as a picture.
      return fail(400, UNSUPPORTED, { code: "gif_unsupported" });
    }

    const files = (await maybe(deps.listMessageFilesByMessageIds([messageId]))) || [];
    const file = fileId !== null && fileId !== undefined
      ? files.find((row) => Number(row.id) === fileId)
      : files[fileIndex ?? 0];
    if (!file) return fail(404, FILE_NOT_FOUND);

    const expiresMs = file.expires_at ? Date.parse(file.expires_at) : NaN;
    if (Number.isFinite(expiresMs) && expiresMs <= Date.now()) return fail(404, FILE_NOT_FOUND);

    // Files that cannot be animated pictures are not even opened.
    if (!isAnimationCandidate({ mimeType: file.mime_type, name: file.original_name })) {
      return fail(400, UNSUPPORTED, { code: "gif_unsupported" });
    }
    if ((Number(file.size_bytes) || 0) > maxBytes()) return tooLarge(maxBytes());

    // The same file, saved before: nothing to do, and nothing is evicted.
    const already = await maybe(deps.findSavedGifBySource(user.id, messageId, file.id));
    if (already) return existingResponse(user, already, limit());

    const bytes = await storage().readMessageFile(file, { maxBytes: maxBytes() });
    if (!bytes) return fail(404, FILE_NOT_FOUND);

    return store({ user, bytes, source: { messageId, fileId: file.id } });
  }

  /** POST /api/gifs/upload: add a picture from the device. */
  async function saveUploaded({ user, bytes }) {
    if (!uploadsEnabled()) return uploadsDisabled();
    return store({ user, bytes });
  }

  /** DELETE /api/gifs/:id */
  async function remove({ user, gifId }) {
    const row = await maybe(deps.deleteSavedGif(user.id, gifId));
    if (!row) return fail(404, "GIF not found.");
    await removeFilesQuietly([row]);
    const count = Number(await maybe(deps.countSavedGifs(user.id))) || 0;
    const max = limit();
    emitToSessions(user.username, { type: "saved_gif_removed", gifId: row.id, limit: max, count });
    return ok(200, { ok: true, id: row.id, limit: max, count });
  }

  /** GET /api/gifs/:id/file: the bytes, for the owner only. */
  async function readFile({ user, gifId }) {
    const row = await maybe(deps.findSavedGif(user.id, gifId));
    if (!row) return fail(404, "GIF not found.");
    const bytes = await storage().readGif(row, { maxBytes: SAVED_GIF_MAX_BYTES });
    if (!bytes) return fail(404, "GIF file not found.");
    const mime = ALLOWED_SERVED_MIME.has(String(row.mime || "")) ? row.mime : null;
    return { ok: true, status: 200, bytes, mime };
  }

  // ─── Sending a saved GIF as a message ──────────────────────────────────────

  // Same placeholder an upload without a caption gets, so clients hide it in the
  // bubble and preview it from `summaryText` ("Sent a GIF").
  const GENERIC_BODY = "Sent a media file";
  const SUMMARY_TEXT = "Sent a GIF";

  async function fileUrl(copy) {
    if (isRemoteType(copy.storageDriver) && typeof deps.storageProvider?.getDownloadUrl === "function") {
      try {
        return await deps.storageProvider.getDownloadUrl(copy.storageKey);
      } catch {
        // fall back to the server's own address below
      }
    }
    return `/api/uploads/messages/${copy.storedName}`;
  }

  async function notifyRecipients({ user, chat, chatId, text }) {
    try {
      if (typeof deps.sendPushNotificationToUsers !== "function") return;
      const members = (await maybe(deps.listChatMembers(chatId))) || [];
      const mutedRows = (await maybe(deps.listMutedUserIdsForChat(chatId))) || [];
      const muted = new Set(mutedRows.map((row) => row?.user_id || row).filter(Boolean));
      const recipientIds = members
        .filter((member) => member.id !== user.id)
        .filter((member) => !(typeof deps.isUserConnected === "function" && deps.isUserConnected(member.username)))
        .map((member) => member.id)
        .filter((id) => id && !muted.has(id));
      if (!recipientIds.length) return;
      const title =
        chat.type === "dm"
          ? user.nickname || user.username
          : chat.name || (chat.type === "channel" ? "Channel" : "Group");
      await deps.sendPushNotificationToUsers(recipientIds, {
        title,
        body: text,
        data: { url: "/", chatId },
      });
    } catch {
      // a failed push never affects the message
    }
  }

  /**
   * Sends one of the caller's saved GIFs into a chat the caller may write to
   * (the route has already checked membership, channel ownership and the reply
   * target). The message gets a COPY of the GIF as its attachment, stored and
   * expiring like any upload.
   */
  async function sendAsMessage({ user, chat, savedGifId, caption = "", replyToMessageId = null, clientRequestId = null }) {
    if (!uploadsEnabled()) return uploadsDisabled();

    const gif = await maybe(deps.findSavedGif(user.id, savedGifId));
    if (!gif) return fail(404, "GIF not found.");

    const maxFileBytes = Number(deps.MESSAGE_FILE_LIMITS?.maxFileSizeBytes) || 0;
    if (maxFileBytes && Number(gif.size_bytes) > maxFileBytes) return tooLarge(maxFileBytes);

    // A retried request is answered from the message it already made.
    if (clientRequestId && typeof deps.findMessageIdByClientRequestId === "function") {
      const existingId = await maybe(deps.findMessageIdByClientRequestId(chat.id, user.id, clientRequestId));
      if (existingId) return ok(200, { id: existingId, deduped: true });
    }

    if (
      !isRemoteType(deps.storageProvider?.type) &&
      typeof deps.hasEnoughFreeDiskSpace === "function" &&
      !deps.hasEnoughFreeDiskSpace(Number(gif.size_bytes) || 0)
    ) {
      return fail(400, "Not enough free storage space on server.");
    }

    const bytes = await storage().readGif(gif, { maxBytes: SAVED_GIF_MAX_BYTES });
    if (!bytes) return fail(404, "GIF file not found.");
    const verdict = evaluateGifBytes(bytes);
    if (!verdict.ok) return fail(500, "Unable to send the GIF.");

    let copy;
    try {
      copy = await storage().writeMessageCopy({ bytes, mime: verdict.mime, type: verdict.type });
    } catch (error) {
      console.error("saved gifs: unable to copy the file:", error?.message || error);
      return fail(500, "Unable to send the GIF.");
    }

    const createdAtIso = new Date().toISOString();
    const expiresAtIso =
      typeof deps.computeExpiryIso === "function"
        ? deps.computeExpiryIso(createdAtIso, getSetting("MESSAGE_FILE_RETENTION"))
        : null;
    const text = String(caption || "").trim();
    const body = text || GENERIC_BODY;
    const fileRecord = {
      kind: "media",
      originalName: `animation.${verdict.type}`,
      storedName: copy.storedName,
      mimeType: verdict.mime,
      sizeBytes: bytes.length,
      widthPx: verdict.width,
      heightPx: verdict.height,
      durationSeconds: null,
      expiresAt: expiresAtIso,
      storageDriver: copy.storageDriver,
      storageKey: copy.storageKey,
      processingStatus: "ready",
      encryptionType: copy.encryptionType,
      isAnimated: true,
    };

    let messageId;
    try {
      const created = await maybe(
        deps.createOrReuseMessage(chat.id, user.id, body, replyToMessageId || null, null, clientRequestId || null),
      );
      messageId = created?.id || null;
      if (!messageId) throw new Error("Unable to create message.");
      if (created.deduped) {
        // Another request with the same id won the race: ours is a stray copy.
        await storage().removeMessageCopy(copy);
        return ok(200, { id: messageId, deduped: true });
      }
    } catch (error) {
      console.error("saved gifs: unable to create the message:", error?.message || error);
      await storage().removeMessageCopy(copy);
      return fail(500, "Unable to send the GIF.");
    }

    let inserted;
    try {
      inserted = await maybe(deps.createMessageFiles(messageId, [fileRecord]));
      if (chat.type === "saved" && typeof deps.markMessageRead === "function") {
        await maybe(deps.markMessageRead(messageId, user.id));
      }
    } catch (error) {
      console.error("saved gifs: unable to attach the file:", error?.message || error);
      // The message exists but has no picture: nobody has seen it yet, so take it back.
      try {
        await maybe(deps.hideMessageForEveryone(messageId));
      } catch {
        // nothing more to do
      }
      await storage().removeMessageCopy(copy);
      return fail(500, "Unable to send the GIF.");
    }

    const fileId = (Array.isArray(inserted) ? inserted[0]?.id : inserted?.id) ?? null;
    let storedId = fileId;
    if (storedId === null && typeof deps.listMessageFilesByMessageIds === "function") {
      const rows = (await maybe(deps.listMessageFilesByMessageIds([messageId]))) || [];
      storedId = rows[0]?.id ?? null;
    }
    const publicFile = {
      id: storedId,
      kind: "media",
      name: fileRecord.originalName,
      mimeType: fileRecord.mimeType,
      processing: false,
      sizeBytes: fileRecord.sizeBytes,
      width: fileRecord.widthPx,
      height: fileRecord.heightPx,
      durationSeconds: null,
      expiresAt: expiresAtIso,
      expires_at: expiresAtIso,
      thumbStorageKey: null,
      thumbUrl: null,
      url: await fileUrl(copy),
      isAnimated: true,
      gif: true,
    };

    if (typeof deps.emitChatEvent === "function") {
      deps.emitChatEvent(chat.id, {
        type: "chat_message",
        chatId: chat.id,
        messageId,
        username: user.username,
        userId: user.id,
        body,
        summaryText: SUMMARY_TEXT,
        replyToMessageId: replyToMessageId || null,
        files: [publicFile],
        expiresAt: expiresAtIso,
        expires_at: expiresAtIso,
        ...(chat.type === "saved"
          ? { read_at: new Date().toISOString(), read_by_user_id: user.id }
          : {}),
      });
    }

    void notifyRecipients({ user, chat, chatId: chat.id, text: text || SUMMARY_TEXT });

    return ok(200, { id: messageId, deduped: false, expiresAt: expiresAtIso, files: [publicFile] });
  }

  return { list, saveFromMessage, saveUploaded, remove, readFile, sendAsMessage };
}
