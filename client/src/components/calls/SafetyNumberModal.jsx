import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "../../hooks/useFocusTrap.js";
import { Lock, ShieldCheck, ShieldOff, LoaderCircle } from "../../icons/lucide.js";
import { getE2eeServices } from "../../e2ee/services.js";
import { describeContactTrustError, loadContactTrust } from "../../e2ee/contactTrust.js";
import { buildSafetyPayload } from "../../e2ee/safetyQr.js";
import { hasPersian } from "../../utils/fontUtils.js";
import SafetyQrCode from "./SafetyQrCode.jsx";
import SafetyCompare from "./SafetyCompare.jsx";

const EMPTY = { loading: true, error: "", groups: null, digits: "", verified: false, devices: [], pending: 0, wasVerified: false };

/**
 * Shows the safety number for a conversation partner, as digits and as a QR
 * code the other person can scan (and a way to scan theirs, or type their
 * number). If both people see the same number, nobody (including the server)
 * swapped the keys. Marking it verified is remembered on this device until the
 * number changes.
 *
 * When the person has devices this device has not seen before, that is shown
 * here and can be accepted (or the new number verified). Until then calls and
 * video messages treat those devices with suspicion.
 *
 * @param {string} [chatId] a chat both people are in; lets the lookup work for
 *                          group members who have no direct chat
 * @param {() => void} [onChanged] called after a device was accepted or the
 *                          verification changed
 */
export default function SafetyNumberModal({ open, onClose, selfUser, peer, chatId, sas = null, onChanged }) {
  const dialogRef = useRef(null);
  useFocusTrap(dialogRef, open);
  const [status, setStatus] = useState(EMPTY);
  const [reload, setReload] = useState(0);
  // A comparison that matched is on show: its own button asks for the confirmation.
  const [matched, setMatched] = useState(false);

  useEffect(() => {
    if (!open || !selfUser?.id || !peer?.userId) return undefined;
    let cancelled = false;
    setStatus(EMPTY);
    (async () => {
      try {
        const info = await loadContactTrust({
          services: getE2eeServices(),
          selfUserId: selfUser.id,
          peerUserId: peer.userId,
          chatId,
          force: true,
        });
        if (!cancelled) setStatus({ loading: false, error: "", ...info });
      } catch (error) {
        const message = describeContactTrustError(error);
        if (!cancelled) setStatus({ ...EMPTY, loading: false, error: message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, selfUser?.id, peer?.userId, chatId, reload]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;

  const setVerifiedTo = async (next) => {
    const services = getE2eeServices();
    // Verifying the number of the devices listed right now also accepts them.
    await services.trust.setVerified(peer.userId, status.digits, next, next ? status.devices : null);
    services.directory.invalidate(peer.userId);
    setStatus((prev) => ({ ...prev, verified: next, pending: next ? 0 : prev.pending }));
    onChanged?.();
  };
  const toggleVerified = () => setVerifiedTo(!status.verified);
  const acceptDevices = async () => {
    await getE2eeServices().directory.acknowledge(peer.userId, status.devices);
    setReload((n) => n + 1);
    onChanged?.();
  };
  const peerName = peer?.nickname || peer?.username || "this contact";
  let payload = null;
  if (status.digits) {
    try {
      payload = buildSafetyPayload({ selfUserId: selfUser.id, peerUserId: peer.userId, digits: status.digits });
    } catch {
      payload = null; // an id the code format cannot carry: the digits remain
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[350] flex items-center justify-center bg-black/40 px-6">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="safety-number-title"
        className="max-h-[calc(100dvh-3rem)] w-full max-w-sm overflow-y-auto rounded-2xl border border-slate-100 bg-white p-6 shadow-xl dark:border-slate-800 dark:bg-slate-950"
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
            {payload ? (
              <div className="mt-4 flex flex-col items-center gap-2">
                <div className="w-60 max-w-full rounded-xl border border-slate-200 bg-white shadow-xs dark:border-slate-600">
                  <SafetyQrCode
                    payload={payload}
                    label={`Verification code (QR) for ${peerName}`}
                    description={`Digits: ${status.groups.join(" ")}`}
                  />
                </div>
                <p className={`text-center text-xs text-slate-500 dark:text-slate-400 ${hasPersian(peerName) ? "font-fa" : ""}`}>
                  Let {peerName} scan this code, or scan theirs.
                </p>
              </div>
            ) : null}
            <div
              dir="ltr"
              className="mt-4 grid grid-cols-4 gap-x-3 gap-y-2 rounded-xl border border-emerald-200 bg-emerald-50/60 p-4 text-center font-mono text-base font-semibold tracking-wider text-slate-800 dark:border-emerald-500/30 dark:bg-slate-900 dark:text-slate-100"
              aria-label="Safety number"
            >
              {status.groups.map((group, index) => (
                <span key={index}>{group}</span>
              ))}
            </div>
            {status.pending > 0 ? (
              <p
                role="alert"
                className="mt-3 flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-400/40 dark:bg-amber-500/10 dark:text-amber-100"
              >
                <ShieldOff size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                <span>
                  {status.wasVerified
                    ? `${peerName}'s safety number changed because a new device was added. Compare the new number with them, then mark it as verified.`
                    : `${peerName} has ${status.pending === 1 ? "a new device" : `${status.pending} new devices`} that you have not seen before. Calls and video messages stay cautious about them until you accept.`}
                </span>
              </p>
            ) : null}
            {status.pending === 0 && status.wasVerified && !status.verified ? (
              <p
                role="alert"
                className="mt-3 flex items-start gap-2 rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-100"
              >
                <ShieldOff size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                <span>
                  The safety number changed since you verified it, because a device was added or removed. Compare the new number with {peerName}, then mark it as verified again.
                </span>
              </p>
            ) : null}
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
            <SafetyCompare
              selfUserId={selfUser.id}
              peerUserId={peer.userId}
              digits={status.digits}
              verified={status.verified}
              onMarkVerified={() => setVerifiedTo(true)}
              onMatchChange={setMatched}
            />
          </>
        )}

        <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
          {!status.loading && !status.error && status.pending > 0 && !status.wasVerified ? (
            <button
              type="button"
              onClick={acceptDevices}
              className="rounded-full border border-amber-300 bg-amber-50 px-4 py-2 text-xs font-semibold text-amber-800 transition hover:border-amber-400 dark:border-amber-400/40 dark:bg-amber-500/10 dark:text-amber-100"
            >
              Accept new devices
            </button>
          ) : null}
          {!status.loading && !status.error && !(matched && !status.verified) ? (
            <button
              type="button"
              onClick={toggleVerified}
              className="rounded-full border border-emerald-200 bg-white px-4 py-2 text-xs font-semibold text-emerald-700 transition hover:border-emerald-300 hover:shadow-[0_0_14px_color-mix(in_srgb,var(--color-emerald-500)_20%,transparent)] dark:border-emerald-500/30 dark:bg-slate-950 dark:text-emerald-200"
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
