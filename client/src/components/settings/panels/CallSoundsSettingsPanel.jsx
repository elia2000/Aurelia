import { memo, useState } from "react";
import { Phone, Volume2, VolumeX } from "../../../icons/lucide.js";
import { callSounds } from "../../../calls/callSounds.js";
import { setCallSoundPrefs } from "../../../calls/callSoundPrefs.js";
import { useCallSoundPrefs } from "../../../calls/useCallSoundPrefs.js";

const canVibrate = () => typeof navigator !== "undefined" && typeof navigator.vibrate === "function";

function SwitchRow({ label, hint, checked, onChange, icon, isMobile }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`flex w-full items-center justify-between gap-3 rounded-2xl border border-emerald-200/70 bg-white/90 px-4 py-3 text-left font-semibold text-emerald-700 transition hover:border-emerald-300 hover:bg-emerald-50 hover:shadow-[0_0_18px_color-mix(in_srgb,var(--color-emerald-500)_18%,transparent)] dark:border-emerald-500/30 dark:bg-slate-900/50 dark:text-emerald-200 dark:hover:bg-emerald-500/10 ${
        isMobile ? "text-xs" : "text-sm"
      }`}
    >
      <span className="flex min-w-0 items-center gap-3">
        {icon}
        <span className="min-w-0">
          {label}
          {hint ? (
            <span className="block text-[11px] font-normal text-slate-500 dark:text-slate-400">{hint}</span>
          ) : null}
        </span>
      </span>
      <span
        aria-hidden="true"
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 transition ${
          checked ? "justify-end bg-emerald-500" : "justify-start bg-slate-300 dark:bg-slate-700"
        }`}
      >
        <span className="inline-block h-5 w-5 rounded-full bg-white shadow-sm transition" />
      </span>
    </button>
  );
}

/**
 * What this device does when a call rings: sounds on or off, how loud the
 * ringtone is, whether the phone vibrates, and a button to hear it. Everything
 * applies at once and is remembered on this device only.
 */
export const CallSoundsSettingsPanel = memo(function CallSoundsSettingsPanel({ onDone, variant = "desktop" }) {
  const prefs = useCallSoundPrefs();
  const [testFailed, setTestFailed] = useState(false);
  const isMobile = variant === "mobile";
  const soundsOn = prefs.enabled;

  const playTest = async () => {
    setTestFailed(false);
    const played = await callSounds.playTest();
    // With the volume at 0 there is nothing to hear on purpose.
    if (!played && prefs.volume > 0) setTestFailed(true);
  };

  return (
    <div className="space-y-4 text-slate-600 dark:text-slate-300">
      <SwitchRow
        label="Call sounds"
        hint="Ringtone, the tone you hear while calling, and short sounds when a call connects or ends"
        checked={soundsOn}
        onChange={(enabled) => setCallSoundPrefs({ enabled })}
        isMobile={isMobile}
        icon={soundsOn ? <Volume2 size={18} className="shrink-0" /> : <VolumeX size={18} className="shrink-0" />}
      />

      <div
        className={`rounded-2xl border border-emerald-200/70 bg-white/90 px-4 py-3 dark:border-emerald-500/30 dark:bg-slate-900/50 ${
          soundsOn ? "" : "opacity-60"
        }`}
      >
        <div className="flex items-center justify-between gap-3">
          <label
            htmlFor="call-sounds-volume"
            className={`font-semibold text-emerald-700 dark:text-emerald-200 ${isMobile ? "text-xs" : "text-sm"}`}
          >
            Ringtone volume
          </label>
          <span aria-hidden="true" className="text-xs font-semibold tabular-nums text-slate-500 dark:text-slate-400">
            {prefs.volume}%
          </span>
        </div>
        <input
          id="call-sounds-volume"
          type="range"
          min="0"
          max="100"
          step="5"
          value={prefs.volume}
          disabled={!soundsOn}
          aria-valuetext={`${prefs.volume} percent`}
          onChange={(event) => setCallSoundPrefs({ volume: Number(event.target.value) })}
          style={{ "--p": prefs.volume / 100 }}
          className="aurelle-range mt-2"
        />
      </div>

      {canVibrate() ? (
        <SwitchRow
          label="Vibrate on incoming calls"
          hint="Also a short buzz when a call connects or ends"
          checked={prefs.vibrate}
          onChange={(vibrate) => setCallSoundPrefs({ vibrate })}
          isMobile={isMobile}
          icon={<Phone size={18} className="shrink-0" />}
        />
      ) : null}

      <div>
        <button
          type="button"
          onClick={playTest}
          disabled={!soundsOn}
          className={`inline-flex w-full items-center justify-center gap-2 rounded-2xl border border-emerald-200/70 bg-white/90 px-4 py-3 font-semibold text-emerald-700 transition hover:border-emerald-300 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-white/90 dark:border-emerald-500/30 dark:bg-slate-900/50 dark:text-emerald-200 dark:hover:bg-emerald-500/10 ${
            isMobile ? "text-xs" : "text-sm"
          }`}
        >
          <Volume2 size={16} className="shrink-0" />
          Play test sound
        </button>
        {testFailed ? (
          <p role="status" className="mt-2 text-xs text-rose-600 dark:text-rose-300">
            Couldn&apos;t play a sound. Check that this tab is not muted and the device volume is up.
          </p>
        ) : null}
      </div>

      <p className="text-[11px] text-slate-500 dark:text-slate-400">
        These settings are for this device only. A call can only ring out loud after you have tapped or typed
        in Aurelle once since opening it; otherwise you still get the call screen and a notification.
      </p>

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
