// The messages ticked in the open chat, shared by the things that start and
// read the selection: the message menu ("Select"), the rows, the selection bar
// and the forward/delete flows. Outside React state, so a tick redraws only
// the chat window and not the whole page.
//
// Only one selection exists at a time and it belongs to one chat: it ends
// when another chat (or none) is open, and when its last message is unticked.
import { useSyncExternalStore } from "react";
import {
  MAX_BATCH_MESSAGES,
  extendToKey,
  pruneKeys,
  selectOnlyKey,
  toggleKey,
} from "./batchSelection.js";

const IDLE = Object.freeze({ chatId: null, active: false, keys: [], anchor: null });

export function createBatchSelectionStore() {
  let snapshot = IDLE;
  const listeners = new Set();

  const commit = (next) => {
    if (next === snapshot) return;
    snapshot = next;
    listeners.forEach((listener) => listener());
  };

  // A selection state becomes a snapshot; an empty one is the end of selection mode.
  const fromSelection = (chatId, selection) =>
    selection.keys.length
      ? { chatId, active: true, keys: selection.keys, anchor: selection.anchor }
      : IDLE;

  const current = () => ({ keys: snapshot.keys, anchor: snapshot.anchor });

  return {
    getSnapshot: () => snapshot,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    /** Starts selection mode with `key` ticked (or ticks one more in the same chat). */
    enter(chatId, key) {
      if (!chatId || !key) return;
      if (snapshot.active && snapshot.chatId === chatId) {
        if (snapshot.keys.includes(key)) return;
        const { state } = toggleKey(current(), key);
        commit(fromSelection(chatId, state));
        return;
      }
      commit(fromSelection(chatId, selectOnlyKey(key)));
    },

    /** Ticks or unticks a message. Unticking the last one ends selection mode. */
    toggle(key, { limit = MAX_BATCH_MESSAGES } = {}) {
      if (!snapshot.active) return { limited: false };
      const { state, limited } = toggleKey(current(), key, { limit });
      if (state.keys !== snapshot.keys) commit(fromSelection(snapshot.chatId, state));
      return { limited };
    },

    /** Shift click: ticks the range from the anchor to `key`. */
    extendTo(orderedKeys, key, { limit = MAX_BATCH_MESSAGES } = {}) {
      if (!snapshot.active) return { limited: false };
      const { state, limited } = extendToKey(current(), orderedKeys, key, { limit });
      if (state.keys !== snapshot.keys || state.anchor !== snapshot.anchor) {
        commit(fromSelection(snapshot.chatId, state));
      }
      return { limited };
    },

    exit() {
      commit(IDLE);
    },

    /** The open chat changed (or was left): a selection of another chat ends. */
    bindChat(chatId) {
      if (snapshot.active && snapshot.chatId !== (chatId || null)) commit(IDLE);
    },

    /** Forgets the keys whose messages are gone. */
    prune(validKeys) {
      if (!snapshot.active) return;
      const next = pruneKeys(current(), validKeys);
      if (next.keys === snapshot.keys) return;
      commit(fromSelection(snapshot.chatId, next));
    },
  };
}

export const batchSelectionStore = createBatchSelectionStore();

/** The current selection of `store`, redrawing the component when it changes. */
export function useBatchSelectionSnapshot(store = batchSelectionStore) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
