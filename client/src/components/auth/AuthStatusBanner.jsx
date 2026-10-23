import { AlertCircle, Info } from "../../icons/lucide.js";

export default function AuthStatusBanner({ status, notice }) {
  if (!status && !notice) return null;
  return (
    <>
      {notice ? (
        <p
          role="status"
          data-testid="auth-notice"
          className="mt-3 flex items-start gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-900/30 dark:text-emerald-100 sm:mt-4 sm:px-4 sm:py-3 sm:text-sm"
        >
          <Info size={16} className="shrink-0 self-center" />
          <span>{notice}</span>
        </p>
      ) : null}
      {status ? (
        <p className="mt-3 flex items-start gap-2 rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-500/30 dark:bg-rose-900/40 dark:text-rose-200 sm:mt-4 sm:px-4 sm:py-3 sm:text-sm">
          <AlertCircle size={16} className="shrink-0 self-center" />
          <span>{status}</span>
        </p>
      ) : null}
    </>
  );
}
