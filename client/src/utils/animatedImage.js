// Tells animated pictures (GIF, animated WebP, APNG) from still ones by looking
// at the first bytes of a file. Nothing here decodes pixels, and nothing here
// decides what the server stores: the server reads the bytes again and sets the
// `isAnimated` / `gif` flags of a message file itself. This is only a hint for
// the interface (keep the file as it is, show a GIF badge in the composer).

/** How much of a file is read to inspect it. */
export const SNIFF_BYTES = 256 * 1024;

const ascii = (bytes, start, end) => {
  let text = "";
  for (let i = start; i < end && i < bytes.length; i += 1) {
    text += String.fromCharCode(bytes[i]);
  }
  return text;
};

const u16le = (bytes, at) => bytes[at] | (bytes[at + 1] << 8);
const u24le = (bytes, at) => bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16);
const u32be = (bytes, at) =>
  ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;

const emptyInfo = () => ({ kind: null, animated: false, width: null, height: null });

// GIF: header, logical screen, then blocks. A second image descriptor means
// animation. `null` means the inspected part of the file ended first.
function inspectGif(bytes) {
  const info = { kind: "gif", animated: null, width: u16le(bytes, 6), height: u16le(bytes, 8) };
  if (bytes.length < 13) return info;
  let at = 13;
  const globalTable = bytes[10] & 0x80 ? 3 * (1 << ((bytes[10] & 0x07) + 1)) : 0;
  at += globalTable;
  let frames = 0;
  const skipSubBlocks = () => {
    while (at < bytes.length) {
      const size = bytes[at];
      at += 1;
      if (size === 0) return true;
      at += size;
    }
    return false;
  };
  while (at < bytes.length) {
    const marker = bytes[at];
    at += 1;
    if (marker === 0x3b) {
      info.animated = frames > 1;
      return info;
    }
    if (marker === 0x21) {
      at += 1; // the extension label
      if (!skipSubBlocks()) return info;
      continue;
    }
    if (marker === 0x2c) {
      frames += 1;
      if (frames > 1) {
        info.animated = true;
        return info;
      }
      if (at + 9 > bytes.length) return info;
      const flags = bytes[at + 8];
      at += 9;
      if (flags & 0x80) at += 3 * (1 << ((flags & 0x07) + 1));
      at += 1; // the LZW minimum code size
      if (!skipSubBlocks()) return info;
      continue;
    }
    // Not a block that belongs here: a broken file. The server will refuse it.
    return info;
  }
  return info;
}

// WebP: a RIFF container whose first chunk says (VP8X flag 0x02) if it is animated.
function inspectWebp(bytes) {
  const info = { kind: "webp", animated: false, width: null, height: null };
  const chunk = ascii(bytes, 12, 16);
  if (chunk === "VP8X" && bytes.length >= 30) {
    info.animated = (bytes[20] & 0x02) !== 0;
    info.width = u24le(bytes, 24) + 1;
    info.height = u24le(bytes, 27) + 1;
  }
  return info;
}

// PNG: an `acTL` chunk before the first `IDAT` makes it an APNG.
function inspectPng(bytes) {
  const info = { kind: "png", animated: null, width: null, height: null };
  if (bytes.length >= 24) {
    info.width = u32be(bytes, 16);
    info.height = u32be(bytes, 20);
  }
  let at = 8;
  while (at + 8 <= bytes.length) {
    const length = u32be(bytes, at);
    const type = ascii(bytes, at + 4, at + 8);
    if (type === "acTL") {
      info.animated = true;
      return info;
    }
    if (type === "IDAT" || type === "IEND") {
      info.animated = false;
      return info;
    }
    at += 12 + length;
  }
  return info;
}

/**
 * What the first bytes of a picture say about it.
 *
 * @param {Uint8Array | ArrayLike<number>} bytes
 * @returns {{ kind: "gif" | "webp" | "png" | null, animated: boolean | null, width: number | null, height: number | null }}
 *   `animated: null` means the inspected part was too short to tell.
 */
export function inspectImageHead(bytes) {
  if (!bytes || bytes.length < 12) return emptyInfo();
  const head = ascii(bytes, 0, 6);
  if (head === "GIF87a" || head === "GIF89a") return inspectGif(bytes);
  if (head.startsWith("RIFF") && ascii(bytes, 8, 12) === "WEBP") return inspectWebp(bytes);
  if (
    bytes[0] === 0x89 &&
    ascii(bytes, 1, 4) === "PNG" &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return inspectPng(bytes);
  }
  return emptyInfo();
}

/** The first bytes of a File or Blob (never more than `maxBytes`). */
export async function readImageHead(blob, maxBytes = SNIFF_BYTES) {
  if (!blob || typeof blob.slice !== "function") return new Uint8Array(0);
  try {
    const part = blob.slice(0, maxBytes);
    const buffer =
      typeof part.arrayBuffer === "function"
        ? await part.arrayBuffer()
        : await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsArrayBuffer(part);
          });
    return new Uint8Array(buffer);
  } catch {
    return new Uint8Array(0);
  }
}

/**
 * Inspects a picked file. The bytes win; when they are not recognised the
 * content type of the file is used (an `image/gif` stays a GIF).
 */
export async function inspectImageFile(file) {
  const info = inspectImageHead(await readImageHead(file));
  if (info.kind) return info;
  const mime = String(file?.type || "").toLowerCase();
  if (mime === "image/gif") return { ...info, kind: "gif", animated: null };
  return info;
}

/**
 * True for pictures that must reach the server exactly as they are, without any
 * redrawing on the client: every GIF, every animated WebP, every APNG. Redrawing
 * on a canvas would keep only the first frame.
 */
export function shouldKeepImageUntouched(info) {
  if (!info) return false;
  return info.kind === "gif" || info.animated === true;
}

/** True when the interface should present the picture as a GIF (badge, no still preview). */
export function looksAnimated(info) {
  if (!info) return false;
  if (info.kind === "gif") return info.animated !== false;
  return info.animated === true;
}

/**
 * Whether a message file is a GIF. The server flags what it has checked
 * (`isAnimated` / `gif`); older rows have no flag, so an `image/gif` file
 * counts as well.
 */
export function isGifFile(file) {
  if (!file) return false;
  if (file.isAnimated === true || file.gif === true) return true;
  const mime = String(file.mimeType || file.mime_type || file.mime || "").toLowerCase();
  return mime === "image/gif";
}

export const SAVED_GIF_ACCEPT = "image/gif,image/webp,image/png,.gif,.webp,.apng";
export const SAVED_GIF_MAX_BYTES = 20 * 1024 * 1024;
