import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import multer from "multer";
import express from "express";
import request from "supertest";
import { createUploadTools } from "../lib/uploads.js";

describe("server/lib/uploads.js avatar storage enhancements", () => {
  let tmpDir;
  let avatarUploadRootDir;
  let mockRemoteProvider;
  let mockLocalProvider;
  let mockStorageEncryption;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-avatar-test-"));
    avatarUploadRootDir = path.join(tmpDir, "avatars");
    fs.mkdirSync(avatarUploadRootDir, { recursive: true });

    mockRemoteProvider = {
      type: "s3",
      uploadBuffer: vi.fn().mockResolvedValue({ key: "uploads/avatars/test.png" }),
      deleteFile: vi.fn().mockResolvedValue(true),
      getDownloadUrl: vi
        .fn()
        .mockResolvedValue("https://s3.example.com/uploads/avatars/test.png"),
    };

    mockLocalProvider = {
      type: "local",
      uploadBuffer: vi.fn(),
      deleteFile: vi.fn(),
      getDownloadUrl: vi.fn(),
    };

    mockStorageEncryption = {
      encryptFileInPlace: vi.fn().mockReturnValue(true),
      decryptBuffer: vi.fn((buf) => buf),
      decryptFileToBuffer: vi.fn(() => null),
      getDecryptedFileSize: vi.fn(() => 0),
    };
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  });

  describe("storeAvatarFile", () => {
    test("uploads to S3 and removes local temporary file when storageProvider is S3", async () => {
      const uploadTools = createUploadTools({
        fs,
        path,
        crypto,
        multer,
        adminGetRow: () => null,
        adminRun: () => null,
        adminSave: () => null,
        uploadRootDir: tmpDir,
        avatarUploadRootDir,
        fileUploadMaxSize: 10 * 1024 * 1024,
        fileUploadMaxFiles: 1,
        fileUploadMaxTotalSize: 10 * 1024 * 1024,
        storageEncryption: mockStorageEncryption,
        storageProvider: mockRemoteProvider,
      });

      const filePath = path.join(avatarUploadRootDir, "avatar-123.png");
      fs.writeFileSync(filePath, "sample-avatar-bytes");

      const file = {
        filename: "avatar-123.png",
        path: filePath,
        mimetype: "image/png",
        size: 19,
      };

      const result = await uploadTools.storeAvatarFile(file);

      expect(result.avatarUrl).toBe("/api/uploads/avatars/avatar-123.png");
      expect(result.storageDriver).toBe("s3");
      expect(result.storageKey).toBe("uploads/avatars/avatar-123.png");

      expect(mockRemoteProvider.uploadBuffer).toHaveBeenCalledWith(
        "uploads/avatars/avatar-123.png",
        expect.any(Buffer),
        "image/png",
      );
      // Local file should be removed
      expect(fs.existsSync(filePath)).toBe(false);
    });

    test("encrypts in place and keeps local file when storageProvider is local", async () => {
      const uploadTools = createUploadTools({
        fs,
        path,
        crypto,
        multer,
        adminGetRow: () => null,
        adminRun: () => null,
        adminSave: () => null,
        uploadRootDir: tmpDir,
        avatarUploadRootDir,
        fileUploadMaxSize: 10 * 1024 * 1024,
        fileUploadMaxFiles: 1,
        fileUploadMaxTotalSize: 10 * 1024 * 1024,
        storageEncryption: mockStorageEncryption,
        storageProvider: mockLocalProvider,
      });

      const filePath = path.join(avatarUploadRootDir, "avatar-local.png");
      fs.writeFileSync(filePath, "sample-avatar-bytes");

      const file = {
        filename: "avatar-local.png",
        path: filePath,
        mimetype: "image/png",
        size: 19,
      };

      const result = await uploadTools.storeAvatarFile(file);

      expect(result.avatarUrl).toBe("/api/uploads/avatars/avatar-local.png");
      expect(result.storageDriver).toBe("local");
      expect(mockStorageEncryption.encryptFileInPlace).toHaveBeenCalledWith(
        filePath,
      );
      expect(mockRemoteProvider.uploadBuffer).not.toHaveBeenCalled();
      // Local file should still exist
      expect(fs.existsSync(filePath)).toBe(true);
    });
  });

  describe("ensureAvatarExists", () => {
    test("preserves avatar URL when file is missing locally but S3 storageProvider is configured", () => {
      const adminRun = vi.fn();
      const adminSave = vi.fn();

      const uploadTools = createUploadTools({
        fs,
        path,
        crypto,
        multer,
        adminGetRow: () => null,
        adminRun,
        adminSave,
        uploadRootDir: tmpDir,
        avatarUploadRootDir,
        fileUploadMaxSize: 10 * 1024 * 1024,
        fileUploadMaxFiles: 1,
        fileUploadMaxTotalSize: 10 * 1024 * 1024,
        storageEncryption: mockStorageEncryption,
        storageProvider: mockRemoteProvider,
      });

      // avatar-missing.png does not exist in avatarUploadRootDir
      const url = uploadTools.ensureAvatarExists(
        "user-1",
        "/api/uploads/avatars/avatar-missing.png",
      );
      expect(url).toBe("/api/uploads/avatars/avatar-missing.png");
      expect(adminRun).not.toHaveBeenCalled();
    });

    test("clears avatar in DB when file is missing locally and storageProvider is local", () => {
      const adminRun = vi.fn();
      const adminSave = vi.fn();

      const uploadTools = createUploadTools({
        fs,
        path,
        crypto,
        multer,
        adminGetRow: () => null,
        adminRun,
        adminSave,
        uploadRootDir: tmpDir,
        avatarUploadRootDir,
        fileUploadMaxSize: 10 * 1024 * 1024,
        fileUploadMaxFiles: 1,
        fileUploadMaxTotalSize: 10 * 1024 * 1024,
        storageEncryption: mockStorageEncryption,
        storageProvider: mockLocalProvider,
      });

      const url = uploadTools.ensureAvatarExists(
        "user-1",
        "/api/uploads/avatars/avatar-missing.png",
      );
      expect(url).toBeNull();
      expect(adminRun).toHaveBeenCalled();
    });
  });

  describe("removeAvatarByUrl", () => {
    test("deletes from both local disk and S3 when storageProvider is S3", () => {
      const uploadTools = createUploadTools({
        fs,
        path,
        crypto,
        multer,
        adminGetRow: () => null,
        adminRun: () => null,
        adminSave: () => null,
        uploadRootDir: tmpDir,
        avatarUploadRootDir,
        fileUploadMaxSize: 10 * 1024 * 1024,
        fileUploadMaxFiles: 1,
        fileUploadMaxTotalSize: 10 * 1024 * 1024,
        storageEncryption: mockStorageEncryption,
        storageProvider: mockRemoteProvider,
      });

      const filePath = path.join(avatarUploadRootDir, "avatar-del.png");
      fs.writeFileSync(filePath, "data");

      uploadTools.removeAvatarByUrl("/api/uploads/avatars/avatar-del.png");

      expect(fs.existsSync(filePath)).toBe(false);
      expect(mockRemoteProvider.deleteFile).toHaveBeenCalledWith(
        "uploads/avatars/avatar-del.png",
      );
    });

    test("deletes from S3 when avatarUrl is a full S3 or CDN URL", () => {
      const uploadTools = createUploadTools({
        fs,
        path,
        crypto,
        multer,
        adminGetRow: () => null,
        adminRun: () => null,
        adminSave: () => null,
        uploadRootDir: tmpDir,
        avatarUploadRootDir,
        fileUploadMaxSize: 10 * 1024 * 1024,
        fileUploadMaxFiles: 1,
        fileUploadMaxTotalSize: 10 * 1024 * 1024,
        storageEncryption: mockStorageEncryption,
        storageProvider: mockRemoteProvider,
      });

      uploadTools.removeAvatarByUrl(
        "https://my-bucket.s3.amazonaws.com/uploads/avatars/avatar-full-url.png?query=1",
      );

      expect(mockRemoteProvider.deleteFile).toHaveBeenCalledWith(
        "uploads/avatars/avatar-full-url.png",
      );
    });
  });
});


describe("server/lib/uploads.js avatars cannot be turned into scripts", () => {
  let tmpDir;
  let avatarUploadRootDir;
  let tools;
  let app;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-avatar-xss-"));
    avatarUploadRootDir = path.join(tmpDir, "avatars");
    fs.mkdirSync(avatarUploadRootDir, { recursive: true });
    tools = createUploadTools({
      fs,
      path,
      crypto,
      multer,
      adminGetRow: () => null,
      adminRun: () => null,
      adminSave: () => null,
      uploadRootDir: tmpDir,
      avatarUploadRootDir,
      fileUploadMaxSize: 10 * 1024 * 1024,
      fileUploadMaxFiles: 1,
      fileUploadMaxTotalSize: 10 * 1024 * 1024,
      storageEncryption: {
        encryptFileInPlace: () => true,
        decryptFileToBuffer: (file) => fs.readFileSync(file),
      },
      storageProvider: { type: "local" },
    });
    app = express();
    app.post("/up", tools.uploadAvatar.single("avatar"), (req, res) =>
      res.json({ filename: req.file.filename }),
    );
    tools.registerUploadRoutes(app, { adminGetRow: () => null });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("the stored extension follows the declared image type, not the file name", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
    for (const [filename, contentType, expected] of [
      ["evil.svg", "image/png", ".png"],
      ["evil.html", "image/jpeg", ".jpg"],
      ["evil.png", "image/webp", ".webp"],
      ["no-extension", "image/gif", ".gif"],
      ["evil.svg", "image/svg+xml", ".bin"],
    ]) {
      const res = await request(app).post("/up").attach("avatar", svg, { filename, contentType });
      expect(res.status, filename).toBe(200);
      expect(path.extname(res.body.filename), `${filename} as ${contentType}`).toBe(expected);
    }
  });

  test("a stored avatar is served as its image type", async () => {
    fs.writeFileSync(path.join(avatarUploadRootDir, "avatar-1-aa.png"), "png-bytes");
    const res = await request(app).get("/api/uploads/avatars/avatar-1-aa.png");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/png");
    expect(res.headers["content-disposition"]).toBeUndefined();
    expect(res.headers["content-security-policy"]).toContain("sandbox");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  test("an older avatar saved under a document extension is downloaded, never rendered", async () => {
    for (const name of ["avatar-2-bb.svg", "avatar-3-cc.html", "avatar-4-dd.bin"]) {
      fs.writeFileSync(path.join(avatarUploadRootDir, name), "<svg onload=alert(1)/>");
      const res = await request(app).get(`/api/uploads/avatars/${name}`);
      expect(res.status, name).toBe(200);
      expect(res.headers["content-type"], name).toContain("application/octet-stream");
      expect(res.headers["content-disposition"], name).toBe("attachment");
      expect(res.headers["content-security-policy"], name).toContain("sandbox");
    }
  });
});
