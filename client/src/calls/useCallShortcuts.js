import { useEffect, useRef } from "react";
import { createShortcutHandler } from "./shortcuts.js";

/**
 * Listens for the call's keyboard shortcuts while `enabled` (the call card is
 * on screen: a minimised call leaves the keys to the chat). It listens first,
 * in the capture phase of the document, so that Escape minimises the call
 * rather than also closing the chat behind it; a window or menu in front of the
 * call (see windowOnTop) and the call's own settings still get Escape first.
 * @param {{enabled: boolean, actions: Record<string, (event: KeyboardEvent) => boolean | void>, getCard?: () => Element | null}} args
 */
export function useCallShortcuts({ enabled, actions, getCard }) {
  const latest = useRef({ actions, getCard });
  useEffect(() => {
    latest.current = { actions, getCard };
  });
  useEffect(() => {
    if (!enabled) return undefined;
    const onKeyDown = createShortcutHandler({
      getActions: () => latest.current.actions,
      getCard: () => latest.current.getCard?.() ?? null,
    });
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [enabled]);
}
