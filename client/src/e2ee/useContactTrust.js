import { useCallback, useEffect, useRef, useState } from "react";
import { getE2eeServices } from "./services.js";
import { isE2eeSupported } from "./support.js";
import { TRUST } from "./trust.js";
import { CONTACT_TRUST, classifyContactTrust, loadContactTrust } from "./contactTrust.js";

const SETTLE_MS = 200;

/**
 * The state of one contact for the shield in the chat header:
 * `{state: "verified"|"unverified"|"changed", mismatch, ready, refresh}`.
 * It follows what the trust tracker sees (a device added, a number verified)
 * and never blocks anything itself.
 */
export function useContactTrust({ selfUserId, peerUserId, chatId, enabled = true }) {
  const [result, setResult] = useState({ state: CONTACT_TRUST.UNVERIFIED, mismatch: false, ready: false });
  const refreshRef = useRef(() => {});
  const active = Boolean(enabled && selfUserId && peerUserId && isE2eeSupported());

  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    let timer = null;
    let lastSignature = `${TRUST.OK}|||`;
    setResult({ state: CONTACT_TRUST.UNVERIFIED, mismatch: false, ready: false });

    const run = async () => {
      try {
        const info = await loadContactTrust({ services: getE2eeServices(), selfUserId, peerUserId, chatId });
        if (!cancelled) setResult({ state: classifyContactTrust(info), mismatch: false, ready: true });
      } catch (error) {
        if (cancelled) return;
        // A contact whose keys conflict is the worst case; anything else (offline, no
        // devices yet) says nothing new, so the shield keeps what it showed.
        if (error?.name === "KeyMismatchError") setResult({ state: CONTACT_TRUST.CHANGED, mismatch: true, ready: true });
        else setResult((previous) => ({ ...previous, ready: true }));
      }
    };
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(run, SETTLE_MS);
    };
    refreshRef.current = schedule;
    run();

    let unsubscribe = () => {};
    try {
      unsubscribe = getE2eeServices().trust.subscribe((event) => {
        if (event.userId !== peerUserId) return;
        if (event.type === "assessed") {
          // Every lookup is reported; only a lookup that saw something different is news.
          const signature = [
            event.status === TRUST.NEW ? TRUST.OK : event.status,
            event.added.join(),
            event.removed.join(),
            event.mismatched.join(),
          ].join("|");
          if (signature === lastSignature) return;
          lastSignature = signature;
        }
        schedule();
      });
    } catch {
      // No secure storage: the shield stays as it is.
    }
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [active, selfUserId, peerUserId, chatId]);

  const refresh = useCallback(() => refreshRef.current(), []);
  return { ...result, refresh };
}
