import { useCallback, useEffect, useState } from "react";
import { LoaderCircle, Laptop, LogOut, Smartphone } from "../../../icons/lucide.js";
import { fetchSessions, revokeOtherSessions, revokeSession } from "../../../api/securityApi.js";
import { formatRelativeTime, formatShortDate } from "../../../utils/relativeTime.js";
import ConfirmModal from "../../modals/ConfirmModal.jsx";
import { InlineError } from "../common/InlineError.jsx";

import { methodLabel } from "../../../utils/sessionLabels.js";

const isPhone = (session) => /^(Android|iOS)$/.test(session?.os || "");

/**
 * "Where you're signed in": every session of this account, this device first.
 * A session shows the browser and operating system only (no IP address) and
 * when it was last active. Signing one out ends it at once: that browser is
 * returned to the sign-in page.
 */
export function ActiveSessionsSection({ variant = "desktop", now = () => Date.now() }) {
  const isMobile = variant === "mobile";
  const [sessions, setSessions] = useState(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [confirmAll, setConfirmAll] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await fetchSessions();
      setSessions(Array.isArray(data?.sessions) ? data.sessions : []);
      setError("");
    } catch (err) {
      setError(err.message || "Unable to load your sessions.");
      setSessions((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => {
    load();
    // A device may have been signed out elsewhere since the list was drawn.
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  const others = (sessions || []).filter((session) => !session.current);

  async function signOutOne(session) {
    setBusyId(session.id);
    setError("");
    try {
      await revokeSession(session.id);
      setSessions((prev) => (prev || []).filter((item) => item.id !== session.id));
    } catch (err) {
      // 404 means it is already gone (signed out from another device).
      if (err.status === 404) setSessions((prev) => (prev || []).filter((item) => item.id !== session.id));
      else setError(err.message);
    } finally {
      setBusyId("");
    }
  }

  async function signOutOthers() {
    setBulkBusy(true);
    setError("");
    try {
      await revokeOtherSessions();
      setSessions((prev) => (prev || []).filter((item) => item.current));
      setConfirmAll(false);
    } catch (err) {
      setError(err.message);
      setConfirmAll(false);
    } finally {
      setBulkBusy(false);
    }
  }

  const titleSize = isMobile ? "text-xs" : "text-sm";
  const metaSize = isMobile ? "text-[10px]" : "text-xs";

  return (
    <section aria-labelledby="active-sessions-title" className="space-y-3">
      <div>
        <h4
          id="active-sessions-title"
          className={`${titleSize} font-semibold text-slate-700 dark:text-slate-200`}
        >
          Active sessions
        </h4>
        <p className={`mt-1 ${metaSize} text-slate-500 dark:text-slate-400`}>
          Browsers and devices signed in to your account. Sign out any you don&apos;t recognise.
          Only the browser and system are kept, never an IP address.
        </p>
      </div>

      {sessions === null ? (
        <p className={`flex items-center gap-2 ${metaSize} text-slate-500 dark:text-slate-400`} role="status">
          <LoaderCircle size={14} className="animate-spin" /> Loading sessions...
        </p>
      ) : (
        <ul className="space-y-2" aria-label="Signed-in devices">
          {sessions.map((session) => {
            const Icon = isPhone(session) ? Smartphone : Laptop;
            const how = methodLabel(session);
            return (
              <li
                key={session.id}
                data-testid="session-row"
                className="flex items-center gap-3 rounded-2xl border border-emerald-200/70 bg-white/90 px-3 py-3 dark:border-emerald-500/30 dark:bg-slate-900/50"
              >
                <Icon size={isMobile ? 18 : 20} className="shrink-0 text-emerald-600 dark:text-emerald-300" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className={`flex flex-wrap items-center gap-2 ${titleSize} font-semibold text-slate-800 dark:text-slate-100`}>
                    <span className="truncate">{session.device}</span>
                    {session.current ? (
                      <span className="rounded-full bg-emerald-600 px-2 py-0.5 text-[10px] font-semibold text-white">
                        This device
                      </span>
                    ) : null}
                  </p>
                  <p className={`${metaSize} text-slate-600 dark:text-slate-300`}>
                    {session.current ? "Active now" : `Last active ${formatRelativeTime(session.lastSeenAt, now()).replace(/^Active now$/, "just now")}`}
                    {session.createdAt ? ` · Signed in ${formatShortDate(session.createdAt)}` : ""}
                  </p>
                  {how ? <p className={`${metaSize} text-slate-500 dark:text-slate-400`}>{how}</p> : null}
                </div>
                {!session.current ? (
                  <button
                    type="button"
                    onClick={() => signOutOne(session)}
                    disabled={busyId === session.id || bulkBusy}
                    aria-label={`Sign out ${session.device}`}
                    className="inline-flex shrink-0 items-center gap-1 rounded-full border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-600 transition duration-150 hover:border-rose-300 hover:shadow-[0_0_14px_rgba(244,63,94,0.2)] disabled:cursor-not-allowed disabled:opacity-50 dark:border-rose-500/30 dark:bg-rose-900/40 dark:text-rose-200"
                  >
                    {busyId === session.id ? <LoaderCircle size={12} className="animate-spin" /> : <LogOut size={12} />}
                    Sign out
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {sessions !== null && sessions.length === 0 && !error ? (
        <p className={`${metaSize} text-slate-500 dark:text-slate-400`}>No other sessions.</p>
      ) : null}

      {others.length > 0 ? (
        <button
          type="button"
          onClick={() => setConfirmAll(true)}
          disabled={bulkBusy}
          className="w-full rounded-2xl border border-rose-200/80 bg-rose-50/70 px-4 py-2.5 text-xs font-semibold text-rose-600 transition duration-150 hover:border-rose-300 hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-rose-500/40 dark:bg-rose-900/30 dark:text-rose-200 dark:hover:bg-rose-900/50"
        >
          Sign out all other devices
        </button>
      ) : null}

      <InlineError message={error} />

      <ConfirmModal
        open={confirmAll}
        title="Sign out all other devices"
        message={`This signs ${others.length === 1 ? "1 other device" : `${others.length} other devices`} out of your account right away. This device stays signed in.`}
        confirmLabel="Sign out"
        busy={bulkBusy}
        onClose={() => setConfirmAll(false)}
        onConfirm={signOutOthers}
      />
    </section>
  );
}
