import { createElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import SelectionCheckbox from "../../components/chat/selection/SelectionCheckbox.jsx";
import { getMessageKey, orderedSelection } from "../../utils/batchSelection.js";
import {
  SELECTION_LIMIT_HINT,
  buildCopyText,
  canForwardMessage,
  describeSkipped,
  isMessageSelectable,
} from "../../utils/batchMessages.js";
import { batchSelectionStore, useBatchSelectionSnapshot } from "../../utils/batchSelectionStore.js";
import { copyTextToClipboard } from "../../utils/clipboard.js";
import { hasActiveTextSelection } from "../../utils/messageSelection.js";
import { showToast } from "../../utils/toast.js";

const NO_KEYS = [];

const isTypingTarget = (target) =>
  target instanceof Element &&
  Boolean(target.closest("input, textarea, select, [contenteditable='true']"));

/**
 * Selection mode of the open chat (several messages ticked to forward, delete
 * or copy together), for the chat window.
 *
 * Reads the shared selection (utils/batchSelectionStore.js) and gives the
 * window what it draws and does with it:
 * - what each row needs (`isSelected`, `tabStopKey`, `toggle`, `getLeadingSlot`);
 * - the actions of the selection bar (`copy`, `forward`, `remove`), which hand
 *   the ticked messages, oldest first, to `onForward` / `onDelete`;
 * - the keys: Escape ends selection mode, Delete deletes, Ctrl/Cmd+C copies
 *   (unless text is selected), Up/Down move between rows.
 * It also ends selection mode when another chat is opened, forgets messages
 * that were deleted, and moves focus in and out.
 */
export function useBatchSelection({
  chatId,
  messages,
  loadingMessages = false,
  scrollRef = null,
  // True on a screen with a mouse: a tick appears while a row is hovered.
  hoverable = false,
  channelName = "",
  offline = false,
  onForward = null,
  onDelete = null,
  store = batchSelectionStore,
}) {
  const snapshot = useBatchSelectionSnapshot(store);
  const activeChatId = chatId || null;
  const active = snapshot.active && snapshot.chatId === activeChatId;
  const selectedKeys = active ? snapshot.keys : NO_KEYS;
  const anchorKey = active ? snapshot.anchor : null;
  const selectedSet = useMemo(() => new Set(selectedKeys), [selectedKeys]);

  const { allKeys, orderedKeys, byKey } = useMemo(() => {
    const all = [];
    const ordered = [];
    const map = new Map();
    (Array.isArray(messages) ? messages : []).forEach((msg) => {
      const key = getMessageKey(msg);
      if (!key) return;
      all.push(key);
      map.set(key, msg);
      if (isMessageSelectable(msg)) ordered.push(key);
    });
    return { allKeys: all, orderedKeys: ordered, byKey: map };
  }, [messages]);

  // The ticked messages in chat order.
  const selectedMessages = useMemo(
    () =>
      orderedSelection({ keys: selectedKeys }, orderedKeys)
        .map((key) => byKey.get(key))
        .filter(Boolean),
    [selectedKeys, orderedKeys, byKey],
  );

  // The handlers below read the latest values from here, so their identity
  // stays the same (the rows are memoised and compare them).
  const latest = useRef({});
  useLayoutEffect(() => {
    latest.current = {
      orderedKeys,
      selectedMessages,
      channelName,
      offline,
      onForward,
      onDelete,
    };
  });

  // ---- lifetime ------------------------------------------------------------
  useEffect(() => {
    store.bindChat(activeChatId);
  }, [store, activeChatId]);

  useEffect(() => () => store.exit(), [store]);

  // A message that was deleted (here or elsewhere) leaves the selection.
  useEffect(() => {
    if (!active || loadingMessages) return;
    store.prune(new Set(allKeys));
  }, [store, active, loadingMessages, allKeys]);

  // ---- actions -------------------------------------------------------------
  const exit = useCallback(() => store.exit(), [store]);

  const enterByKey = useCallback(
    (key) => {
      if (!activeChatId || !key) return;
      store.enter(activeChatId, key);
    },
    [store, activeChatId],
  );

  const toggle = useCallback(
    (msg, { shiftKey = false } = {}) => {
      const key = getMessageKey(msg);
      if (!key) return;
      const result = shiftKey
        ? store.extendTo(latest.current.orderedKeys || [], key)
        : store.toggle(key);
      if (result.limited) showToast(SELECTION_LIMIT_HINT, { tone: "error" });
    },
    [store],
  );

  const copy = useCallback(async () => {
    const { selectedMessages: list, channelName: channel } = latest.current;
    const { text, skipped } = buildCopyText(list || [], { channelName: channel });
    if (!text) {
      showToast("Nothing to copy: the selected messages have no text.", { tone: "error" });
      return false;
    }
    const copied = await copyTextToClipboard(text);
    if (!copied) {
      showToast("Couldn't copy to the clipboard.", { tone: "error" });
      return false;
    }
    if (skipped) showToast(describeSkipped({ action: "copy", count: skipped }), { tone: "info" });
    store.exit();
    return true;
  }, [store]);

  const forward = useCallback(() => {
    const { selectedMessages: list, offline: isOffline, onForward: handler } = latest.current;
    if (!list?.length) return;
    if (isOffline) {
      showToast("You're offline. Forward the messages when you're back online.", { tone: "error" });
      return;
    }
    const eligible = list.filter(canForwardMessage);
    const skipped = list.length - eligible.length;
    if (!eligible.length) {
      showToast(describeSkipped({ action: "forward", count: skipped }), { tone: "error" });
      return;
    }
    if (skipped) showToast(describeSkipped({ action: "forward", count: skipped }), { tone: "info" });
    handler?.(eligible);
  }, []);

  const remove = useCallback(() => {
    const { selectedMessages: list, offline: isOffline, onDelete: handler } = latest.current;
    if (!list?.length) return;
    if (isOffline) {
      showToast("You're offline. Delete the messages when you're back online.", { tone: "error" });
      return;
    }
    handler?.(list);
  }, []);

  // ---- keys ----------------------------------------------------------------
  useEffect(() => {
    if (!active) return undefined;
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        // A dialog (the forward chooser, the delete question) closes first.
        if (document.querySelector('[role="dialog"]')) return;
        // Not also the page's own Escape, which closes the open chat.
        event.preventDefault();
        event.stopPropagation();
        store.exit();
        return;
      }
      if (event.defaultPrevented || isTypingTarget(event.target)) return;
      if (document.querySelector('[role="dialog"]')) return;
      const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
      if (event.key === "Delete" && plain) {
        event.preventDefault();
        remove();
        return;
      }
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "c" &&
        !hasActiveTextSelection()
      ) {
        event.preventDefault();
        void copy();
        return;
      }
      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && plain) {
        const row =
          event.target instanceof Element
            ? event.target.closest("[data-message-key][role='checkbox']")
            : null;
        const root = scrollRef?.current;
        if (!row || !root) return;
        const rows = Array.from(root.querySelectorAll("[data-message-key][role='checkbox']"));
        const next = rows[rows.indexOf(row) + (event.key === "ArrowDown" ? 1 : -1)];
        if (!next) return;
        event.preventDefault();
        next.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [active, store, scrollRef, remove, copy]);

  // ---- focus ---------------------------------------------------------------
  const wasActive = useRef(false);
  const returnFocusRef = useRef(null);
  const lastAnchorRef = useRef(null);
  useEffect(() => {
    if (anchorKey) lastAnchorRef.current = anchorKey;
  }, [anchorKey]);
  useEffect(() => {
    if (active === wasActive.current) return undefined;
    wasActive.current = active;
    const focusRow = (key) => {
      const root = scrollRef?.current;
      if (!root || !key) return;
      const row = Array.from(root.querySelectorAll("[data-message-key]")).find(
        (node) => node.getAttribute("data-message-key") === key,
      );
      row?.focus({ preventScroll: true });
    };
    const focusIsLost = () => {
      const focused = document.activeElement;
      return (
        !focused ||
        focused === document.body ||
        Boolean(focused.closest("[data-selection-bar], [data-selection-enter]"))
      );
    };
    if (active) {
      window.getSelection?.()?.removeAllRanges();
      const focused = document.activeElement;
      returnFocusRef.current =
        focused instanceof HTMLElement && focused !== document.body ? focused : null;
      // The tick button that was clicked is replaced; keep the focus in the list.
      const frame = window.requestAnimationFrame(() => {
        if (focusIsLost()) focusRow(lastAnchorRef.current);
      });
      return () => window.cancelAnimationFrame(frame);
    }
    const frame = window.requestAnimationFrame(() => {
      if (!focusIsLost()) return;
      const previous = returnFocusRef.current;
      returnFocusRef.current = null;
      if (previous?.isConnected && !isTypingTarget(previous)) {
        previous.focus({ preventScroll: true });
        return;
      }
      focusRow(lastAnchorRef.current);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active, scrollRef]);

  // ---- what the rows get ---------------------------------------------------
  const isSelected = useCallback((key) => selectedSet.has(key), [selectedSet]);

  // The tick of each row (MessageItem's leadingSlot): the same element for the
  // same row and state, so rows that did not change are not drawn again.
  const slotCache = useRef({ scope: "", elements: new Map() });
  const getLeadingSlot = useCallback(
    (msg) => {
      if (!active && !hoverable) return null;
      if (!isMessageSelectable(msg)) return null;
      const key = getMessageKey(msg);
      const selected = active && selectedSet.has(key);
      const scope = `${activeChatId}|${active ? 1 : 0}|${hoverable ? 1 : 0}`;
      if (slotCache.current.scope !== scope) slotCache.current = { scope, elements: new Map() };
      const cacheKey = `${key}|${selected ? 1 : 0}`;
      let element = slotCache.current.elements.get(cacheKey);
      if (!element) {
        element = createElement(SelectionCheckbox, {
          messageKey: key,
          active,
          selected,
          onEnter: enterByKey,
        });
        slotCache.current.elements.set(cacheKey, element);
      }
      return element;
    },
    [active, hoverable, selectedSet, activeChatId, enterByKey],
  );

  // Only one row is in the tab order: the one last ticked (else the first ticked).
  const tabStopKey = active ? (anchorKey && selectedSet.has(anchorKey) ? anchorKey : selectedKeys[0]) : null;

  const forwardableCount = useMemo(
    () => selectedMessages.filter(canForwardMessage).length,
    [selectedMessages],
  );

  return {
    active,
    count: selectedMessages.length,
    forwardableCount,
    isSelected,
    tabStopKey,
    getLeadingSlot,
    toggle,
    exit,
    copy,
    forward,
    remove,
  };
}
