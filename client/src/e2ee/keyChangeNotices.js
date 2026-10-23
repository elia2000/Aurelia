// The "Alice added a new device" lines of a direct chat.
//
// They are made on this device from what the trust tracker saw (trust.js), kept
// in this browser per signed-in person and per contact, and shown in the
// conversation like the other service lines. Nothing about them reaches the
// server, and they are not messages: they have no id the server knows, they
// are never counted as unread and never sent anywhere.
//
//   open      the change still needs the person: verify, or accept the device
//   resolved  they did (or the change went away); the line stays as a quiet note
//
// A line is kept once per change: the tracker reports an unacknowledged device
// on every lookup, and this module folds those reports into one line.

import { TRUST } from "./trust.js";
import { defaultStorage } from "../utils/safeStorage.js";
import { formatDayLabel, formatTime, parseServerDate } from "../utils/chatFormat.js";

export const NOTICE_KIND = Object.freeze({ ADDED: "added", REMOVED: "removed", MISMATCH: "mismatch" });
export const NOTICE_STATE = Object.freeze({ OPEN: "open", RESOLVED: "resolved" });
export const NOTICE_RESOLUTION = Object.freeze({ VERIFIED: "verified", ACCEPTED: "accepted", GONE: "gone", CLEARED: "cleared" });

const KINDS = new Set(Object.values(NOTICE_KIND));
const STATES = new Set(Object.values(NOTICE_STATE));
const RESOLUTIONS = new Set(Object.values(NOTICE_RESOLUTION));

export const STORAGE_PREFIX = "aurelle-key-notices:";
export const MAX_NOTICES_PER_CONTACT = 30;
const MAX_DEVICE_IDS = 20;
const MAX_ID_LENGTH = 64;
const EMPTY = Object.freeze([]);

/** The type of the pseudo message the timeline draws (`msg._systemEvent.type`). */
export const KEY_CHANGE_EVENT = "key_change";

const sortedUnique = (ids) => [...new Set(ids.map(String))].sort();
const sameIds = (a, b) => a.length === b.length && a.every((id, i) => id === b[i]);

const defaultId = () =>
  (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`).slice(0, 36);

/**
 * "danger" (red) when the person had verified this contact, or the keys of a
 * device changed unexpectedly; "warning" (amber) for a contact never verified.
 */
export const severityOf = (notice) =>
  notice.kind === NOTICE_KIND.MISMATCH || notice.verified ? "danger" : "warning";

/**
 * Whether the person may remove the line. An open warning about a device that
 * is blocked (or keys that conflict) stays until it is dealt with; a removed
 * device is only news.
 */
export const isDismissible = (notice) =>
  notice.state === NOTICE_STATE.RESOLVED || notice.kind === NOTICE_KIND.REMOVED;

function resolveWhere(list, predicate, resolution, at) {
  let changed = false;
  const next = list.map((notice) => {
    if (notice.state !== NOTICE_STATE.OPEN || !predicate(notice)) return notice;
    changed = true;
    const how = typeof resolution === "function" ? resolution(notice) : resolution;
    return { ...notice, state: NOTICE_STATE.RESOLVED, resolution: how, resolvedAt: at };
  });
  return changed ? next : list;
}

function trim(list) {
  if (list.length <= MAX_NOTICES_PER_CONTACT) return list;
  // Oldest first; lines that are done go before lines that still need the person.
  const drop = list.length - MAX_NOTICES_PER_CONTACT;
  const order = list
    .map((notice, index) => ({ notice, index }))
    .sort((a, b) => (a.notice.state === b.notice.state ? a.index - b.index : a.notice.state === NOTICE_STATE.RESOLVED ? -1 : 1));
  const gone = new Set(order.slice(0, drop).map((entry) => entry.index));
  return list.filter((_, index) => !gone.has(index));
}

/**
 * Folds one thing the trust tracker said into the lines of a contact.
 * Pure: returns `list` itself when nothing changes.
 *
 * @param {Array} list    the contact's lines, oldest first
 * @param {object} event  a trust event (see trust.js)
 * @param {{now: number, newId: () => string}} context
 */
export function applyTrustEvent(list, event, { now, newId = defaultId }) {
  if (!event || typeof event !== "object" || !event.userId) return list;
  let next = list;

  if (event.type === "acknowledged") {
    return resolveWhere(next, (n) => n.kind === NOTICE_KIND.ADDED, NOTICE_RESOLUTION.ACCEPTED, now);
  }
  if (event.type === "verified") {
    if (!event.verified) return next;
    return resolveWhere(
      next,
      (n) => n.kind === NOTICE_KIND.ADDED || n.kind === NOTICE_KIND.REMOVED,
      NOTICE_RESOLUTION.VERIFIED,
      now,
    );
  }
  if (event.type !== "assessed") return list;

  const added = sortedUnique(event.added || []);
  const mismatched = sortedUnique(event.mismatched || []);
  const removed = sortedUnique(event.removed || []);
  const verified = Boolean(event.verified);
  const make = (kind, deviceIds, extra = {}) => ({
    id: newId(),
    kind,
    userId: String(event.userId),
    at: now,
    deviceIds: deviceIds.slice(0, MAX_DEVICE_IDS),
    count: deviceIds.length,
    verified,
    state: NOTICE_STATE.OPEN,
    resolution: null,
    ...extra,
  });

  if (event.status === TRUST.KEY_MISMATCH) {
    const open = next.find((n) => n.kind === NOTICE_KIND.MISMATCH && n.state === NOTICE_STATE.OPEN && sameIds(n.deviceIds, mismatched.slice(0, MAX_DEVICE_IDS)));
    if (open) return next;
    // The same conflict after it had cleared is a new incident.
    next = next.filter((n) => !(n.kind === NOTICE_KIND.MISMATCH && sameIds(n.deviceIds, mismatched.slice(0, MAX_DEVICE_IDS))));
    return trim([...next, make(NOTICE_KIND.MISMATCH, mismatched)]);
  }

  // The keys are consistent again: a conflict that was open is over.
  next = resolveWhere(next, (n) => n.kind === NOTICE_KIND.MISMATCH, NOTICE_RESOLUTION.CLEARED, now);

  // Devices that were reported and are not pending any more were accepted (somewhere else, or
  // a moment ago) or went away.
  const listed = (event.listed || []).map(String);
  next = resolveWhere(
    next,
    (n) => n.kind === NOTICE_KIND.ADDED && !n.deviceIds.some((id) => added.includes(id)),
    (n) => (n.deviceIds.every((id) => listed.includes(id)) ? NOTICE_RESOLUTION.ACCEPTED : NOTICE_RESOLUTION.GONE),
    now,
  );

  if (removed.length) {
    const key = removed.slice(0, MAX_DEVICE_IDS);
    if (!next.some((n) => n.kind === NOTICE_KIND.REMOVED && sameIds(n.deviceIds, key))) {
      next = trim([...next, make(NOTICE_KIND.REMOVED, removed)]);
    }
  }

  // A person's very first device is not a change: there was nothing to compare with.
  if (event.status === TRUST.DEVICES_ADDED && added.length && Number(event.known) > 0) {
    const key = added.slice(0, MAX_DEVICE_IDS);
    const seen = next.find((n) => n.kind === NOTICE_KIND.ADDED && sameIds(n.deviceIds, key));
    if (!seen) {
      const earlier = next.filter((n) => n.kind === NOTICE_KIND.ADDED && n.state === NOTICE_STATE.OPEN);
      // One open line per contact: a newer, larger set replaces the older line.
      next = trim([
        ...next.filter((n) => !earlier.includes(n)),
        make(NOTICE_KIND.ADDED, added, { verified: verified || earlier.some((n) => n.verified) }),
      ]);
    }
  }
  return next;
}

// ── Words ───────────────────────────────────────────────────────────────────

/**
 * What a line says. `{name}` stands for the contact's name, which the screen
 * draws on its own (a name can be in another script than the sentence).
 *
 * @returns {{severity: "danger"|"warning"|"calm", headline: string, detail: string}}
 */
export function describeNotice(notice) {
  const count = Number(notice.count) || notice.deviceIds?.length || 1;
  const devices = count === 1 ? "a new device" : `${count} new devices`;
  if (notice.state === NOTICE_STATE.RESOLVED) {
    const text =
      notice.resolution === NOTICE_RESOLUTION.VERIFIED
        ? "You verified {name}'s new safety number"
        : notice.resolution === NOTICE_RESOLUTION.ACCEPTED
          ? count === 1
            ? "You accepted {name}'s new device"
            : "You accepted {name}'s new devices"
          : notice.resolution === NOTICE_RESOLUTION.CLEARED
            ? "{name}'s security keys match again"
            : count === 1
              ? "{name}'s new device is no longer listed"
              : "{name}'s new devices are no longer listed";
    return { severity: "calm", headline: text, detail: "" };
  }
  if (notice.kind === NOTICE_KIND.MISMATCH) {
    return {
      severity: "danger",
      headline: "{name}'s security keys changed unexpectedly",
      detail: "Calls and video messages with them are blocked. Check the safety number with them in person.",
    };
  }
  if (notice.kind === NOTICE_KIND.REMOVED) {
    return notice.verified
      ? {
          severity: "danger",
          headline: "Safety number changed",
          detail: "{name} removed a device. Compare the new number and verify it again.",
        }
      : { severity: "warning", headline: "{name} removed a device. Verify the safety number", detail: "" };
  }
  return notice.verified
    ? {
        severity: "danger",
        headline: "Safety number changed",
        detail: `{name} added ${devices}. ${count === 1 ? "It is" : "They are"} blocked until you verify the new number.`,
      }
    : { severity: "warning", headline: `{name} added ${devices}. Verify the safety number`, detail: "" };
}

/** The line as plain text, for screen readers and the selection label. */
export function noticePlainText(notice, name) {
  const { headline, detail } = describeNotice(notice);
  return [headline, detail].filter(Boolean).join(". ").replaceAll("{name}", name || "Your contact");
}

// ── Into the conversation ───────────────────────────────────────────────────

const timeOf = (msg) => {
  const raw = msg?.created_at || msg?._createdAt;
  return raw ? parseServerDate(raw).getTime() : Number.NaN;
};

/** The line as a message-shaped object, so the timeline can lay it out like a service line. */
export function noticeToMessage(notice, { chatId, peerName, selfUserId }) {
  const iso = new Date(notice.at).toISOString();
  const text = noticePlainText(notice, peerName);
  return {
    id: `key-notice-${notice.id}`,
    chat_id: chatId,
    created_at: iso,
    body: "",
    username: "",
    messageType: "text",
    // Never a message of the server: not read, not selectable, not forwarded.
    _localOnly: true,
    _readByMe: true,
    _dayKey: formatDayLabel(iso),
    _dayLabel: formatDayLabel(iso),
    _timeLabel: formatTime(iso),
    _systemEvent: {
      type: KEY_CHANGE_EVENT,
      text,
      name: text,
      suffix: "",
      chatId,
      selfUserId,
      peerName: peerName || "",
      notice: {
        id: notice.id,
        kind: notice.kind,
        userId: notice.userId,
        state: notice.state,
        resolution: notice.resolution,
        severity: severityOf(notice),
        verified: Boolean(notice.verified),
        count: notice.count,
        dismissible: isDismissible(notice),
        template: describeNotice(notice),
      },
    },
  };
}

/**
 * The chat's messages with the contact's lines put in at the time they were
 * noticed. A line older than the oldest message loaded so far waits until the
 * older history has been loaded (it would sit at the top out of place).
 *
 * @returns the same array when there is nothing to add
 */
export function mergeKeyNotices(messages, notices, { chatId, peerName, selfUserId, hasOlderMessages = false } = {}) {
  if (!notices?.length || !chatId) return messages;
  const lines = [...notices].sort((a, b) => a.at - b.at);
  let oldest = Number.POSITIVE_INFINITY;
  for (const msg of messages) {
    const t = timeOf(msg);
    if (Number.isFinite(t)) {
      oldest = t;
      break;
    }
  }
  const shown = hasOlderMessages && messages.length ? lines.filter((n) => n.at >= oldest) : lines;
  if (!shown.length) return messages;

  const result = [];
  let index = 0;
  let last = Number.NEGATIVE_INFINITY;
  const flush = (before) => {
    while (index < shown.length && shown[index].at < before) {
      result.push(noticeToMessage(shown[index], { chatId, peerName, selfUserId }));
      index += 1;
    }
  };
  for (const msg of messages) {
    const t = timeOf(msg);
    // A message without a usable time stays behind whatever came before it.
    if (Number.isFinite(t)) last = Math.max(last, t);
    flush(Number.isFinite(t) ? t : last);
    result.push(msg);
  }
  flush(Number.POSITIVE_INFINITY);
  return result;
}

// ── Remembering them on this device ─────────────────────────────────────────

const cleanId = (value) => (typeof value === "string" && value && value.length <= MAX_ID_LENGTH ? value : null);

/** One stored line, or null when it is not one: whatever is in storage is not trusted. */
export function sanitizeNotice(raw, userId) {
  if (!raw || typeof raw !== "object") return null;
  const id = cleanId(raw.id);
  if (!id || !KINDS.has(raw.kind) || !STATES.has(raw.state)) return null;
  const at = Number(raw.at);
  if (!Number.isFinite(at) || at <= 0) return null;
  const deviceIds = sortedUnique(
    Array.isArray(raw.deviceIds) ? raw.deviceIds.map(cleanId).filter(Boolean).slice(0, MAX_DEVICE_IDS) : [],
  );
  const count = Number.isInteger(raw.count) && raw.count > 0 && raw.count < 10_000 ? raw.count : Math.max(1, deviceIds.length);
  return {
    id,
    kind: raw.kind,
    userId: String(userId),
    at,
    deviceIds,
    count,
    verified: raw.verified === true,
    state: raw.state,
    resolution: RESOLUTIONS.has(raw.resolution) ? raw.resolution : null,
    ...(Number.isFinite(Number(raw.resolvedAt)) && Number(raw.resolvedAt) > 0 ? { resolvedAt: Number(raw.resolvedAt) } : {}),
  };
}

/**
 * Lines per signed-in person and contact, in `storage` (localStorage when
 * there is one). Reading is cached: `list` returns the same array until a line
 * changes, so it can be used with useSyncExternalStore.
 */
export function createKeyNoticeStore({ storage = defaultStorage(), now = () => Date.now(), newId = defaultId } = {}) {
  // key -> { raw: what storage held when it was read, list }
  const cache = new Map();
  const listeners = new Set();
  const keyOf = (selfUserId, peerUserId) => `${STORAGE_PREFIX}${selfUserId}:${peerUserId}`;

  const readRaw = (key) => {
    try {
      return storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  };

  const parse = (raw, peerUserId) => {
    try {
      const parsed = JSON.parse(raw || "null");
      if (!Array.isArray(parsed)) return EMPTY;
      const lines = parsed.map((item) => sanitizeNotice(item, peerUserId)).filter(Boolean).slice(-MAX_NOTICES_PER_CONTACT);
      return lines.length ? Object.freeze(lines) : EMPTY;
    } catch {
      return EMPTY;
    }
  };

  const notify = () => listeners.forEach((listener) => listener());

  function list(selfUserId, peerUserId) {
    if (!selfUserId || !peerUserId) return EMPTY;
    const key = keyOf(selfUserId, peerUserId);
    if (!cache.has(key)) {
      const raw = readRaw(key);
      cache.set(key, { raw, list: parse(raw, peerUserId) });
    }
    return cache.get(key).list;
  }

  function update(selfUserId, peerUserId, change) {
    if (!selfUserId || !peerUserId) return;
    const key = keyOf(selfUserId, peerUserId);
    // Another tab may have written since: start from what is stored now.
    const stored = readRaw(key);
    const known = cache.get(key);
    const current = known && known.raw === stored ? known.list : parse(stored, peerUserId);
    const next = change(current);
    if (next === current) {
      // Nothing to add, but another tab may have changed what is stored.
      if (known?.list !== current) {
        cache.set(key, { raw: stored, list: current });
        if (known) notify();
      }
      return;
    }
    const frozen = next.length ? Object.freeze([...next]) : EMPTY;
    let raw = stored;
    try {
      if (frozen.length) {
        raw = JSON.stringify(frozen);
        storage?.setItem(key, raw);
      } else {
        raw = null;
        storage?.removeItem(key);
      }
    } catch {
      // Not remembered after a reload; still shown for now.
    }
    cache.set(key, { raw, list: frozen });
    notify();
  }

  return {
    list,
    /** Folds a trust event of `event.userId` into that contact's lines. */
    handleTrustEvent(selfUserId, event) {
      if (!event?.userId) return;
      update(selfUserId, String(event.userId), (current) => applyTrustEvent(current, event, { now: now(), newId }));
    },
    /** Removes a line the person may dismiss. */
    dismiss(selfUserId, peerUserId, id) {
      update(selfUserId, peerUserId, (current) => {
        const line = current.find((n) => n.id === id);
        if (!line || !isDismissible(line)) return current;
        return current.filter((n) => n !== line);
      });
    },
    /** Another tab wrote to storage. */
    refresh(key) {
      if (typeof key === "string" && key.startsWith(STORAGE_PREFIX)) {
        cache.delete(key);
        notify();
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

let shared = null;
export function getKeyNoticeStore() {
  if (!shared) {
    shared = createKeyNoticeStore();
    if (typeof window !== "undefined") {
      window.addEventListener("storage", (event) => shared.refresh(event.key));
    }
  }
  return shared;
}
export const __setKeyNoticeStoreForTests = (store) => {
  shared = store;
};
