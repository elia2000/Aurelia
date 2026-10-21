import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import QuickReactionBar from "../chat/reactions/QuickReactionBar.jsx";

const SCREEN_GAP = 12;

// A right click outside the open menu closes it and opens the menu of whatever
// is under the cursor, so the user can jump from one message to another
// without a click in between (Telegram does the same).
function reopenAtPoint(x, y) {
  if (typeof window === "undefined") return;
  window.requestAnimationFrame(() => {
    const target = document.elementFromPoint(x, y);
    if (!target) return;
    target.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        view: window,
        button: 2,
        clientX: x,
        clientY: y,
      }),
    );
  });
}

export default function AppContextMenu({ menu, onClose }) {
  const menuRef = useRef(null);
  const [desktopPosition, setDesktopPosition] = useState({ x: 0, y: 0 });
  const [verticalPlacement, setVerticalPlacement] = useState("below");
  // The focused item belongs to the menu it was set for: a menu that opens
  // after another one starts on its first item, not on the item number the
  // last menu ended on (a stale index would focus, and Enter would pick, an
  // item the person never moved to).
  const [focusState, setFocusState] = useState({ menu: null, index: 0 });
  const focusedIndex = menu && focusState.menu === menu ? focusState.index : 0;
  const setFocusedIndex = useCallback(
    (next) =>
      setFocusState((prev) => {
        const base = prev.menu === menu ? prev.index : 0;
        return { menu, index: typeof next === "function" ? next(base) : next };
      }),
    [menu],
  );
  // The reaction bar's "+" opens the emoji picker over the menu.
  const [reactionPickerOpen, setReactionPickerOpen] = useState(false);
  // The finger that opened the menu with a long press can still produce a click
  // when it lifts, and that click lands on the backdrop. Only a press that
  // started on the backdrop (or a keyboard activation) closes the menu.
  const backdropPressedRef = useRef(false);

  useEffect(() => {
    if (!menu) return undefined;
    backdropPressedRef.current = false;
    setReactionPickerOpen(false);
    // When the menu goes away, give focus back to what had it (a message row
    // opened from the keyboard), unless that was a text field (a phone would
    // pop its keyboard up) or the chosen action already moved focus elsewhere.
    const previous = document.activeElement;
    return () => {
      if (!(previous instanceof HTMLElement) || !previous.isConnected) return;
      if (previous === document.body) return;
      if (previous.matches("input, textarea, select, [contenteditable='true']")) return;
      const current = document.activeElement;
      if (current && current !== document.body && !current.closest('[role="menu"]')) {
        return;
      }
      try {
        previous.focus({ preventScroll: true });
      } catch {
        previous.focus();
      }
    };
  }, [menu]);

  // Focus the active menu item whenever focusedIndex changes
  useEffect(() => {
    if (!menu || focusedIndex < 0) return;
    const container = menuRef.current;
    if (!container) return;
    const items = container.querySelectorAll('[role="menuitem"]');
    const target = items[focusedIndex];
    if (target) {
      try {
        target.focus({ preventScroll: true });
      } catch {
        target.focus();
      }
    }
  }, [focusedIndex, menu]);

  // Moves keyboard focus between the menu items and the reaction bar.
  const leaveMenuTo = (target) => {
    const root = menuRef.current?.parentElement;
    const items = menuRef.current?.querySelectorAll('[role="menuitem"]') || [];
    const node =
      target === "bar"
        ? root?.querySelector("[data-reaction-bar] button")
        : target === "last"
          ? items[items.length - 1]
          : items[0];
    node?.focus({ preventScroll: true });
  };

  useEffect(() => {
    if (!menu) return undefined;
    const items = menu.items || [];
    const hasReactionBar = Boolean(menu.reactions);
    const handleKeyDown = (event) => {
      // Keys typed in the reaction bar or its emoji picker are theirs; only
      // Escape still closes the whole menu.
      if (
        event.key !== "Escape" &&
        event.target instanceof Element &&
        event.target.closest("[data-reaction-bar], [data-reaction-picker]")
      ) {
        return;
      }
      if (event.key === "Escape") {
        // Only close the menu: the page also closes the open chat on Escape.
        event.stopPropagation();
        event.preventDefault();
        onClose?.();
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setFocusedIndex((prev) => (prev + 1) % items.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        // Up from the first item goes to the reaction bar above the menu.
        const firstItem = menuRef.current?.querySelector('[role="menuitem"]');
        if (hasReactionBar && firstItem && document.activeElement === firstItem) {
          leaveMenuTo("bar");
          return;
        }
        setFocusedIndex((prev) => (prev - 1 + items.length) % items.length);
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        setFocusedIndex(0);
        return;
      }
      if (event.key === "End") {
        event.preventDefault();
        setFocusedIndex(items.length - 1);
      }
    };
    // Capture phase, so this runs before the page's own key handlers.
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [menu, onClose, setFocusedIndex]);

  useEffect(() => {
    const targetEl = menu?.targetEl;
    if (!menu || !targetEl || typeof MutationObserver === "undefined") return undefined;
    if (!targetEl.isConnected) {
      onClose?.();
      return undefined;
    }
    const observer = new MutationObserver(() => {
      if (!targetEl.isConnected) {
        observer.disconnect();
        onClose?.();
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
    return () => observer.disconnect();
  }, [menu, onClose]);

  useLayoutEffect(() => {
    if (!menu || !menuRef.current || typeof window === "undefined") return;
    const rect = menuRef.current.getBoundingClientRect();
    const nextX = Math.min(
      Math.max(SCREEN_GAP, Number(menu.point?.x || 0)),
      window.innerWidth - rect.width - SCREEN_GAP,
    );
    const preferY = Number(menu.point?.y || 0);
    const fitsBelow = preferY + rect.height + SCREEN_GAP <= window.innerHeight;
    const nextY = fitsBelow
      ? preferY
      : Math.max(SCREEN_GAP, preferY - rect.height);
    setDesktopPosition({ x: nextX, y: nextY });
    setVerticalPlacement(fitsBelow ? "below" : "above");
  }, [menu]);

  if (!menu || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-200"
      onContextMenu={(event) => {
        event.preventDefault();
        if (
          event.target instanceof Element &&
          event.target.closest('[role="menu"], [data-reaction-bar], [data-reaction-picker]')
        ) {
          return;
        }
        onClose?.();
        reopenAtPoint(event.clientX, event.clientY);
      }}
    >
      <button
        type="button"
        aria-label="Close context menu"
        className="absolute inset-0 h-full w-full cursor-default border-0 bg-transparent p-0"
        onPointerDown={() => {
          backdropPressedRef.current = true;
        }}
        onClick={(event) => {
          if (event.detail !== 0 && !backdropPressedRef.current) return;
          onClose?.();
        }}
      />


      <div
        ref={menuRef}
        role="menu"
        aria-label="Context menu"
        className={`fixed overflow-hidden rounded-[1.25rem] border border-slate-300/80 bg-white text-slate-900 shadow-[0_18px_46px_rgba(15,23,42,0.2)] dark:border-white/10 dark:bg-slate-800 dark:text-slate-100 ${
          verticalPlacement === "below"
            ? "sb-context-menu-open-down"
            : "sb-context-menu-open-up"
        }`}
        style={{
          top: `${desktopPosition.y}px`,
          left: `${desktopPosition.x}px`,
          minWidth: "220px",
          maxWidth: "280px",
          visibility: reactionPickerOpen ? "hidden" : undefined,
          transformOrigin:
            verticalPlacement === "below" ? "top left" : "bottom left",
        }}
      >
        <div className="py-1.5">
          {menu.items.map((item, index) => {
            const Icon = item.icon;
            const isDisabled = Boolean(item.disabled);
            return (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                disabled={isDisabled}
                tabIndex={focusedIndex === index ? 0 : -1}
                onClick={() => {
                  if (isDisabled) return;
                  item.onSelect?.();
                  onClose?.();
                }}
                onFocus={() => setFocusedIndex(index)}
                className={`flex w-full items-center gap-3 px-4 py-3 text-left text-sm transition ${
                  isDisabled
                    ? "cursor-not-allowed opacity-50 text-slate-400 dark:text-slate-500"
                    : item.danger
                      ? "text-rose-600 dark:text-rose-300 hover:bg-black/5 dark:hover:bg-white/10"
                      : "hover:bg-black/5 dark:hover:bg-white/10"
                }`}
              >
                {Icon ? (
                  <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden="true">
                    <Icon size={16} />
                  </span>
                ) : null}
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {menu.reactions ? (
        <QuickReactionBar
          key={menu.reactions.messageId}
          chatId={menu.reactions.chatId}
          messageId={menu.reactions.messageId}
          anchorRef={menuRef}
          anchorPos={desktopPosition}
          measureKey={menu}
          onDone={onClose}
          onPickerChange={setReactionPickerOpen}
          onLeave={(direction) => leaveMenuTo(direction === "up" ? "last" : "first")}
        />
      ) : null}
    </div>,
    document.body,
  );
}
