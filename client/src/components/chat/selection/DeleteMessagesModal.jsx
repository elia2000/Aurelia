import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LoaderCircle } from "../../../icons/lucide.js";
import { useFocusTrap } from "../../../hooks/useFocusTrap.js";
import { describeDeleteEffect, messagesLabel } from "../../../utils/batchMessages.js";
import {
  readDeleteForEveryonePreference,
  writeDeleteForEveryonePreference,
} from "../../../utils/deletePreference.js";

/**
 * "Delete N messages?": the question before several selected messages go.
 *
 * `everyoneCount` of the `total` may be deleted for everyone (the rest, such
 * as other people's messages or call entries, can only be hidden for the
 * person). The switch is offered when at least one may, and says in words what
 * the current choice does to the whole selection. `onConfirm(deleteForEveryone)`
 * may return a promise; the dialog shows progress until it settles.
 */
export default function DeleteMessagesModal({
  open = true,
  total,
  everyoneCount = 0,
  offline = false,
  onClose,
  onConfirm,
}) {
  const dialogRef = useRef(null);
  useFocusTrap(dialogRef, open);
  const [preference, setPreference] = useState(readDeleteForEveryonePreference);
  const [submitting, setSubmitting] = useState(false);
  const canDeleteForEveryone = everyoneCount > 0 && !offline;
  const deleteForEveryone = canDeleteForEveryone && preference;

  // Escape closes this question and nothing else (not the open chat behind it).
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!submitting) onClose?.();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, submitting, onClose]);

  if (!open || typeof document === "undefined") return null;

  const handleConfirm = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onConfirm?.(deleteForEveryone);
    } finally {
      setSubmitting(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-320 flex items-center justify-center bg-black/40 px-6">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-messages-title"
        aria-describedby="delete-messages-description"
        className="w-full max-w-sm rounded-2xl border border-rose-100/70 bg-white p-6 shadow-xl dark:border-rose-500/30 dark:bg-slate-950"
      >
        <h3
          id="delete-messages-title"
          className="text-lg font-semibold text-rose-600 dark:text-rose-300"
        >
          {`Delete ${messagesLabel(total)}?`}
        </h3>
        <p
          id="delete-messages-description"
          className="mt-2 text-sm text-slate-600 dark:text-slate-300"
        >
          {describeDeleteEffect({ total, everyoneCount, deleteForEveryone })}
        </p>
        {canDeleteForEveryone ? (
          <button
            type="button"
            onClick={() => {
              const next = !deleteForEveryone;
              setPreference(next);
              writeDeleteForEveryonePreference(next);
            }}
            role="switch"
            aria-checked={deleteForEveryone}
            disabled={submitting}
            className="mt-4 flex w-full items-center justify-between rounded-2xl border border-emerald-200/70 bg-white/90 px-4 py-3 text-left text-sm font-semibold text-emerald-700 transition hover:border-emerald-300 hover:bg-emerald-50 hover:shadow-[0_0_18px_color-mix(in_srgb,var(--color-emerald-500)_18%,transparent)] disabled:cursor-not-allowed disabled:opacity-60 dark:border-emerald-500/30 dark:bg-slate-900/50 dark:text-emerald-200 dark:hover:bg-emerald-500/10"
          >
            <span>Delete for everyone</span>
            <span
              className={`relative inline-flex h-6 w-11 items-center rounded-full p-0.5 transition ${
                deleteForEveryone
                  ? "justify-end bg-emerald-500"
                  : "justify-start bg-slate-300 dark:bg-slate-700"
              }`}
            >
              <span className="inline-block h-5 w-5 rounded-full bg-white shadow-sm transition" />
            </span>
          </button>
        ) : null}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => {
              if (!submitting) onClose?.();
            }}
            disabled={submitting}
            className="rounded-full border border-emerald-200 bg-white px-4 py-2 text-xs font-semibold text-emerald-700 transition hover:border-emerald-300 hover:shadow-[0_0_14px_color-mix(in_srgb,var(--color-emerald-500)_20%,transparent)] disabled:cursor-not-allowed disabled:opacity-60 dark:border-emerald-500/30 dark:bg-slate-950 dark:text-emerald-200"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={submitting}
            className="inline-flex items-center gap-1.5 rounded-full border border-rose-200 bg-rose-50 px-4 py-2 text-xs font-semibold text-rose-600 transition hover:border-rose-300 hover:shadow-[0_0_14px_rgba(244,63,94,0.2)] disabled:cursor-not-allowed disabled:opacity-60 dark:border-rose-500/30 dark:bg-rose-900/40 dark:text-rose-200"
          >
            {submitting ? <LoaderCircle size={13} className="animate-spin" /> : null}
            Delete
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
