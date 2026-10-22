import { useEffect, useRef, useState } from "react";
import { Check } from "../../icons/lucide.js";
import { DEFAULT_FIXED_LEVEL, FIXED_LEVELS } from "../../calls/mediaTuning.js";
import { FIT_CHOICES } from "../../calls/pictureFit.js";
import { isDefaultOutput } from "../../calls/audioDevices.js";
import { ConnectionSection } from "./QualityParts.jsx";
import { ShortcutsSection } from "./ShortcutsParts.jsx";

function Row({ checked, onClick, children, hint }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 ${
        checked ? "bg-emerald-500/20 text-white" : "text-slate-200 hover:bg-white/10"
      }`}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate">{children}</span>
        {hint ? <span className="block truncate text-[11px] text-slate-400">{hint}</span> : null}
      </span>
      {checked ? <Check size={16} aria-hidden="true" className="shrink-0 text-emerald-300" /> : null}
    </button>
  );
}

function Section({ title, children }) {
  return (
    <div role="radiogroup" aria-label={title} className="space-y-0.5">
      <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400">{title}</p>
      {children}
    </div>
  );
}

/**
 * Auto, or one fixed level on a slider. Switching Auto off goes back to the
 * level that was last used (a good one the first time).
 */
function QualityControl({ quality, onQuality }) {
  const auto = quality === "auto";
  const [lastFixed, setLastFixed] = useState(DEFAULT_FIXED_LEVEL);
  // Remember the last fixed level, so that switching Auto off comes back to it.
  if (!auto && quality !== lastFixed && FIXED_LEVELS.some((level) => level.id === quality)) setLastFixed(quality);
  const shown = auto ? lastFixed : quality;
  const index = Math.max(0, FIXED_LEVELS.findIndex((level) => level.id === shown));
  const level = FIXED_LEVELS[index];
  return (
    <div className="px-3 pb-1">
      <button
        type="button"
        role="switch"
        aria-checked={auto}
        onClick={() => onQuality(auto ? lastFixed : "auto")}
        className="flex w-full items-center gap-3 rounded-xl py-2 text-left text-sm text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300"
      >
        <span className="min-w-0 flex-1">
          <span className="block">Auto</span>
          <span className="block text-[11px] text-slate-400">Keeps the call smooth: adapts to the network</span>
        </span>
        <span
          aria-hidden="true"
          className={`relative h-6 w-11 shrink-0 rounded-full transition ${auto ? "bg-emerald-500" : "bg-slate-600"}`}
        >
          <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${auto ? "left-[22px]" : "left-0.5"}`} />
        </span>
      </button>
      <input
        type="range"
        min={0}
        max={FIXED_LEVELS.length - 1}
        step={1}
        value={index}
        disabled={auto}
        aria-label="Video quality"
        aria-valuetext={auto ? "Auto" : level.label}
        onChange={(event) => onQuality(FIXED_LEVELS[Number(event.target.value)].id)}
        className="mt-1 h-2 w-full cursor-pointer accent-emerald-400 disabled:cursor-default disabled:opacity-40"
      />
      <div aria-hidden="true" className="mt-1 flex justify-between text-[10px]">
        {FIXED_LEVELS.map((item) => (
          <span key={item.id} className={!auto && item.id === shown ? "font-semibold text-white" : "text-slate-400"}>
            {item.short}
          </span>
        ))}
      </div>
      <p className="mt-1 text-[11px] text-slate-400">
        {auto ? "Auto picks the level for you." : `${level.label}: kept even if the network is weak. Switch Auto on if the picture freezes.`}
      </p>
    </div>
  );
}

const describePicture = (stats) =>
  stats ? `Receiving ${stats.width}×${stats.height}${stats.fps ? ` · ${stats.fps} fps` : ""}` : "";

/**
 * The call's settings: where the sound goes, which microphone, and (video
 * calls) how sharp the picture you watch should be. Below the choices: how the
 * connection is doing, in numbers, and the keyboard shortcuts of the call.
 *
 * `clearOf` is the distance in pixels from the bottom edge of the card to the
 * top of something the panel must not cover (the screen-sharing banner, which
 * has to stay readable while the settings are open): the panel then sits above
 * it, and is not taller than what is left.
 */
export default function CallSettingsMenu({
  open,
  onClose,
  audio,
  onPickRoute,
  onPickInput,
  onPickOutput,
  showQuality,
  quality,
  onQuality,
  videoStats,
  screenStats,
  fit,
  onFit,
  connection,
  showShortcuts = false,
  clearOf = 0,
}) {
  const panelRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    // Keyboard users land on the first choice, and Escape closes the menu. The ? key lands on the shortcuts instead.
    if (!showShortcuts) panelRef.current?.querySelector('[role="radio"]')?.focus();
    const onKey = (event) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // Escape belongs to whatever is on top of the call (the safety number, say).
      const call = panelRef.current?.closest('[role="dialog"]');
      const target = event.target;
      if (call && target instanceof Element && target !== document.body && !call.contains(target)) return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, onClose, showShortcuts]);

  if (!open) return null;
  const { model, routeKind, inputId, outputId, outputError, deviceError } = audio;
  const hasAudio = model.routes.length > 0 || model.canPickInput || model.canPickOutput;
  const picture = describePicture(videoStats);
  const sharedScreen = describePicture(screenStats);

  return (
    <>
      {/* A tap anywhere else closes the menu. */}
      <div className="absolute inset-0 z-30" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role="group"
        aria-label="Call settings"
        className="absolute inset-x-3 bottom-24 z-40 max-h-[65%] overflow-y-auto rounded-2xl border border-white/10 bg-slate-900/95 p-2 text-left shadow-2xl backdrop-blur"
        style={
          clearOf > 0
            ? { bottom: `${clearOf + 8}px`, maxHeight: `min(65%, calc(100% - ${clearOf + 8}px - 4.5rem))` }
            : undefined
        }
      >
        {model.routes.length > 0 ? (
          <Section title="Sound">
            {model.routes.map((route) => (
              <Row key={route.id} checked={routeKind === route.kind} onClick={() => onPickRoute(route)}>
                {route.name}
              </Row>
            ))}
          </Section>
        ) : null}
        {model.canPickOutput ? (
          <Section title="Speaker">
            {model.outputs.map((device) => (
              <Row
                key={device.id}
                checked={outputId === device.id || (isDefaultOutput(outputId) && isDefaultOutput(device.id))}
                onClick={() => onPickOutput(device.id)}
              >
                {device.label}
              </Row>
            ))}
          </Section>
        ) : null}
        {model.canPickInput ? (
          <Section title="Microphone">
            {model.inputs.map((device) => (
              <Row key={device.id} checked={inputId === device.id} onClick={() => onPickInput(device.id)}>
                {device.label}
              </Row>
            ))}
          </Section>
        ) : null}
        {outputError ? (
          <p role="status" className="px-3 py-1 text-xs text-amber-200">
            This speaker could not be used. The sound stays where it was.
          </p>
        ) : null}
        {deviceError ? (
          <p role="status" className="px-3 py-1 text-xs text-amber-200">
            {deviceError === "permission_denied"
              ? "The browser did not allow that microphone."
              : deviceError === "no_device"
                ? "That microphone is not available any more."
                : "The microphone could not be switched."}
          </p>
        ) : null}
        {showQuality ? (
          <>
            <div role="group" aria-label="Video quality" className="space-y-0.5">
              <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400">Video quality</p>
              <QualityControl quality={quality} onQuality={onQuality} />
              {picture ? <p className="px-3 pb-1 text-[11px] text-slate-400">{picture}</p> : null}
            </div>
            <Section title="Picture">
              {FIT_CHOICES.map((choice) => (
                <Row key={choice.id} checked={fit === choice.id} onClick={() => onFit(choice.id)} hint={choice.hint}>
                  {choice.label}
                </Row>
              ))}
            </Section>
          </>
        ) : null}
        {sharedScreen ? (
          // Their shared screen always shows whole; it has no quality or picture choice to make.
          <div role="group" aria-label="Shared screen" className="space-y-0.5">
            <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400">Shared screen</p>
            <p className="px-3 pb-1 text-[11px] text-slate-400">{sharedScreen}</p>
          </div>
        ) : null}
        {connection ? (
          <ConnectionSection
            rank={connection.rank}
            reconnecting={connection.reconnecting}
            relayed={connection.relayed}
            stats={connection.stats}
            limit={connection.limit}
          />
        ) : null}
        <ShortcutsSection reveal={showShortcuts} />
        {!hasAudio && !showQuality && !sharedScreen && !connection ? <p className="px-3 py-2 text-sm text-slate-400">Nothing to change.</p> : null}
      </div>
    </>
  );
}
