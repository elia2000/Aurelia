// Which messages are ticked while a person selects several of them (to
// forward, delete or copy them together).
//
// Everything here is pure. A selection is `{ keys, anchor }`: the keys of the
// ticked messages and the key a shift click measures its range from. The
// functions never change a selection in place, and return the same object
// when nothing changed so callers can compare by reference.

// What the server takes in one forward or delete request.
export const MAX_BATCH_MESSAGES = 100;

export const emptySelection = () => ({ keys: [], anchor: null });

/**
 * The key a message is known by in the chat window: the one its timeline row
 * uses, which does not change when a message that was still being sent is
 * confirmed by the server.
 */
export const getMessageKey = (msg) =>
  String(msg?._clientId ?? msg?._serverId ?? msg?.id ?? "");

export const selectOnlyKey = (key) =>
  key ? { keys: [key], anchor: key } : emptySelection();

/**
 * Ticks the key, or unticks it. Ticking is refused at `limit`, which is
 * reported as `limited` so the caller can say why nothing happened.
 */
export function toggleKey(state, key, { limit = MAX_BATCH_MESSAGES } = {}) {
  if (!key) return { state, limited: false };
  if (state.keys.includes(key)) {
    return {
      state: { keys: state.keys.filter((item) => item !== key), anchor: key },
      limited: false,
    };
  }
  if (state.keys.length >= limit) return { state, limited: true };
  return { state: { keys: [...state.keys, key], anchor: key }, limited: false };
}

/**
 * Shift click: ticks every message from the anchor to `targetKey` (both
 * included), keeping what was ticked before. `orderedKeys` are the keys that
 * can be ticked, in chat order. A range that does not fit under `limit` is cut
 * off at the limit, starting from the anchor, and reported as `limited`.
 */
export function extendToKey(state, orderedKeys, targetKey, { limit = MAX_BATCH_MESSAGES } = {}) {
  const targetIndex = orderedKeys.indexOf(targetKey);
  if (targetIndex < 0) return { state, limited: false };
  const anchorIndex = state.anchor ? orderedKeys.indexOf(state.anchor) : -1;
  if (anchorIndex < 0) {
    // Nothing to measure from: the target alone, which becomes the anchor.
    if (state.keys.includes(targetKey)) {
      return { state: { keys: state.keys, anchor: targetKey }, limited: false };
    }
    if (state.keys.length >= limit) return { state, limited: true };
    return { state: { keys: [...state.keys, targetKey], anchor: targetKey }, limited: false };
  }

  const step = targetIndex >= anchorIndex ? 1 : -1;
  const next = [...state.keys];
  const present = new Set(next);
  let limited = false;
  for (let i = anchorIndex; i !== targetIndex + step; i += step) {
    const key = orderedKeys[i];
    if (present.has(key)) continue;
    if (next.length >= limit) {
      limited = true;
      break;
    }
    next.push(key);
    present.add(key);
  }
  if (next.length === state.keys.length) return { state, limited };
  return { state: { keys: next, anchor: state.anchor }, limited };
}

/**
 * Forgets the keys that are not in `validKeys` (messages that were deleted).
 * The anchor moves to a key that is still ticked.
 */
export function pruneKeys(state, validKeys) {
  const keys = state.keys.filter((key) => validKeys.has(key));
  if (keys.length === state.keys.length) return state;
  if (!keys.length) return emptySelection();
  return {
    keys,
    anchor: state.anchor && keys.includes(state.anchor) ? state.anchor : keys[keys.length - 1],
  };
}

/** The ticked keys in chat order (oldest first), whatever order they were ticked in. */
export function orderedSelection(state, orderedKeys) {
  const wanted = new Set(state.keys);
  return orderedKeys.filter((key) => wanted.has(key));
}
