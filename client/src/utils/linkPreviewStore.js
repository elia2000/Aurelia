// Link previews this tab already asked the server for, so a message that
// scrolls out and back in, or the same link in ten messages, costs one request.
//
//   peekLinkPreview(url)   -> a preview, null (known: nothing to show) or undefined (not asked yet)
//   loadLinkPreview(url)   -> Promise of a preview or null; never rejects, shows nothing on error
//
// At most MAX_PARALLEL requests run at once, the rest wait their turn. When the
// server says previews are off, or that this person is asking too fast, nothing
// is asked for a while.

import { fetchLinkPreview } from "../api/linkPreviewApi.js";

// The server lets one person have two previews loading at once (more are
// answered "busy"), so this asks for no more than that.
export const MAX_PARALLEL = 2;
const MAX_ENTRIES = 300;
const FOUND_TTL_MS = 30 * 60 * 1000;
const MISSING_TTL_MS = 10 * 60 * 1000;
const NETWORK_ERROR_TTL_MS = 60 * 1000;
const DISABLED_PAUSE_MS = 5 * 60 * 1000;
const TOO_FAST_PAUSE_MS = 60 * 1000;
// The only kind of picture address that is ever used: one of our own server's.
const IMAGE_PATH = /^\/api\/link-preview\/image\/[a-f0-9]{32}$/;

const entries = new Map(); // url -> { value, expiresAt }; oldest first
const pending = new Map(); // url -> Promise
const waiting = [];
let running = 0;
let pausedUntil = 0;

const text = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const dimension = (value) => (Number.isFinite(value) && value > 0 && value <= 10000 ? Math.round(value) : null);

/**
 * The server's answer as a card needs it, or null. Only text and one of our own
 * picture addresses get through: a picture address on another site is dropped,
 * so a preview can never make this browser contact the linked site.
 */
export function normalizePreview(data) {
  if (!data || typeof data !== "object") return null;
  const title = text(data.title, 200);
  const description = text(data.description, 400);
  if (!title && !description) return null;
  const rawImage = data.image && typeof data.image === "object" ? data.image : null;
  const image =
    rawImage && typeof rawImage.url === "string" && IMAGE_PATH.test(rawImage.url)
      ? { url: rawImage.url, width: dimension(rawImage.width), height: dimension(rawImage.height) }
      : null;
  return { url: text(data.url, 2048), title, description, siteName: text(data.siteName, 100), image };
}

function remember(url, value, ttlMs) {
  entries.delete(url);
  entries.set(url, { value, expiresAt: Date.now() + ttlMs });
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
}

export function peekLinkPreview(url) {
  const entry = entries.get(url);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    entries.delete(url);
    return undefined;
  }
  return entry.value;
}

async function askServer(url) {
  try {
    const { ok, status, data } = await fetchLinkPreview(url);
    if (ok) {
      const preview = normalizePreview(data);
      remember(url, preview, preview ? FOUND_TTL_MS : MISSING_TTL_MS);
      return preview;
    }
    if (status === 404 && data.code === "link_previews_disabled") {
      pausedUntil = Date.now() + DISABLED_PAUSE_MS;
      return null;
    }
    if (status === 429) {
      pausedUntil = Date.now() + TOO_FAST_PAUSE_MS;
      return null;
    }
    if (status === 401 || status === 403 || status >= 500) return null; // asked again some other time
    remember(url, null, MISSING_TTL_MS); // 400 and 422: this link has no preview
    return null;
  } catch {
    remember(url, null, NETWORK_ERROR_TTL_MS);
    return null;
  }
}

function pump() {
  while (running < MAX_PARALLEL && waiting.length) {
    const job = waiting.shift();
    running += 1;
    askServer(job.url)
      .then(job.resolve)
      .finally(() => {
        running -= 1;
        pump();
      });
  }
}

export function loadLinkPreview(url) {
  const known = peekLinkPreview(url);
  if (known !== undefined) return Promise.resolve(known);
  if (Date.now() < pausedUntil) return Promise.resolve(null);
  const already = pending.get(url);
  if (already) return already;
  const promise = new Promise((resolve) => {
    waiting.push({ url, resolve });
    pump();
  }).finally(() => pending.delete(url));
  pending.set(url, promise);
  return promise;
}

/** Forgets everything (a test, or a different person signing in). */
export function resetLinkPreviewStore() {
  entries.clear();
  pending.clear();
  waiting.length = 0;
  running = 0;
  pausedUntil = 0;
}
