import { lazy, Suspense, useEffect, useState } from "react";
import { Phone, Shield, ShieldAlert, ShieldCheck, Video } from "../../icons/lucide.js";
import { useCalls } from "../../calls/callContext.js";
import { useHeaderActions } from "../../calls/useHeaderActions.js";
import { toCallPeer } from "../../calls/callPeer.js";
import { CONTACT_TRUST } from "../../e2ee/contactTrust.js";
import { onSafetyNumberRequest } from "../../e2ee/safetyNumberRequests.js";
import { useContactTrust } from "../../e2ee/useContactTrust.js";

// The safety-number screen pulls in the crypto code, so it loads on demand.
const SafetyNumberModal = lazy(() => import("./SafetyNumberModal.jsx"));

const layout =
  "inline-flex h-8 w-8 items-center justify-center rounded-full border transition disabled:cursor-not-allowed disabled:opacity-50";
const plain =
  "border-emerald-200 bg-white/80 text-emerald-700 hover:border-emerald-300 hover:shadow-[0_0_14px_color-mix(in_srgb,var(--color-emerald-500)_20%,transparent)] dark:border-emerald-500/30 dark:bg-slate-950 dark:text-emerald-200";
const base = `${layout} ${plain}`;

// The shield says where this contact stands: verified (green), not verified (plain), or changed
// (red: a new device or a number that no longer holds). The label says the same in words.
const SHIELD = {
  [CONTACT_TRUST.VERIFIED]: {
    Icon: ShieldCheck,
    label: "Encryption and safety number: verified",
    title: "Verified. Open the safety number",
    className:
      "border-emerald-400 bg-emerald-50 text-emerald-800 hover:shadow-[0_0_14px_color-mix(in_srgb,var(--color-emerald-500)_25%,transparent)] dark:border-emerald-400/50 dark:bg-emerald-500/15 dark:text-emerald-100",
  },
  [CONTACT_TRUST.UNVERIFIED]: {
    Icon: Shield,
    label: "Encryption and safety number: not verified",
    title: "Not verified yet. Open the safety number",
    className: plain,
  },
  [CONTACT_TRUST.CHANGED]: {
    Icon: ShieldAlert,
    label: "Encryption and safety number: changed, review it",
    title: "The safety number changed. Review it",
    className:
      "border-rose-400 bg-rose-50 text-rose-700 hover:shadow-[0_0_14px_rgba(244,63,94,0.2)] dark:border-rose-400/50 dark:bg-rose-500/15 dark:text-rose-200",
  },
};

/**
 * Encryption and call buttons for the header of a direct chat: the safety
 * number (so a contact can be verified without being in a call) and, when the
 * server and browser support it, voice and video calls.
 */
export default function CallButtons({ chatId, peer, user }) {
  const { inCall, startCall } = useCalls();
  const actions = useHeaderActions(peer);
  const [safetyOpen, setSafetyOpen] = useState(false);
  const trust = useContactTrust({
    selfUserId: user?.id,
    peerUserId: peer?.id,
    chatId,
    enabled: actions.verify,
  });
  const shield = SHIELD[trust.state] || SHIELD[CONTACT_TRUST.UNVERIFIED];

  // A notice in the conversation ("Verify") opens this chat's safety number.
  useEffect(
    () => onSafetyNumberRequest((requested) => {
      if (requested === String(chatId)) setSafetyOpen(true);
    }),
    [chatId],
  );
  if (!actions.count) return null;

  const start = (kind) => startCall({ chatId, kind, peer: toCallPeer(peer) });

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {actions.verify ? (
        <button
          type="button"
          className={`${layout} ${shield.className}`}
          onClick={() => setSafetyOpen(true)}
          aria-label={shield.label}
          title={shield.title}
          data-trust={trust.state}
        >
          <shield.Icon size={15} />
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
            onChanged={trust.refresh}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
