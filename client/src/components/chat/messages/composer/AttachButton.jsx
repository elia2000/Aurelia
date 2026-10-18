import { File, ImageIcon, Paperclip } from "../../../../icons/lucide.js";

/**
 * The paperclip. It collapses (width and opacity animate, nothing around it
 * jumps) as soon as there is any text and comes back when the field is empty.
 * While collapsed it is `inert`, so it cannot take focus or be tapped.
 * The popup menu lives outside the clipped part so it is not cut off.
 */
export default function AttachButton({
  visible,
  disabled,
  menuOpen,
  menuRef,
  guard,
  onToggleMenu,
  onPickMedia,
  onPickDocument,
}) {
  return (
    <div className="relative mb-px flex shrink-0" ref={menuRef}>
      <div
        inert={!visible}
        aria-hidden={!visible}
        data-visible={visible}
        className="flex overflow-hidden transition-[width,opacity] duration-200 ease-out motion-reduce:transition-none"
        style={{ width: visible ? 36 : 0, opacity: visible ? 1 : 0 }}
      >
        <button
          type="button"
          disabled={disabled}
          {...guard(onToggleMenu)}
          className={`relative inline-flex h-9 w-9 items-center justify-center rounded-full transition after:absolute after:-inset-0.5 after:content-[''] ${
            disabled
              ? "cursor-not-allowed text-slate-400 dark:text-slate-500"
              : "text-emerald-700 hover:bg-emerald-100 dark:text-emerald-200 dark:hover:bg-emerald-500/10"
          }`}
          aria-label="Attach file"
          aria-expanded={menuOpen && visible}
        >
          <Paperclip size={20} className="icon-anim-sway" />
        </button>
      </div>
      {menuOpen && visible && !disabled ? (
        <div className="absolute bottom-full right-0 z-40 mb-2 w-44 overflow-hidden rounded-2xl border border-emerald-200 bg-white p-1 text-sm font-semibold text-slate-700 shadow-xl shadow-emerald-950/10 dark:border-emerald-500/30 dark:bg-slate-900 dark:text-slate-100">
          <button
            type="button"
            {...guard(onPickMedia)}
            className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left transition hover:bg-emerald-50 hover:text-emerald-700 dark:hover:bg-emerald-500/10 dark:hover:text-emerald-200"
          >
            <ImageIcon size={18} className="icon-anim-sway shrink-0 text-emerald-500" />
            Photo or Video
          </button>
          <button
            type="button"
            {...guard(onPickDocument)}
            className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left transition hover:bg-emerald-50 hover:text-emerald-700 dark:hover:bg-emerald-500/10 dark:hover:text-emerald-200"
          >
            <File size={18} className="icon-anim-lift shrink-0 text-emerald-500" />
            Document
          </button>
        </div>
      ) : null}
    </div>
  );
}
