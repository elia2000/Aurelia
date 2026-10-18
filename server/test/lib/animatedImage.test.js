import { describe, test, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ANIMATION_SCAN_MAX_BYTES,
  MAX_FRAMES,
  animationFlags,
  detectAnimatedFile,
  detectAnimation,
  detectAnimationFromReader,
  inspectImage,
  isAnimationCandidate,
  sniffImageType,
} from "../../lib/animatedImage.js";
import { buildGif, buildJpeg, buildPng, buildWebp } from "../helpers/imageBytes.js";

describe("sniffImageType", () => {
  test("recognises images by their first bytes, not by anything a sender says", () => {
    expect(sniffImageType(buildGif())).toBe("gif");
    expect(sniffImageType(buildGif({ version: "87a" }))).toBe("gif");
    expect(sniffImageType(buildWebp())).toBe("webp");
    expect(sniffImageType(buildPng())).toBe("png");
    expect(sniffImageType(buildJpeg())).toBe("jpeg");
    expect(sniffImageType(Buffer.from("BM\0\0\0\0", "latin1"))).toBe("bmp");
  });

  test.each([
    ["an HTML document", Buffer.from("<html><script>alert(1)</script></html>")],
    ["an SVG", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
    ["a RIFF file that is not WebP", Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE")])],
    ["a GIF header cut short", Buffer.from("GIF8")],
    ["nothing", Buffer.alloc(0)],
    ["not a buffer", "GIF89a"],
  ])("returns null for %s", (_label, input) => {
    expect(sniffImageType(input)).toBeNull();
  });
});

describe("GIF", () => {
  test("two frames is animated, with the real size and frame count", () => {
    const info = inspectImage(buildGif({ width: 320, height: 200, frames: 2 }));
    expect(info).toMatchObject({
      type: "gif",
      mime: "image/gif",
      width: 320,
      height: 200,
      frames: 2,
      animated: true,
      tooManyFrames: false,
    });
  });

  test("a single frame is a still GIF", () => {
    const info = inspectImage(buildGif({ frames: 1 }));
    expect(info.frames).toBe(1);
    expect(info.animated).toBe(false);
  });

  test("a GIF with no image data at all is not animated", () => {
    const info = inspectImage(buildGif({ frames: 0 }));
    expect(info.frames).toBe(0);
    expect(info.animated).toBe(false);
  });

  test("works without a loop extension, without a trailer and for the 87a variant", () => {
    expect(inspectImage(buildGif({ loopExtension: false, frames: 3 })).frames).toBe(3);
    expect(inspectImage(buildGif({ trailer: false, frames: 2 })).animated).toBe(true);
    expect(inspectImage(buildGif({ version: "87a", loopExtension: false, frames: 2 })).animated).toBe(true);
  });

  test("a local colour table on a frame is skipped correctly", () => {
    const base = buildGif({ frames: 0, loopExtension: false });
    const trailerless = base.subarray(0, base.length - 1);
    const frame = (localTable) =>
      Buffer.concat([
        Buffer.from([0x2c, 0, 0, 0, 0, 4, 0, 4, 0, localTable ? 0x80 : 0x00]),
        localTable ? Buffer.from([1, 2, 3, 4, 5, 6]) : Buffer.alloc(0),
        Buffer.from([0x02, 0x02, 0x4c, 0x01, 0x00]),
      ]);
    const bytes = Buffer.concat([trailerless, frame(true), frame(false), Buffer.from([0x3b])]);
    expect(inspectImage(bytes).frames).toBe(2);
  });

  test("stops counting frames at the limit and says so", () => {
    const info = inspectImage(buildGif({ frames: 30 }), { maxFrames: 10 });
    expect(info.tooManyFrames).toBe(true);
    expect(info.animated).toBe(true);
    expect(info.frames).toBeLessThanOrEqual(11);
  });

  test("the default frame limit is the documented one", () => {
    const info = inspectImage(buildGif({ frames: MAX_FRAMES + 5, loopExtension: false }));
    expect(info.tooManyFrames).toBe(true);
  });

  test("stopAtFrames ends the walk early", () => {
    const info = inspectImage(buildGif({ frames: 50 }), { stopAtFrames: 2 });
    expect(info.frames).toBe(2);
    expect(info.animated).toBe(true);
  });

  test("a huge claimed size costs nothing: no pixels are decoded", () => {
    const info = inspectImage(buildGif({ width: 65535, height: 65535, frames: 2 }));
    expect(info.width).toBe(65535);
    expect(info.height).toBe(65535);
    expect(info.animated).toBe(true);
  });

  test("a truncated or garbled GIF never throws", () => {
    const whole = buildGif({ frames: 3 });
    for (let cut = 0; cut < whole.length; cut += 3) {
      expect(() => inspectImage(whole.subarray(0, cut))).not.toThrow();
    }
    const garbled = Buffer.from(whole);
    garbled[20] = 0x99;
    expect(() => inspectImage(garbled)).not.toThrow();
  });

  test("a sub-block chain that never ends is bounded by the buffer", () => {
    const head = buildGif({ frames: 0, loopExtension: false });
    const evil = Buffer.concat([
      head.subarray(0, head.length - 1),
      Buffer.from([0x21, 0xfe]),
      ...Array.from({ length: 5000 }, () => Buffer.concat([Buffer.from([0x01]), Buffer.from([0x41])])),
    ]);
    const started = Date.now();
    const info = inspectImage(evil);
    expect(info.animated).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("animated WebP", () => {
  test("VP8X with the animation flag and two frames is animated", () => {
    const info = inspectImage(buildWebp({ width: 100, height: 50, frames: 2 }));
    expect(info).toMatchObject({
      type: "webp",
      mime: "image/webp",
      width: 100,
      height: 50,
      frames: 2,
      animated: true,
    });
  });

  test("a still WebP is not animated and still reports its size", () => {
    const info = inspectImage(buildWebp({ animated: false, width: 33, height: 17 }));
    expect(info.animated).toBe(false);
    expect(info.width).toBe(33);
    expect(info.height).toBe(17);
  });

  test("the animation flag without any frames does not count", () => {
    expect(inspectImage(buildWebp({ flagOnly: true })).animated).toBe(false);
  });

  test("an animation with one frame is not animated", () => {
    expect(inspectImage(buildWebp({ frames: 1 })).animated).toBe(false);
  });

  test("frame counting is bounded", () => {
    const info = inspectImage(buildWebp({ frames: 40 }), { maxFrames: 5 });
    expect(info.tooManyFrames).toBe(true);
    expect(info.animated).toBe(true);
  });

  test("truncated files never throw", () => {
    const whole = buildWebp({ frames: 3 });
    for (let cut = 0; cut < whole.length; cut += 2) {
      expect(() => inspectImage(whole.subarray(0, cut))).not.toThrow();
    }
  });
});

describe("APNG", () => {
  test("an acTL chunk with two frames is animated", () => {
    const info = inspectImage(buildPng({ animated: true, frames: 5, width: 12, height: 8 }));
    expect(info).toMatchObject({ type: "png", mime: "image/png", width: 12, height: 8, frames: 5, animated: true });
  });

  test("a plain PNG is not animated", () => {
    const info = inspectImage(buildPng());
    expect(info.animated).toBe(false);
    expect(info.frames).toBe(1);
  });

  test("an acTL with a single frame is not animated", () => {
    expect(inspectImage(buildPng({ animated: true, frames: 1 })).animated).toBe(false);
  });

  test("an absurd frame count is reported as too many", () => {
    const info = inspectImage(buildPng({ animated: true, frames: 4_000_000 }));
    expect(info.tooManyFrames).toBe(true);
  });

  test("a chunk length that points past the end of the file never throws", () => {
    const bytes = buildPng({ animated: true });
    bytes.writeUInt32BE(0x7fffffff, 8);
    expect(() => inspectImage(bytes)).not.toThrow();
  });
});

describe("detectAnimation", () => {
  test("true / false for the animated formats, null for everything else", () => {
    expect(detectAnimation(buildGif({ frames: 4 }))).toBe(true);
    expect(detectAnimation(buildGif({ frames: 1 }))).toBe(false);
    expect(detectAnimation(buildWebp())).toBe(true);
    expect(detectAnimation(buildPng({ animated: true }))).toBe(true);
    expect(detectAnimation(buildPng())).toBe(false);
    expect(detectAnimation(buildJpeg())).toBeNull();
    expect(detectAnimation(Buffer.from("hello"))).toBeNull();
  });

  test("a file named .gif that holds something else is not animated", () => {
    expect(detectAnimation(Buffer.from("<html></html>"))).toBeNull();
  });
});

describe("isAnimationCandidate", () => {
  test.each([
    [{ mimeType: "image/gif" }, true],
    [{ mimeType: "IMAGE/WEBP" }, true],
    [{ mimeType: "image/png" }, true],
    [{ mimeType: "image/apng" }, true],
    [{ mimeType: "application/octet-stream", name: "funny.gif" }, true],
    [{ mimeType: "", name: "funny.GIF" }, true],
    [{ mimeType: "image/jpeg", name: "photo.jpg" }, false],
    [{ mimeType: "video/mp4", name: "clip.gif" }, false],
    [{ mimeType: "application/pdf", name: "doc.pdf" }, false],
    [{ mimeType: "application/octet-stream", name: "blob" }, false],
    [{}, false],
  ])("%j -> %s", (input, expected) => {
    expect(isAnimationCandidate(input)).toBe(expected);
  });
});

describe("detectAnimatedFile", () => {
  const withTempFile = async (bytes, run) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anim-"));
    const file = path.join(dir, "x.bin");
    fs.writeFileSync(file, bytes);
    try {
      return await run(file);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  test("reads the file and answers", async () => {
    expect(
      await withTempFile(buildGif({ frames: 3 }), (filePath) => detectAnimatedFile({ fs, filePath })),
    ).toBe(true);
    expect(
      await withTempFile(buildGif({ frames: 1 }), (filePath) => detectAnimatedFile({ fs, filePath })),
    ).toBe(false);
    expect(
      await withTempFile(buildJpeg(), (filePath) => detectAnimatedFile({ fs, filePath })),
    ).toBeNull();
  });

  test("decrypts first when told how", async () => {
    const xor = (b) => Buffer.from(b.map((x) => x ^ 0x5a));
    const encrypted = xor(buildGif({ frames: 2 }));
    expect(
      await withTempFile(encrypted, (filePath) => detectAnimatedFile({ fs, filePath, decrypt: xor })),
    ).toBe(true);
  });

  test("a file above the limit is never read beyond it", async () => {
    const result = await withTempFile(buildGif({ frames: 2, padTo: 4096 }), (filePath) =>
      detectAnimatedFile({ fs, filePath, maxBytes: 100 }),
    );
    expect(result).toBeNull();

    // Even the whole-file path of encrypted files refuses a file above the limit.
    const xor = (b) => Buffer.from(b.map((x) => x ^ 0x5a));
    const encrypted = await withTempFile(xor(buildGif({ frames: 2, padTo: 4096 })), (filePath) =>
      detectAnimatedFile({ fs, filePath, decrypt: xor, maxBytes: 100 }),
    );
    expect(encrypted).toBeNull();
  });

  test("a big file is answered from its start: the rest is never read", async () => {
    // Two frames up front, then ten megabytes of anything.
    const bytes = Buffer.concat([buildGif({ frames: 2 }), Buffer.alloc(10 * 1024 * 1024)]);
    const reads = [];
    const spyFs = {
      promises: {
        open: async (filePath, flags) => {
          const handle = await fs.promises.open(filePath, flags);
          return {
            stat: () => handle.stat(),
            close: () => handle.close(),
            read: async (buffer, offset, length, position) => {
              reads.push(length);
              return handle.read(buffer, offset, length, position);
            },
          };
        },
      },
    };
    const result = await withTempFile(bytes, (filePath) => detectAnimatedFile({ fs: spyFs, filePath }));
    expect(result).toBe(true);
    expect(Math.max(...reads)).toBeLessThanOrEqual(256 * 1024);
  });

  test("a big still PNG is answered from its first bytes", async () => {
    const bytes = Buffer.concat([buildPng(), Buffer.alloc(8 * 1024 * 1024)]);
    const reads = [];
    const spyFs = {
      promises: {
        open: async (filePath, flags) => {
          const handle = await fs.promises.open(filePath, flags);
          return {
            stat: () => handle.stat(),
            close: () => handle.close(),
            read: async (buffer, offset, length, position) => {
              reads.push(length);
              return handle.read(buffer, offset, length, position);
            },
          };
        },
      },
    };
    expect(await withTempFile(bytes, (filePath) => detectAnimatedFile({ fs: spyFs, filePath }))).toBe(false);
    expect(Math.max(...reads)).toBeLessThanOrEqual(256 * 1024);
  });

  test("the default limit is the documented 32 MB", () => {
    expect(ANIMATION_SCAN_MAX_BYTES).toBe(32 * 1024 * 1024);
  });

  test("a missing file, a missing fs and an empty path all answer null instead of throwing", async () => {
    expect(await detectAnimatedFile({ fs, filePath: "/nonexistent/file.gif" })).toBeNull();
    expect(await detectAnimatedFile({ fs: {}, filePath: "/x" })).toBeNull();
    expect(await detectAnimatedFile({ fs, filePath: "" })).toBeNull();
  });
});

describe("inspectImage().complete: can more bytes change the answer?", () => {
  test("a GIF that reached its trailer is complete, one cut off in the middle is not", () => {
    const whole = buildGif({ frames: 1 });
    expect(inspectImage(whole).complete).toBe(true);
    expect(inspectImage(whole.subarray(0, whole.length - 6)).complete).toBe(false);
  });

  test("an animated GIF is complete as soon as the second frame is seen", () => {
    const whole = buildGif({ frames: 5 });
    const upToSecondFrame = whole.subarray(0, 13 + 6 + 19 + 8 + 10 + 8 + 5 + 8 + 10 + 1);
    const info = inspectImage(upToSecondFrame, { stopAtFrames: 2 });
    expect(info.animated).toBe(true);
    expect(info.complete).toBe(true);
  });

  test("a still WebP is complete at its image chunk; an animated one only once it is animated or ends", () => {
    expect(inspectImage(buildWebp({ animated: false })).complete).toBe(true);
    const animated = buildWebp({ animated: true, frames: 3 });
    expect(inspectImage(animated).complete).toBe(true);
    const headerOnly = buildWebp({ animated: true, flagOnly: true });
    // The animation flag is set and no frame has been seen yet, but the file ends here.
    expect(inspectImage(headerOnly).animated).toBe(false);
    expect(inspectImage(headerOnly.subarray(0, 40)).complete).toBe(false);
  });

  test("a PNG is complete at the first image data chunk or at the animation control chunk", () => {
    expect(inspectImage(buildPng()).complete).toBe(true);
    expect(inspectImage(buildPng({ animated: true, frames: 4 })).complete).toBe(true);
    expect(inspectImage(buildPng().subarray(0, 20)).complete).toBe(false);
  });
});

describe("detectAnimationFromReader", () => {
  // A reader over a buffer that records how much was asked for.
  const readerOf = (bytes) => {
    const asked = [];
    const read = async (limit) => {
      asked.push(limit);
      return bytes.subarray(0, Math.min(limit, bytes.length));
    };
    return { read, asked };
  };

  test("asks for a small prefix first and stops as soon as it knows", async () => {
    const { read, asked } = readerOf(buildGif({ frames: 3 }));
    expect(await detectAnimationFromReader(read, { size: 200, ladder: [64, 256, 1024] })).toBe(true);
    // The whole file is only a couple of hundred bytes, so the second rung is the last one needed.
    expect(asked[0]).toBe(64);
    expect(asked.length).toBeLessThanOrEqual(2);
  });

  test("grows the prefix when the second frame is further into the file", async () => {
    const bytes = buildGif({ frames: 2, padTo: 3000 });
    const { read, asked } = readerOf(bytes);
    const result = await detectAnimationFromReader(read, {
      size: bytes.length,
      ladder: [200, 1000, 4000, 8000],
    });
    expect(result).toBe(true);
    expect(asked).toEqual([200, 1000, 4000]);
  });

  test("a still PNG is answered from the first prefix, whatever its size", async () => {
    const still = Buffer.concat([buildPng(), Buffer.alloc(50_000)]);
    const { read, asked } = readerOf(still);
    expect(await detectAnimationFromReader(read, { size: 50_000_000, ladder: [64, 1024, 65536] })).toBe(false);
    expect(asked).toEqual([64]);
  });

  test("a still GIF is false once the whole file was read", async () => {
    const bytes = buildGif({ frames: 1 });
    const { read } = readerOf(bytes);
    expect(await detectAnimationFromReader(read, { size: bytes.length, ladder: [16, 4096] })).toBe(false);
  });

  test("without a known size, a short read means the end of the file", async () => {
    const bytes = buildGif({ frames: 1, trailer: false });
    const { read } = readerOf(bytes);
    expect(await detectAnimationFromReader(read, { ladder: [16, 4096] })).toBe(false);
  });

  test("never asks for more than the limit and gives up with null", async () => {
    const bytes = buildGif({ frames: 2, padTo: 6000 });
    const { read, asked } = readerOf(bytes);
    const result = await detectAnimationFromReader(read, {
      size: bytes.length,
      ladder: [100, 500, 100_000],
      maxBytes: 1000,
    });
    expect(result).toBeNull();
    expect(Math.max(...asked)).toBeLessThanOrEqual(1000);
  });

  test("null for things that are not GIF, WebP or PNG, and for a reader that fails or returns nothing", async () => {
    expect(await detectAnimationFromReader(readerOf(buildJpeg()).read, { size: 14 })).toBeNull();
    expect(await detectAnimationFromReader(async () => null, { size: 100 })).toBeNull();
    expect(await detectAnimationFromReader(async () => Buffer.alloc(0), { size: 100 })).toBeNull();
    expect(
      await detectAnimationFromReader(async () => {
        throw new Error("network down");
      }, { size: 100 }),
    ).toBeNull();
  });
});

describe("animationFlags", () => {
  test.each([
    [{ is_animated: 1 }, true],
    [{ is_animated: "1" }, true],
    [{ is_animated: true }, true],
    [{ isAnimated: true }, true],
    [{ is_animated: 0 }, false],
    [{ is_animated: "0" }, false],
    [{ is_animated: null }, false],
    [{}, false],
    [null, false],
  ])("%j -> %s", (row, expected) => {
    expect(animationFlags(row)).toEqual({ isAnimated: expected, gif: expected });
  });
});
