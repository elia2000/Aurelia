import { describe, expect, it } from "vitest";
import {
  buildSavedGifPreviewFile,
  findGifFile,
  resolveSaveGifTarget,
} from "../../src/gifs/gifMessageActions.js";

const MESSAGE_ID = "3f2c1d0e-8a4b-4c6d-9e1f-0a1b2c3d4e5f";

describe("findGifFile", () => {
  const gifA = { id: 11, mimeType: "image/gif", isAnimated: true };
  const gifB = { id: 12, mimeType: "image/webp", gif: true };
  const still = { id: 13, mimeType: "image/png" };
  const video = { id: 14, mimeType: "video/mp4", isAnimated: true };

  it("returns the first GIF and ignores stills and videos", () => {
    expect(findGifFile({ files: [still, video, gifA, gifB] })).toBe(gifA);
  });

  it("prefers the GIF that was pointed at", () => {
    expect(findGifFile({ files: [gifA, gifB] }, "12")).toBe(gifB);
    expect(findGifFile({ files: [gifA, gifB] }, 12)).toBe(gifB);
  });

  it("falls back to the first GIF when the pointed-at file is not a GIF", () => {
    expect(findGifFile({ files: [gifA, still] }, 13)).toBe(gifA);
  });

  it("treats an old row without the flag as a GIF when it says image/gif", () => {
    const old = { id: 5, mimeType: "image/gif" };
    expect(findGifFile({ files: [old] })).toBe(old);
  });

  it("finds nothing in a message without GIFs", () => {
    expect(findGifFile({ files: [still] })).toBeNull();
    expect(findGifFile({})).toBeNull();
    expect(findGifFile(null)).toBeNull();
  });
});

describe("resolveSaveGifTarget", () => {
  it("uses the server's message id and the numeric file id", () => {
    expect(resolveSaveGifTarget({ id: MESSAGE_ID }, { id: 7 })).toEqual({ messageId: MESSAGE_ID, fileId: 7 });
    expect(resolveSaveGifTarget({ id: MESSAGE_ID }, { id: "7" })).toEqual({ messageId: MESSAGE_ID, fileId: 7 });
  });

  it("prefers the server id of a message that still carries its temporary id", () => {
    expect(resolveSaveGifTarget({ id: "pending-123-abc", _serverId: MESSAGE_ID }, { id: 7 })).toEqual({
      messageId: MESSAGE_ID,
      fileId: 7,
    });
  });

  it("is null while the server does not know the message or the file", () => {
    expect(resolveSaveGifTarget({ id: "pending-123-abc" }, { id: 7 })).toBeNull();
    expect(resolveSaveGifTarget({ id: MESSAGE_ID }, { id: "saved-gif-x" })).toBeNull();
    expect(resolveSaveGifTarget({ id: MESSAGE_ID }, { id: 0 })).toBeNull();
    expect(resolveSaveGifTarget(null, { id: 7 })).toBeNull();
    expect(resolveSaveGifTarget({ id: MESSAGE_ID }, null)).toBeNull();
  });
});

describe("buildSavedGifPreviewFile", () => {
  it("describes a moving picture that shows the person's own copy", () => {
    const file = buildSavedGifPreviewFile({
      id: "g1",
      url: "/api/gifs/g1/file",
      width: 320,
      height: 200,
      mime: "image/gif",
      size: 4096,
    });
    expect(file).toMatchObject({
      kind: "media",
      mimeType: "image/gif",
      url: "/api/gifs/g1/file",
      width: 320,
      height: 200,
      sizeBytes: 4096,
      isAnimated: true,
      gif: true,
    });
    expect(file.id).toBe("saved-gif-g1");
  });

  it("copes with a GIF whose size is not known", () => {
    const file = buildSavedGifPreviewFile({ id: "g2", url: "/x", width: null, height: undefined });
    expect(file.width).toBeNull();
    expect(file.height).toBeNull();
    expect(file.mimeType).toBe("image/gif");
    expect(file.sizeBytes).toBe(0);
  });
});
