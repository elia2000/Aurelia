import { useEffect, useSyncExternalStore } from "react";
import { savedGifs } from "./savedGifsStore.js";

/** The current state of a saved-GIFs store (the app's own unless another is given). */
export function useSavedGifsState(store = savedGifs) {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

/**
 * Ties the saved-GIFs store to the signed-in person. When another person signs
 * in, or nobody does any more, the store forgets the previous person's GIFs.
 */
export function useSavedGifsOwner(ownerKey, store = savedGifs) {
  useEffect(() => {
    store.bindOwner(ownerKey);
    return () => store.reset();
  }, [ownerKey, store]);
}
