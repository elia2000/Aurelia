import { useSyncExternalStore } from "react";

/**
 * A tiny external store for values that change many times a second (the finger
 * position while sliding, a recording level). Components that read it with
 * useStore re-render on their own; the composer around them does not.
 */
export function createStore(initial) {
  let value = initial;
  const listeners = new Set();
  return {
    get: () => value,
    set(patch) {
      const next = typeof patch === "function" ? patch(value) : { ...value, ...patch };
      if (Object.keys(next).every((key) => Object.is(next[key], value[key]))) return;
      value = next;
      listeners.forEach((listener) => listener());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function useStore(store) {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
