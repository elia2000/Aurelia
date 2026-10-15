import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "../../hooks/useFocusTrap.js";
import { Lock, ShieldCheck, ShieldOff, LoaderCircle } from "../../icons/lucide.js";
import { computeSafetyNumber } from "../../e2ee/safetyNumber.js";
import { getE2eeServices } from "../../e2ee/services.js";
import { hasPersian } from "../../utils/fontUtils.js";

/**
 * Shows the safety number for a conversation partner. If both people see the
 * same number, nobody (including the server) swapped the keys. Marking it
 * verified is remembered on this device until the number changes.
 */
export default function SafetyNumberModal({ open, onClose, selfUser, peer, sas = null }) {
  const dialogRef = useRef(null);
  useFocusTrap(dialogRef, open);
  const [status, setStatus] = useState({ loading: true, error: "", groups: null, digits: "", verified: false });

  useEffect(() => {
    if (!open || !selfUser?.id || !peer?.userId) return undefined;
    let cancelled = false;
    setStatus({ loading: true, error: "", groups: null, digits: "", verified: false });
    (async () => {
      try {
        const services = getE2eeServices();
        const [{ devices: mine }, theirs] = await Promise.all([
          services.api.listMyDevices(),
          services.directory.getUserDevices(peer.userId, { force: true }),
        ]);
        const { digits, groups } = await computeSafetyNumber({
          selfUserId: selfUser.id,
          selfDevices: mine,
          peerUserId: peer.userId,
          peerDevices: theirs.devices,
        });
        const verified = await services.trust.isVerified(peer.userId, digits);
        if (!cancelled) setStatus({ loading: false, error: "", groups, digits, verified });
      } catch (error) {
        const message =
          error?.name === "KeyMismatchError"
            ? "This contact's security keys changed unexpectedly. Do not trust this conversation until you have checked with them in person."
            : error?.message === "Both people need at least one registered device."
              ? "This contact has not set up secure messaging yet."
              : "Could not load the safety number.";
        if (!cancelled) setStatus({ loading: false, error: message, groups: null, digits: "", verified: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, selfUser?.id, peer?.userId]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;

  const toggleVerified = async () => {
    const next = !status.verified;
    await getE2eeServices().trust.setVerified(peer.userId, status.digits, next);
    setStatus((prev) => ({ ...prev, verified: next }));
  };
  const peerName = peer?.nickname || peer?.username || "this contact";

  return createPortal(
    <div className="fixed inset-0 z-[350] flex items-center justify-center bg-black/40 px-6">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="safety-number-title"
        className="w-full max-w-sm rounded-2xl border border-slate-100 bg-white p-6 shadow-xl dark:border-slate-800 dark:bg-slate-950"
      >
        <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-300">
          <Lock size={18} />
          <h3 id="safety-number-title" className="text-lg font-semibold">
            Verify security
          </h3>
        </div>
        <p className={`mt-2 text-sm text-slate-600 dark:text-slate-300 ${hasPersian(peerName) ? "font-fa" : ""}`}>
          Compare this number with {peerName} in person or over a channel you already trust. If it matches on both
          screens, your calls and video messages cannot be intercepted.
        </p>

        {status.loading ? (
          <div className="mt-6 flex justify-center text-emerald-500">
            <LoaderCircle className="h-6 w-6 animate-spin" />
          </div>
        ) : status.error ? (
          <p className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-600 dark:border-rose-500/30 dark:bg-rose-900/30 dark:text-rose-200">
            {status.error}
          </p>
        ) : (
          <>
            <div
              dir="ltr"
              className="mt-4 grid grid-cols-4 gap-x-3 gap-y-2 rounded-xl border border-emerald-200 bg-emerald-50/60 p-4 text-center font-mono text-base font-semibold tracking-wider text-slate-800 dark:border-emerald-500/30 dark:bg-slate-900 dark:text-slate-100"
              aria-label="Safety number"
            >
              {status.groups.map((group, index) => (
                <span key={index}>{group}</span>
              ))}
            </div>
            {sas ? (
              <p className="mt-3 text-center text-xs text-slate-500 dark:text-slate-400">
                Current call code: <span className="text-base">{sas.join(" ")}</span>
              </p>
            ) : null}
            <p
              className={`mt-3 flex items-center gap-1.5 text-xs font-semibold ${
                status.verified ? "text-emerald-600 dark:text-emerald-300" : "text-amber-600 dark:text-amber-300"
              }`}
            >
              {status.verified ? <ShieldCheck size={14} /> : <ShieldOff size={14} />}
              {status.verified ? "You verified this number." : "Not verified yet."}
            </p>
          </>
        )}

        <div className="mt-5 flex items-center justify-end gap-2">
          {!status.loading && !status.error ? (
            <button
              type="button"
              onClick={toggleVerified}
              className="rounded-full border border-emerald-200 bg-white px-4 py-2 text-xs font-semibold text-emerald-700 transition hover:border-emerald-300 hover:shadow-[0_0_14px_rgba(16,185,129,0.2)] dark:border-emerald-500/30 dark:bg-slate-950 dark:text-emerald-200"
            >
              {status.verified ? "Remove verification" : "Mark as verified"}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-slate-200 bg-slate-50 px-4 py-2 text-xs font-semibold text-slate-700 transition hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
          >
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
