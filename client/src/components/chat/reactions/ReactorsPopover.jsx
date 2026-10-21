import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Avatar from "../../common/Avatar.jsx";
import ReactionEmoji from "./ReactionEmoji.jsx";
import { Close } from "../../../icons/lucide.js";
import { listMessageReactors } from "../../../api/reactionsApi.js";
import { useMessageReactions } from "../../../hooks/chat/useMessageReactions.js";
import { useFocusTrap } from "../../../hooks/useFocusTrap.js";
import { hasPersian } from "../../../utils/fontUtils.js";
import {
  REACTION_USERS_CAP,
  buildReactorRows,
  normalizeReactorGroups,
  reactorsErrorMessage,
} from "../../../utils/reactions.js";
import "./reactions.css";

const EDGE_GAP = 12;
const ANCHOR_GAP = 8;
const SHEET_BREAKPOINT_PX = 640;
// Right after the list opened from a long press, the press is still going.
const OPENING_PRESS_MS = 800;

const LOADING = { status: "loading", groups: [], total: 0, truncated: false };

/**
 * Where the panel goes. A phone gets a sheet from the bottom; a wide screen
 * gets a popover under the chip (above it when there is no room below).
 */
function computePlacement(anchorEl) {
  if (typeof window === "undefined") return { sheet: false };
  if (window.innerWidth < SHEET_BREAKPOINT_PX || !anchorEl?.isConnected) {
    return { sheet: window.innerWidth < SHEET_BREAKPOINT_PX };
  }
  const rect = anchorEl.getBoundingClientRect();
  const spaceBelow = window.innerHeight - rect.bottom - EDGE_GAP - ANCHOR_GAP;
  const spaceAbove = rect.top - EDGE_GAP - ANCHOR_GAP;
  const below = spaceBelow >= 260 || spaceBelow >= spaceAbove;
  const maxHeight = Math.max(160, Math.min(384, below ? spaceBelow : spaceAbove));
  return {
    sheet: false,
    left: Math.max(EDGE_GAP, Math.min(rect.left, window.innerWidth - 288 - EDGE_GAP)),
    ...(below
      ? { top: rect.bottom + ANCHOR_GAP }
      : { bottom: window.innerHeight - rect.top + ANCHOR_GAP }),
    maxHeight,
  };
}

function ReactorRow({ row }) {
  const persian = hasPersian(row.name);
  return (
    <li className="flex items-center gap-3 px-3 py-1.5" data-reactor-row>
      <Avatar
        src={row.avatarUrl}
        alt={row.name}
        name={row.name}
        color={row.color || "#10b981"}
        className="h-9 w-9 shrink-0 text-xs font-semibold text-white"
      />
      {/* The name sits next to the picture whatever its script: an inline box
          as wide as the name, not a block that pushes it to the far side. */}
      <span className="min-w-0 flex-1 text-sm font-medium text-slate-800 dark:text-slate-100">
        <span
          dir="auto"
          className={`inline-block max-w-full truncate align-top ${persian ? "font-fa" : ""}`}
        >
          {row.name}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-1" aria-label={`Reacted ${row.emojis.join(" ")}`}>
        {row.emojis.map((emoji) => (
          <ReactionEmoji key={emoji} emoji={emoji} size={18} />
        ))}
      </span>
    </li>
  );
}

/**
 * Who reacted to a message, with a tab per emoji. It asks the server once for
 * everybody and filters on the screen; when the numbers under the message
 * change it asks again. Mount it only when it should be open.
 */
export default function ReactorsPopover({ chatId, messageId, initialEmoji = "", anchorEl = null, onClose }) {
  const panelRef = useRef(null);
  const openedAtRef = useRef(0);
  const [data, setData] = useState(LOADING);
  const [tab, setTab] = useState(initialEmoji || "");
  const [reloadToken, setReloadToken] = useState(0);
  const [placement, setPlacement] = useState(() => computePlacement(anchorEl));

  const live = useMessageReactions(messageId);
  const signature = live.map((item) => `${item.emoji}:${item.count}`).join("|");

  useFocusTrap(panelRef, true);

  useEffect(() => {
    openedAtRef.current = Date.now();
  }, []);

  useEffect(() => {
    // Every reaction was taken back: nothing left to list.
    if (!signature) onClose?.();
  }, [signature, onClose]);

  useEffect(() => {
    if (!signature) return undefined;
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await listMessageReactors({ chatId, messageId, signal: controller.signal });
        const body = await response.json().catch(() => null);
        if (controller.signal.aborted) return;
        if (!response.ok) {
          setData({
            status: "error",
            groups: [],
            total: 0,
            truncated: false,
            error: reactorsErrorMessage(response.status, body?.error),
            retry: response.status !== 403 && response.status !== 404,
          });
          return;
        }
        setData({ status: "ready", ...normalizeReactorGroups(body) });
      } catch {
        if (controller.signal.aborted) return;
        setData({
          status: "error",
          groups: [],
          total: 0,
          truncated: false,
          error: "Couldn't load the list. Check your connection.",
          retry: true,
        });
      }
    };
    void load();
    return () => controller.abort();
  }, [chatId, messageId, signature, reloadToken]);

  useLayoutEffect(() => {
    const place = () => setPlacement(computePlacement(anchorEl));
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchorEl, data.status]);

  useEffect(() => {
    // First in line, so Escape closes this and not the chat behind it.
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      event.preventDefault();
      onClose?.();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const activeTab = data.groups.some((group) => group.emoji === tab) ? tab : "";
  const rows = useMemo(() => buildReactorRows(data.groups, activeTab), [data.groups, activeTab]);
  const retry = useCallback(() => {
    setData(LOADING);
    setReloadToken((token) => token + 1);
  }, []);

  if (typeof document === "undefined") return null;

  const sheet = Boolean(placement.sheet);
  const panelStyle = sheet
    ? { paddingBottom: "env(safe-area-inset-bottom)" }
    : {
        left: placement.left ?? EDGE_GAP,
        top: placement.top,
        bottom: placement.bottom,
        maxHeight: placement.maxHeight,
      };

  return createPortal(
    <div
      className="fixed inset-0 z-210"
      onContextMenu={(event) => {
        event.preventDefault();
        // A long press that opened this list sends its own context menu event a
        // moment later, to whatever is under the finger: this backdrop.
        if (Date.now() - openedAtRef.current < OPENING_PRESS_MS) return;
        onClose?.();
      }}
    >
      <button
        type="button"
        aria-label="Close"
        tabIndex={-1}
        className={`absolute inset-0 h-full w-full cursor-default border-0 p-0 ${
          sheet ? "bg-black/40" : "bg-transparent"
        }`}
        onClick={() => onClose?.()}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Who reacted"
        data-reactors-popover
        className={`sb-reaction-bar fixed flex flex-col overflow-hidden border border-emerald-200 bg-white text-slate-900 shadow-[0_18px_46px_rgba(15,23,42,0.22)] dark:border-emerald-500/30 dark:bg-slate-900 dark:text-slate-100 ${
          sheet
            ? "inset-x-0 bottom-0 max-h-[70vh] rounded-t-2xl"
            : "w-72 rounded-2xl"
        }`}
        style={panelStyle}
      >
        <div className="flex items-center gap-1 border-b border-emerald-100 p-1.5 dark:border-emerald-500/20">
          <div
            role="tablist"
            aria-label="Reactions"
            className="flex min-w-0 flex-1 gap-1 overflow-x-auto"
          >
            {data.groups.length > 1 ? (
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === ""}
                onClick={() => setTab("")}
                className={`inline-flex h-8 shrink-0 items-center gap-1 rounded-full px-2.5 text-xs font-semibold transition ${
                  activeTab === ""
                    ? "bg-emerald-500 text-white"
                    : "text-slate-600 hover:bg-emerald-50 dark:text-slate-300 dark:hover:bg-emerald-500/10"
                }`}
              >
                All
                <span className="tabular-nums">{data.total}</span>
              </button>
            ) : null}
            {data.groups.map((group) => (
              <button
                key={group.emoji}
                type="button"
                role="tab"
                aria-selected={activeTab === group.emoji || data.groups.length === 1}
                aria-label={`${group.emoji} ${group.count}`}
                onClick={() => setTab(group.emoji)}
                className={`inline-flex h-8 shrink-0 items-center gap-1 rounded-full px-2.5 text-xs font-semibold transition ${
                  activeTab === group.emoji || data.groups.length === 1
                    ? "bg-emerald-500 text-white"
                    : "text-slate-600 hover:bg-emerald-50 dark:text-slate-300 dark:hover:bg-emerald-500/10"
                }`}
              >
                <ReactionEmoji emoji={group.emoji} size={15} />
                <span className="tabular-nums">{group.count}</span>
              </button>
            ))}
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={() => onClose?.()}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-slate-500 transition hover:bg-emerald-50 dark:text-slate-300 dark:hover:bg-emerald-500/10"
          >
            <Close size={16} />
          </button>
        </div>
        <div className="chat-scroll min-h-16 flex-1 overflow-y-auto py-1">
          {data.status === "loading" ? (
            <p role="status" className="px-4 py-5 text-center text-sm text-slate-500 dark:text-slate-400">
              Loading…
            </p>
          ) : data.status === "error" ? (
            <div role="alert" className="px-4 py-4 text-center text-sm text-slate-600 dark:text-slate-300">
              <p>{data.error}</p>
              {data.retry ? (
                <button
                  type="button"
                  onClick={retry}
                  className="mt-2 rounded-full border border-emerald-300 px-3 py-1 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-50 dark:border-emerald-500/40 dark:text-emerald-200 dark:hover:bg-emerald-500/10"
                >
                  Try again
                </button>
              ) : null}
            </div>
          ) : rows.length ? (
            <>
              <ul aria-label="People who reacted">
                {rows.map((row) => (
                  <ReactorRow key={row.id} row={row} />
                ))}
              </ul>
              {data.truncated ? (
                <p className="px-4 py-2 text-center text-xs text-slate-500 dark:text-slate-400">
                  Showing the first {REACTION_USERS_CAP} people.
                </p>
              ) : null}
            </>
          ) : (
            <p className="px-4 py-5 text-center text-sm text-slate-500 dark:text-slate-400">No reactions yet.</p>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
