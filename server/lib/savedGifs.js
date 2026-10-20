/**
 * Saved GIFs: the pure rules.
 *
 * A person keeps a private collection of GIFs (animated GIF, animated WebP,
 * APNG). This module holds what needs no database and no disk: the limits, the
 * storage key layout, the public shape of a saved GIF, the parsing of a "save
 * this one from a message" request and the verdict on a file's bytes.
 *
 * The verdict is always about the bytes. A file name or a content type that a
 * sender supplied decides nothing: the type, the size of the picture and the
 * frame count come from the file itself (see animatedImage.js).
 */

import { isValidUuid } from "./uuidUtils.js";
import {
  IMAGE_EXTENSION_BY_TYPE,
  MAX_FRAMES,
  inspectImage,
  sniffImageType,
} from "./animatedImage.js";

export const SAVED_GIF_DEFAULT_LIMIT = 50;
export const SAVED_GIF_MIN_LIMIT = 1;
export const SAVED_GIF_MAX_LIMIT = 200;
/** The largest GIF that can be saved or sent from the collection. */
export const SAVED_GIF_MAX_BYTES = 20 * 1024 * 1024;
/** Width and height bound: what a client has to decode, whatever the file claims. */
export const SAVED_GIF_MAX_DIMENSION = 4096;
/** A message holds at most 50 files (FILE_UPLOAD_MAX_FILES), so no index goes beyond 49. */
const MAX_FILE_INDEX = 49;

const GIF_TYPES = new Set(["gif", "webp", "png"]);

/** The `MAX_SAVED_GIFS` setting, clamped to the supported 1-200 range. */
export function clampMaxSavedGifs(value) {
  // Nothing configured (null, undefined, "") is the default, not zero.
  if (value === null || value === undefined || String(value).trim() === "") {
    return SAVED_GIF_DEFAULT_LIMIT;
  }
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return SAVED_GIF_DEFAULT_LIMIT;
  return Math.min(SAVED_GIF_MAX_LIMIT, Math.max(SAVED_GIF_MIN_LIMIT, n));
}

/** ".gif" | ".webp" | ".png" for a checked image type, otherwise null. */
export function extensionForGifType(type) {
  return GIF_TYPES.has(type) ? IMAGE_EXTENSION_BY_TYPE[type] : null;
}

/**
 * `gifs/<userId>/<gifId><ext>`: the key under which the bytes are stored. The
 * owner's id is part of it, the extension follows the checked type.
 */
export function buildSavedGifKey(userId, gifId, type) {
  const extension = extensionForGifType(type);
  if (!extension) throw new Error("Unsupported GIF type.");
  if (!isValidUuid(userId) || !isValidUuid(gifId)) throw new Error("Invalid id for a GIF key.");
  return `gifs/${userId}/${gifId}${extension}`;
}

const KEY_SHAPE = /^gifs\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(gif|webp|png)$/i;

/** The person a saved-GIF key belongs to (lower case), or null when it is not a saved-GIF key. */
export function ownerOfSavedGifKey(key) {
  if (typeof key !== "string") return null;
  const match = KEY_SHAPE.exec(key);
  return match ? match[1].toLowerCase() : null;
}

/**
 * True only for a key of exactly the shape buildSavedGifKey() makes, inside
 * this person's own folder. Everything that reads, writes or deletes a stored
 * GIF checks it first, so a bad row can never reach another person's bytes or
 * climb out of the folder.
 */
export function isSavedGifKeyOf(userId, key) {
  if (typeof userId !== "string" || typeof key !== "string" || !userId) return false;
  const match = KEY_SHAPE.exec(key);
  return Boolean(match) && match[1].toLowerCase() === userId.toLowerCase();
}

const toIso = (value) => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  return value === undefined || value === null ? null : String(value);
};

const toIntOrNull = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

/**
 * What the API tells the owner about one saved GIF. No storage detail, no
 * hash, no origin: only what a client needs to show and send it.
 */
export function serializeSavedGif(row) {
  return {
    id: row.id,
    url: `/api/gifs/${row.id}/file`,
    // There is no still frame to point to: a client shows the GIF itself.
    thumbUrl: null,
    width: toIntOrNull(row.width),
    height: toIntOrNull(row.height),
    mime: row.mime,
    size: toIntOrNull(row.size_bytes) ?? 0,
    createdAt: toIso(row.created_at),
  };
}

const bad = (error) => ({ ok: false, error });

/**
 * Validates `POST /api/gifs`: { messageId, fileId | fileIndex }.
 * With neither, the message's first file is meant.
 */
export function parseSaveRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return bad("A message id is required.");
  }
  const { messageId, fileId, fileIndex } = body;
  if (messageId === undefined || messageId === null || messageId === "") {
    return bad("Field 'messageId' is required.");
  }
  if (typeof messageId !== "string" || messageId !== messageId.trim() || !isValidUuid(messageId)) {
    return bad("Field 'messageId' is not a valid UUID.");
  }

  const hasFileId = fileId !== undefined && fileId !== null && fileId !== "";
  const hasFileIndex = fileIndex !== undefined && fileIndex !== null && fileIndex !== "";
  if (hasFileId && hasFileIndex) return bad("Provide either 'fileId' or 'fileIndex', not both.");

  if (hasFileId) {
    const id = typeof fileId === "number" || typeof fileId === "string" ? Number(fileId) : NaN;
    if (!Number.isSafeInteger(id) || id < 1 || (typeof fileId === "string" && !/^\d{1,15}$/.test(fileId))) {
      return bad("Field 'fileId' must be a positive whole number.");
    }
    return { ok: true, messageId, fileId: id, fileIndex: null };
  }

  if (hasFileIndex) {
    const index = typeof fileIndex === "number" || typeof fileIndex === "string" ? Number(fileIndex) : NaN;
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index > MAX_FILE_INDEX ||
      (typeof fileIndex === "string" && !/^\d{1,3}$/.test(fileIndex))
    ) {
      return bad(`Field 'fileIndex' must be a whole number from 0 to ${MAX_FILE_INDEX}.`);
    }
    return { ok: true, messageId, fileId: null, fileIndex: index };
  }

  return { ok: true, messageId, fileId: null, fileIndex: 0 };
}

const refuse = (code, error) => ({ ok: false, status: 400, code, error });

/**
 * The verdict on a file's bytes: can it be a saved GIF?
 *
 * Resolves to { ok: true, type, mime, width, height, frames } or
 * { ok: false, status: 400, code, error }. Codes: gif_empty, gif_too_large,
 * gif_unsupported, gif_not_animated, gif_too_many_frames, gif_dimensions.
 */
export function evaluateGifBytes(buffer, { maxBytes = SAVED_GIF_MAX_BYTES } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return refuse("gif_empty", "The file is empty.");
  }
  if (buffer.length > maxBytes) {
    return refuse(
      "gif_too_large",
      `A GIF can be at most ${Math.max(1, Math.round(maxBytes / (1024 * 1024)))} MB.`,
    );
  }
  const type = sniffImageType(buffer);
  if (!GIF_TYPES.has(type)) {
    return refuse("gif_unsupported", "Only animated GIF, WebP or PNG images can be saved.");
  }
  const info = inspectImage(buffer, { maxFrames: MAX_FRAMES });
  if (!info) {
    return refuse("gif_unsupported", "Only animated GIF, WebP or PNG images can be saved.");
  }
  if (info.tooManyFrames) {
    return refuse("gif_too_many_frames", `A GIF can have at most ${MAX_FRAMES} frames.`);
  }
  if (!info.animated) {
    return refuse("gif_not_animated", "This image is not animated.");
  }
  if (
    !(info.width >= 1) ||
    !(info.height >= 1) ||
    info.width > SAVED_GIF_MAX_DIMENSION ||
    info.height > SAVED_GIF_MAX_DIMENSION
  ) {
    return refuse(
      "gif_dimensions",
      `A GIF can be at most ${SAVED_GIF_MAX_DIMENSION} by ${SAVED_GIF_MAX_DIMENSION} pixels.`,
    );
  }
  return {
    ok: true,
    type: info.type,
    mime: info.mime,
    width: info.width,
    height: info.height,
    frames: info.frames,
  };
}
