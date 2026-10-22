import { memo } from "react";
import { Link } from "../../../icons/lucide.js";
import { useLinkPreviewPrefs } from "../../../hooks/chat/useLinkPreview.js";
import { setLinkPreviewChoice } from "../../../utils/linkPreviewPrefs.js";

/**
 * "Show link previews": a title, description and small picture under a message
 * that has a link. The server makes them (this device never contacts the linked
 * site), and only when the admin has turned the feature on; without that there
 * is nothing to choose and nothing is drawn. Until the person chooses, the
 * switch follows the server (on). The choice is remembered on this device.
 */
const LinkPreviewsSetting = memo(function LinkPreviewsSetting({ variant = "desktop" }) {
  const { serverEnabled, enabled } = useLinkPreviewPrefs();
  if (!serverEnabled) return null;
  const isMobile = variant === "mobile";

  return (
    <div className="border-t border-emerald-100/70 pt-4 dark:border-emerald-500/20">
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        onClick={() => setLinkPreviewChoice(!enabled)}
        className={`flex w-full items-center justify-between gap-3 rounded-2xl border border-emerald-200/70 bg-white/90 px-4 py-3 text-left font-semibold text-emerald-700 transition hover:border-emerald-300 hover:bg-emerald-50 hover:shadow-[0_0_18px_color-mix(in_srgb,var(--color-emerald-500)_18%,transparent)] dark:border-emerald-500/30 dark:bg-slate-900/50 dark:text-emerald-200 dark:hover:bg-emerald-500/10 ${
          isMobile ? "text-xs" : "text-sm"
        }`}
      >
        <span className="flex min-w-0 items-center gap-3">
          <Link size={18} className="shrink-0" aria-hidden="true" />
          <span className="min-w-0">
            Show link previews
            <span className="block text-[11px] font-normal text-slate-500 dark:text-slate-400">
              A title and picture under links. The server fetches the page, so your device never contacts that site.
            </span>
          </span>
        </span>
        <span
          aria-hidden="true"
          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 transition ${
            enabled ? "justify-end bg-emerald-500" : "justify-start bg-slate-300 dark:bg-slate-700"
          }`}
        >
          <span className="inline-block h-5 w-5 rounded-full bg-white shadow-sm transition" />
        </span>
      </button>
    </div>
  );
});

export default LinkPreviewsSetting;
