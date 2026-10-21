// Tiny, valid pictures built byte by byte for the tests of animated images.

const ascii = (text) => Array.from(text, (ch) => ch.charCodeAt(0));
const le16 = (n) => [n & 0xff, (n >> 8) & 0xff];
const be32 = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const le32 = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
const le24 = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];

/** A GIF with `frames` identical frames (1 = a still GIF). */
export function makeGifBytes({ frames = 2, width = 2, height = 2 } = {}) {
  const bytes = [
    ...ascii("GIF89a"),
    ...le16(width),
    ...le16(height),
    0x80, // a global colour table of 2 entries
    0x00,
    0x00,
    0x00, 0x00, 0x00, 0xff, 0xff, 0xff,
  ];
  for (let i = 0; i < frames; i += 1) {
    bytes.push(0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00); // graphic control: 100 ms
    bytes.push(0x2c, ...le16(0), ...le16(0), ...le16(width), ...le16(height), 0x00);
    bytes.push(0x02, 0x02, 0x44, 0x01, 0x00); // LZW data
  }
  bytes.push(0x3b);
  return new Uint8Array(bytes);
}

/** A WebP header. Animated pictures set the animation flag of the VP8X chunk. */
export function makeWebpBytes({ animated = false, width = 8, height = 6 } = {}) {
  return new Uint8Array([
    ...ascii("RIFF"),
    ...le32(22),
    ...ascii("WEBP"),
    ...ascii("VP8X"),
    ...le32(10),
    animated ? 0x02 : 0x00,
    0x00, 0x00, 0x00,
    ...le24(width - 1),
    ...le24(height - 1),
  ]);
}

/** A PNG made of its signature and chunks; `animated` adds the acTL chunk (an APNG). */
export function makePngBytes({ animated = false, width = 4, height = 3 } = {}) {
  const chunk = (type, data) => [...be32(data.length), ...ascii(type), ...data, 0, 0, 0, 0];
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk("IHDR", [...be32(width), ...be32(height), 8, 6, 0, 0, 0]),
    ...(animated ? chunk("acTL", [...be32(2), ...be32(0)]) : []),
    ...chunk("IDAT", [0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01]),
    ...chunk("IEND", []),
  ]);
}

/** The first bytes of a JPEG. */
export function makeJpegBytes() {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01]);
}
