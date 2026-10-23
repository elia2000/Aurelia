/**
 * An extra field for forms that re-authenticate with the password (change
 * password, delete account): shown once the server says this account has
 * two-factor authentication on. Accepts an authenticator code or a recovery code.
 */
export function TwoFactorCodeField({ value, onChange, compact = false, id = "two-factor-code" }) {
  return (
    <label className="block" htmlFor={id}>
      <span
        className={`${compact ? "text-xs" : "text-sm"} font-semibold text-slate-700 dark:text-slate-200`}
      >
        Authentication code
      </span>
      <input
        id={id}
        type="text"
        inputMode="text"
        autoComplete="one-time-code"
        autoCapitalize="characters"
        maxLength={16}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="123456"
        className={`mt-2 w-full border border-emerald-200 bg-white text-slate-700 outline-hidden transition tracking-widest focus:border-emerald-400 focus:ring-2 focus:ring-emerald-300/60 dark:border-emerald-500/30 dark:bg-slate-900 dark:text-slate-100 ${
          compact ? "rounded-xl px-3 py-2 text-xs" : "rounded-2xl px-4 py-3 text-sm"
        }`}
      />
      <span className="mt-1 block text-[11px] text-slate-500 dark:text-slate-400">
        The 6 digits from your authenticator app, or a recovery code.
      </span>
    </label>
  );
}
