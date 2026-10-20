import { describe, test, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRemoteChannelManager } from "../../lib/remoteChannels.js";
import { buildGif, buildJpeg } from "../helpers/imageBytes.js";

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-anim-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeManager() {
  return createRemoteChannelManager({
    config: {
      enabled: true,
      fileUploadEnabled: true,
      uploadRootDir: tmpDir,
      avatarUploadRootDir: tmpDir,
      messageFileLimits: {
        maxFiles: 10,
        maxFileSizeBytes: 25 * 1024 * 1024,
        maxTotalBytes: 75 * 1024 * 1024,
      },
    },
    fs,
    path,
    crypto,
    storageProvider: { type: "local" },
    storageEncryption: {
      encryptFileInPlace: () => {},
      decryptBuffer: (buf) => Buffer.from(buf),
    },
    getUploadKind: () => "media",
    isDangerousUploadFile: () => false,
    hasEnoughFreeDiskSpace: () => true,
    sanitizePositiveInt: (n) => n,
    sanitizeDurationSeconds: (n) => n,
    debugLog: () => {},
  });
}

const documentMessage = (mimeType, name) => ({
  id: 7,
  media: {
    document: {
      mimeType,
      size: 100,
      attributes: [{ className: "DocumentAttributeFilename", fileName: name }],
    },
  },
});

const mirror = (manager, bytes, message) =>
  manager.downloadTelegramMediaFile(
    { downloadMedia: async () => bytes },
    message,
    0,
    { count: 0, totalBytes: 0, names: new Set() },
  );

describe("mirrored Telegram pictures", () => {
  test("an animated GIF document is mirrored untouched and flagged", async () => {
    const bytes = buildGif({ frames: 5 });
    const result = await mirror(makeManager(), bytes, documentMessage("image/gif", "party.gif"));
    expect(result?.file).toBeTruthy();
    expect(result.file.mimeType).toBe("image/gif");
    expect(result.file.isAnimated).toBe(true);
    // The bytes on disk are the bytes Telegram sent.
    expect(fs.readFileSync(result.filePath).equals(bytes)).toBe(true);
  });

  test("a still GIF is not flagged", async () => {
    const result = await mirror(makeManager(), buildGif({ frames: 1 }), documentMessage("image/gif", "still.gif"));
    expect(result.file.isAnimated).toBe(false);
  });

  test("a photo is not flagged and is not even opened for the check", async () => {
    const result = await mirror(makeManager(), buildJpeg(), {
      id: 8,
      media: { photo: { sizes: [{ w: 100, h: 100 }] } },
    });
    expect(result.file.mimeType).toBe("image/jpeg");
    expect(result.file.isAnimated).toBe(false);
  });

  test("HTML that Telegram calls a GIF is not flagged", async () => {
    const result = await mirror(makeManager(), Buffer.from("<html></html>"), documentMessage("image/gif", "x.gif"));
    expect(result?.file?.isAnimated ?? false).toBe(false);
  });

  test("the first stage reports it too, so the worker hand-off can carry it", async () => {
    const manager = makeManager();
    const fetched = await manager.fetchTelegramMediaToTemp(
      { downloadMedia: async () => buildGif({ frames: 4 }) },
      documentMessage("image/gif", "party.gif"),
      0,
      { count: 0, totalBytes: 0, names: new Set() },
    );
    expect(fetched.descriptor.isAnimated).toBe(true);
  });
});
