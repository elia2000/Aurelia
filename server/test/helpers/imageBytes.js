/**
 * Builders for tiny, structurally valid GIF / WebP / PNG byte strings.
 *
 * The animation checks only walk headers and block lengths, so the pixel data
 * here is a few filler bytes; what matters is that the block structure is the
 * real one. Used by the unit tests and the API fixtures.
 */

const u16le = (n) => Buffer.from([n & 0xff, (n >> 8) & 0xff]);
const u32le = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
};
const u32be = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};

/** A GIF with `frames` image frames. */
export function buildGif({
  width = 4,
  height = 4,
  frames = 2,
  trailer = true,
  version = "89a",
  loopExtension = true,
  padTo = 0,
} = {}) {
  const parts = [
    Buffer.from(`GIF${version}`, "latin1"),
    u16le(width),
    u16le(height),
    Buffer.from([0x80, 0x00, 0x00]), // global colour table of 2 entries
    Buffer.from([0x00, 0x00, 0x00, 0xff, 0xff, 0xff]),
  ];
  if (loopExtension) {
    // NETSCAPE2.0 looping extension.
    parts.push(
      Buffer.from([0x21, 0xff, 0x0b]),
      Buffer.from("NETSCAPE2.0", "latin1"),
      Buffer.from([0x03, 0x01, 0x00, 0x00, 0x00]),
    );
  }
  for (let i = 0; i < frames; i += 1) {
    parts.push(
      Buffer.from([0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00]), // graphic control
      Buffer.from([0x2c, 0, 0, 0, 0]),
      u16le(width),
      u16le(height),
      Buffer.from([0x00]), // no local colour table
      Buffer.from([0x02, 0x02, 0x4c, 0x01, 0x00]), // LZW size, one sub-block, terminator
    );
  }
  if (trailer) parts.push(Buffer.from([0x3b]));
  const bytes = Buffer.concat(parts);
  if (padTo > bytes.length) {
    // Comment extension that carries filler, to reach a given file size.
    const missing = padTo - bytes.length;
    const filler = [];
    let left = missing - 3; // introducer, label, final terminator
    while (left > 0) {
      const take = Math.min(255, left - 1);
      if (take <= 0) break;
      filler.push(Buffer.from([take]), Buffer.alloc(take, 0x20));
      left -= take + 1;
    }
    const comment = Buffer.concat([Buffer.from([0x21, 0xfe]), ...filler, Buffer.from([0x00])]);
    // Insert before the first frame's graphic control extension.
    const insertAt = 13 + 6 + (loopExtension ? 19 : 0);
    return Buffer.concat([bytes.subarray(0, insertAt), comment, bytes.subarray(insertAt)]);
  }
  return bytes;
}

const riffChunk = (fourcc, data) => {
  const padding = data.length % 2 ? Buffer.from([0]) : Buffer.alloc(0);
  return Buffer.concat([Buffer.from(fourcc, "latin1"), u32le(data.length), data, padding]);
};

/** A WebP: animated (VP8X + ANIM + ANMF frames) or a still lossless image. */
export function buildWebp({ width = 4, height = 4, animated = true, frames = 2, flagOnly = false } = {}) {
  let chunks;
  if (animated) {
    const flags = Buffer.from([0x02, 0, 0, 0]);
    const w = Buffer.from([(width - 1) & 0xff, ((width - 1) >> 8) & 0xff, ((width - 1) >> 16) & 0xff]);
    const h = Buffer.from([(height - 1) & 0xff, ((height - 1) >> 8) & 0xff, ((height - 1) >> 16) & 0xff]);
    chunks = [
      riffChunk("VP8X", Buffer.concat([flags, w, h])),
      riffChunk("ANIM", Buffer.from([0xff, 0xff, 0xff, 0xff, 0x00, 0x00])),
    ];
    if (!flagOnly) {
      for (let i = 0; i < frames; i += 1) {
        chunks.push(riffChunk("ANMF", Buffer.alloc(24, 0x01)));
      }
    }
  } else {
    // VP8L: signature byte, then 14 bits width-1 and 14 bits height-1.
    const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
    chunks = [riffChunk("VP8L", Buffer.concat([Buffer.from([0x2f]), u32le(bits), Buffer.alloc(8)]))];
  }
  const body = Buffer.concat([Buffer.from("WEBP", "latin1"), ...chunks]);
  return Buffer.concat([Buffer.from("RIFF", "latin1"), u32le(body.length), body]);
}

const pngChunk = (type, data) =>
  Buffer.concat([u32be(data.length), Buffer.from(type, "latin1"), data, u32be(0)]);

/** A PNG: animated (APNG, with an acTL chunk) or a still one. */
export function buildPng({ width = 4, height = 4, animated = false, frames = 2 } = {}) {
  const ihdr = Buffer.concat([u32be(width), u32be(height), Buffer.from([8, 6, 0, 0, 0])]);
  const chunks = [pngChunk("IHDR", ihdr)];
  if (animated) chunks.push(pngChunk("acTL", Buffer.concat([u32be(frames), u32be(0)])));
  chunks.push(pngChunk("IDAT", Buffer.alloc(12, 0x05)), pngChunk("IEND", Buffer.alloc(0)));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ...chunks,
  ]);
}

/** A minimal JPEG start, enough for the signature check. */
export function buildJpeg() {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
}
