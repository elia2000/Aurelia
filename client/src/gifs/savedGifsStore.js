import * as gifApi from "../api/gifApi.js";
import { SAVED_GIF_MAX_BYTES } from "../utils/animatedImage.js";
import { showToast } from "../utils/toast.js";

// The person's own saved GIFs: the list, the limit the server reports, the
// notices ("GIF saved", "the oldest GIF was removed") and the calls that change
// them. Nothing in here is persisted, and the state belongs to one account: it
// is dropped on logout and when a different person signs in.
//
// The reducers are pure functions of (state, server answer); the store around
// them only does the network calls and tells the interface when the state
// changed.

const HANDLED_ADDS_LIMIT = 40;
const UPLOAD_TYPES = new Set(["image/gif", "image/webp", "image/png"]);

export const emptyState = (owner = null) => ({
  owner,
  // idle: not asked yet | loading | ready | error
  status: "idle",
  // A request for the list is on its way (also while a ready list is refreshed).
  loading: false,
  gifs: [],
  // The limit comes from the server (GET /api/gifs, saves, events), never from here.
  limit: null,
  count: 0,
  error: "",
  uploading: false,
  // Set while the persistent "your collection is full" notice is up.
  notice: null,
  // Ids of saves already counted, so the answer of a request and the realtime
  // event for the same save (both arrive on the device that saved) notify once.
  handledAdds: [],
  // A change arrived while the list was loading: ask again afterwards.
  dirty: false,
  // The connection dropped and came back: events of that time are gone, so
  // the list is read again the next time it is looked at.
  stale: false,
  seq: 0,
});

const toNumber = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const normalizeGif = (gif) =>
  gif && typeof gif === "object" && gif.id
    ? {
        id: String(gif.id),
        url: gif.url || `/api/gifs/${gif.id}/file`,
        width: toNumber(gif.width),
        height: toNumber(gif.height),
        mime: gif.mime || "image/gif",
        size: toNumber(gif.size) ?? 0,
        createdAt: gif.createdAt || null,
      }
    : null;

const createdAtMs = (gif) => {
  const time = Date.parse(gif?.createdAt || "");
  return Number.isFinite(time) ? time : 0;
};

// Newest first; a GIF that is already there keeps its place.
const insertSorted = (gifs, gif) => {
  if (gifs.some((item) => item.id === gif.id)) {
    return gifs.map((item) => (item.id === gif.id ? gif : item));
  }
  const next = gifs.slice();
  const at = next.findIndex((item) => createdAtMs(item) < createdAtMs(gif));
  if (at === -1) next.push(gif);
  else next.splice(at, 0, gif);
  return next;
};

const limitFrom = (state, limit) => {
  const n = toNumber(limit);
  return n !== null && n > 0 ? Math.trunc(n) : state.limit;
};

/** The whole list, as GET /api/gifs answers it. */
export function reduceList(state, payload) {
  const gifs = (Array.isArray(payload?.gifs) ? payload.gifs : []).map(normalizeGif).filter(Boolean);
  const count = toNumber(payload?.count);
  return {
    ...state,
    status: "ready",
    loading: false,
    gifs,
    limit: limitFrom(state, payload?.limit),
    count: count !== null ? count : gifs.length,
    error: "",
    stale: false,
  };
}

/**
 * A GIF was stored (a save, an upload, or the realtime event for one).
 * `evicted` lists the GIFs the server removed to stay within the limit; when it
 * is not empty the notice is raised, once per saved GIF.
 */
export function reduceAdded(state, payload) {
  const gif = normalizeGif(payload?.gif);
  if (!gif) return state;
  const evictedIds = (Array.isArray(payload?.evicted) ? payload.evicted : [])
    .map((item) => (item && typeof item === "object" ? item.id : item))
    .filter(Boolean)
    .map(String);
  const handled = state.handledAdds.includes(gif.id);
  const limit = limitFrom(state, payload?.limit);

  let gifs = state.gifs;
  if (state.status === "ready") {
    gifs = insertSorted(
      state.gifs.filter((item) => !evictedIds.includes(item.id)),
      gif,
    );
  }
  const count = toNumber(payload?.count);

  let notice = state.notice;
  let seq = state.seq;
  if (!handled && evictedIds.length > 0) {
    seq += 1;
    notice = {
      id: seq,
      removed: (state.notice?.removed || 0) + evictedIds.length,
      limit,
    };
  }

  return {
    ...state,
    gifs,
    limit,
    count: count !== null ? count : state.status === "ready" ? gifs.length : state.count,
    notice,
    seq,
    handledAdds: handled
      ? state.handledAdds
      : [...state.handledAdds, gif.id].slice(-HANDLED_ADDS_LIMIT),
    dirty: state.dirty || state.loading,
  };
}

/** A GIF was removed (DELETE, or the realtime event for it). */
export function reduceRemoved(state, payload) {
  const id = String(payload?.gifId ?? payload?.id ?? "");
  if (!id) return state;
  const gifs = state.status === "ready" ? state.gifs.filter((item) => item.id !== id) : state.gifs;
  const count = toNumber(payload?.count);
  return {
    ...state,
    gifs,
    limit: limitFrom(state, payload?.limit),
    count: count !== null ? count : state.status === "ready" ? gifs.length : state.count,
    dirty: state.dirty || state.loading,
  };
}

/** The text of the persistent notice that follows an automatic removal. */
export function describeEviction(notice) {
  const limit = toNumber(notice?.limit);
  const removed = Math.max(1, Number(notice?.removed) || 1);
  const full =
    limit && limit > 0
      ? `Your GIF collection is full (${limit} ${limit === 1 ? "GIF" : "GIFs"}).`
      : "Your GIF collection is full.";
  const what = removed === 1 ? "The oldest GIF was removed." : `The ${removed} oldest GIFs were removed.`;
  return `${full} ${what}`;
}

const ERROR_TEXT_BY_CODE = {
  gif_unsupported: "Only animated GIFs, WebP and PNG pictures can be saved.",
  gif_not_animated: "This picture is not animated, so it cannot be saved as a GIF.",
  gif_too_large: "This GIF is too large to save (20 MB at most).",
  gif_too_many_frames: "This GIF has too many frames to save.",
  gif_dimensions: "This GIF is too big to save (4096 px at most on a side).",
  gif_missing: "Choose one GIF file.",
  gif_invalid_upload: "That file could not be read.",
};

/** What to tell the person when the server refused a request. */
export function describeGifError(result, fallback) {
  if (result?.data?.code && ERROR_TEXT_BY_CODE[result.data.code]) {
    return ERROR_TEXT_BY_CODE[result.data.code];
  }
  if (result?.status === 429) return "Too many GIF requests. Please slow down.";
  if (result?.status === 503) return "File uploads are disabled on this server.";
  if (result?.status === 404) return "That message or file is no longer available.";
  if (typeof result?.data?.error === "string" && result.data.error.trim()) {
    return result.data.error;
  }
  return fallback;
}

/** Checks a file picked from the device before it is uploaded. Returns an error text or "". */
export function checkGifUpload(file) {
  if (!file) return "Choose one GIF file.";
  const type = String(file.type || "").toLowerCase();
  const name = String(file.name || "").toLowerCase();
  const looksRight = UPLOAD_TYPES.has(type) || /\.(gif|webp|apng|png)$/.test(name);
  if (!looksRight) return "Only animated GIFs, WebP and PNG pictures can be added.";
  if (Number(file.size || 0) > SAVED_GIF_MAX_BYTES) return "This GIF is too large to add (20 MB at most).";
  return "";
}

// `notify(text, tone)` shows a short message ("GIF saved") for a moment; the
// app's own store uses the shared toasts (<ToastHost />).
const notifyWithToast = (text, tone) =>
  showToast(text, { tone: tone === "error" ? "error" : "info" });

export function createSavedGifsStore({ api = gifApi, notify = notifyWithToast } = {}) {
  let state = emptyState();
  let generation = 0;
  let loadPromise = null;
  const listeners = new Set();

  const set = (next) => {
    if (next === state) return;
    state = next;
    listeners.forEach((listener) => listener());
  };
  const update = (fn) => set(fn(state));

  const getState = () => state;
  const subscribe = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  // A different person (or nobody) now uses the app: forget everything.
  const bindOwner = (key) => {
    const owner = key === null || key === undefined || key === "" ? null : String(key);
    if (owner === state.owner) return;
    generation += 1;
    loadPromise = null;
    set(emptyState(owner));
  };
  const reset = () => {
    generation += 1;
    loadPromise = null;
    set(emptyState(null));
  };

  const load = ({ force = false } = {}) => {
    if (!force && state.status === "ready" && !state.stale) return Promise.resolve();
    if (loadPromise) return loadPromise;
    const mine = generation;
    update((s) => ({
      ...s,
      status: s.status === "ready" ? "ready" : "loading",
      loading: true,
      error: "",
      dirty: false,
      stale: false,
    }));
    loadPromise = (async () => {
      try {
        const result = await api.listSavedGifs();
        if (mine !== generation) return;
        if (result.ok) {
          update((s) => reduceList(s, result.data));
        } else {
          update((s) => ({
            ...s,
            status: s.status === "ready" ? "ready" : "error",
            loading: false,
            error: describeGifError(result, "Unable to load your GIFs."),
          }));
        }
      } catch {
        if (mine !== generation) return;
        update((s) => ({
          ...s,
          status: s.status === "ready" ? "ready" : "error",
          loading: false,
          error: "Unable to load your GIFs. Check your connection.",
        }));
      } finally {
        if (mine === generation) {
          loadPromise = null;
          // A save or removal happened while the list was on its way.
          if (state.dirty) void load({ force: true });
        }
      }
    })();
    return loadPromise;
  };

  const applyStored = (result, existingText, newText) => {
    const data = result.data || {};
    update((s) =>
      reduceAdded(s, {
        gif: data.gif,
        evicted: data.evicted,
        limit: data.limit,
        count: data.count,
      }),
    );
    notify(data.existing ? existingText : newText);
  };

  /** Keeps a GIF of a message. `target` is { messageId, fileId } or { messageId, fileIndex }. */
  const saveFromMessage = async (target) => {
    const mine = generation;
    try {
      const result = await api.saveGifFromMessage(target);
      if (mine !== generation) return { ok: false, stale: true };
      if (!result.ok) {
        notify(describeGifError(result, "Unable to save the GIF."), "error");
        return { ok: false, status: result.status };
      }
      applyStored(result, "Already in your GIFs", "GIF saved");
      return { ok: true, existing: Boolean(result.data?.existing), gif: result.data?.gif || null };
    } catch {
      if (mine !== generation) return { ok: false, stale: true };
      notify("Unable to save the GIF. Check your connection.", "error");
      return { ok: false };
    }
  };

  /** Adds a GIF from the device. */
  const uploadFile = async (file) => {
    const problem = checkGifUpload(file);
    if (problem) {
      notify(problem, "error");
      return { ok: false };
    }
    const mine = generation;
    update((s) => ({ ...s, uploading: true }));
    try {
      const result = await api.uploadSavedGif(file);
      if (mine !== generation) return { ok: false, stale: true };
      if (!result.ok) {
        notify(describeGifError(result, "Unable to add the GIF."), "error");
        return { ok: false, status: result.status };
      }
      applyStored(result, "Already in your GIFs", "GIF added");
      return { ok: true, existing: Boolean(result.data?.existing), gif: result.data?.gif || null };
    } catch {
      if (mine !== generation) return { ok: false, stale: true };
      notify("Unable to add the GIF. Check your connection.", "error");
      return { ok: false };
    } finally {
      if (mine === generation) update((s) => ({ ...s, uploading: false }));
    }
  };

  /** Takes a GIF out of the collection. */
  const remove = async (id) => {
    const mine = generation;
    try {
      const result = await api.deleteSavedGif(id);
      if (mine !== generation) return { ok: false, stale: true };
      // "Not found" means it is gone already, which is what was asked for.
      if (result.ok || result.status === 404) {
        update((s) => reduceRemoved(s, { gifId: id, limit: result.data?.limit, count: result.data?.count }));
        return { ok: true };
      }
      notify(describeGifError(result, "Unable to remove the GIF."), "error");
      return { ok: false, status: result.status };
    } catch {
      if (mine !== generation) return { ok: false, stale: true };
      notify("Unable to remove the GIF. Check your connection.", "error");
      return { ok: false };
    }
  };

  /** saved_gif_added / saved_gif_removed from the realtime connection. */
  const handleRealtimeEvent = (payload) => {
    if (!payload || typeof payload !== "object") return;
    if (payload.type === "saved_gif_added") update((s) => reduceAdded(s, payload));
    else if (payload.type === "saved_gif_removed") update((s) => reduceRemoved(s, payload));
  };

  /**
   * The realtime connection came back after a break: whatever was saved or
   * removed on another device meanwhile is not in the list. The list that is
   * shown stays until it has been read again.
   */
  const invalidate = () =>
    update((s) => (s.stale || (s.status !== "ready" && s.status !== "error") ? s : { ...s, stale: true }));

  const dismissNotice = () => update((s) => (s.notice ? { ...s, notice: null } : s));

  return {
    getState,
    subscribe,
    bindOwner,
    reset,
    load,
    saveFromMessage,
    uploadFile,
    remove,
    handleRealtimeEvent,
    invalidate,
    dismissNotice,
  };
}

/** The store the app uses. */
export const savedGifs = createSavedGifsStore();
