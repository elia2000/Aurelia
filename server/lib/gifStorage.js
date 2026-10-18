/**
 * Where the bytes of GIFs live.
 *
 * Three jobs, one place, so the rules about keys, encryption and bounds are
 * written once:
 *
 *   1. Saved GIFs (the person's private collection): stored under
 *      `gifs/<userId>/<gifId>.<ext>`. On a bucket the key is the object key; on
 *      local disk it is a path below `rootDir` (data/uploads). Written with the
 *      same at-rest encryption as message files when STORAGE_ENCRYPTION_KEY is
 *      set. Every read, write and delete first checks that the key has exactly
 *      the layout above and (for reads and deletes) belongs to the row's owner.
 *   2. Message files: reading one (to save it as a GIF) and writing a fresh
 *      copy of a saved GIF as a message attachment, exactly as an upload would
 *      be stored (data/uploads/messages, or `uploads/messages/` on a bucket).
 *   3. Asking a bucket whether an object that a client uploaded straight to it
 *      is an animated image, by reading only the start of it.
 *
 * Nothing here throws on a missing or unreachable file: reads answer null,
 * removals report counts. Writes throw, so the caller can undo its own work.
 */

import { isSafeStorageKey } from "./storageKeys.js";
import {
  ANIMATION_PREFIX_LADDER,
  detectAnimationFromReader,
  isAnimationCandidate,
} from "./animatedImage.js";
import { SAVED_GIF_MAX_BYTES, extensionForGifType, isSavedGifKeyOf, ownerOfSavedGifKey } from "./savedGifs.js";

const isRemoteType = (type) => type === "remote" || type === "s3";
// The encrypted form of a file is a little larger than its content.
const ENCRYPTION_OVERHEAD = 64;

export function createGifStorage({
  fs,
  path,
  crypto,
  storageProvider = null,
  storageEncryption,
  rootDir,
  uploadRootDir,
  fetchImpl = globalThis.fetch,
  fetchTimeoutMs = 20_000,
  logger = console,
}) {
  const remoteProvider = () =>
    storageProvider &&
    isRemoteType(storageProvider.type) &&
    typeof storageProvider.uploadBuffer === "function" &&
    typeof storageProvider.getDownloadUrl === "function"
      ? storageProvider
      : null;

  /** `relative` joined below `base`, or null if it would end up anywhere else. */
  const resolveUnder = (base, relative) => {
    if (!base || !relative) return null;
    const resolvedBase = path.resolve(base);
    const target = path.resolve(resolvedBase, relative);
    return target.startsWith(resolvedBase + path.sep) ? target : null;
  };

  const decrypt = (buffer) => {
    try {
      return storageEncryption.decryptBuffer(buffer);
    } catch {
      return null;
    }
  };

  async function readLocal(target, maxBytes) {
    if (!target) return null;
    try {
      const { size } = await fs.promises.stat(target);
      if (size > maxBytes + ENCRYPTION_OVERHEAD) return null;
      const plain = decrypt(await fs.promises.readFile(target));
      return plain && plain.length <= maxBytes ? plain : null;
    } catch {
      return null;
    }
  }

  /**
   * Reads an object through its download URL. With `range`, only that many
   * bytes from the start are wanted (a server that ignores the Range header is
   * cut off at the same point). Without it, an object larger than `maxBytes`
   * is refused, by its announced size and again while streaming.
   */
  async function fetchObject(key, { maxBytes, range = 0 }) {
    const provider = remoteProvider();
    if (!provider || !isSafeStorageKey(key)) return null;
    // A storage proxy is configured for the bucket: go through the provider's
    // own proxied request, which the global fetch cannot do.
    if (provider.proxyAgent && typeof provider._sendPresignedRequest === "function") {
      try {
        const url = await provider.getDownloadUrl(key);
        const { body } = await provider._sendPresignedRequest(
          url,
          "GET",
          null,
          range ? { Range: `bytes=0-${range - 1}` } : {},
        );
        const whole = Buffer.from(body);
        if (range) return whole.subarray(0, range);
        return whole.length <= maxBytes + ENCRYPTION_OVERHEAD ? whole : null;
      } catch {
        return null;
      }
    }
    if (typeof fetchImpl !== "function") return null;
    let response = null;
    try {
      const url = await provider.getDownloadUrl(key);
      response = await fetchImpl(url, {
        headers: range ? { Range: `bytes=0-${range - 1}` } : {},
        signal: AbortSignal.timeout(fetchTimeoutMs),
      });
      if (!response || !response.ok) return null;
      const limit = range || maxBytes + ENCRYPTION_OVERHEAD;
      const announced = Number(response.headers?.get?.("content-length"));
      if (!range && Number.isFinite(announced) && announced > limit) {
        await response.body?.cancel?.().catch(() => {});
        return null;
      }
      const reader = response.body?.getReader?.();
      if (!reader) {
        const whole = Buffer.from(await response.arrayBuffer());
        if (range) return whole.subarray(0, range);
        return whole.length <= limit ? whole : null;
      }
      const chunks = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > limit) {
          if (!range) {
            await reader.cancel().catch(() => {});
            return null;
          }
          chunks.push(Buffer.from(value.subarray(0, value.length - (total - limit))));
          await reader.cancel().catch(() => {});
          break;
        }
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks);
    } catch {
      try {
        await response?.body?.cancel?.();
      } catch {
        // nothing to do
      }
      return null;
    }
  }

  async function readRemoteDecrypted(key, maxBytes) {
    const raw = await fetchObject(key, { maxBytes });
    if (!raw) return null;
    const plain = decrypt(raw);
    return plain && plain.length <= maxBytes ? plain : null;
  }

  // ─── Saved GIFs ────────────────────────────────────────────────────────────

  /** Stores the bytes of a saved GIF under `key`. Throws on a bad key or a failed write. */
  async function writeGif({ key, bytes, mime }) {
    if (!ownerOfSavedGifKey(key)) throw new Error("Invalid GIF storage key.");
    const provider = remoteProvider();
    if (provider) {
      await provider.uploadBuffer(key, bytes, mime || "application/octet-stream");
      return { storageDriver: provider.type || "s3" };
    }
    const target = resolveUnder(rootDir, key);
    if (!target) throw new Error("Invalid GIF storage key.");
    const data = storageEncryption.encryptBuffer(bytes);
    for (let attempt = 0; ; attempt += 1) {
      await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      try {
        // "wx": a key is only ever written once, an existing file is never replaced.
        await fs.promises.writeFile(target, data, { flag: "wx", mode: 0o600 });
        return { storageDriver: "local" };
      } catch (error) {
        // Deleting the person's last GIF tidies their folder; a save made at the
        // same moment finds it gone once, and simply makes it again.
        if (error?.code === "ENOENT" && attempt === 0) continue;
        throw error;
      }
    }
  }

  /** The plain bytes of a saved GIF, or null if it is missing, too big or not this row's own. */
  async function readGif(row, { maxBytes = SAVED_GIF_MAX_BYTES } = {}) {
    if (!row || !isSavedGifKeyOf(row.user_id, row.storage_key)) return null;
    if (isRemoteType(row.storage_driver)) {
      return readRemoteDecrypted(row.storage_key, maxBytes);
    }
    return readLocal(resolveUnder(rootDir, row.storage_key), maxBytes);
  }

  /**
   * Deletes the stored bytes of saved GIFs. Rows whose key is not their owner's
   * own are skipped. Resolves to { removed, failed }; never throws.
   */
  async function removeGifs(rows) {
    let removed = 0;
    let failed = 0;
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row || !isSavedGifKeyOf(row.user_id, row.storage_key)) {
        if (row) logger.warn?.("[gifs] Not removing a file whose key is not its owner's own.");
        continue;
      }
      try {
        if (isRemoteType(row.storage_driver)) {
          const provider = remoteProvider();
          if (!provider || typeof provider.deleteFile !== "function") {
            failed += 1;
            continue;
          }
          await provider.deleteFile(row.storage_key);
        } else {
          const target = resolveUnder(rootDir, row.storage_key);
          if (!target) continue;
          await fs.promises.unlink(target).catch((error) => {
            if (error?.code !== "ENOENT") throw error;
          });
          // Tidy the person's folder once their last GIF is gone.
          await fs.promises.rmdir(path.dirname(target)).catch(() => {});
        }
        removed += 1;
      } catch (error) {
        failed += 1;
        logger.warn?.("[gifs] Unable to remove a stored GIF:", error?.message || error);
      }
    }
    return { removed, failed };
  }

  // ─── Message files ─────────────────────────────────────────────────────────

  /** The plain bytes of a message attachment, or null if missing or above `maxBytes`. */
  async function readMessageFile(row, { maxBytes = SAVED_GIF_MAX_BYTES } = {}) {
    if (!row) return null;
    const storedName = path.basename(String(row.stored_name || ""));
    if (isRemoteType(row.storage_driver)) {
      const key = row.storage_key || (storedName ? `uploads/messages/${storedName}` : "");
      return readRemoteDecrypted(key, maxBytes);
    }
    if (!storedName) return null;
    const local = await readLocal(resolveUnder(uploadRootDir, storedName), maxBytes);
    if (local) return local;
    // The server may have moved to a bucket since the file was written.
    if (remoteProvider()) {
      return readRemoteDecrypted(row.storage_key || `uploads/messages/${storedName}`, maxBytes);
    }
    return null;
  }

  /**
   * Stores a copy of a saved GIF as a new message attachment, the way an upload
   * is stored. Resolves to the file fields to insert; throws if the write fails.
   */
  async function writeMessageCopy({ bytes, mime, type }) {
    const extension = extensionForGifType(type);
    if (!extension) throw new Error("Unsupported GIF type.");
    const storedName = `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${extension}`;
    const provider = remoteProvider();
    if (provider) {
      const storageKey = `uploads/messages/${storedName}`;
      await provider.uploadBuffer(storageKey, bytes, mime || "application/octet-stream");
      return {
        storedName,
        storageDriver: provider.type || "s3",
        storageKey,
        encryptionType: "none",
        sizeBytes: bytes.length,
      };
    }
    const target = resolveUnder(uploadRootDir, storedName);
    if (!target) throw new Error("Invalid file name.");
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    const data = storageEncryption.encryptBuffer(bytes);
    await fs.promises.writeFile(target, data, { flag: "wx" });
    return {
      storedName,
      storageDriver: "local",
      storageKey: null,
      encryptionType: storageEncryption.isEncryptedFileBuffer(data) ? "local" : "none",
      sizeBytes: bytes.length,
    };
  }

  /** Undoes writeMessageCopy() when the message could not be created. Never throws. */
  async function removeMessageCopy(copy) {
    try {
      if (!copy) return;
      if (isRemoteType(copy.storageDriver)) {
        await remoteProvider()?.deleteFile?.(copy.storageKey);
        return;
      }
      const target = resolveUnder(uploadRootDir, path.basename(String(copy.storedName || "")));
      if (target) await fs.promises.unlink(target).catch(() => {});
    } catch (error) {
      logger.warn?.("[gifs] Unable to remove a file copy:", error?.message || error);
    }
  }

  // ─── Files uploaded straight to the bucket ─────────────────────────────────

  /**
   * Is the object an animated image? Reads only the start of it (growing until
   * the answer is known) and only for files that could be one. Resolves to
   * true / false, or null when it cannot be told. Never throws.
   */
  async function detectStoredAnimation({ storageKey, storageDriver, size = null, mimeType = "", name = "" }) {
    try {
      if (!isRemoteType(storageDriver) || !remoteProvider()) return null;
      if (!isAnimationCandidate({ mimeType, name })) return null;
      if (!isSafeStorageKey(storageKey)) return null;
      return await detectAnimationFromReader(
        (limit) => fetchObject(storageKey, { maxBytes: limit, range: limit }),
        { size, ladder: ANIMATION_PREFIX_LADDER },
      );
    } catch {
      return null;
    }
  }

  return {
    writeGif,
    readGif,
    removeGifs,
    readMessageFile,
    writeMessageCopy,
    removeMessageCopy,
    detectStoredAnimation,
  };
}
