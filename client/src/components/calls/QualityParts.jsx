import { QUALITY_LIMIT_TEXT, connectionRows, describeQuality, levelForRank } from "../../calls/connectionQuality.js";

// The call screen is always dark, so these colours do not follow the theme. The
// good levels use the same light accent as the encrypted chip beside them.
const TONE_CLASS = {
  ok: "text-emerald-200",
  warn: "text-amber-300",
  bad: "text-rose-400",
  muted: "text-slate-400",
};

const BAR_HEIGHTS = [5, 8, 11, 14];

/** Four bars, the first `bars` of them lit. The bars carry no text: whatever shows them names the level. */
export function SignalBars({ bars, pulse = false, className = "" }) {
  return (
    <svg
      viewBox="0 0 16 14"
      width="16"
      height="14"
      aria-hidden="true"
      className={`${pulse ? "animate-pulse motion-reduce:animate-none" : ""} ${className}`}
    >
      {BAR_HEIGHTS.map((height, index) => (
        <rect
          key={height}
          x={index * 4.5}
          y={14 - height}
          width="3"
          height={height}
          rx="1"
          fill="currentColor"
          opacity={index < bars ? 1 : 0.28}
        />
      ))}
    </svg>
  );
}

/**
 * The signal icon in the call's header: "Connection: Good" as a tooltip and
 * as its name, a pill that turns amber on Fair and red on Poor, and a pulse
 * while the call is getting its connection back. A press opens the settings,
 * where the numbers are.
 */
export function QualityIndicator({ rank, reconnecting, relayed, onClick }) {
  const shown = describeQuality({ rank, reconnecting, relayed });
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={shown.text}
      title={shown.title}
      data-quality={shown.id}
      className={`inline-flex h-9 shrink-0 items-center justify-center rounded-full border border-white/10 bg-slate-900/70 px-2.5 backdrop-blur transition hover:bg-slate-800/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 ${TONE_CLASS[shown.tone]}`}
    >
      <SignalBars bars={shown.bars} pulse={shown.id === "reconnecting"} />
    </button>
  );
}

const titleClass = "px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400";

/** The numbers behind the signal icon, for the curious: round trip, loss, jitter, bandwidth and the path. */
export function ConnectionSection({ rank, reconnecting, relayed, stats, limit }) {
  const shown = describeQuality({ rank, reconnecting, relayed });
  const level = levelForRank(rank);
  const heldBack = !reconnecting && level && level.bars <= 2 && limit ? QUALITY_LIMIT_TEXT[limit] : null;
  return (
    <div role="group" aria-label="Connection" className="space-y-0.5">
      <p className={titleClass}>Connection</p>
      <p className={`flex items-center gap-2 px-3 pb-1 text-sm ${TONE_CLASS[shown.tone]}`}>
        <SignalBars bars={shown.bars} pulse={shown.id === "reconnecting"} />
        <span className="text-slate-100">{shown.label}</span>
      </p>
      {heldBack ? <p className="px-3 pb-1 text-[11px] text-slate-400">Held back by {heldBack}.</p> : null}
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 px-3 pb-1 text-[11px]">
        {connectionRows(stats, { relayed }).map((row) => (
          <div key={row.id} className="contents">
            <dt className="text-slate-400">{row.label}</dt>
            <dd className="text-right tabular-nums text-slate-200">{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
