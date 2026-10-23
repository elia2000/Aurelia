import { useEffect, useId, useMemo, useState } from "react";
import { Camera, Keyboard, ShieldCheck, ShieldOff } from "../../icons/lucide.js";
import { detectorReadsQr, hasQrScanApi } from "../../utils/qr/qrScanner.js";
import {
  SAFETY_QR_MATCH_MESSAGE,
  SAFETY_QR_MESSAGES,
  checkScannedSafetyPayload,
  checkTypedSafetyNumber,
} from "../../e2ee/safetyQr.js";
import { useQrScanner } from "./useQrScanner.js";

const ACTION =
  "inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-white px-3 py-1.5 text-xs font-semibold text-emerald-700 transition hover:border-emerald-300 hover:shadow-[0_0_14px_color-mix(in_srgb,var(--color-emerald-500)_20%,transparent)] dark:border-emerald-500/30 dark:bg-slate-950 dark:text-emerald-200";

/** The verdict of a comparison: it matches (and may be remembered) or it does not. */
function Verdict({ ok, problem, verified, onMarkVerified, busy }) {
  if (ok) {
    return (
      <div
        role="status"
        className="rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-100"
      >
        <p className="flex items-center gap-1.5 font-semibold">
          <ShieldCheck size={14} aria-hidden="true" />
          {SAFETY_QR_MATCH_MESSAGE}
        </p>
        {verified ? (
          <p className="mt-1">You already marked this number as verified.</p>
        ) : (
          <>
            <p className="mt-1">The number on both screens is the same. Mark it as verified to remember that on this device.</p>
            <button type="button" onClick={onMarkVerified} disabled={busy} className={`${ACTION} mt-2 disabled:cursor-not-allowed disabled:opacity-50`}>
              Mark as verified
            </button>
          </>
        )}
      </div>
    );
  }
  return (
    <p
      role="alert"
      className="flex items-start gap-1.5 rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-800 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-100"
    >
      <ShieldOff size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span>{SAFETY_QR_MESSAGES[problem] || SAFETY_QR_MESSAGES.malformed}</span>
    </p>
  );
}

/**
 * Comparing the safety number with the contact's: by scanning their QR code
 * (when this browser can), or by typing or pasting their 60 digits. A match is
 * never remembered on its own; the person presses "Mark as verified".
 *
 * @param {string} selfUserId
 * @param {string} peerUserId
 * @param {string} digits       the safety number as computed right now
 * @param {boolean} verified    already marked as verified
 * @param {() => Promise<void>|void} onMarkVerified
 * @param {(matched: boolean) => void} [onMatchChange]  tells the screen a match is on show
 */
export default function SafetyCompare({ selfUserId, peerUserId, digits, verified, onMarkVerified, onMatchChange }) {
  const inputId = useId();
  const [support, setSupport] = useState(() => (hasQrScanApi() ? "checking" : "no"));
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState(null);
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (support !== "checking") return undefined;
    let cancelled = false;
    detectorReadsQr().then((reads) => {
      if (!cancelled) setSupport(reads ? "yes" : "no");
    });
    return () => {
      cancelled = true;
    };
  }, [support]);

  const current = useMemo(() => ({ selfUserId, peerUserId, digits }), [selfUserId, peerUserId, digits]);

  // What was scanned judged against the number as it is now: if it changed, the verdict is stale.
  useEffect(() => {
    setScanResult(null);
  }, [digits, peerUserId]);

  const { videoRef, phase, error } = useQrScanner({
    active: scanning,
    onResult: (text) => {
      setScanning(false);
      setScanResult(checkScannedSafetyPayload(text, current));
    },
  });

  const typedResult = typing ? checkTypedSafetyNumber(typed, current) : { state: "empty" };
  const verdict = scanResult || (typedResult.state === "complete" ? typedResult : null);
  const matched = Boolean(verdict?.ok);
  useEffect(() => {
    onMatchChange?.(matched);
    return () => onMatchChange?.(false);
  }, [matched, onMatchChange]);

  const markVerified = async () => {
    setBusy(true);
    try {
      await onMarkVerified?.();
    } finally {
      setBusy(false);
    }
  };

  const startScan = () => {
    setScanResult(null);
    setScanning(true);
  };

  return (
    <div className="mt-4 space-y-2" data-testid="safety-compare">
      <div className="flex flex-wrap items-center gap-2">
        {support === "yes" && !scanning ? (
          <button type="button" onClick={startScan} className={ACTION}>
            <Camera size={14} aria-hidden="true" />
            Scan their code
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => setTyping((open) => !open)}
          aria-expanded={typing}
          className={ACTION}
        >
          <Keyboard size={14} aria-hidden="true" />
          {typing ? "Hide typing" : "Type their number"}
        </button>
      </div>

      {support === "no" ? (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Scanning is not supported in this browser - compare the number or the emoji instead.
        </p>
      ) : null}

      {scanning ? (
        <div className="space-y-2">
          <div className="relative overflow-hidden rounded-xl bg-black">
            <video
              ref={videoRef}
              aria-label="Camera"
              className={`aspect-4/3 w-full object-cover ${phase === "scanning" ? "" : "invisible"}`}
              playsInline
              muted
            />
            {phase === "starting" ? (
              <p role="status" className="absolute inset-0 flex items-center justify-center text-xs text-slate-200">
                Starting the camera…
              </p>
            ) : null}
            {phase === "scanning" ? (
              <p role="status" className="absolute inset-x-0 bottom-0 bg-black/60 px-3 py-1.5 text-center text-xs text-white">
                Point the camera at their code
              </p>
            ) : null}
            {phase === "error" ? (
              <p role="alert" className="absolute inset-0 flex items-center justify-center px-4 text-center text-xs text-rose-100">
                {error}
              </p>
            ) : null}
          </div>
          <button type="button" onClick={() => setScanning(false)} className={ACTION}>
            Stop scanning
          </button>
        </div>
      ) : null}

      {typing ? (
        <div>
          <label htmlFor={inputId} className="sr-only">
            Number from your contact
          </label>
          <textarea
            id={inputId}
            dir="ltr"
            rows={3}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            placeholder="Type or paste the 60 digits"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            inputMode="numeric"
            className="w-full resize-none rounded-xl border border-slate-200 bg-white px-3 py-2 font-mono text-sm tracking-wider text-slate-800 outline-none focus-visible:outline-2 focus-visible:outline-emerald-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          />
          {typedResult.state === "partial" ? (
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{typedResult.count} of 60 digits</p>
          ) : null}
          {typedResult.state === "too_long" ? (
            <p role="alert" className="mt-1 text-xs text-rose-700 dark:text-rose-300">
              That is more than 60 digits.
            </p>
          ) : null}
          {typedResult.state === "invalid" ? (
            <p role="alert" className="mt-1 text-xs text-rose-700 dark:text-rose-300">
              Only digits can be compared. Type or paste the 60 digits.
            </p>
          ) : null}
        </div>
      ) : null}

      {verdict ? (
        <Verdict ok={verdict.ok} problem={verdict.problem} verified={verified} onMarkVerified={markVerified} busy={busy} />
      ) : null}
    </div>
  );
}
