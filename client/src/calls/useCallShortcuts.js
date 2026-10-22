import { useEffect, useRef } from "react";
import { createShortcutHandler } from "./shortcuts.js";
import { getCallShortcutsEnabled } from "./callShortcutPrefs.js";

/**
 * Listens for the call's keyboard shortcuts while `enabled` (the call card is
 * on screen: a minimised call leaves the keys to the chat). It listens first,
 * in the capture phase of the document, so that Escape minimises the call
 * rather than also closing the chat behind it; a window or menu in front of the
 * call (see windowOnTop) and the call's own settings still get Escape first.
 * The single-letter keys follow the per-device switch (callShortcutPrefs.js),
 * and everything but Escape needs the focus on the call card or the bare page.
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
      // Read at the moment of the key press, so a switch applies at once.
      lettersEnabled: getCallShortcutsEnabled,
    });
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [enabled]);
}
