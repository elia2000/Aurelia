/**
 * Is this really a picture a preview may show, and how big is it?
 *
 * Decided from the bytes only (never the Content-Type or file name the other
 * site sent). PNG, JPEG, WebP and GIF are accepted; SVG, BMP and everything
 * else are not. The size is read from the header, so a tiny file that claims
 * to be thousands of pixels wide (a decompression bomb for whoever decodes it:
 * the server never does, but the browser of everyone reading the chat would)
 * is refused without decoding anything.
 */

import { IMAGE_MIME_BY_TYPE, sniffImageType } from "../animatedImage.js";

export const PREVIEW_IMAGE_MAX_BYTES = 400 * 1024;
export const MAX_IMAGE_SIDE = 10000;
// A preview picture is drawn 64 px wide, but the browser decodes all of it: 4
// bytes a pixel, so this is at most 16 MB of bitmap (a real og:image is about
// 1200 x 630; 36 MP, which this used to allow, was 144 MB for one card).
export const MAX_IMAGE_PIXELS = 2048 * 2048;

const ALLOWED = new Set(["png", "jpeg", "webp", "gif"]);

const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function pngSize(b) {
  if (b.length < 24 || b.toString("latin1", 12, 16) !== "IHDR") return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function gifSize(b) {
  if (b.length < 10) return null;
  return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
}

function webpSize(b) {
  if (b.length < 30) return null;
  const kind = b.toString("latin1", 12, 16);
  if (kind === "VP8 ") {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (kind === "VP8L") {
    if (b[20] !== 0x2f) return null;
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (kind === "VP8X") {
    return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  }
  return null;
}

function jpegSize(b) {
  let i = 2;
  for (let steps = 0; steps < 512 && i + 4 <= b.length; steps += 1) {
    if (b[i] !== 0xff) return null;
    let marker = b[i + 1];
    while (marker === 0xff && i + 2 < b.length) {
      i += 1;
      marker = b[i + 1];
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2; // markers without a length
      continue;
    }
    const length = b.readUInt16BE(i + 2);
    if (SOF_MARKERS.has(marker)) {
      if (i + 9 > b.length) return null;
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    if (marker === 0xda || length < 2) return null; // image data starts, no size seen
    i += 2 + length;
  }
  return null;
}

/**
 * @param {Buffer} buffer
 * @returns {{ type: "png"|"jpeg"|"webp"|"gif", mime: string, width: number, height: number } | null}
 */
export function readPreviewImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length > PREVIEW_IMAGE_MAX_BYTES) return null;
  const type = sniffImageType(buffer);
  if (!type || !ALLOWED.has(type)) return null;
  let size = null;
  try {
    size = { png: pngSize, gif: gifSize, webp: webpSize, jpeg: jpegSize }[type](buffer);
  } catch {
    size = null;
  }
  if (!size) return null;
  const { width, height } = size;
  if (!(width > 0 && height > 0)) return null;
  if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE || width * height > MAX_IMAGE_PIXELS) return null;
  return { type, mime: IMAGE_MIME_BY_TYPE[type], width, height };
}
