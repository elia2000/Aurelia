import { GifIcon } from "../../../icons/lucide.js";
import { describeEviction, savedGifs } from "../../../gifs/savedGifsStore.js";
import { useSavedGifsOwner, useSavedGifsState } from "../../../gifs/useSavedGifs.js";

/**
 * Mount once, inside the signed-in app. It keeps the saved-GIFs store bound to
 * the signed-in person (so one account never sees another's GIFs) and shows the
 * notice that stays until it is dismissed when the oldest GIFs were removed to
 * make room ("Your GIF collection is full (50 GIFs). The oldest GIF was removed.").
 */
export default function SavedGifsHost({ ownerKey, store = savedGifs }) {
  useSavedGifsOwner(ownerKey, store);
  const { notice } = useSavedGifsState(store);
  if (!notice) return null;
  return (
    <div
      // Like the toasts (ToastHost): on a wide screen it centres over the chat,
      // not over the whole window including the chat list.
      className="pointer-events-none fixed inset-x-0 z-340 flex justify-center px-4 md:left-[35%]"
      style={{ bottom: "calc(8.5rem + env(safe-area-inset-bottom))" }}
    >
      {/* A new alert element for every removal, so it is read out again. */}
      <div
        key={notice.id}
        role="alert"
        data-testid="gif-collection-notice"
        data-keeps-picker-open=""
        className="pointer-events-auto flex w-full max-w-sm items-center gap-3 rounded-2xl border border-amber-300/70 bg-white p-3 pr-2.5 text-slate-800 shadow-xl shadow-slate-900/15 dark:border-amber-500/40 dark:bg-slate-900 dark:text-slate-100"
      >
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
          <GifIcon size={18} aria-hidden="true" />
        </span>
        <p className="min-w-0 flex-1 text-sm leading-snug">{describeEviction(notice)}</p>
        <button
          type="button"
          onClick={() => store.dismissNotice()}
          className="h-8 shrink-0 rounded-full bg-emerald-600 px-4 text-xs font-semibold text-white transition duration-150 hover:bg-emerald-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500 dark:bg-emerald-400 dark:text-emerald-950 dark:hover:bg-emerald-300"
        >
          OK
        </button>
      </div>
    </div>
  );
}
