import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GifIcon, ImagePlus, LoaderCircle, Trash } from "../../../icons/lucide.js";
import { savedGifs } from "../../../gifs/savedGifsStore.js";
import { useSavedGifsState } from "../../../gifs/useSavedGifs.js";
import { SAVED_GIF_ACCEPT } from "../../../utils/animatedImage.js";
import ContextMenuSurface from "../../context-menu/ContextMenuSurface.jsx";

const SKELETON_TILES = 9;
const MENU_WIDTH_PX = 208;
const MENU_HEIGHT_PX = 52;
const MENU_MARGIN_PX = 8;
// Two taps on the same tile within this time send one GIF, not two.
const SEND_COOLDOWN_MS = 700;

const detectTouch = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(pointer: coarse)").matches
    : false;

const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));

function GifTile({ gif, index, isTouch, onSend, onOpenMenu }) {
  const contextMenu = useMemo(
    () => ({
      isMobile: isTouch,
      onOpen: ({ event, targetEl }) => onOpenMenu(gif, event, targetEl),
    }),
    [gif, isTouch, onOpenMenu],
  );
  return (
    <ContextMenuSurface
      as="button"
      type="button"
      contextMenu={contextMenu}
      // A long press on a picture must open our menu, not the browser's.
      onContextMenu={(event) => event.preventDefault()}
      onClick={() => onSend(gif)}
      aria-label={`Send GIF ${index + 1}`}
      data-gif-id={gif.id}
      className="relative block aspect-square w-full overflow-hidden bg-slate-100 outline-hidden transition duration-150 [-webkit-touch-callout:none] hover:brightness-90 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-400 dark:bg-slate-800"
    >
      <img
        src={gif.url}
        alt=""
        loading="lazy"
        decoding="async"
        draggable="false"
        className="absolute inset-0 block h-full w-full select-none object-cover"
      />
    </ContextMenuSurface>
  );
}

// The menu of one GIF. It is drawn inside the panel (not on the page body) so a
// press on it is not a press outside the emoji picker, which would close it.
function GifTileMenu({ menu, onClose, onRemove }) {
  const itemRef = useRef(null);

  useEffect(() => {
    itemRef.current?.focus({ preventScroll: true });
    // Above the picker's own Escape handling, which closes the whole picker.
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      event.stopImmediatePropagation();
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div className="absolute inset-0 z-20" onContextMenu={(event) => event.preventDefault()}>
      <button
        type="button"
        aria-label="Close menu"
        tabIndex={-1}
        className="absolute inset-0 h-full w-full cursor-default border-0 bg-transparent p-0"
        onClick={onClose}
      />
      <div
        role="menu"
        aria-label="GIF options"
        className="absolute overflow-hidden rounded-2xl border border-slate-300/80 bg-white py-1 text-slate-900 shadow-[0_12px_32px_rgba(15,23,42,0.22)] dark:border-white/10 dark:bg-slate-800 dark:text-slate-100"
        style={{ left: `${menu.left}px`, top: `${menu.top}px`, width: `${MENU_WIDTH_PX}px` }}
      >
        <button
          ref={itemRef}
          type="button"
          role="menuitem"
          onClick={onRemove}
          className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-rose-600 transition hover:bg-black/5 focus:bg-black/5 focus:outline-hidden dark:text-rose-300 dark:hover:bg-white/10 dark:focus:bg-white/10"
        >
          <Trash size={16} aria-hidden="true" className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">Remove from saved</span>
        </button>
      </div>
    </div>
  );
}

/**
 * The person's own saved GIFs: a dense grid, newest first, a counter against the
 * limit the server reports, and a button to add a GIF from the device. Tapping a
 * GIF sends it; a right click or a long press offers to remove it.
 */
export default function GifsPanel({
  onSend,
  canAdd = true,
  isTouch = detectTouch(),
  onMenuOpenChange,
  store = savedGifs,
}) {
  const state = useSavedGifsState(store);
  const rootRef = useRef(null);
  const fileInputRef = useRef(null);
  const lastSendRef = useRef(0);
  const menuReturnRef = useRef(null);
  const [menu, setMenu] = useState(null);

  useEffect(() => {
    if (state.status === "idle") void store.load();
  }, [state.status, store]);

  useEffect(() => {
    onMenuOpenChange?.(Boolean(menu));
    return () => onMenuOpenChange?.(false);
  }, [menu, onMenuOpenChange]);

  const handleSend = useCallback(
    (gif) => {
      const now = Date.now();
      if (now - lastSendRef.current < SEND_COOLDOWN_MS) return;
      lastSendRef.current = now;
      onSend?.(gif);
    },
    [onSend],
  );

  const openMenu = useCallback((gif, event, targetEl) => {
    const rect = targetEl?.getBoundingClientRect?.() || null;
    const panel = rootRef.current?.getBoundingClientRect?.() || null;
    const x = Number(event?.clientX) || rect?.left || 0;
    const y = Number(event?.clientY) || rect?.bottom || 0;
    menuReturnRef.current = targetEl || null;
    // Where the menu sits inside the panel, kept in the panel by its edges.
    setMenu({
      gifId: gif.id,
      left: panel ? clamp(x - panel.left, MENU_MARGIN_PX, panel.width - MENU_WIDTH_PX - MENU_MARGIN_PX) : MENU_MARGIN_PX,
      top: panel ? clamp(y - panel.top, MENU_MARGIN_PX, panel.height - MENU_HEIGHT_PX - MENU_MARGIN_PX) : MENU_MARGIN_PX,
    });
  }, []);

  const closeMenu = useCallback(() => {
    setMenu(null);
    const back = menuReturnRef.current;
    menuReturnRef.current = null;
    if (back?.isConnected) back.focus({ preventScroll: true });
  }, []);

  const removeFromMenu = useCallback(() => {
    const id = menu?.gifId;
    closeMenu();
    if (id) void store.remove(id);
  }, [closeMenu, menu, store]);

  const pickFile = (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void store.uploadFile(file);
  };

  const { gifs, status, limit, count, uploading } = state;
  const full = Boolean(limit) && count >= limit;

  let content;
  if (status === "error" && gifs.length === 0) {
    content = (
      <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 px-6 py-8 text-center">
        <p className="text-sm text-slate-600 dark:text-slate-300">{state.error || "Unable to load your GIFs."}</p>
        <button
          type="button"
          onClick={() => store.load({ force: true })}
          className="rounded-full border border-emerald-200 px-4 py-1.5 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-50 dark:border-emerald-500/30 dark:text-emerald-200 dark:hover:bg-emerald-500/10"
        >
          Try again
        </button>
      </div>
    );
  } else if (status !== "ready") {
    content = (
      <div role="status" aria-label="Loading GIFs" className="grid grid-cols-3 gap-0.5">
        {Array.from({ length: SKELETON_TILES }, (_, i) => (
          <div key={i} className="aspect-square animate-pulse bg-slate-100 dark:bg-slate-800" />
        ))}
      </div>
    );
  } else if (gifs.length === 0) {
    content = (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-8 text-center">
        <span className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-200">
          <GifIcon size={24} aria-hidden="true" />
        </span>
        <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">No saved GIFs yet</h3>
        <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          Open the menu of any GIF in a chat and choose <strong className="font-semibold">Save GIF</strong>
          {canAdd ? (
            <>
              , or use <strong className="font-semibold">Add GIF</strong> to pick one from your device
            </>
          ) : null}
          . Only you can see your GIFs
          {limit ? `, up to ${limit}. When the collection is full, the oldest GIF is removed.` : "."}
        </p>
      </div>
    );
  } else {
    content = (
      <ul className="grid grid-cols-3 gap-0.5">
        {gifs.map((gif, index) => (
          <li key={gif.id} className="min-w-0">
            <GifTile gif={gif} index={index} isTouch={isTouch} onSend={handleSend} onOpenMenu={openMenu} />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div ref={rootRef} className="relative flex min-h-0 flex-1 flex-col" data-testid="gif-panel">
      <div className="flex items-center justify-between gap-2 border-b border-emerald-100 px-3 py-2 dark:border-emerald-500/20">
        <p
          className={`text-xs font-semibold ${
            full ? "text-amber-600 dark:text-amber-400" : "text-slate-500 dark:text-slate-400"
          }`}
        >
          {status === "ready" ? (
            <>
              <span aria-hidden="true">{limit ? `${count}/${limit}` : count}</span>
              <span className="sr-only">{limit ? `${count} of ${limit} GIFs saved` : `${count} GIFs saved`}</span>
              <span aria-hidden="true" className="ml-1 font-normal">
                saved
              </span>
            </>
          ) : (
            <span className="font-normal">My GIFs</span>
          )}
        </p>
        {canAdd ? (
          <button
            type="button"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex h-7 items-center gap-1.5 rounded-full border border-emerald-200 px-3 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-emerald-500/30 dark:text-emerald-200 dark:hover:bg-emerald-500/10"
          >
            {uploading ? (
              <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />
            ) : (
              <ImagePlus size={14} aria-hidden="true" />
            )}
            {uploading ? "Adding…" : "Add GIF"}
          </button>
        ) : null}
      </div>

      <div data-touch-scroll="" className="chat-scroll min-h-0 flex-1 overflow-y-auto">
        {content}
      </div>

      {canAdd ? (
        <input
          ref={fileInputRef}
          type="file"
          accept={SAVED_GIF_ACCEPT}
          className="sr-only"
          tabIndex={-1}
          aria-label="Choose a GIF from your device"
          onChange={pickFile}
        />
      ) : null}

      {menu ? <GifTileMenu menu={menu} onClose={closeMenu} onRemove={removeFromMenu} /> : null}
    </div>
  );
}
