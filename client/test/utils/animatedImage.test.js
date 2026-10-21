import { describe, it, expect } from "vitest";
import {
  inspectImageFile,
  inspectImageHead,
  isGifFile,
  looksAnimated,
  readImageHead,
  shouldKeepImageUntouched,
} from "../../src/utils/animatedImage.js";
import { makeGifBytes, makeJpegBytes, makePngBytes, makeWebpBytes } from "./gifFixtures.js";

describe("inspectImageHead", () => {
  it("reads the size and the frame count of a GIF", () => {
    const animated = inspectImageHead(makeGifBytes({ frames: 3, width: 5, height: 7 }));
    expect(animated).toEqual({ kind: "gif", animated: true, width: 5, height: 7 });
    const still = inspectImageHead(makeGifBytes({ frames: 1 }));
    expect(still.kind).toBe("gif");
    expect(still.animated).toBe(false);
  });

  it("says nothing sure about a GIF whose first frame runs past the inspected bytes", () => {
    const full = makeGifBytes({ frames: 1 });
    const cut = full.slice(0, full.length - 8);
    const info = inspectImageHead(cut);
    expect(info.kind).toBe("gif");
    expect(info.animated).toBeNull();
  });

  it("finds the animation flag of a WebP", () => {
    expect(inspectImageHead(makeWebpBytes({ animated: true, width: 9, height: 4 }))).toEqual({
      kind: "webp",
      animated: true,
      width: 9,
      height: 4,
    });
    expect(inspectImageHead(makeWebpBytes({ animated: false })).animated).toBe(false);
  });

  it("finds the acTL chunk of an APNG and not in a plain PNG", () => {
    expect(inspectImageHead(makePngBytes({ animated: true, width: 4, height: 3 }))).toEqual({
      kind: "png",
      animated: true,
      width: 4,
      height: 3,
    });
    expect(inspectImageHead(makePngBytes({ animated: false })).animated).toBe(false);
  });

  it("does not know a JPEG, text or something too short", () => {
    expect(inspectImageHead(makeJpegBytes()).kind).toBeNull();
    expect(inspectImageHead(new TextEncoder().encode("GIF is a word in this text file")).kind).toBeNull();
    expect(inspectImageHead(new Uint8Array(3)).kind).toBeNull();
    expect(inspectImageHead(null).kind).toBeNull();
  });
});

describe("shouldKeepImageUntouched / looksAnimated", () => {
  it("keeps every GIF, animated WebP and APNG as it is", () => {
    for (const bytes of [
      makeGifBytes({ frames: 2 }),
      makeGifBytes({ frames: 1 }),
      makeWebpBytes({ animated: true }),
      makePngBytes({ animated: true }),
    ]) {
      expect(shouldKeepImageUntouched(inspectImageHead(bytes))).toBe(true);
    }
  });

  it("lets still pictures be processed", () => {
    for (const bytes of [makePngBytes(), makeWebpBytes(), makeJpegBytes()]) {
      expect(shouldKeepImageUntouched(inspectImageHead(bytes))).toBe(false);
    }
  });

  it("presents animated pictures as GIFs, and a one-frame GIF not", () => {
    expect(looksAnimated(inspectImageHead(makeGifBytes({ frames: 2 })))).toBe(true);
    expect(looksAnimated(inspectImageHead(makeGifBytes({ frames: 1 })))).toBe(false);
    expect(looksAnimated(inspectImageHead(makeWebpBytes({ animated: true })))).toBe(true);
    expect(looksAnimated(inspectImageHead(makePngBytes()))).toBe(false);
  });
});

describe("inspectImageFile", () => {
  it("reads only the start of the file", async () => {
    const file = new File([makeGifBytes({ frames: 2 })], "a.gif", { type: "image/gif" });
    expect((await readImageHead(file, 20)).length).toBe(20);
    expect((await inspectImageFile(file)).animated).toBe(true);
  });

  it("trusts the bytes over the name and the content type", async () => {
    const png = new File([makePngBytes()], "fake.gif", { type: "image/gif" });
    const info = await inspectImageFile(png);
    expect(info.kind).toBe("png");
    expect(shouldKeepImageUntouched(info)).toBe(false);
  });

  it("falls back to the content type when the bytes are not recognised", async () => {
    const odd = new File([new Uint8Array(40)], "x.gif", { type: "image/gif" });
    const info = await inspectImageFile(odd);
    expect(info.kind).toBe("gif");
    expect(shouldKeepImageUntouched(info)).toBe(true);
    const jpeg = new File([makeJpegBytes()], "x.jpg", { type: "image/jpeg" });
    expect(shouldKeepImageUntouched(await inspectImageFile(jpeg))).toBe(false);
  });
});

describe("isGifFile", () => {
  it("follows the flags of the server and falls back to the type for older rows", () => {
    expect(isGifFile({ isAnimated: true, mimeType: "image/webp" })).toBe(true);
    expect(isGifFile({ gif: true })).toBe(true);
    expect(isGifFile({ mimeType: "image/gif" })).toBe(true);
    expect(isGifFile({ mimeType: "image/png", isAnimated: false })).toBe(false);
    expect(isGifFile({ mimeType: "video/mp4" })).toBe(false);
    expect(isGifFile(null)).toBe(false);
  });
});
