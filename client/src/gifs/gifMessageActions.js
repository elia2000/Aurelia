import { isGifFile } from "../utils/animatedImage.js";

// Small pure helpers between a chat message and the saved-GIFs collection.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isPicture = (file) => String(file?.mimeType || file?.mime_type || file?.mime || "").toLowerCase().startsWith("image/");

/**
 * The GIF of a message that a "Save GIF" action means: the one with the id
 * `preferredFileId` (the picture the person pointed at) when that is a GIF,
 * else the first GIF.
 */
export function findGifFile(message, preferredFileId = null) {
  const files = (Array.isArray(message?.files) ? message.files : []).filter(
    (file) => isPicture(file) && isGifFile(file),
  );
  if (preferredFileId !== null && preferredFileId !== undefined && preferredFileId !== "") {
    const wanted = files.find((file) => String(file?.id) === String(preferredFileId));
    if (wanted) return wanted;
  }
  return files[0] || null;
}

/**
 * What POST /api/gifs needs for one GIF of a message: the message's id (the
 * server's, not the temporary one of a message that is still being sent) and
 * the file's id. `null` while the server does not know the message or file yet.
 */
export function resolveSaveGifTarget(message, file) {
  if (!message || !file) return null;
  const messageId = String(message._serverId || message.id || "");
  if (!UUID.test(messageId)) return null;
  const fileId = Number(file.id);
  if (!Number.isInteger(fileId) || fileId <= 0) return null;
  return { messageId, fileId };
}

const positiveOrNull = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * The picture shown at once, while a saved GIF is on its way to the chat. The
 * server answers with its own file entry, which replaces this one.
 */
export function buildSavedGifPreviewFile(gif) {
  return {
    id: `saved-gif-${gif.id}`,
    _localId: `saved-gif-${gif.id}`,
    kind: "media",
    name: "animation.gif",
    mimeType: gif.mime || "image/gif",
    sizeBytes: Number(gif.size) || 0,
    width: positiveOrNull(gif.width),
    height: positiveOrNull(gif.height),
    durationSeconds: null,
    url: gif.url,
    isAnimated: true,
    gif: true,
  };
}
