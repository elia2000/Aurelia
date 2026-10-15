import { Phone, Video } from "../../icons/lucide.js";
import { useCalls } from "../../calls/callContext.js";
import { CHAT_PAGE_CONFIG } from "../../settings/chatPageConfig.js";

/** Voice / video call buttons for the header of a direct chat. */
export default function CallButtons({ chatId, peer }) {
  const { supported, inCall, startCall } = useCalls();
  if (!supported || CHAT_PAGE_CONFIG.callsEnabled === false || !peer?.id || peer.isDeleted) return null;

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

  const base =
    "inline-flex h-8 w-8 items-center justify-center rounded-full border border-emerald-200 bg-white/80 text-emerald-700 transition hover:border-emerald-300 hover:shadow-[0_0_14px_rgba(16,185,129,0.2)] disabled:cursor-not-allowed disabled:opacity-50 dark:border-emerald-500/30 dark:bg-slate-950 dark:text-emerald-200";

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <button type="button" className={base} disabled={inCall} onClick={() => start("audio")} aria-label="Voice call" title="Voice call">
        <Phone size={15} />
      </button>
      <button type="button" className={base} disabled={inCall} onClick={() => start("video")} aria-label="Video call" title="Video call">
        <Video size={15} />
      </button>
    </div>
  );
}
