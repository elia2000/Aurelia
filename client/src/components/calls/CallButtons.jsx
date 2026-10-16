import { lazy, Suspense, useState } from "react";
import { Phone, ShieldCheck, Video } from "../../icons/lucide.js";
import { useCalls } from "../../calls/callContext.js";
import { useHeaderActions } from "../../calls/useHeaderActions.js";

// The safety-number screen pulls in the crypto code, so it loads on demand.
const SafetyNumberModal = lazy(() => import("./SafetyNumberModal.jsx"));

const base =
  "inline-flex h-8 w-8 items-center justify-center rounded-full border border-emerald-200 bg-white/80 text-emerald-700 transition hover:border-emerald-300 hover:shadow-[0_0_14px_color-mix(in_srgb,var(--color-emerald-500)_20%,transparent)] disabled:cursor-not-allowed disabled:opacity-50 dark:border-emerald-500/30 dark:bg-slate-950 dark:text-emerald-200";

/**
 * Encryption and call buttons for the header of a direct chat: the safety
 * number (so a contact can be verified without being in a call) and, when the
 * server and browser support it, voice and video calls.
 */
export default function CallButtons({ chatId, peer, user }) {
  const { inCall, startCall } = useCalls();
  const actions = useHeaderActions(peer);
  const [safetyOpen, setSafetyOpen] = useState(false);
  if (!actions.count) return null;

  const start = (kind) =>
    startCall({
      chatId,
      kind,
      peer: {
        userId: peer.id,
        username: peer.username,
        nickname: peer.nickname,
        avatarUrl: peer.avatar_url,
        color: peer.color,
      },
    });

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {actions.verify ? (
        <button
          type="button"
          className={base}
          onClick={() => setSafetyOpen(true)}
          aria-label="Encryption and safety number"
          title="Encryption and safety number"
        >
          <ShieldCheck size={15} />
        </button>
      ) : null}
      {actions.calls ? (
        <>
          <button type="button" className={base} disabled={inCall} onClick={() => start("audio")} aria-label="Voice call" title="Voice call">
            <Phone size={15} />
          </button>
          <button type="button" className={base} disabled={inCall} onClick={() => start("video")} aria-label="Video call" title="Video call">
            <Video size={15} />
          </button>
        </>
      ) : null}
      {safetyOpen ? (
        <Suspense fallback={null}>
          <SafetyNumberModal
            open
            onClose={() => setSafetyOpen(false)}
            selfUser={user}
            chatId={chatId}
            peer={{ userId: peer.id, username: peer.username, nickname: peer.nickname }}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
