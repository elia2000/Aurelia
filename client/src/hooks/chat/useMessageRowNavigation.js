import { useEffect, useMemo, useState } from "react";
import { getMessageKey } from "../../utils/batchSelection.js";

/**
 * Keyboard access to the message rows of the open chat (what the message menu,
 * the reactions, Select and the pins hang on): the list is ONE tab stop, which
 * is the newest message until another row is reached, and the arrow keys, Home
 * and End move between rows ("roving tabindex"). Enter the list with Tab,
 * press the Menu key or Shift+F10 on a row for its menu.
 *
 * Returns `tabStopKey`, the key (see getMessageKey) of the row that should be
 * tabbable. In selection mode (`enabled` false) the rows have their own keys
 * (useBatchSelection), so this does nothing.
 */
export function useMessageRowNavigation({ chatId, scrollRef, messages, enabled = true }) {
  // The row that was reached last belongs to the chat it was reached in.
  const [reached, setReached] = useState({ chatId: null, key: null });

  const newestKey = useMemo(() => {
    for (let i = (messages?.length || 0) - 1; i >= 0; i -= 1) {
      if (!messages[i]?._systemEvent) return getMessageKey(messages[i]) || null;
    }
    return null;
  }, [messages]);

  const reachedKey = useMemo(() => {
    if (reached.chatId !== chatId || !reached.key) return null;
    return (messages || []).some((msg) => !msg?._systemEvent && getMessageKey(msg) === reached.key)
      ? reached.key
      : null;
  }, [reached, chatId, messages]);

  useEffect(() => {
    if (!enabled) return undefined;

    // Only focus that came from the keyboard moves the tab stop: a click or a
    // tap on a message also focuses its row, and must not redraw the chat.
    const onFocusIn = (event) => {
      const root = scrollRef?.current;
      const target = event.target;
      if (!root || !(target instanceof Element) || !root.contains(target)) return;
      const row = target.closest("[data-message-row]");
      const key = row?.getAttribute("data-message-key");
      if (!row || !key) return;
      let viaKeyboard = true;
      try {
        viaKeyboard = target.matches(":focus-visible");
      } catch {
        // an old browser: treat it as keyboard focus
      }
      if (viaKeyboard) setReached((prev) => (prev.chatId === chatId && prev.key === key ? prev : { chatId, key }));
    };

    const onKeyDown = (event) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      const root = scrollRef?.current;
      const row = event.target;
      // Only a key typed on the row itself: a link or a button inside it keeps its keys.
      if (!root || !(row instanceof HTMLElement) || !row.hasAttribute("data-message-row")) return;
      if (!root.contains(row) || row.getAttribute("role") === "checkbox") return;
      const rows = Array.from(root.querySelectorAll("[data-message-row]"));
      const index = rows.indexOf(row);
      if (index < 0) return;
      let next = null;
      if (event.key === "ArrowDown") next = rows[index + 1];
      else if (event.key === "ArrowUp") next = rows[index - 1];
      else if (event.key === "Home") next = rows[0];
      else if (event.key === "End") next = rows[rows.length - 1];
      else return;
      if (!next || next === row) return;
      event.preventDefault();
      next.focus();
    };

    window.addEventListener("focusin", onFocusIn);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("focusin", onFocusIn);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [enabled, chatId, scrollRef]);

  return { tabStopKey: enabled ? reachedKey || newestKey : null };
}
