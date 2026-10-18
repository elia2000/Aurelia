import { describe, test, expect } from "vitest";
import {
  SAVED_GIF_DEFAULT_LIMIT,
  SAVED_GIF_MAX_BYTES,
  SAVED_GIF_MAX_DIMENSION,
  SAVED_GIF_MAX_LIMIT,
  buildSavedGifKey,
  clampMaxSavedGifs,
  evaluateGifBytes,
  extensionForGifType,
  isSavedGifKeyOf,
  parseSaveRequest,
  serializeSavedGif,
} from "../../lib/savedGifs.js";
import { MAX_FRAMES } from "../../lib/animatedImage.js";
import { buildGif, buildJpeg, buildPng, buildWebp } from "../helpers/imageBytes.js";

const ALICE = "a0a0a0a0-b1b1-4c2c-8d3d-e4e4e4e4e4e4";
const BOB = "b0b0b0b0-c1c1-4d2d-9e3e-f5f5f5f5f5f5";
const GIF_ID = "d0d0d0d0-e1e1-4f2f-b040-171717171717";
const MESSAGE_ID = "e0e0e0e0-f1f1-4020-c151-282828282828";

describe("limits", () => {
  test("the documented numbers", () => {
    expect(SAVED_GIF_DEFAULT_LIMIT).toBe(50);
    expect(SAVED_GIF_MAX_LIMIT).toBe(200);
    expect(SAVED_GIF_MAX_BYTES).toBe(20 * 1024 * 1024);
  });

  test.each([
    [undefined, 50],
    [null, 50],
    ["", 50],
    ["   ", 50],
    ["abc", 50],
    [50, 50],
    ["30", 30],
    [1, 1],
    [200, 200],
    [201, 200],
    [100000, 200],
    [0, 1],
    [-5, 1],
    [12.9, 12],
  ])("clampMaxSavedGifs(%j) -> %s", (input, expected) => {
    expect(clampMaxSavedGifs(input)).toBe(expected);
  });
});

describe("storage keys", () => {
  test("a key starts with the owner's id and carries the checked type's extension", () => {
    expect(buildSavedGifKey(ALICE, GIF_ID, "gif")).toBe(`gifs/${ALICE}/${GIF_ID}.gif`);
    expect(buildSavedGifKey(ALICE, GIF_ID, "webp")).toBe(`gifs/${ALICE}/${GIF_ID}.webp`);
    expect(buildSavedGifKey(ALICE, GIF_ID, "png")).toBe(`gifs/${ALICE}/${GIF_ID}.png`);
  });

  test("only GIF, WebP and PNG have an extension; the name a sender chose never does", () => {
    expect(extensionForGifType("gif")).toBe(".gif");
    expect(extensionForGifType("webp")).toBe(".webp");
    expect(extensionForGifType("png")).toBe(".png");
    expect(extensionForGifType("jpeg")).toBeNull();
    expect(extensionForGifType("svg")).toBeNull();
    expect(() => buildSavedGifKey(ALICE, GIF_ID, "svg")).toThrow();
  });

  test("refuses to build a key from an id that is not a UUID", () => {
    expect(() => buildSavedGifKey("../etc", GIF_ID, "gif")).toThrow();
    expect(() => buildSavedGifKey(ALICE, "x/../y", "gif")).toThrow();
  });

  test("isSavedGifKeyOf accepts the owner's own keys only", () => {
    const key = buildSavedGifKey(ALICE, GIF_ID, "gif");
    expect(isSavedGifKeyOf(ALICE, key)).toBe(true);
    expect(isSavedGifKeyOf(BOB, key)).toBe(false);
  });

  test.each([
    `gifs/${ALICE}/../${BOB}/${GIF_ID}.gif`,
    `gifs/${ALICE}/${GIF_ID}.gif/../x.gif`,
    `/gifs/${ALICE}/${GIF_ID}.gif`,
    `gifs/${ALICE}/${GIF_ID}.html`,
    `gifs/${ALICE}/${GIF_ID}.gif\0.png`,
    `gifs\\${ALICE}\\${GIF_ID}.gif`,
    `uploads/messages/${GIF_ID}.gif`,
    `gifs/${ALICE}/nested/${GIF_ID}.gif`,
    `gifs/${ALICE}`,
    "",
    null,
    undefined,
    42,
  ])("isSavedGifKeyOf rejects %j", (key) => {
    expect(isSavedGifKeyOf(ALICE, key)).toBe(false);
  });

  test("a missing owner id matches nothing", () => {
    expect(isSavedGifKeyOf("", `gifs//${GIF_ID}.gif`)).toBe(false);
    expect(isSavedGifKeyOf(null, `gifs/null/${GIF_ID}.gif`)).toBe(false);
  });
});

describe("serializeSavedGif", () => {
  const row = {
    id: GIF_ID,
    user_id: ALICE,
    storage_key: `gifs/${ALICE}/${GIF_ID}.gif`,
    storage_driver: "s3",
    mime: "image/gif",
    width: 320,
    height: 200,
    frames: 12,
    size_bytes: 4096,
    sha256: "ab".repeat(32),
    created_at: "2026-10-17T10:00:00.000Z",
    source_message_id: MESSAGE_ID,
    source_file_id: "5",
  };

  test("is exactly the documented public shape", () => {
    expect(serializeSavedGif(row)).toEqual({
      id: GIF_ID,
      url: `/api/gifs/${GIF_ID}/file`,
      thumbUrl: null,
      width: 320,
      height: 200,
      mime: "image/gif",
      size: 4096,
      createdAt: "2026-10-17T10:00:00.000Z",
    });
  });

  test("reveals no storage detail, owner, hash or origin", () => {
    const text = JSON.stringify(serializeSavedGif(row));
    for (const secret of [ALICE, row.storage_key, "s3", "ab".repeat(32), MESSAGE_ID, "storage", "sha256"]) {
      expect(text).not.toContain(secret);
    }
  });

  test("numbers come out as numbers, whatever the driver returns", () => {
    const out = serializeSavedGif({ ...row, width: "320", height: "200", size_bytes: "4096" });
    expect(out.width).toBe(320);
    expect(out.height).toBe(200);
    expect(out.size).toBe(4096);
  });

  test("missing dimensions are null, not zero", () => {
    const out = serializeSavedGif({ ...row, width: null, height: undefined });
    expect(out.width).toBeNull();
    expect(out.height).toBeNull();
  });

  test("a Date or an ISO string both come out as an ISO string", () => {
    expect(serializeSavedGif({ ...row, created_at: new Date("2026-10-17T10:00:00.000Z") }).createdAt).toBe(
      "2026-10-17T10:00:00.000Z",
    );
  });
});

describe("parseSaveRequest", () => {
  test("a message id and a file id", () => {
    expect(parseSaveRequest({ messageId: MESSAGE_ID, fileId: 7 })).toEqual({
      ok: true,
      messageId: MESSAGE_ID,
      fileId: 7,
      fileIndex: null,
    });
    expect(parseSaveRequest({ messageId: MESSAGE_ID, fileId: "12" })).toMatchObject({ ok: true, fileId: 12 });
  });

  test("a message id and a file index", () => {
    expect(parseSaveRequest({ messageId: MESSAGE_ID, fileIndex: 0 })).toEqual({
      ok: true,
      messageId: MESSAGE_ID,
      fileId: null,
      fileIndex: 0,
    });
    expect(parseSaveRequest({ messageId: MESSAGE_ID, fileIndex: "2" })).toMatchObject({ ok: true, fileIndex: 2 });
  });

  test("with neither, the first file is meant", () => {
    expect(parseSaveRequest({ messageId: MESSAGE_ID })).toMatchObject({ ok: true, fileId: null, fileIndex: 0 });
  });

  test.each([
    ["no body", undefined],
    ["a body that is not an object", "x"],
    ["no message id", {}],
    ["a message id that is not a UUID", { messageId: "nope" }],
    ["a message id that is an array", { messageId: [MESSAGE_ID] }],
    ["a message id with spaces around it", { messageId: ` ${MESSAGE_ID} ` }],
    ["both fileId and fileIndex", { messageId: MESSAGE_ID, fileId: 1, fileIndex: 0 }],
    ["a fileId of zero", { messageId: MESSAGE_ID, fileId: 0 }],
    ["a negative fileId", { messageId: MESSAGE_ID, fileId: -4 }],
    ["a fractional fileId", { messageId: MESSAGE_ID, fileId: 1.5 }],
    ["a fileId that is not a number", { messageId: MESSAGE_ID, fileId: "abc" }],
    ["a fileId that is an object", { messageId: MESSAGE_ID, fileId: { $gt: 0 } }],
    ["an unsafe fileId", { messageId: MESSAGE_ID, fileId: 2 ** 60 }],
    ["a negative fileIndex", { messageId: MESSAGE_ID, fileIndex: -1 }],
    ["a fileIndex beyond any message", { messageId: MESSAGE_ID, fileIndex: 1000 }],
    ["a fractional fileIndex", { messageId: MESSAGE_ID, fileIndex: 0.5 }],
    ["a fileIndex that is not a number", { messageId: MESSAGE_ID, fileIndex: "first" }],
  ])("is refused with %s", (_label, body) => {
    const result = parseSaveRequest(body);
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe("string");
    expect(result.error.length).toBeGreaterThan(0);
  });
});

describe("evaluateGifBytes", () => {
  test("an animated GIF passes, with what the bytes say about it", () => {
    const result = evaluateGifBytes(buildGif({ width: 320, height: 200, frames: 4 }));
    expect(result).toMatchObject({
      ok: true,
      type: "gif",
      mime: "image/gif",
      width: 320,
      height: 200,
      frames: 4,
    });
  });

  test("an animated WebP and an animated PNG pass", () => {
    expect(evaluateGifBytes(buildWebp({ animated: true, frames: 3 }))).toMatchObject({ ok: true, type: "webp", mime: "image/webp" });
    expect(evaluateGifBytes(buildPng({ animated: true, frames: 3 }))).toMatchObject({ ok: true, type: "png", mime: "image/png" });
  });

  test.each([
    ["a still GIF", () => buildGif({ frames: 1 }), "gif_not_animated"],
    ["a still WebP", () => buildWebp({ animated: false }), "gif_not_animated"],
    ["a plain PNG", () => buildPng(), "gif_not_animated"],
    ["a JPEG", () => buildJpeg(), "gif_unsupported"],
    ["an SVG", () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), "gif_unsupported"],
    ["an HTML page", () => Buffer.from("<html><script>1</script></html>"), "gif_unsupported"],
    ["nothing at all", () => Buffer.alloc(0), "gif_empty"],
    ["something that is not a buffer", () => "GIF89a", "gif_empty"],
  ])("refuses %s", (_label, build, code) => {
    const result = evaluateGifBytes(build());
    expect(result.ok).toBe(false);
    expect(result.code).toBe(code);
    expect(result.status).toBe(400);
    expect(typeof result.error).toBe("string");
  });

  test("refuses a file over the size cap, whatever it contains", () => {
    const big = buildGif({ frames: 2, padTo: 4096 });
    const result = evaluateGifBytes(big, { maxBytes: 1000 });
    expect(result).toMatchObject({ ok: false, status: 400, code: "gif_too_large" });
    expect(result.error).toMatch(/20 MB|MB/);
  });

  test("a file of exactly the cap is fine", () => {
    const exact = buildGif({ frames: 2, padTo: 2048 });
    expect(evaluateGifBytes(exact, { maxBytes: exact.length })).toMatchObject({ ok: true });
    expect(evaluateGifBytes(exact, { maxBytes: exact.length - 1 })).toMatchObject({ ok: false, code: "gif_too_large" });
  });

  test("refuses more frames than the bound", () => {
    const result = evaluateGifBytes(buildGif({ frames: MAX_FRAMES + 1 }));
    expect(result).toMatchObject({ ok: false, code: "gif_too_many_frames" });
  });

  test("accepts exactly the frame bound", () => {
    expect(evaluateGifBytes(buildGif({ frames: MAX_FRAMES }))).toMatchObject({ ok: true });
  });

  test("refuses dimensions beyond the bound, and zero dimensions", () => {
    expect(SAVED_GIF_MAX_DIMENSION).toBe(4096);
    expect(evaluateGifBytes(buildGif({ width: SAVED_GIF_MAX_DIMENSION + 1, height: 10, frames: 2 }))).toMatchObject({
      ok: false,
      code: "gif_dimensions",
    });
    expect(evaluateGifBytes(buildGif({ width: 10, height: SAVED_GIF_MAX_DIMENSION + 1, frames: 2 }))).toMatchObject({
      ok: false,
      code: "gif_dimensions",
    });
    expect(evaluateGifBytes(buildGif({ width: SAVED_GIF_MAX_DIMENSION, height: SAVED_GIF_MAX_DIMENSION, frames: 2 }))).toMatchObject({
      ok: true,
    });
    expect(evaluateGifBytes(buildGif({ width: 0, height: 10, frames: 2 }))).toMatchObject({
      ok: false,
      code: "gif_dimensions",
    });
  });

  test("the verdict never depends on a name or a type the sender gave: only the bytes count", () => {
    // Bytes of a GIF are a GIF; there is no parameter that could say otherwise.
    expect(evaluateGifBytes.length).toBeLessThanOrEqual(2);
    expect(evaluateGifBytes(buildGif({ frames: 2 }))).toMatchObject({ ok: true, mime: "image/gif" });
  });
});
