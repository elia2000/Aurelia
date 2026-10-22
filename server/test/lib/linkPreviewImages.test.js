import { describe, expect, test } from "vitest";
import { MAX_IMAGE_PIXELS, MAX_IMAGE_SIDE, PREVIEW_IMAGE_MAX_BYTES, readPreviewImage } from "../../lib/linkPreview/images.js";
import { buildWebp } from "../helpers/imageBytes.js";
import { gifBytes, jpegBytes, pngBytes, svgBytes, webpBytes } from "../helpers/linkPreviewFixture.js";

describe("pictures that are accepted", () => {
  test("PNG", () => {
    expect(readPreviewImage(pngBytes(640, 480))).toEqual({ type: "png", mime: "image/png", width: 640, height: 480 });
  });

  test("JPEG (the size is found past other segments)", () => {
    expect(readPreviewImage(jpegBytes(1200, 630))).toEqual({ type: "jpeg", mime: "image/jpeg", width: 1200, height: 630 });
  });

  test("a progressive JPEG", () => {
    const bytes = jpegBytes(300, 200);
    const at = bytes.indexOf(Buffer.from([0xff, 0xc0]));
    bytes[at + 1] = 0xc2; // SOF2
    expect(readPreviewImage(bytes)).toMatchObject({ type: "jpeg", width: 300, height: 200 });
  });

  test("GIF", () => {
    expect(readPreviewImage(gifBytes(120, 90))).toEqual({ type: "gif", mime: "image/gif", width: 120, height: 90 });
  });

  test("WebP, lossless", () => {
    expect(readPreviewImage(webpBytes(800, 600))).toEqual({ type: "webp", mime: "image/webp", width: 800, height: 600 });
  });

  test("WebP, extended", () => {
    expect(readPreviewImage(buildWebp({ width: 500, height: 250, animated: true }))).toMatchObject({
      type: "webp",
      width: 500,
      height: 250,
    });
  });

  test("WebP, lossy", () => {
    const payload = Buffer.concat([
      Buffer.from([0x10, 0x02, 0x00]), // frame tag
      Buffer.from([0x9d, 0x01, 0x2a]), // start code
      Buffer.from([0x40, 0x01, 0xf0, 0x00]), // 320 x 240
      Buffer.alloc(8),
    ]);
    const size = Buffer.alloc(4);
    size.writeUInt32LE(payload.length);
    const chunk = Buffer.concat([Buffer.from("VP8 "), size, payload]);
    const total = Buffer.alloc(4);
    total.writeUInt32LE(chunk.length + 4);
    const bytes = Buffer.concat([Buffer.from("RIFF"), total, Buffer.from("WEBP"), chunk]);
    expect(readPreviewImage(bytes)).toMatchObject({ type: "webp", width: 320, height: 240 });
  });

  test("a picture right at the limits", () => {
    expect(readPreviewImage(pngBytes(2048, 2048))).toMatchObject({ width: 2048, height: 2048 });
    expect(readPreviewImage(pngBytes(MAX_IMAGE_SIDE, 419))).toMatchObject({ width: MAX_IMAGE_SIDE, height: 419 });
    expect(readPreviewImage(pngBytes(1200, 630))).toMatchObject({ width: 1200, height: 630 }); // a typical og:image
    const exact = pngBytes(100, 50, PREVIEW_IMAGE_MAX_BYTES - pngBytes(100, 50).length);
    expect(exact.length).toBe(PREVIEW_IMAGE_MAX_BYTES);
    expect(readPreviewImage(exact)).not.toBeNull();
  });
});

describe("things that are not an accepted picture", () => {
  test("SVG is never accepted, whatever it claims to be", () => {
    expect(readPreviewImage(svgBytes())).toBeNull();
    expect(readPreviewImage(Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
  });

  test("HTML, script, JSON and text are not pictures", () => {
    for (const text of ["<!doctype html><title>x</title>", "<script>alert(1)</script>", '{"a":1}', "hello world, this is text"]) {
      expect(readPreviewImage(Buffer.from(text))).toBeNull();
    }
  });

  test("BMP, TIFF, ICO and AVIF are not accepted", () => {
    expect(readPreviewImage(Buffer.concat([Buffer.from("BM"), Buffer.alloc(40)]))).toBeNull();
    expect(readPreviewImage(Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00]), Buffer.alloc(40)]))).toBeNull();
    expect(readPreviewImage(Buffer.concat([Buffer.from([0, 0, 1, 0, 1, 0]), Buffer.alloc(40)]))).toBeNull();
    expect(readPreviewImage(Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypavif"), Buffer.alloc(40)]))).toBeNull();
  });

  test("a signature followed by nothing usable", () => {
    expect(readPreviewImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBeNull(); // PNG, no header
    expect(readPreviewImage(Buffer.from("GIF89a"))).toBeNull();
    expect(readPreviewImage(Buffer.from([0xff, 0xd8, 0xff]))).toBeNull();
    expect(readPreviewImage(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBeNull(); // JPEG with no frame header
    expect(readPreviewImage(Buffer.concat([Buffer.from("RIFF\0\0\0\0WEBP"), Buffer.alloc(30)]))).toBeNull(); // WebP, no chunk
  });

  test("a JPEG whose segments run off the end", () => {
    expect(readPreviewImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff, 0x00]))).toBeNull();
    expect(readPreviewImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00]))).toBeNull(); // zero length
  });

  test("empty, tiny and wrongly typed input", () => {
    for (const value of [Buffer.alloc(0), Buffer.from([1, 2, 3]), null, undefined, "PNG", 42, new Uint8Array([0x89, 0x50, 0x4e, 0x47])]) {
      expect(readPreviewImage(value)).toBeNull();
    }
  });

  test("a picture over 400 KB", () => {
    expect(PREVIEW_IMAGE_MAX_BYTES).toBe(400 * 1024);
    expect(readPreviewImage(pngBytes(100, 50, PREVIEW_IMAGE_MAX_BYTES))).toBeNull();
  });
});

describe("pictures that claim to be enormous (a few bytes that decode to gigabytes)", () => {
  test.each([
    ["PNG 60000 x 60000", () => pngBytes(60000, 60000)],
    ["PNG 4294967295 wide", () => pngBytes(0xffffffff, 10)],
    ["PNG 10001 wide", () => pngBytes(MAX_IMAGE_SIDE + 1, 10)],
    ["PNG 6001 x 6001", () => pngBytes(6001, 6001)],
    // Small files that the page would still have to decode in full: 6000 x 6000
    // is 144 MB of bitmap for a 64 px thumbnail, and eight of them used to cost
    // a reader's browser half a gigabyte.
    ["PNG 6000 x 6000", () => pngBytes(6000, 6000)],
    ["PNG 2049 x 2048", () => pngBytes(2049, 2048)],
    ["PNG 10000 x 420", () => pngBytes(MAX_IMAGE_SIDE, 420)],
    ["GIF 3000 x 3000", () => gifBytes(3000, 3000)],
    ["JPEG 4000 x 3000", () => jpegBytes(4000, 3000)],
    ["WebP 3000 x 3000", () => webpBytes(3000, 3000)],
    ["PNG 0 wide", () => pngBytes(0, 10)],
    ["PNG 0 high", () => pngBytes(10, 0)],
    ["JPEG 65535 x 65535", () => jpegBytes(65535, 65535)],
    ["JPEG 0 x 0", () => jpegBytes(0, 0)],
    ["GIF 65535 x 65535", () => gifBytes(65535, 65535)],
    ["WebP 16383 x 16383", () => webpBytes(16383, 16383)],
  ])("%s is refused", (_name, make) => {
    expect(readPreviewImage(make())).toBeNull();
  });

  test("the pixel limit is a few megapixels (what a real og:image needs, not what a bomb needs)", () => {
    expect(MAX_IMAGE_PIXELS).toBe(2048 * 2048);
  });
});
