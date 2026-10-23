import { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "../../icons/lucide.js";
import { completeTwoFactorLogin } from "../../api/securityApi.js";

/**
 * Second step of signing in when the account uses two-factor authentication:
 * the 6-digit code from the authenticator app, or one recovery code.
 *
 * `onSuccess(user)` gets the signed-in user's data. `onRestart(message)` is
 * called when the sign-in can not continue (the five minutes ran out, too many
 * wrong codes) and the person must enter the password again.
 */
export default function TwoFactorLoginStep({ challenge, onSuccess, onRestart, onCancel }) {
  const [code, setCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [useRecovery]);

  async function handleSubmit(event) {
    event.preventDefault();
    const value = code.trim();
    if (!value || loading) return;
    setLoading(true);
    setError("");
    try {
      const data = await completeTwoFactorLogin({
        challenge,
        ...(useRecovery ? { recoveryCode: value } : { code: value.replace(/\s+/g, "") }),
      });
      await onSuccess?.(data);
    } catch (err) {
      if (err?.data?.restart) {
        onRestart?.(err.message);
        return;
      }
      const left = err?.data?.attemptsLeft;
      setError(
        Number.isFinite(left) && left > 0
          ? `${err.message} ${left} ${left === 1 ? "try" : "tries"} left.`
          : err.message,
      );
      setCode("");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="mt-4 space-y-3 sm:mt-6 sm:space-y-4" onSubmit={handleSubmit} data-testid="two-factor-login">
      <label className="block" htmlFor="login-two-factor-code">
        <span className="text-xs font-semibold text-slate-700 dark:text-slate-200 sm:text-sm">
          {useRecovery ? "Recovery code" : "Authentication code"}
        </span>
        <input
          id="login-two-factor-code"
          ref={inputRef}
          name="code"
          type="text"
          inputMode={useRecovery ? "text" : "numeric"}
          autoComplete="one-time-code"
          autoCapitalize="characters"
          maxLength={useRecovery ? 16 : 7}
          required
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder={useRecovery ? "XXXXX-XXXXX" : "123456"}
          className="mt-1 w-full rounded-2xl border border-emerald-200 bg-white px-3 py-2 text-center text-base tracking-[0.3em] text-slate-700 outline-hidden transition focus:border-emerald-400 focus:ring-2 focus:ring-emerald-300/60 dark:border-emerald-500/30 dark:bg-slate-950 dark:text-slate-100 sm:mt-2 sm:px-4 sm:py-3"
        />
      </label>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        {useRecovery
          ? "Enter one of the recovery codes you saved. Each one works once."
          : "Open your authenticator app and enter the 6-digit code for Aurelle."}
      </p>
      {error ? (
        <p role="alert" className="rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-500/30 dark:bg-rose-900/40 dark:text-rose-200 sm:text-sm">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={loading || !code.trim()}
        className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-emerald-500 px-3 py-2 text-xs font-semibold text-white shadow-lg shadow-emerald-500/30 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-70 sm:px-4 sm:py-3 sm:text-sm"
      >
        {loading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
        Verify
      </button>
      <div className="flex items-center justify-between gap-3 text-xs">
        <button
          type="button"
          onClick={() => {
            setUseRecovery((prev) => !prev);
            setCode("");
            setError("");
          }}
          className="font-semibold text-emerald-700 underline-offset-2 hover:underline dark:text-emerald-300"
        >
          {useRecovery ? "Use an authentication code" : "Use a recovery code"}
        </button>
        <button
          type="button"
          onClick={() => onCancel?.()}
          className="font-semibold text-slate-600 underline-offset-2 hover:underline dark:text-slate-300"
        >
          Back to sign in
        </button>
      </div>
    </form>
  );
}
