// Keeps the plaintext of video messages THIS device sent (or already played)
// as blob URLs, so replaying or scrolling back never re-downloads and
// re-decrypts the file. Memory is bounded: the oldest entries are revoked.

const MAX_ENTRIES = 6;
const entries = new Map(); // key -> { url, posterUrl, durationMs, mime }

export function rememberVideoNote(key, entry) {
  if (!key || !entry?.url) return;
  const existing = entries.get(key);
  if (existing && existing.url !== entry.url) revoke(existing);
  entries.delete(key);
  entries.set(key, entry);
  while (entries.size > MAX_ENTRIES) {
    const [oldKey, oldEntry] = entries.entries().next().value;
    entries.delete(oldKey);
    revoke(oldEntry);
  }
}

export function getRememberedVideoNote(key) {
  if (!key) return null;
  const entry = entries.get(key);
  if (!entry) return null;
  // Refresh recency.
  entries.delete(key);
  entries.set(key, entry);
  return entry;
}

export function clearRememberedVideoNotes() {
  entries.forEach(revoke);
  entries.clear();
}

function revoke(entry) {
  try {
    if (entry.url) URL.revokeObjectURL(entry.url);
    if (entry.posterUrl) URL.revokeObjectURL(entry.posterUrl);
  } catch (_) {}
}
