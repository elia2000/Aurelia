import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGifStorage } from "../../lib/gifStorage.js";
import { createStorageEncryption } from "../../lib/storageEncryption.js";
import { buildSavedGifKey } from "../../lib/savedGifs.js";
import { buildGif, buildPng } from "../helpers/imageBytes.js";

const ALICE = "a0a0a0a0-b1b1-4c2c-8d3d-e4e4e4e4e4e4";
const BOB = "b0b0b0b0-c1c1-4d2d-9e3e-f5f5f5f5f5f5";
const GIF_ID = "d0d0d0d0-e1e1-4f2f-b040-171717171717";
const GIF_ID_2 = "d1d1d1d1-e1e1-4f2f-b040-171717171717";

const keyOf = (userId, id = GIF_ID, type = "gif") => buildSavedGifKey(userId, id, type);

// An object store in memory that behaves like the remote provider.
function makeRemote() {
  const objects = new Map();
  const calls = { upload: [], delete: [], download: [] };
  const provider = {
    type: "s3",
    uploadBuffer: vi.fn(async (key, body, contentType) => {
      calls.upload.push({ key, contentType });
      objects.set(key, Buffer.from(body));
      return { key };
    }),
    getDownloadUrl: vi.fn(async (key) => {
      calls.download.push(key);
      return `https://bucket.test/${key}?sig=1`;
    }),
    deleteFile: vi.fn(async (key) => {
      calls.delete.push(key);
      objects.delete(key);
      return true;
    }),
  };
  const requests = [];
  const fetchImpl = vi.fn(async (url, init = {}) => {
    requests.push({ url, headers: init.headers || {} });
    const key = decodeURIComponent(new URL(url).pathname.slice(1));
    const body = objects.get(key);
    if (!body) return new Response("nope", { status: 404 });
    const range = /^bytes=0-(\d+)$/.exec(init.headers?.Range || "");
    if (range) {
      const part = body.subarray(0, Number(range[1]) + 1);
      return new Response(part, { status: 206 });
    }
    return new Response(body, { status: 200, headers: { "content-length": String(body.length) } });
  });
  return { provider, objects, calls, fetchImpl, requests };
}

describe("createGifStorage", () => {
  let root;
  let messagesDir;
  let storageEncryption;
  let originalKey;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "gifstore-"));
    messagesDir = path.join(root, "uploads", "messages");
    fs.mkdirSync(messagesDir, { recursive: true });
    originalKey = process.env.STORAGE_ENCRYPTION_KEY;
    delete process.env.STORAGE_ENCRYPTION_KEY;
    storageEncryption = createStorageEncryption();
  });
  afterEach(() => {
    if (originalKey === undefined) delete process.env.STORAGE_ENCRYPTION_KEY;
    else process.env.STORAGE_ENCRYPTION_KEY = originalKey;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const make = (overrides = {}) =>
    createGifStorage({
      fs,
      path,
      crypto,
      storageProvider: null,
      storageEncryption,
      rootDir: path.join(root, "uploads"),
      uploadRootDir: messagesDir,
      logger: { warn: () => {}, error: () => {} },
      ...overrides,
    });

  describe("local driver", () => {
    test("writes under the person's own folder and reads the same bytes back", async () => {
      const storage = make();
      const bytes = buildGif({ frames: 3 });
      const key = keyOf(ALICE);
      const written = await storage.writeGif({ key, bytes, mime: "image/gif" });
      expect(written).toEqual({ storageDriver: "local" });

      const onDisk = path.join(root, "uploads", "gifs", ALICE, `${GIF_ID}.gif`);
      expect(fs.existsSync(onDisk)).toBe(true);
      expect(fs.readFileSync(onDisk).equals(bytes)).toBe(true);

      const row = { user_id: ALICE, storage_key: key, storage_driver: "local" };
      expect((await storage.readGif(row)).equals(bytes)).toBe(true);
    });

    test("with at-rest encryption on, the file on disk is ciphertext and reads back as plaintext", async () => {
      process.env.STORAGE_ENCRYPTION_KEY = "a-long-enough-secret-for-tests";
      const storage = make({ storageEncryption: createStorageEncryption() });
      const bytes = buildGif({ frames: 2 });
      const key = keyOf(ALICE);
      await storage.writeGif({ key, bytes, mime: "image/gif" });

      const onDisk = fs.readFileSync(path.join(root, "uploads", key));
      expect(onDisk.equals(bytes)).toBe(false);
      expect(onDisk.subarray(0, 5).toString()).toBe("SBENC");

      const row = { user_id: ALICE, storage_key: key, storage_driver: "local" };
      expect((await storage.readGif(row)).equals(bytes)).toBe(true);
    });

    test("a save that races the tidying of the person's folder simply makes the folder again", async () => {
      let failed = 0;
      const racyFs = {
        ...fs,
        promises: {
          ...fs.promises,
          writeFile: async (...args) => {
            if (failed === 0) {
              failed += 1;
              const error = new Error("ENOENT: the folder was just removed");
              error.code = "ENOENT";
              throw error;
            }
            return fs.promises.writeFile(...args);
          },
        },
      };
      const storage = make({ fs: racyFs });
      const key = keyOf(ALICE);
      await storage.writeGif({ key, bytes: buildGif({ frames: 2 }), mime: "image/gif" });
      expect(failed).toBe(1);
      expect(fs.existsSync(path.join(root, "uploads", key))).toBe(true);
    });

    test("never overwrites a file that is already there", async () => {
      const storage = make();
      const key = keyOf(ALICE);
      await storage.writeGif({ key, bytes: buildGif({ frames: 2 }), mime: "image/gif" });
      await expect(
        storage.writeGif({ key, bytes: buildGif({ frames: 3 }), mime: "image/gif" }),
      ).rejects.toThrow();
    });

    test("a key outside the layout is refused before anything is written", async () => {
      const storage = make();
      const bad = [
        "gifs/../../escape.gif",
        `gifs/${ALICE}/../${BOB}/${GIF_ID}.gif`,
        "/etc/passwd",
        `uploads/messages/${GIF_ID}.gif`,
        `gifs/${ALICE}/${GIF_ID}.html`,
        "",
      ];
      for (const key of bad) {
        await expect(storage.writeGif({ key, bytes: buildGif(), mime: "image/gif" })).rejects.toThrow();
      }
      expect(fs.existsSync(path.join(root, "escape.gif"))).toBe(false);
      expect(fs.existsSync(path.join(root, "uploads", "gifs"))).toBe(false);
    });

    test("a row that points at another person's key is never read", async () => {
      const storage = make();
      const bobsKey = keyOf(BOB, GIF_ID_2);
      await storage.writeGif({ key: bobsKey, bytes: buildGif({ frames: 2 }), mime: "image/gif" });
      // Alice's row, but the key is Bob's: a corrupted or forged row.
      const forged = { user_id: ALICE, storage_key: bobsKey, storage_driver: "local" };
      expect(await storage.readGif(forged)).toBeNull();
    });

    test("a missing file reads as null, not as an error", async () => {
      const storage = make();
      const row = { user_id: ALICE, storage_key: keyOf(ALICE), storage_driver: "local" };
      expect(await storage.readGif(row)).toBeNull();
    });

    test("a file over the size bound is not read", async () => {
      const storage = make();
      const key = keyOf(ALICE);
      await storage.writeGif({ key, bytes: buildGif({ frames: 2, padTo: 5000 }), mime: "image/gif" });
      const row = { user_id: ALICE, storage_key: key, storage_driver: "local" };
      expect(await storage.readGif(row, { maxBytes: 1000 })).toBeNull();
      expect(await storage.readGif(row, { maxBytes: 10_000 })).not.toBeNull();
    });

    test("removing deletes the file and the person's folder when it is empty", async () => {
      const storage = make();
      const k1 = keyOf(ALICE, GIF_ID);
      const k2 = keyOf(ALICE, GIF_ID_2);
      await storage.writeGif({ key: k1, bytes: buildGif({ frames: 2 }), mime: "image/gif" });
      await storage.writeGif({ key: k2, bytes: buildGif({ frames: 3 }), mime: "image/gif" });

      let result = await storage.removeGifs([{ user_id: ALICE, storage_key: k1, storage_driver: "local" }]);
      expect(result).toEqual({ removed: 1, failed: 0 });
      expect(fs.existsSync(path.join(root, "uploads", k1))).toBe(false);
      expect(fs.existsSync(path.join(root, "uploads", k2))).toBe(true);

      result = await storage.removeGifs([{ user_id: ALICE, storage_key: k2, storage_driver: "local" }]);
      expect(result.removed).toBe(1);
      expect(fs.existsSync(path.join(root, "uploads", "gifs", ALICE))).toBe(false);
    });

    test("removing something that is already gone, or a malformed key, never throws and touches nothing else", async () => {
      const storage = make();
      const keep = keyOf(BOB, GIF_ID_2);
      await storage.writeGif({ key: keep, bytes: buildGif({ frames: 2 }), mime: "image/gif" });
      const result = await storage.removeGifs([
        { user_id: ALICE, storage_key: keyOf(ALICE), storage_driver: "local" },
        { user_id: ALICE, storage_key: "gifs/../../x.gif", storage_driver: "local" },
        { user_id: ALICE, storage_key: keep, storage_driver: "local" }, // Bob's key on Alice's row
        null,
        {},
      ]);
      expect(result.failed).toBe(0);
      expect(fs.existsSync(path.join(root, "uploads", keep))).toBe(true);
    });
  });

  describe("remote driver", () => {
    test("uploads the plain bytes under the key and reads them back through the download URL", async () => {
      const remote = makeRemote();
      const storage = make({ storageProvider: remote.provider, fetchImpl: remote.fetchImpl });
      const bytes = buildGif({ frames: 3 });
      const key = keyOf(ALICE);
      const written = await storage.writeGif({ key, bytes, mime: "image/gif" });
      expect(written).toEqual({ storageDriver: "s3" });
      expect(remote.calls.upload).toEqual([{ key, contentType: "image/gif" }]);
      expect(remote.objects.get(key).equals(bytes)).toBe(true);
      // Nothing was written to the local disk.
      expect(fs.existsSync(path.join(root, "uploads", "gifs"))).toBe(false);

      const row = { user_id: ALICE, storage_key: key, storage_driver: "s3" };
      expect((await storage.readGif(row)).equals(bytes)).toBe(true);
    });

    test("a row stored locally is still read from disk after the server moved to a bucket", async () => {
      const remote = makeRemote();
      const localOnly = make();
      const key = keyOf(ALICE);
      const bytes = buildGif({ frames: 2 });
      await localOnly.writeGif({ key, bytes, mime: "image/gif" });

      const nowRemote = make({ storageProvider: remote.provider, fetchImpl: remote.fetchImpl });
      const row = { user_id: ALICE, storage_key: key, storage_driver: "local" };
      expect((await nowRemote.readGif(row)).equals(bytes)).toBe(true);
      expect(remote.fetchImpl).not.toHaveBeenCalled();
    });

    test("refuses to read an object that is larger than the bound, by its announced size", async () => {
      const remote = makeRemote();
      const storage = make({ storageProvider: remote.provider, fetchImpl: remote.fetchImpl });
      const key = keyOf(ALICE);
      remote.objects.set(key, buildGif({ frames: 2, padTo: 5000 }));
      const row = { user_id: ALICE, storage_key: key, storage_driver: "s3" };
      expect(await storage.readGif(row, { maxBytes: 1000 })).toBeNull();
    });

    test("refuses to read an object that outgrows the bound while streaming, even without a length header", async () => {
      const big = buildGif({ frames: 2, padTo: 5000 });
      const fetchImpl = vi.fn(async () => new Response(big, { status: 200 }));
      const remote = makeRemote();
      const storage = make({ storageProvider: remote.provider, fetchImpl });
      const row = { user_id: ALICE, storage_key: keyOf(ALICE), storage_driver: "s3" };
      expect(await storage.readGif(row, { maxBytes: 1000 })).toBeNull();
    });

    test("behind a storage proxy the provider's own request is used, with the same bounds", async () => {
      const bytes = buildGif({ frames: 3 });
      const sent = [];
      const provider = {
        type: "s3",
        proxyAgent: {},
        uploadBuffer: async () => ({}),
        getDownloadUrl: async (key) => `https://bucket.test/${key}`,
        _sendPresignedRequest: async (url, method, body, headers) => {
          sent.push({ url, method, headers });
          return { statusCode: 200, body: bytes };
        },
      };
      const fetchImpl = vi.fn();
      const storage = make({ storageProvider: provider, fetchImpl });
      const row = { user_id: ALICE, storage_key: keyOf(ALICE), storage_driver: "s3" };
      expect((await storage.readGif(row)).equals(bytes)).toBe(true);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(sent[0]).toMatchObject({ method: "GET", headers: {} });
      // Too big for the bound: refused, as without a proxy.
      expect(await storage.readGif(row, { maxBytes: 10 })).toBeNull();
      // A prefix read sends the Range header and cuts the answer off.
      const prefix = await storage.detectStoredAnimation({
        storageKey: "uploads/messages/a.gif", storageDriver: "s3", size: bytes.length, mimeType: "image/gif", name: "a.gif",
      });
      expect(prefix).toBe(true);
      expect(sent.at(-1).headers.Range).toMatch(/^bytes=0-\d+$/);
    });

    test("a failing download is null, never a throw", async () => {
      const remote = makeRemote();
      const storage = make({ storageProvider: remote.provider, fetchImpl: remote.fetchImpl });
      const row = { user_id: ALICE, storage_key: keyOf(ALICE), storage_driver: "s3" };
      expect(await storage.readGif(row)).toBeNull(); // 404

      const broken = make({
        storageProvider: remote.provider,
        fetchImpl: async () => {
          throw new Error("connection reset");
        },
      });
      expect(await broken.readGif(row)).toBeNull();

      const noUrl = make({
        storageProvider: { ...remote.provider, getDownloadUrl: async () => { throw new Error("no creds"); } },
        fetchImpl: remote.fetchImpl,
      });
      expect(await noUrl.readGif(row)).toBeNull();
    });

    test("removing deletes the object; a failing delete is counted, not thrown", async () => {
      const remote = makeRemote();
      const storage = make({ storageProvider: remote.provider, fetchImpl: remote.fetchImpl });
      const key = keyOf(ALICE);
      await storage.writeGif({ key, bytes: buildGif({ frames: 2 }), mime: "image/gif" });
      expect(await storage.removeGifs([{ user_id: ALICE, storage_key: key, storage_driver: "s3" }])).toEqual({
        removed: 1,
        failed: 0,
      });
      expect(remote.objects.has(key)).toBe(false);

      remote.provider.deleteFile.mockRejectedValueOnce(new Error("bucket unreachable"));
      const again = await storage.removeGifs([{ user_id: ALICE, storage_key: key, storage_driver: "s3" }]);
      expect(again).toEqual({ removed: 0, failed: 1 });
    });
  });

  describe("message files", () => {
    test("reads a local message file by its stored name, and decrypts it", async () => {
      process.env.STORAGE_ENCRYPTION_KEY = "a-long-enough-secret-for-tests";
      const encryption = createStorageEncryption();
      const storage = make({ storageEncryption: encryption });
      const bytes = buildGif({ frames: 4 });
      const filePath = path.join(messagesDir, "1700-aa.gif");
      fs.writeFileSync(filePath, encryption.encryptBuffer(bytes));

      const row = { stored_name: "1700-aa.gif", storage_driver: "local", encryption_type: "local" };
      expect((await storage.readMessageFile(row)).equals(bytes)).toBe(true);
    });

    test("a stored name can never climb out of the messages folder", async () => {
      const storage = make();
      fs.writeFileSync(path.join(root, "secret.gif"), buildGif({ frames: 2 }));
      const row = { stored_name: "../../secret.gif", storage_driver: "local" };
      expect(await storage.readMessageFile(row)).toBeNull();
      // Only the file's last path segment counts: it is not in the folder, so it is not found.
      expect(await storage.readMessageFile({ stored_name: "/etc/passwd", storage_driver: "local" })).toBeNull();
    });

    test("reads a remote message file by its storage key", async () => {
      const remote = makeRemote();
      const storage = make({ storageProvider: remote.provider, fetchImpl: remote.fetchImpl });
      const bytes = buildGif({ frames: 2 });
      remote.objects.set("uploads/messages/x.gif", bytes);
      const row = {
        stored_name: "x.gif",
        storage_key: "uploads/messages/x.gif",
        storage_driver: "remote",
        encryption_type: "none",
      };
      expect((await storage.readMessageFile(row)).equals(bytes)).toBe(true);
    });

    test("a size bound applies to message files too", async () => {
      const storage = make();
      fs.writeFileSync(path.join(messagesDir, "big.gif"), buildGif({ frames: 2, padTo: 5000 }));
      const row = { stored_name: "big.gif", storage_driver: "local" };
      expect(await storage.readMessageFile(row, { maxBytes: 1000 })).toBeNull();
    });
  });

  describe("copying a saved GIF into a message", () => {
    test("local: a new file in the messages folder under a fresh name, flagged encrypted when it is", async () => {
      process.env.STORAGE_ENCRYPTION_KEY = "a-long-enough-secret-for-tests";
      const encryption = createStorageEncryption();
      const storage = make({ storageEncryption: encryption });
      const bytes = buildGif({ frames: 3 });
      const copy = await storage.writeMessageCopy({ bytes, mime: "image/gif", type: "gif" });

      expect(copy.storageDriver).toBe("local");
      expect(copy.storageKey).toBeNull();
      expect(copy.storedName).toMatch(/^\d+-[0-9a-f]{16}\.gif$/);
      expect(copy.encryptionType).toBe("local");
      expect(copy.sizeBytes).toBe(bytes.length);
      const onDisk = fs.readFileSync(path.join(messagesDir, copy.storedName));
      expect(onDisk.subarray(0, 5).toString()).toBe("SBENC");
      expect(encryption.decryptBuffer(onDisk).equals(bytes)).toBe(true);
    });

    test("local without encryption: plain bytes and encryptionType none", async () => {
      const storage = make();
      const bytes = buildGif({ frames: 3 });
      const copy = await storage.writeMessageCopy({ bytes, mime: "image/gif", type: "gif" });
      expect(copy.encryptionType).toBe("none");
      expect(fs.readFileSync(path.join(messagesDir, copy.storedName)).equals(bytes)).toBe(true);
    });

    test("every copy gets its own name, so deleting one message's file never touches another's", async () => {
      const storage = make();
      const bytes = buildGif({ frames: 3 });
      const a = await storage.writeMessageCopy({ bytes, mime: "image/gif", type: "gif" });
      const b = await storage.writeMessageCopy({ bytes, mime: "image/gif", type: "gif" });
      expect(a.storedName).not.toBe(b.storedName);
    });

    test("the extension follows the checked type", async () => {
      const storage = make();
      const png = await storage.writeMessageCopy({ bytes: buildPng({ animated: true }), mime: "image/png", type: "png" });
      expect(png.storedName.endsWith(".png")).toBe(true);
      await expect(
        storage.writeMessageCopy({ bytes: buildGif(), mime: "text/html", type: "html" }),
      ).rejects.toThrow();
    });

    test("remote: uploaded under uploads/messages as plain bytes", async () => {
      const remote = makeRemote();
      const storage = make({ storageProvider: remote.provider, fetchImpl: remote.fetchImpl });
      const bytes = buildGif({ frames: 3 });
      const copy = await storage.writeMessageCopy({ bytes, mime: "image/gif", type: "gif" });
      expect(copy.storageDriver).toBe("s3");
      expect(copy.storageKey).toBe(`uploads/messages/${copy.storedName}`);
      expect(copy.encryptionType).toBe("none");
      expect(remote.objects.get(copy.storageKey).equals(bytes)).toBe(true);
      expect(remote.calls.upload[0].contentType).toBe("image/gif");
    });

    test("removing a copy that was made removes only that copy", async () => {
      const storage = make();
      const bytes = buildGif({ frames: 3 });
      const a = await storage.writeMessageCopy({ bytes, mime: "image/gif", type: "gif" });
      const b = await storage.writeMessageCopy({ bytes, mime: "image/gif", type: "gif" });
      await storage.removeMessageCopy(a);
      expect(fs.existsSync(path.join(messagesDir, a.storedName))).toBe(false);
      expect(fs.existsSync(path.join(messagesDir, b.storedName))).toBe(true);
      await expect(storage.removeMessageCopy(a)).resolves.toBeUndefined();
    });
  });

  describe("detectStoredAnimation (files the server never saw, uploaded straight to the bucket)", () => {
    test("asks the bucket for the start of the file only", async () => {
      const remote = makeRemote();
      const storage = make({ storageProvider: remote.provider, fetchImpl: remote.fetchImpl });
      const key = "uploads/messages/anim.gif";
      // Three frames at the start, then 600 kB more: the answer is in the first prefix.
      const object = Buffer.concat([buildGif({ frames: 3 }), Buffer.alloc(600_000)]);
      remote.objects.set(key, object);

      const result = await storage.detectStoredAnimation({
        storageKey: key,
        storageDriver: "s3",
        size: object.length,
        mimeType: "image/gif",
        name: "anim.gif",
      });
      expect(result).toBe(true);
      expect(remote.requests.length).toBe(1);
      expect(remote.requests[0].headers.Range).toMatch(/^bytes=0-\d+$/);
      expect(Number(remote.requests[0].headers.Range.split("-")[1])).toBeLessThan(object.length);
    });

    test("a still image is false, and something that is not an image is null", async () => {
      const remote = makeRemote();
      const storage = make({ storageProvider: remote.provider, fetchImpl: remote.fetchImpl });
      remote.objects.set("uploads/messages/still.png", buildPng());
      remote.objects.set("uploads/messages/doc.gif", Buffer.from("<html></html>"));
      expect(
        await storage.detectStoredAnimation({
          storageKey: "uploads/messages/still.png", storageDriver: "s3", size: 100, mimeType: "image/png", name: "still.png",
        }),
      ).toBe(false);
      expect(
        await storage.detectStoredAnimation({
          storageKey: "uploads/messages/doc.gif", storageDriver: "s3", size: 13, mimeType: "image/gif", name: "doc.gif",
        }),
      ).toBeNull();
    });

    test("files that cannot be animated images are not even requested", async () => {
      const remote = makeRemote();
      const storage = make({ storageProvider: remote.provider, fetchImpl: remote.fetchImpl });
      for (const [mimeType, name] of [["video/mp4", "a.mp4"], ["image/jpeg", "a.jpg"], ["application/pdf", "a.pdf"]]) {
        expect(
          await storage.detectStoredAnimation({
            storageKey: `uploads/messages/${name}`, storageDriver: "s3", size: 100, mimeType, name,
          }),
        ).toBeNull();
      }
      expect(remote.fetchImpl).not.toHaveBeenCalled();
    });

    test("a key that could leave the bucket layout is never fetched", async () => {
      const remote = makeRemote();
      const storage = make({ storageProvider: remote.provider, fetchImpl: remote.fetchImpl });
      expect(
        await storage.detectStoredAnimation({
          storageKey: "../other-bucket/x.gif", storageDriver: "s3", size: 100, mimeType: "image/gif", name: "x.gif",
        }),
      ).toBeNull();
      expect(remote.fetchImpl).not.toHaveBeenCalled();
    });

    test("a bucket that is down gives null, not an error", async () => {
      const remote = makeRemote();
      const storage = make({
        storageProvider: remote.provider,
        fetchImpl: async () => {
          throw new Error("ECONNREFUSED");
        },
      });
      expect(
        await storage.detectStoredAnimation({
          storageKey: "uploads/messages/x.gif", storageDriver: "s3", size: 100, mimeType: "image/gif", name: "x.gif",
        }),
      ).toBeNull();
    });

    test("without a remote provider there is nothing to ask", async () => {
      const storage = make();
      expect(
        await storage.detectStoredAnimation({
          storageKey: "uploads/messages/x.gif", storageDriver: "s3", size: 100, mimeType: "image/gif", name: "x.gif",
        }),
      ).toBeNull();
    });
  });
});
