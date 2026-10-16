import { memo } from "react";
import { useThemeSnapshot } from "../../../hooks/useThemeColor.js";
import { setThemePreference } from "../../../utils/themeStore.js";
import { DEFAULT_THEME_COLOR, dailyColor } from "../../../utils/themeColor.js";

const swatch = (selected) =>
  `h-9 w-9 rounded-full border-2 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 ${
    selected ? "border-slate-900 ring-2 ring-emerald-300 dark:border-white" : "border-white/70 dark:border-slate-700"
  }`;

/**
 * The accent colour of the app: the built-in green, any colour of the palette
 * the admin set, a colour of your own, or "Random", which moves to a new colour
 * of that palette every day.
 */
export const AppearanceSettingsPanel = memo(function AppearanceSettingsPanel({ onDone, variant = "desktop" }) {
  const { palette, preference, color, userKey } = useThemeSnapshot();
  const isMobile = variant === "mobile";
  const mode = preference.mode;
  const row = `flex w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left font-semibold transition ${
    isMobile ? "text-xs" : "text-sm"
  } border-emerald-200/70 bg-white/90 text-emerald-700 hover:border-emerald-300 hover:bg-emerald-50 dark:border-emerald-500/30 dark:bg-slate-900/50 dark:text-emerald-200 dark:hover:bg-emerald-500/10`;
  const picked = mode === "custom" ? preference.color : null;
  const today = dailyColor(palette, userKey);

  return (
    <div className="space-y-4 text-slate-600 dark:text-slate-300">
      <div className="space-y-2">
        <button
          type="button"
          onClick={() => setThemePreference({ mode: "default" })}
          aria-pressed={mode === "default"}
          className={`${row} ${mode === "default" ? "ring-2 ring-emerald-300" : ""}`}
        >
          <span className="h-6 w-6 shrink-0 rounded-full" style={{ background: DEFAULT_THEME_COLOR }} aria-hidden="true" />
          <span className="min-w-0 flex-1">Default</span>
        </button>
        <button
          type="button"
          onClick={() => setThemePreference({ mode: "random" })}
          aria-pressed={mode === "random"}
          className={`${row} ${mode === "random" ? "ring-2 ring-emerald-300" : ""}`}
        >
          <span className="h-6 w-6 shrink-0 rounded-full" style={{ background: today }} aria-hidden="true" />
          <span className="min-w-0 flex-1">
            Random
            <span className="block text-[11px] font-normal text-slate-500 dark:text-slate-400">
              A new colour every day · today {today}
            </span>
          </span>
        </button>
      </div>

      <div>
        <p className="mb-2 text-[10px] uppercase tracking-[0.25em] text-emerald-500/80">Colours</p>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Theme colours">
          {palette.map((hex) => (
            <button
              key={hex}
              type="button"
              aria-label={`Use ${hex}`}
              aria-pressed={picked === hex}
              title={hex}
              onClick={() => setThemePreference({ mode: "custom", color: hex })}
              className={swatch(picked === hex)}
              style={{ background: hex }}
            />
          ))}
        </div>
      </div>

      <label className={`${row} cursor-pointer`}>
        <input
          type="color"
          aria-label="Pick your own colour"
          value={picked || color || DEFAULT_THEME_COLOR}
          onChange={(event) => setThemePreference({ mode: "custom", color: event.target.value })}
          className="h-8 w-8 shrink-0 cursor-pointer rounded-full border-0 bg-transparent p-0"
        />
        <span className="min-w-0 flex-1">Your own colour</span>
      </label>

      {onDone ? (
        <div className="flex items-center justify-end">
          <button
            type="button"
            onClick={onDone}
            className="rounded-full bg-emerald-500 px-4 py-2 text-xs font-semibold text-white transition hover:bg-emerald-400"
          >
            Done
          </button>
        </div>
      ) : null}
    </div>
  );
});
