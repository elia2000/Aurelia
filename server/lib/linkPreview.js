/**
 * Link previews: a title, a description and a small picture for a link in a
 * message, made by the SERVER so the people reading the chat never connect to
 * the linked site (it learns the server's address, not theirs).
 *
 * Off unless the admin turns LINK_PREVIEWS on. The pieces:
 *
 *   linkPreview/addresses.js    which IP addresses are public
 *   linkPreview/guardedFetch.js the only code that opens a connection (SSRF rules)
 *   linkPreview/html.js         reads title / description / image from a page
 *   linkPreview/images.js       checks the picture really is one (magic bytes, size)
 *   linkPreview/cache.js        in-memory cache with expiry
 *
 * This file puts them together and owns the caches: a result is kept 24 hours
 * (a failure 1 hour), so one site is not fetched again and again, and the
 * pictures are kept in memory and served from our own address
 * (/api/link-preview/image/:id), never hot-linked.
 */

import crypto from "node:crypto";
import { LinkPreviewError, checkLinkUrl, createGuardedFetcher } from "./linkPreview/guardedFetch.js";
import { createTtlCache } from "./linkPreview/cache.js";
import { decodeHtml, parsePreviewFields } from "./linkPreview/html.js";
import { PREVIEW_IMAGE_MAX_BYTES, readPreviewImage } from "./linkPreview/images.js";

export { LinkPreviewError };

export const HTML_MAX_BYTES = 512 * 1024;
export const POSITIVE_TTL_MS = 24 * 60 * 60 * 1000;
export const NEGATIVE_TTL_MS = 60 * 60 * 1000;
export const IMAGE_ROUTE_PREFIX = "/api/link-preview/image/";
export const MAX_CACHED_PREVIEWS = 1000;
export const MAX_CACHED_IMAGES = 300;
export const MAX_CACHED_IMAGE_BYTES = 48 * 1024 * 1024;
export const MAX_PARALLEL_FETCHES = 8;
const MAX_IMAGE_CANDIDATES = 2;
const IMAGE_ID_PATTERN = /^[a-f0-9]{32}$/;

const PAGE_ACCEPT = "text/html;q=1, application/xhtml+xml;q=0.5, */*;q=0.1";
const IMAGE_ACCEPT = "image/png, image/jpeg, image/webp, image/gif, */*;q=0.1";

/**
 * TEST HOOK, not a feature. A real-browser test needs a link preview of a page
 * served from 127.0.0.1, which is blocked on purpose. Setting
 * LINK_PREVIEW_ALLOW_PRIVATE_FOR_TESTS=1 lifts the address and port checks, but
 * ONLY when APP_ENV is set to something other than "production". The server
 * treats a missing APP_ENV as production (server/index.js), so a deployment
 * that forgot the variable, or has it by mistake, stays protected. See
 * test/lib/linkPreviewService.test.js for the proof.
 */
export function allowPrivateForTests(env = process.env) {
  const flag = String(env?.LINK_PREVIEW_ALLOW_PRIVATE_FOR_TESTS ?? "").trim();
  if (flag !== "1") return false;
  const appEnv = String(env?.APP_ENV ?? "production").trim().toLowerCase();
  return appEnv !== "" && appEnv !== "production";
}

/**
 * @param {object} [options]
 * @param {Function} [options.fetcher]      replaces the guarded fetcher (tests)
 * @param {Function} [options.resolve]      DNS lookup for the guarded fetcher (tests)
 * @param {Function} [options.transport]    HTTP transport for the guarded fetcher (tests)
 * @param {boolean}  [options.allowPrivate] TEST HOOK, see allowPrivateForTests
 * @param {() => number} [options.now]
 */
export function createLinkPreviewService({
  fetcher = null,
  resolve,
  transport,
  allowPrivate = false,
  now = () => Date.now(),
} = {}) {
  const fetchGuarded = fetcher || createGuardedFetcher({ resolve, transport, allowPrivate });
  const previews = createTtlCache({ maxEntries: MAX_CACHED_PREVIEWS, now });
  const images = createTtlCache({
    maxEntries: MAX_CACHED_IMAGES,
    maxBytes: MAX_CACHED_IMAGE_BYTES,
    sizeOf: (image) => image.bytes.length,
    now,
  });
  const inflight = new Map(); // key -> Promise
  let active = 0;

  async function fetchImage(candidate) {
    const response = await fetchGuarded(candidate, {
      maxBytes: PREVIEW_IMAGE_MAX_BYTES,
      accept: IMAGE_ACCEPT,
      mustFit: true,
    });
    const info = readPreviewImage(response.body);
    if (!info) return null;
    const id = crypto.createHash("sha256").update(response.body).digest("hex").slice(0, 32);
    images.set(id, { bytes: response.body, mime: info.mime }, POSITIVE_TTL_MS);
    return { id, width: info.width, height: info.height };
  }

  async function build(url) {
    const page = await fetchGuarded(url.href, {
      maxBytes: HTML_MAX_BYTES,
      accept: PAGE_ACCEPT,
      contentTypes: ["text/html"],
    });
    const html = decodeHtml(page.body, page.headers?.["content-type"]);
    const fields = parsePreviewFields(html, page.url.href);
    if (!fields.title && !fields.description) {
      throw new LinkPreviewError("no_preview", "The page has no title or description.");
    }

    let image = null;
    for (const candidate of fields.imageCandidates.slice(0, MAX_IMAGE_CANDIDATES)) {
      try {
        image = await fetchImage(candidate);
      } catch {
        image = null; // a picture that cannot be fetched is not a reason to lose the text
      }
      if (image) break;
    }

    return {
      preview: {
        url: url.href,
        title: fields.title,
        description: fields.description,
        siteName: fields.siteName,
        image: image
          ? { url: `${IMAGE_ROUTE_PREFIX}${image.id}`, width: image.width, height: image.height }
          : null,
      },
      imageId: image ? image.id : null,
    };
  }

  async function load(url, key) {
    active += 1;
    try {
      const built = await build(url);
      previews.set(key, { ok: true, ...built }, POSITIVE_TTL_MS);
      return built.preview;
    } catch (error) {
      const failure = error instanceof LinkPreviewError ? error : new LinkPreviewError("network");
      previews.set(key, { ok: false, code: failure.code }, NEGATIVE_TTL_MS);
      throw failure;
    } finally {
      active -= 1;
    }
  }

  return {
    /**
     * @param {string} rawUrl
     * @param {object} [options]
     * @param {() => boolean} [options.admit]  asked only when a site would really be contacted;
     *                                         false -> LinkPreviewError "rate_limited"
     * @returns {Promise<{ url, title, description, siteName, image: {url, width, height} | null }>}
     * @throws LinkPreviewError  "invalid_url" for a link that is not allowed, any other code
     *                           when no preview can be made
     */
    async getPreview(rawUrl, { admit = null } = {}) {
      const url = checkLinkUrl(rawUrl, { allowPrivate });
      const key = url.href;

      const cached = previews.get(key);
      if (cached) {
        if (!cached.ok) throw new LinkPreviewError(cached.code);
        // The picture may have been pushed out of its own (smaller) cache.
        if (!cached.imageId || images.has(cached.imageId)) return cached.preview;
      }

      const running = inflight.get(key);
      if (running) return running;

      if (active >= MAX_PARALLEL_FETCHES) throw new LinkPreviewError("busy", "Too many previews are loading.");
      if (typeof admit === "function" && !admit()) throw new LinkPreviewError("rate_limited");

      const promise = load(url, key).finally(() => inflight.delete(key));
      inflight.set(key, promise);
      return promise;
    },

    /** { bytes, mime } of a cached picture, or null. */
    getImage(id) {
      if (typeof id !== "string" || !IMAGE_ID_PATTERN.test(id)) return null;
      return images.get(id) ?? null;
    },

    clear() {
      previews.clear();
      images.clear();
    },

    stats() {
      return { previews: previews.size, images: images.size, imageBytes: images.bytes, active };
    },
  };
}
