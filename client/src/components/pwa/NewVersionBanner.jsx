import { useEffect, useState } from "react";
import { fetchAppBuildId } from "../../api/appMetaApi.js";
import { BRAND } from "../../brand.js";
import { CLIENT_BUILD_ID, isStaleBuild } from "../../buildInfo.js";

const RECHECK_MS = 10 * 60 * 1000;

/**
 * Asks to reload when the server is serving a newer build than the one this
 * page is running (an installed app or a tab that stayed open through an update).
 */
export default function NewVersionBanner({
  clientBuildId = CLIENT_BUILD_ID,
  fetchBuildId = fetchAppBuildId,
  onReload = () => window.location.reload(),
}) {
  const [stale, setStale] = useState(false);
  const [later, setLater] = useState(false);

  useEffect(() => {
    if (!clientBuildId) return undefined;
    let cancelled = false;
    const check = async () => {
      try {
        const serverId = await fetchBuildId();
        if (!cancelled) setStale(isStaleBuild(clientBuildId, serverId));
      } catch (_) {
        // Offline or the server is restarting: say nothing.
      }
    };
    check();
    const onVisible = () => {
      if (!document.hidden) check();
    };
    document.addEventListener("visibilitychange", onVisible);
    const timer = setInterval(check, RECHECK_MS);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(timer);
    };
  }, [clientBuildId, fetchBuildId]);

  if (!stale || later) return null;
  return (
    <div
      role="status"
      className="fixed inset-x-3 bottom-3 z-[400] mx-auto flex max-w-md items-center gap-3 rounded-2xl border border-emerald-500/30 bg-slate-900 px-4 py-3 text-sm text-slate-100 shadow-2xl"
      style={{ bottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
    >
      <span className="min-w-0 flex-1">A new version of {BRAND.name} is available.</span>
      <button
        type="button"
        onClick={() => setLater(true)}
        className="rounded-full px-3 py-1.5 text-slate-300 hover:bg-white/10"
      >
        Later
      </button>
      <button
        type="button"
        onClick={onReload}
        className="rounded-full bg-emerald-500 px-3 py-1.5 font-semibold text-white hover:bg-emerald-400"
      >
        Reload
      </button>
    </div>
  );
}
