import { useCallback, useEffect, useMemo, useState } from "react";
import { Copy, Download, LoaderCircle, ShieldCheck } from "../../../icons/lucide.js";
import {
  confirmTwoFactor,
  disableTwoFactor,
  fetchTwoFactorStatus,
  regenerateRecoveryCodes,
  startTwoFactorSetup,
} from "../../../api/securityApi.js";
import { copyTextToClipboard } from "../../../utils/clipboard.js";
import { formatShortDate } from "../../../utils/relativeTime.js";
import SafetyQrCode from "../../calls/SafetyQrCode.jsx";
import { InlineError } from "../common/InlineError.jsx";

const inputClass =
  "w-full rounded-2xl border border-emerald-200 bg-white px-3 py-2 text-sm text-slate-700 outline-hidden transition focus:border-emerald-400 focus:ring-2 focus:ring-emerald-300/60 dark:border-emerald-500/30 dark:bg-slate-900 dark:text-slate-100";
const primaryButton =
  "inline-flex items-center justify-center gap-2 rounded-full bg-emerald-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-emerald-500/20 transition duration-150 hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50";
const quietButton =
  "inline-flex items-center justify-center gap-2 rounded-full border border-emerald-200 bg-white px-4 py-2 text-xs font-semibold text-emerald-700 transition duration-150 hover:border-emerald-300 disabled:cursor-not-allowed disabled:opacity-50 dark:border-emerald-500/30 dark:bg-slate-950 dark:text-emerald-200";
const dangerButton =
  "inline-flex items-center justify-center gap-2 rounded-full border border-rose-200 bg-rose-50 px-4 py-2 text-xs font-semibold text-rose-600 transition duration-150 hover:border-rose-300 hover:shadow-[0_0_14px_rgba(244,63,94,0.2)] disabled:cursor-not-allowed disabled:opacity-50 dark:border-rose-500/30 dark:bg-rose-900/40 dark:text-rose-200";

/** "JBSW Y3DP EHPK 3PXP ..." - the key as people copy it by eye. */
export function groupSecret(secret) {
  return String(secret || "").replace(/\s+/g, "").replace(/(.{4})/g, "$1 ").trim();
}

function Field({ id, label, children, hint }) {
  return (
    <div>
      <label htmlFor={id} className="text-xs font-semibold text-slate-700 dark:text-slate-200">
        {label}
      </label>
      <div className="mt-1">{children}</div>
      {hint ? <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">{hint}</p> : null}
    </div>
  );
}

/** A form that asks for the password and a code (an authenticator code, or a recovery code). */
function ReauthForm({ idPrefix, submitLabel, danger = false, busy, error, onSubmit, onCancel }) {
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const ready = password !== "" && code.trim() !== "" && !busy;
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        onSubmit(
          useRecovery
            ? { password, recoveryCode: code.trim() }
            : { password, code: code.replace(/\s+/g, "") },
        );
      }}
    >
      <Field id={`${idPrefix}-password`} label="Current password">
        <input
          id={`${idPrefix}-password`}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className={inputClass}
        />
      </Field>
      <Field
        id={`${idPrefix}-code`}
        label={useRecovery ? "Recovery code" : "Authentication code"}
        hint={useRecovery ? "One of the codes you saved. Each works once." : "The 6 digits shown in your authenticator app."}
      >
        <input
          id={`${idPrefix}-code`}
          type="text"
          inputMode={useRecovery ? "text" : "numeric"}
          autoComplete="one-time-code"
          autoCapitalize="characters"
          maxLength={useRecovery ? 16 : 7}
          value={code}
          onChange={(event) => setCode(event.target.value)}
          className={`${inputClass} tracking-widest`}
        />
      </Field>
      <button
        type="button"
        className="text-xs font-semibold text-emerald-700 underline-offset-2 hover:underline dark:text-emerald-300"
        onClick={() => {
          setUseRecovery((prev) => !prev);
          setCode("");
        }}
      >
        {useRecovery ? "Use an authentication code instead" : "Use a recovery code instead"}
      </button>
      <InlineError message={error} />
      <div className="flex items-center justify-end gap-2">
        <button type="button" onClick={onCancel} disabled={busy} className={quietButton}>
          Cancel
        </button>
        <button type="submit" disabled={!ready} className={danger ? dangerButton : primaryButton}>
          {busy ? <LoaderCircle size={12} className="animate-spin" /> : null}
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

function RecoveryCodes({ codes, onDone, title = "Your recovery codes" }) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = useMemo(() => codes.join("\n"), [codes]);

  const download = () => {
    const blob = new Blob([`Aurelle recovery codes\nEach code works once.\n\n${text}\n`], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "aurelle-recovery-codes.txt";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  return (
    <div className="space-y-3" data-testid="recovery-codes">
      <h5 className="text-sm font-semibold text-slate-800 dark:text-slate-100">{title}</h5>
      <p className="rounded-xl border border-amber-300/70 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-400/30 dark:bg-amber-900/20 dark:text-amber-100">
        Save these now. They are shown only once. If you lose your authenticator app, a recovery code
        is the only way back in without an administrator.
      </p>
      <ul className="grid grid-cols-2 gap-2 rounded-2xl border border-emerald-200/70 bg-white/90 p-3 font-mono text-sm tracking-wider text-slate-800 dark:border-emerald-500/30 dark:bg-slate-900/50 dark:text-slate-100">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={quietButton}
          onClick={async () => setCopied(await copyTextToClipboard(text))}
        >
          <Copy size={12} /> {copied ? "Copied" : "Copy"}
        </button>
        <button type="button" className={quietButton} onClick={download}>
          <Download size={12} /> Download
        </button>
      </div>
      <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-200">
        <input type="checkbox" checked={saved} onChange={(event) => setSaved(event.target.checked)} />
        I saved my recovery codes
      </label>
      <div className="flex justify-end">
        <button type="button" disabled={!saved} onClick={onDone} className={primaryButton}>
          Done
        </button>
      </div>
    </div>
  );
}

/**
 * Two-factor sign-in with an authenticator app (TOTP).
 *   off -> password -> key + QR + one code -> recovery codes (once) -> on
 *   on  -> new recovery codes / turn off (password + a code)
 */
export function TwoFactorSection({ variant = "desktop" }) {
  const isMobile = variant === "mobile";
  const [status, setStatus] = useState(null);
  const [mode, setMode] = useState("idle");
  const [setup, setSetup] = useState(null);
  const [recoveryCodes, setRecoveryCodes] = useState([]);
  const [recoveryTitle, setRecoveryTitle] = useState("");
  const [setupPassword, setSetupPassword] = useState("");
  const [confirmCode, setConfirmCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copiedKey, setCopiedKey] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await fetchTwoFactorStatus());
    } catch (err) {
      setError(err.message);
      setStatus((prev) => prev ?? { available: false, enabled: false, recoveryCodesRemaining: 0, loadFailed: true });
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const reset = () => {
    setMode("idle");
    setSetup(null);
    setSetupPassword("");
    setConfirmCode("");
    setError("");
    setBusy(false);
  };

  async function run(task) {
    setBusy(true);
    setError("");
    try {
      await task();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const startSetup = (event) => {
    event.preventDefault();
    run(async () => {
      const data = await startTwoFactorSetup({ password: setupPassword });
      setSetup(data);
      setSetupPassword("");
      setMode("setup-confirm");
    });
  };

  const confirmSetup = (event) => {
    event.preventDefault();
    run(async () => {
      const data = await confirmTwoFactor({ code: confirmCode.replace(/\s+/g, "") });
      setRecoveryCodes(data.recoveryCodes || []);
      setRecoveryTitle("Your recovery codes");
      setSetup(null);
      setConfirmCode("");
      setMode("codes");
      await load();
    });
  };

  const titleSize = isMobile ? "text-xs" : "text-sm";
  const metaSize = isMobile ? "text-[10px]" : "text-xs";

  if (status === null) {
    return (
      <p className={`flex items-center gap-2 ${metaSize} text-slate-500 dark:text-slate-400`} role="status">
        <LoaderCircle size={14} className="animate-spin" /> Loading two-factor settings...
      </p>
    );
  }

  const remaining = Number(status.recoveryCodesRemaining || 0);

  return (
    <section aria-labelledby="two-factor-title" className="space-y-3">
      <div>
        <h4 id="two-factor-title" className={`${titleSize} font-semibold text-slate-700 dark:text-slate-200`}>
          Two-factor authentication
        </h4>
        <p className={`mt-1 ${metaSize} text-slate-500 dark:text-slate-400`}>
          Ask for a 6-digit code from an authenticator app after your password. There is no email
          recovery: keep your recovery codes safe.
        </p>
      </div>

      {mode === "idle" && !status.available && !status.enabled ? (
        <p className={`${metaSize} text-slate-600 dark:text-slate-300`}>
          {status.loadFailed ? "Could not load this setting." : "Two-factor authentication is not available on this server."}
        </p>
      ) : null}

      {mode === "idle" && status.enabled ? (
        <div className="space-y-3">
          <p className="flex items-center gap-2 rounded-2xl border border-emerald-200/70 bg-emerald-50/70 px-3 py-2 text-xs font-semibold text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-900/20 dark:text-emerald-100">
            <ShieldCheck size={16} aria-hidden="true" />
            <span>
              On{status.enabledAt ? ` since ${formatShortDate(status.enabledAt)}` : ""}
            </span>
          </p>
          <p
            className={`${metaSize} ${remaining <= 2 ? "font-semibold text-amber-700 dark:text-amber-300" : "text-slate-600 dark:text-slate-300"}`}
            data-testid="recovery-remaining"
          >
            {remaining === 0
              ? "You have no recovery codes left. Get new ones."
              : `${remaining} recovery ${remaining === 1 ? "code" : "codes"} left.`}
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={quietButton} onClick={() => { setError(""); setMode("regenerate"); }}>
              Get new recovery codes
            </button>
            <button type="button" className={dangerButton} onClick={() => { setError(""); setMode("disable"); }}>
              Turn off
            </button>
          </div>
        </div>
      ) : null}

      {mode === "idle" && !status.enabled && status.available ? (
        <button type="button" className={primaryButton} onClick={() => { setError(""); setMode("setup-password"); }}>
          Turn on two-factor authentication
        </button>
      ) : null}

      {mode === "setup-password" ? (
        <form className="space-y-3" onSubmit={startSetup}>
          <Field id="tf-setup-password" label="Current password" hint="We ask again so nobody on an unlocked device can switch this on.">
            <input
              id="tf-setup-password"
              type="password"
              autoComplete="current-password"
              value={setupPassword}
              onChange={(event) => setSetupPassword(event.target.value)}
              className={inputClass}
            />
          </Field>
          <InlineError message={error} />
          <div className="flex items-center justify-end gap-2">
            <button type="button" className={quietButton} onClick={reset} disabled={busy}>Cancel</button>
            <button type="submit" className={primaryButton} disabled={busy || setupPassword === ""}>
              {busy ? <LoaderCircle size={12} className="animate-spin" /> : null}
              Continue
            </button>
          </div>
        </form>
      ) : null}

      {mode === "setup-confirm" && setup ? (
        <form className="space-y-3" onSubmit={confirmSetup}>
          <p className="text-xs text-slate-700 dark:text-slate-200">
            1. Scan this code with your authenticator app, or enter the key by hand.
          </p>
          <div className="mx-auto w-44 max-w-full">
            <SafetyQrCode
              payload={setup.otpauthUri}
              label="QR code for your authenticator app"
              description="Scan to add your Aurelle account to an authenticator app."
            />
          </div>
          <div className="rounded-2xl border border-emerald-200/70 bg-white/90 p-3 dark:border-emerald-500/30 dark:bg-slate-900/50">
            <p className="text-[11px] text-slate-500 dark:text-slate-400">Setup key</p>
            <p className="mt-1 break-all font-mono text-sm tracking-wider text-slate-900 dark:text-slate-100" data-testid="totp-secret">
              {groupSecret(setup.secret)}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 hover:underline dark:text-emerald-300"
                onClick={async () => setCopiedKey(await copyTextToClipboard(setup.secret))}
              >
                <Copy size={12} /> {copiedKey ? "Copied" : "Copy key"}
              </button>
              <a
                href={setup.otpauthUri}
                className="text-xs font-semibold text-emerald-700 hover:underline dark:text-emerald-300"
              >
                Open in authenticator app
              </a>
            </div>
          </div>
          <Field id="tf-confirm-code" label="2. Enter the 6-digit code it shows">
            <input
              id="tf-confirm-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              value={confirmCode}
              onChange={(event) => setConfirmCode(event.target.value)}
              className={`${inputClass} tracking-widest`}
            />
          </Field>
          <InlineError message={error} />
          <div className="flex items-center justify-end gap-2">
            <button type="button" className={quietButton} onClick={reset} disabled={busy}>Cancel</button>
            <button type="submit" className={primaryButton} disabled={busy || confirmCode.replace(/\s+/g, "").length < 6}>
              {busy ? <LoaderCircle size={12} className="animate-spin" /> : null}
              Turn on
            </button>
          </div>
        </form>
      ) : null}

      {mode === "codes" ? (
        <RecoveryCodes
          codes={recoveryCodes}
          title={recoveryTitle}
          onDone={() => {
            setRecoveryCodes([]);
            reset();
          }}
        />
      ) : null}

      {mode === "regenerate" ? (
        <div className="space-y-2">
          <p className={`${metaSize} text-slate-600 dark:text-slate-300`}>
            New codes replace the old ones. Codes you saved before stop working.
          </p>
          <ReauthForm
            idPrefix="tf-regen"
            submitLabel="Get new codes"
            busy={busy}
            error={error}
            onCancel={reset}
            onSubmit={(payload) =>
              run(async () => {
                const data = await regenerateRecoveryCodes(payload);
                setRecoveryCodes(data.recoveryCodes || []);
                setRecoveryTitle("Your new recovery codes");
                setMode("codes");
                await load();
              })
            }
          />
        </div>
      ) : null}

      {mode === "disable" ? (
        <div className="space-y-2">
          <p className={`${metaSize} text-slate-600 dark:text-slate-300`}>
            Without it, your password is the only thing protecting this account.
          </p>
          <ReauthForm
            idPrefix="tf-disable"
            submitLabel="Turn off"
            danger
            busy={busy}
            error={error}
            onCancel={reset}
            onSubmit={(payload) =>
              run(async () => {
                await disableTwoFactor(payload);
                reset();
                await load();
              })
            }
          />
        </div>
      ) : null}

      {mode === "idle" ? <InlineError message={error} /> : null}
    </section>
  );
}
