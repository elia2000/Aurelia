import { useEffect, useMemo, useSyncExternalStore } from "react";
import { getE2eeServices } from "./services.js";
import { isE2eeSupported } from "./support.js";
import { getKeyNoticeStore, mergeKeyNotices } from "./keyChangeNotices.js";

// How often an open direct chat looks its contact up again, and how soon after the last look
// a window coming back to the front may do it again.
const RECHECK_MS = 2 * 60 * 1000;
const MIN_GAP_MS = 10 * 1000;

// Everything the trust tracker says is written down as notices for the signed-in person. Two
// places ask for that (the app's call layer and an open chat); it is one subscription.
let recorder = null;

/** Starts writing the tracker's findings into the notices store; call the result to let go. */
export function retainKeyNoticeRecorder(selfUserId, { trust, store = getKeyNoticeStore() } = {}) {
  if (!selfUserId) return () => {};
  let tracker = trust;
  try {
    tracker ||= getE2eeServices().trust;
  } catch {
    return () => {};
  }
  if (recorder && (recorder.selfUserId !== selfUserId || recorder.trust !== tracker || recorder.store !== store)) {
    recorder.stop();
    recorder = null;
  }
  if (!recorder) {
    const stop = tracker.subscribe((event) => store.handleTrustEvent(selfUserId, event));
    recorder = { selfUserId, trust: tracker, store, count: 0, stop: () => { stop(); } };
  }
  const mine = recorder;
  mine.count += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    mine.count -= 1;
    if (mine.count <= 0) {
      mine.stop();
      if (recorder === mine) recorder = null;
    }
  };
}

/** The notices of one contact, as they are right now. */
export function useKeyNotices(selfUserId, peerUserId) {
  const store = getKeyNoticeStore();
  return useSyncExternalStore(
    store.subscribe,
    () => store.list(selfUserId, peerUserId),
    () => store.list(selfUserId, peerUserId),
  );
}

/**
 * While a direct chat is open: look the contact's devices up now and then (the server does not
 * announce a new device), so a change is noticed while the chat is on screen.
 */
export function useKeyChangeWatch({ selfUserId, peerUserId, chatId, enabled }) {
  useEffect(() => {
    if (!enabled || !selfUserId || !peerUserId || !chatId) return undefined;
    const release = retainKeyNoticeRecorder(selfUserId);
    let stopped = false;
    let lastCheck = 0;
    const check = () => {
      const now = Date.now();
      if (stopped || now - lastCheck < MIN_GAP_MS) return;
      lastCheck = now;
      try {
        // A mismatch throws; the tracker has already reported it.
        getE2eeServices().directory.getUserDevices(peerUserId, { force: true, chatId }).catch(() => {});
      } catch {
        // No secure storage in this browser.
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    check();
    const timer = window.setInterval(onVisible, RECHECK_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    window.addEventListener("online", onVisible);
    return () => {
      stopped = true;
      release();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener("online", onVisible);
    };
  }, [enabled, selfUserId, peerUserId, chatId]);
}

/**
 * The messages of a chat with the notices about its contact put in. For anything but a direct
 * chat with a person who can be looked up, the messages come back as they are.
 */
export function useKeyChangeTimeline({ messages, chatId, chatType, peer, selfUserId, hasOlderMessages = false }) {
  const peerUserId = chatType === "dm" && peer?.id && !peer.isDeleted ? String(peer.id) : null;
  const enabled = Boolean(peerUserId && selfUserId && chatId && isE2eeSupported());
  useKeyChangeWatch({ selfUserId, peerUserId, chatId, enabled });
  const notices = useKeyNotices(enabled ? selfUserId : null, enabled ? peerUserId : null);
  const peerName = peer?.nickname || peer?.username || "";
  return useMemo(
    () =>
      enabled && notices.length
        ? mergeKeyNotices(messages, notices, { chatId, peerName, selfUserId, hasOlderMessages })
        : messages,
    [enabled, messages, notices, chatId, peerName, selfUserId, hasOlderMessages],
  );
}
