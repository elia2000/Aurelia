import { useEffect, useRef } from "react";
import { Monitor, ScreenShare } from "../../icons/lucide.js";
import { describeSurface } from "../../calls/screenShareText.js";

// The small pieces of the call screen that belong to screen sharing. How they
// sit on the screen is decided by CallOverlay.

/**
 * Stays on the call while a screen is shared, whatever else is hidden: there
 * must never be doubt about what the other person can see.
 *
 * It sits straight on top of the other person's video once the details have
 * faded out, so its backing is dark and nearly opaque whatever the picture is
 * (a white wall measured 1.4:1 with the old translucent rose): text on it is
 * 13:1 or better over the brightest frame, see "sharing-banner" in
 * utils/themeContrast.js. It is above the call settings' click-catcher (z-30),
 * so "Stop sharing" works while the settings are open, and CallOverlay lifts
 * the settings panel clear of it.
 */
export function ScreenSharingBanner({ surface, onStop, bannerRef }) {
  return (
    <div
      ref={bannerRef}
      role="group"
      aria-label="Screen sharing"
      data-screen-banner
      className="relative z-35 mx-4 mb-1 mt-2 flex items-center gap-3 rounded-2xl border border-rose-400/50 bg-rose-950/90 py-2 pl-3 pr-2 text-left text-rose-50 shadow-lg backdrop-blur"
    >
      <span aria-hidden="true" className="relative flex h-2.5 w-2.5 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-75 motion-reduce:animate-none" />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-rose-400" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold leading-tight">You are sharing your screen</span>
        <span className="block truncate text-[11px] text-rose-100">{describeSurface(surface)}</span>
      </span>
      <button
        type="button"
        data-screen-stop
        onClick={onStop}
        className="shrink-0 rounded-full bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-rose-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-200"
      >
        Stop sharing
      </button>
    </div>
  );
}

/** A tile of what you share. */
const PREVIEW_TILE = "flex flex-col items-center justify-center gap-1 overflow-hidden rounded-2xl border border-white/20 bg-black text-center shadow-lg";

/**
 * What the person who shares sees of their own share, in the corner.
 *
 * A live picture is only shown when it cannot reach itself: another browser
 * tab (this one is never offered). A whole screen, or a window (it could be the
 * one this call is in), would show the call inside the call inside the call, so
 * those get a still label instead.
 */
export function ScreenPreviewTile({ stream, surface, className = "", style }) {
  const ref = useRef(null);
  const live = surface === "browser" && Boolean(stream);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.srcObject !== (live ? stream : null)) el.srcObject = live ? stream : null;
    if (live) el.play?.().catch(() => {});
  }, [live, stream]);
  return (
    <div
      data-view="screen-preview"
      data-live={live ? "true" : "false"}
      role="img"
      aria-label="Preview of the screen you are sharing"
      className={`${PREVIEW_TILE} ${className}`}
      style={style}
    >
      {live ? (
        <video ref={ref} autoPlay playsInline muted className="h-full w-full object-contain" />
      ) : (
        <>
          <Monitor size={24} aria-hidden="true" className="text-rose-300" />
          <span className="px-1 text-[11px] font-semibold leading-tight text-slate-100">{describeSurface(surface)}</span>
          <span className="text-[10px] uppercase tracking-wide text-rose-300">Shared</span>
        </>
      )}
    </div>
  );
}

/** The label that tells the viewer what they are looking at. */
export function SharingTheirScreenLabel({ waiting }) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <p
        data-screen-label
        className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/20 px-3 py-1 text-xs font-semibold text-emerald-100"
      >
        <ScreenShare size={13} aria-hidden="true" /> Sharing their screen
      </p>
      {waiting ? <p className="text-xs text-slate-300">Waiting for the picture…</p> : null}
    </div>
  );
}
