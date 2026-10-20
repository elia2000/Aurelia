/**
 * Animated image detection (GIF, animated WebP, APNG).
 *
 * Works on the file's bytes, never on the MIME type or the file name the
 * sender supplied: a GIF is a GIF because it starts with the GIF signature and
 * has more than one frame. Only headers and block lengths are walked; no pixel
 * data is ever decoded, so the work is linear in the file size and needs no
 * memory beyond the buffer itself, whatever dimensions the file claims.
 *
 * Bounds that protect the server (and, through the saved-GIF limits, the
 * clients that will decode the file):
 *   - ANIMATION_SCAN_MAX_BYTES  nothing bigger than this is ever read for a check
 *   - MAX_FRAMES                frame counting stops one past this limit
 *   - MAX_WALK_STEPS            every walk ends after this many blocks/chunks
 */

export const ANIMATION_SCAN_MAX_BYTES = 32 * 1024 * 1024;
export const MAX_FRAMES = 2000;
const MAX_WALK_STEPS = 2_000_000;

export const IMAGE_MIME_BY_TYPE = {
  gif: "image/gif",
  webp: "image/webp",
  png: "image/png",
  jpeg: "image/jpeg",
  bmp: "image/bmp",
};

export const IMAGE_EXTENSION_BY_TYPE = {
  gif: ".gif",
  webp: ".webp",
  png: ".png",
  jpeg: ".jpg",
  bmp: ".bmp",
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** What the bytes say the file is: "gif" | "webp" | "png" | "jpeg" | "bmp" | null. */
export function sniffImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  if (buffer.length >= 6) {
    const head = buffer.toString("latin1", 0, 6);
    if (head === "GIF87a" || head === "GIF89a") return "gif";
  }
  if (
    buffer.length >= 12 &&
    buffer.toString("latin1", 0, 4) === "RIFF" &&
    buffer.toString("latin1", 8, 12) === "WEBP"
  ) {
    return "webp";
  }
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return "png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpeg";
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return "bmp";
  return null;
}

/** Skips a run of GIF data sub-blocks. Returns the position after the terminator, or -1 if cut off. */
function skipGifSubBlocks(buffer, start) {
  let pos = start;
  let steps = 0;
  while (pos < buffer.length) {
    const size = buffer[pos];
    pos += 1;
    if (size === 0) return pos;
    pos += size;
    steps += 1;
    if (steps > MAX_WALK_STEPS) return -1;
  }
  return -1;
}

function inspectGif(buffer, { maxFrames, stopAtFrames }) {
  if (buffer.length < 13) return null;
  const width = buffer.readUInt16LE(6);
  const height = buffer.readUInt16LE(8);
  const packed = buffer[10];
  let pos = 13;
  if (packed & 0x80) pos += 3 * (1 << ((packed & 0x07) + 1));

  let frames = 0;
  let steps = 0;
  let tooManyFrames = false;
  // True once more bytes could not change the answer: the trailer was reached,
  // a block we do not know ended the walk, or enough frames were counted.
  let complete = false;
  while (pos < buffer.length && steps < MAX_WALK_STEPS) {
    steps += 1;
    const marker = buffer[pos];
    if (marker === 0x3b) {
      complete = true; // trailer
      break;
    }
    if (marker === 0x21) {
      // Extension: introducer, label, then data sub-blocks.
      pos = skipGifSubBlocks(buffer, pos + 2);
      if (pos < 0) break;
      continue;
    }
    if (marker === 0x2c) {
      // Image descriptor: 9 bytes, optional local colour table, LZW size, data.
      if (pos + 10 > buffer.length) break;
      const localPacked = buffer[pos + 9];
      pos += 10;
      if (localPacked & 0x80) pos += 3 * (1 << ((localPacked & 0x07) + 1));
      pos += 1; // LZW minimum code size
      if (pos > buffer.length) break;
      frames += 1;
      if (frames > maxFrames) {
        tooManyFrames = true;
        complete = true;
        break;
      }
      if (stopAtFrames && frames >= stopAtFrames) {
        complete = frames >= 2;
        break;
      }
      pos = skipGifSubBlocks(buffer, pos);
      if (pos < 0) break;
      continue;
    }
    complete = true; // not a block we know: the rest cannot be trusted
    break;
  }
  if (frames >= 2) complete = true;

  return {
    type: "gif",
    mime: IMAGE_MIME_BY_TYPE.gif,
    width,
    height,
    frames,
    animated: frames >= 2,
    complete,
    tooManyFrames,
  };
}

function readUInt24LE(buffer, offset) {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

function inspectWebp(buffer, { maxFrames, stopAtFrames }) {
  let width = 0;
  let height = 0;
  let animationFlag = false;
  let frames = 0;
  let tooManyFrames = false;
  // A still image chunk (or a VP8X header without the animation flag) settles it.
  let stillSeen = false;
  const riffEnd = buffer.length >= 8 ? 8 + buffer.readUInt32LE(4) : Infinity;
  let pos = 12;
  let steps = 0;
  while (pos + 8 <= buffer.length && steps < MAX_WALK_STEPS) {
    steps += 1;
    const fourcc = buffer.toString("latin1", pos, pos + 4);
    const size = buffer.readUInt32LE(pos + 4);
    const data = pos + 8;
    if (fourcc === "VP8X" && size >= 10 && data + 10 <= buffer.length) {
      animationFlag = Boolean(buffer[data] & 0x02);
      if (!animationFlag) stillSeen = true;
      width = 1 + readUInt24LE(buffer, data + 4);
      height = 1 + readUInt24LE(buffer, data + 7);
    } else if (fourcc === "VP8L" && size >= 5 && data + 5 <= buffer.length && !width) {
      // One signature byte (0x2f), then 14 bits of width-1 and 14 of height-1.
      const bits = buffer.readUInt32LE(data + 1);
      width = (bits & 0x3fff) + 1;
      height = ((bits >>> 14) & 0x3fff) + 1;
      stillSeen = !animationFlag;
    } else if (fourcc === "VP8 " && size >= 10 && data + 10 <= buffer.length && !width) {
      width = buffer.readUInt16LE(data + 6) & 0x3fff;
      height = buffer.readUInt16LE(data + 8) & 0x3fff;
      stillSeen = !animationFlag;
    } else if (fourcc === "ANMF") {
      frames += 1;
      if (frames > maxFrames) {
        tooManyFrames = true;
        break;
      }
      if (stopAtFrames && frames >= stopAtFrames) break;
    }
    pos = data + size + (size & 1);
  }
  const animated = animationFlag && frames >= 2;
  const reachedEnd = buffer.length >= riffEnd && pos + 8 > riffEnd;

  return {
    type: "webp",
    mime: IMAGE_MIME_BY_TYPE.webp,
    width,
    height,
    frames: frames || 1,
    animated,
    complete: animated || tooManyFrames || stillSeen || reachedEnd,
    tooManyFrames,
  };
}

function inspectPng(buffer, { maxFrames }) {
  let width = 0;
  let height = 0;
  let frames = 1;
  let tooManyFrames = false;
  let complete = false;
  let pos = 8;
  let steps = 0;
  while (pos + 8 <= buffer.length && steps < MAX_WALK_STEPS) {
    steps += 1;
    const length = buffer.readUInt32BE(pos);
    const type = buffer.toString("latin1", pos + 4, pos + 8);
    const data = pos + 8;
    if (type === "IHDR" && length >= 8 && data + 8 <= buffer.length) {
      width = buffer.readUInt32BE(data);
      height = buffer.readUInt32BE(data + 4);
    } else if (type === "acTL" && length >= 8 && data + 8 <= buffer.length) {
      frames = buffer.readUInt32BE(data);
      if (frames > maxFrames) {
        tooManyFrames = true;
        frames = maxFrames + 1;
      }
      complete = true;
      break; // acTL must precede IDAT; nothing after it can change the answer
    } else if (type === "IDAT" || type === "IEND") {
      complete = true;
      break; // no animation control chunk before the image data: a still PNG
    }
    pos = data + length + 4; // data + CRC
    if (length > buffer.length) break;
  }

  return {
    type: "png",
    mime: IMAGE_MIME_BY_TYPE.png,
    width,
    height,
    frames,
    animated: frames >= 2,
    complete,
    tooManyFrames,
  };
}

/**
 * Looks inside an image. Returns null when the bytes are not a GIF, WebP or PNG
 * (JPEG and BMP are recognised by sniffImageType but are never animated).
 *
 *   { type, mime, width, height, frames, animated, complete, tooManyFrames }
 *
 * `complete` says that reading more of the file could not change `animated`
 * (so a caller that only has a prefix of the file may stop there).
 *
 * `frames` is counted up to `maxFrames` (one more is reported with
 * `tooManyFrames`). `stopAtFrames` ends the walk early once that many frames
 * were seen, which is all a plain "is it animated" question needs.
 */
export function inspectImage(buffer, { maxFrames = MAX_FRAMES, stopAtFrames = 0 } = {}) {
  const type = sniffImageType(buffer);
  const options = { maxFrames, stopAtFrames };
  try {
    if (type === "gif") return inspectGif(buffer, options);
    if (type === "webp") return inspectWebp(buffer, options);
    if (type === "png") return inspectPng(buffer, options);
  } catch {
    return null;
  }
  return null;
}

/** Quick "is this an animated GIF / WebP / APNG" answer: true, false, or null if it is none of them. */
export function detectAnimation(buffer) {
  const info = inspectImage(buffer, { stopAtFrames: 2 });
  return info ? info.animated : null;
}

// How much of a file is read, step by step, to find out whether it is
// animated: most answers are in the first few hundred kilobytes, and only a
// GIF whose first frame is huge needs more.
export const ANIMATION_PREFIX_LADDER = [256 * 1024, 2 * 1024 * 1024, 16 * 1024 * 1024, ANIMATION_SCAN_MAX_BYTES];

// What one request may make the server read from a bucket to answer that
// question for all of its files together. Each step of the ladder reads the
// start of the object again, and an object in a bucket is whatever its sender
// made it (a presigned upload has no length limit, and a GIF can be made that
// never settles), so without a cap one request could cost the whole ladder per
// file. The 16 MB step still fits, so a GIF with a huge first frame is still
// recognised; the 32 MB step does not.
export const ANIMATION_REQUEST_SCAN_BUDGET_BYTES = 20 * 1024 * 1024;

/**
 * Answers "is this animated?" for a file that is read from its start in
 * growing prefixes, e.g. from object storage.
 *
 * `read(limit)` resolves to (at most) the first `limit` bytes of the file, or
 * null when it cannot be read. `size` is the file's size when known.
 * Resolves to true / false, or null when it cannot be told: not an animated
 * format, unreadable, or undecided within `maxBytes`. Never throws.
 */
export async function detectAnimationFromReader(
  read,
  { size = null, ladder = ANIMATION_PREFIX_LADDER, maxBytes = ANIMATION_SCAN_MAX_BYTES } = {},
) {
  try {
    const knownSize = Number.isFinite(Number(size)) && Number(size) > 0 ? Number(size) : null;
    let previousLength = -1;
    for (const rung of ladder) {
      const limit = Math.min(rung, maxBytes);
      const buffer = await read(limit);
      if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
      const info = inspectImage(buffer, { stopAtFrames: 2 });
      if (!info) return null;
      if (info.animated) return true;
      const wholeFile = knownSize !== null ? buffer.length >= knownSize : buffer.length < limit;
      if (info.complete || wholeFile) return false;
      if (buffer.length === previousLength || limit >= maxBytes) return null;
      previousLength = buffer.length;
    }
    return null;
  } catch {
    return null;
  }
}

/** The two file-payload fields that mark a GIF-style attachment (both mean the same). */
export function animationFlags(row) {
  const raw = row?.is_animated ?? row?.isAnimated;
  const on = raw === true || raw === 1 || raw === "1" || raw === "true";
  return { isAnimated: on, gif: on };
}

const CANDIDATE_MIME_TYPES = new Set([
  "image/gif",
  "image/webp",
  "image/png",
  "image/apng",
]);
const CANDIDATE_EXTENSIONS = new Set([".gif", ".webp", ".png", ".apng"]);

/**
 * Cheap pre-filter on what the sender claimed, so photos, videos and
 * documents are never opened for an animation check. The bytes still decide.
 */
export function isAnimationCandidate({ mimeType = "", name = "" } = {}) {
  const mime = String(mimeType || "").trim().toLowerCase();
  if (CANDIDATE_MIME_TYPES.has(mime)) return true;
  if (mime && mime !== "application/octet-stream" && !mime.startsWith("image/")) return false;
  const dot = String(name || "").lastIndexOf(".");
  const ext = dot >= 0 ? String(name).slice(dot).toLowerCase() : "";
  return CANDIDATE_EXTENSIONS.has(ext);
}

/**
 * Answers whether a file on disk is animated, reading as little of it as it
 * takes: the start of the file in growing steps (a big PNG screenshot is
 * answered from its first kilobytes), never more than `maxBytes`.
 * Resolves to true / false, or null when it cannot be told: not an animated
 * format, unreadable, or undecided within `maxBytes`. Never throws.
 *
 * @param {object} options
 * @param {object} options.fs        node:fs (needs fs.promises.open)
 * @param {string} options.filePath
 * @param {(buffer: Buffer) => Buffer} [options.decrypt] undoes at-rest encryption
 *        (an encrypted file can only be opened as a whole)
 */
export async function detectAnimatedFile({
  fs,
  filePath,
  decrypt = null,
  maxBytes = ANIMATION_SCAN_MAX_BYTES,
}) {
  let handle = null;
  try {
    if (!fs?.promises?.open || !filePath) return null;
    handle = await fs.promises.open(filePath, "r");
    const { size } = await handle.stat();
    if (!size) return null;

    const readPrefix = async (limit) => {
      const length = Math.min(limit, size);
      const buffer = Buffer.allocUnsafe(length);
      let offset = 0;
      while (offset < length) {
        const { bytesRead } = await handle.read(buffer, offset, length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      return buffer.subarray(0, offset);
    };

    if (!decrypt) {
      return await detectAnimationFromReader(readPrefix, { size, maxBytes });
    }

    // An encrypted file is a little larger than its content; the limit is a
    // memory bound, so it is applied to what is read.
    if (size > maxBytes + 1024) return null;
    const bytes = decrypt(await readPrefix(size));
    if (bytes.length > maxBytes) return null;
    return detectAnimation(bytes);
  } catch {
    return null;
  } finally {
    try {
      await handle?.close();
    } catch {
      // nothing to do
    }
  }
}
