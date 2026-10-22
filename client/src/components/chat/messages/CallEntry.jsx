import { memo, useCallback } from "react";
import { Phone, Video } from "../../../icons/lucide.js";
import CallDirectionIcon from "../../common/CallDirectionIcon.jsx";
import { useCalls } from "../../../calls/callContext.js";
import { useHeaderActions } from "../../../calls/useHeaderActions.js";
import { toCallPeer } from "../../../calls/callPeer.js";
import { describeCall } from "../../../utils/callEntry.js";

// Arrow and reason: red for a call nobody talked in, the app's green otherwise.
// The own bubble is green too, so its colours are one step darker to stay readable.
const TONE = {
  own: {
    ok: "text-emerald-800 dark:text-emerald-100",
    bad: "text-rose-700 dark:text-rose-200",
  },
  other: {
    ok: "text-emerald-600 dark:text-emerald-400",
    bad: "text-rose-600 dark:text-rose-400",
  },
};

const BUTTON =
  "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white shadow-xs transition duration-150 hover:bg-emerald-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-emerald-400 dark:text-emerald-950 dark:hover:bg-emerald-300 dark:focus-visible:outline-emerald-300";

/**
 * The round button of a call entry: starts a new call of the same kind to the
 * same person (a phone for voice entries, a camera for video entries). It is
 * off while another call is going on and when calls are not available (no
 * server support, a deleted account), like the buttons in the chat header.
 */
export function CallBackButton({ kind, label, chatId, peer }) {
  const { inCall, startCall } = useCalls();
  const actions = useHeaderActions(peer);
  const available = actions.calls && Boolean(chatId);
  const start = useCallback(() => {
    if (!available || inCall) return;
    // The call screen reports why a call could not start; nothing to add here.
    Promise.resolve(startCall({ chatId, kind, peer: toCallPeer(peer) })).catch(() => {});
  }, [available, chatId, inCall, kind, peer, startCall]);
  const Icon = kind === "video" ? Video : Phone;
  const hint = inCall
    ? "Finish your current call first"
    : available
      ? label
      : "Calls are unavailable";
  return (
    <button
      type="button"
      data-call-back={kind}
      className={BUTTON}
      disabled={!available || inCall}
      onClick={start}
      aria-label={label}
      title={hint}
    >
      <Icon size={18} aria-hidden="true" />
    </button>
  );
}

/**
 * A call history entry drawn inside a message bubble: the arrow for the
 * direction, the title ("Outgoing video call"), the length or the reason, and
 * the button that calls back. The time is the bubble's own MessageMeta.
 * `inert`: selection mode, in which nothing inside the row acts or takes focus.
 */
function CallEntry({ msg, isOwn, chatId, peer = null, inert = false }) {
  const view = describeCall(msg?.call, { outgoing: isOwn });
  const tone = TONE[isOwn ? "own" : "other"][view.tone];
  return (
    <div
      data-call-entry
      data-call-kind={view.kind}
      data-call-outcome={view.outcome}
      data-call-direction={view.direction}
      // While messages are being selected a click only ticks the row.
      inert={inert || undefined}
      className="flex items-center gap-3"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-semibold leading-[1.25]">{view.title}</p>
        <p className={`mt-0.5 flex items-center gap-1 text-[13px] leading-[1.25] ${tone}`}>
          <CallDirectionIcon direction={view.direction} />
          {view.subtitle ? (
            <>
              <span aria-hidden="true">{view.subtitle}</span>
              <span className="sr-only">{view.subtitleSpoken}</span>
            </>
          ) : null}
        </p>
      </div>
      <CallBackButton
        kind={view.callBack.kind}
        label={view.callBack.label}
        chatId={chatId}
        peer={peer}
      />
    </div>
  );
}

export default memo(CallEntry);
