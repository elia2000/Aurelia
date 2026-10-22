import { useEffect, useRef } from "react";
import { CALL_SHORTCUTS } from "../../calls/shortcuts.js";
import { setCallShortcutsEnabled } from "../../calls/callShortcutPrefs.js";
import { useCallShortcutsEnabled } from "../../calls/useCallShortcutPrefs.js";

/** Whether this device has a mouse or a keyboard worth telling about: a phone or tablet with only a touch screen does not. */
function hasFineInput() {
  try {
    return typeof window.matchMedia !== "function" || window.matchMedia("(any-pointer: fine)").matches;
  } catch (_) {
    return true;
  }
}

function Keys({ keys }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      {keys.map((cap, index) => (
        <span key={cap} className="flex items-center gap-1">
          {index > 0 ? <span aria-hidden="true" className="text-slate-500">+</span> : null}
          <kbd className="min-w-6 rounded-md border border-white/20 bg-white/10 px-1.5 py-0.5 text-center font-mono text-[11px] text-slate-100">{cap}</kbd>
        </span>
      ))}
    </span>
  );
}

/**
 * The switch for the single-letter keys (M, V, S, P, F) on this device. On by
 * default. Turning them off leaves Esc, ? and Shift+H alone (see callShortcutPrefs.js).
 */
function LetterKeysSwitch({ enabled }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      data-shortcuts-switch
      onClick={() => setCallShortcutsEnabled(!enabled)}
      className="flex w-full items-center gap-3 rounded-xl py-2 text-left text-sm text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300"
    >
      <span className="min-w-0 flex-1">
        <span className="block">Single-key shortcuts</span>
        <span className="block text-[11px] text-slate-400">M, V, S, P and F, while this call has the focus. For this device.</span>
      </span>
      <span aria-hidden="true" className={`relative h-6 w-11 shrink-0 rounded-full transition ${enabled ? "bg-emerald-500" : "bg-slate-600"}`}>
        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${enabled ? "left-[22px]" : "left-0.5"}`} />
      </span>
    </button>
  );
}

/**
 * The cheat sheet of the call's keyboard shortcuts, folded away in the settings,
 * with the per-device switch for the single-letter keys at its top.
 * The ? key opens it (`reveal`): it is then scrolled into view and its heading
 * takes the focus, so a screen reader reads it out.
 */
export function ShortcutsSection({ reveal = false }) {
  const detailsRef = useRef(null);
  const summaryRef = useRef(null);
  const lettersOn = useCallShortcutsEnabled();
  useEffect(() => {
    if (!reveal) return;
    detailsRef.current?.scrollIntoView?.({ block: "nearest" });
    summaryRef.current?.focus({ preventScroll: true });
  }, [reveal]);
  if (!hasFineInput()) return null;
  return (
    <details ref={detailsRef} open={reveal || undefined} data-shortcuts className="px-3 pb-1">
      <summary
        ref={summaryRef}
        className="cursor-pointer rounded-md pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300"
      >
        Keyboard shortcuts
      </summary>
      <LetterKeysSwitch enabled={lettersOn} />
      {lettersOn ? null : (
        <p className="pb-1 text-[11px] text-slate-400">
          The letter keys are off. Esc, ? and Shift+H still work.
        </p>
      )}
      <ul className="space-y-1.5 pb-1 pt-1">
        {CALL_SHORTCUTS.map((shortcut) => (
          <li key={shortcut.id} className="flex items-center justify-between gap-3 text-xs text-slate-200">
            <span className="min-w-0">{shortcut.label}</span>
            <Keys keys={shortcut.keys} />
          </li>
        ))}
      </ul>
    </details>
  );
}
