import { useRef } from "react";

const PICKER_TABS = [
  { id: "emoji", label: "Emoji" },
  { id: "gifs", label: "GIFs" },
];

/**
 * The "Emoji | GIFs" switch at the top of the emoji picker. Arrow keys move
 * between the two tabs, like any tab list.
 */
export default function PickerTabs({ value, onChange }) {
  const refs = useRef({});

  const onKeyDown = (event) => {
    const keys = { ArrowRight: 1, ArrowLeft: -1, Home: "first", End: "last" };
    if (!(event.key in keys)) return;
    event.preventDefault();
    const at = PICKER_TABS.findIndex((tab) => tab.id === value);
    const step = keys[event.key];
    const next =
      step === "first"
        ? 0
        : step === "last"
          ? PICKER_TABS.length - 1
          : (at + step + PICKER_TABS.length) % PICKER_TABS.length;
    const id = PICKER_TABS[next].id;
    onChange(id);
    refs.current[id]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label="Emoji or GIFs"
      onKeyDown={onKeyDown}
      className="flex shrink-0 items-stretch border-b border-emerald-100 dark:border-emerald-500/20"
    >
      {PICKER_TABS.map((tab) => {
        const selected = tab.id === value;
        return (
          <button
            key={tab.id}
            ref={(node) => {
              refs.current[tab.id] = node;
            }}
            type="button"
            role="tab"
            id={`picker-tab-${tab.id}`}
            aria-selected={selected}
            aria-controls={`picker-panel-${tab.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            className={`relative h-9 flex-1 text-xs font-semibold transition duration-150 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-emerald-400 ${
              selected
                ? "text-emerald-700 dark:text-emerald-200"
                : "text-slate-500 hover:bg-emerald-50 hover:text-emerald-700 dark:text-slate-400 dark:hover:bg-emerald-500/10 dark:hover:text-emerald-200"
            }`}
          >
            {tab.label}
            {selected ? (
              <span
                aria-hidden="true"
                className="absolute inset-x-6 bottom-0 h-0.5 rounded-full bg-emerald-500 dark:bg-emerald-400"
              />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
