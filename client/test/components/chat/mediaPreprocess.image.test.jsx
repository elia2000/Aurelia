import { describe, test, expect } from "vitest";
import { extractImageMetadataAndThumbnail } from "../../../src/utils/mediaPreprocess.js";
import { makeGifBytes, makePngBytes } from "../../utils/gifFixtures.js";

// What happens to a picked picture in a real browser: animated pictures reach
// the server untouched (only measured), still ones get a small thumbnail.

const canvasBlob = (type, w = 40, h = 30) =>
  new Promise((resolve) => {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#e11";
    ctx.fillRect(0, 0, w, h);
    canvas.toBlob(resolve, type);
  });

describe("extractImageMetadataAndThumbnail - GIFs stay GIFs", () => {
  test("an animated GIF is measured from its header, flagged as animated and gets no still thumbnail", async () => {
    const file = new File([makeGifBytes({ frames: 3, width: 24, height: 16 })], "a.gif", { type: "image/gif" });
    const result = await extractImageMetadataAndThumbnail(file);
    expect(result).toEqual({ width: 24, height: 16, isAnimated: true });
    expect(result.thumbnail).toBeUndefined();
  });

  test("the file itself is never replaced or re-encoded: the very same bytes are still there", async () => {
    const bytes = makeGifBytes({ frames: 4, width: 8, height: 8 });
    const file = new File([bytes], "b.gif", { type: "image/gif" });
    await extractImageMetadataAndThumbnail(file);
    const after = new Uint8Array(await file.arrayBuffer());
    expect(Array.from(after)).toEqual(Array.from(bytes));
    expect(file.type).toBe("image/gif");
  });

  test("a GIF whose header cannot be read is still not redrawn on a canvas", async () => {
    const file = new File([new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])], "broken.gif", { type: "image/gif" });
    const result = await extractImageMetadataAndThumbnail(file);
    expect(result.thumbnail).toBeUndefined();
  });

  test("a still PNG is processed as before: size and a small thumbnail", async () => {
    const blob = await canvasBlob("image/png", 40, 30);
    const result = await extractImageMetadataAndThumbnail(new File([blob], "p.png", { type: "image/png" }));
    expect(result.width).toBe(40);
    expect(result.height).toBe(30);
    expect(result.thumbnail).toMatch(/^data:image\//);
    expect(result.isAnimated).not.toBe(true);
  });

  test("a still JPEG too", async () => {
    const blob = await canvasBlob("image/jpeg", 50, 20);
    const result = await extractImageMetadataAndThumbnail(new File([blob], "p.jpg", { type: "image/jpeg" }));
    expect(result).toMatchObject({ width: 50, height: 20 });
    expect(result.isAnimated).not.toBe(true);
    expect(result.thumbnail).toMatch(/^data:image\//);
  });

  test("an animated PNG (APNG) is left alone like a GIF", async () => {
    const file = new File([makePngBytes({ animated: true })], "anim.png", { type: "image/png" });
    const result = await extractImageMetadataAndThumbnail(file);
    expect(result.isAnimated).toBe(true);
    expect(result.thumbnail).toBeUndefined();
  });
});
