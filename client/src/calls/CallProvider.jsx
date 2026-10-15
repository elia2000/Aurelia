import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { CallManager, CALL_PHASE } from "./callManager.js";
import { startRingtone } from "./ringtone.js";
import { endCallBeacon } from "../api/e2eeApi.js";
import { getE2eeServices, isCallingSupported } from "../e2ee/services.js";
import { CALL_EVENT, CallContext, IDLE_CALL_SNAPSHOT, REALTIME_OPEN_EVENT } from "./callContext.js";
import { CHAT_PAGE_CONFIG } from "../settings/chatPageConfig.js";
import { NOTIFICATIONS_ENABLED_KEY } from "../utils/chatPageConstants.js";

// Mirrors the Notifications switch in the app's settings (on unless turned off).
const appNotificationsOn = () => {
  try {
    return window.localStorage.getItem(NOTIFICATIONS_ENABLED_KEY) !== "0";
  } catch (_) {
    return true;
  }
};

const BROADCAST_NAME = "aurelle-calls";

const noopSubscribe = () => () => {};
const idleSnapshot = IDLE_CALL_SNAPSHOT;

function useManagerState(manager) {
  return useSyncExternalStore(
    manager ? manager.subscribe : noopSubscribe,
    manager ? manager.getState : () => idleSnapshot,
    () => idleSnapshot,
  );
}

async function showIncomingNotification(state) {
  try {
    if (!appNotificationsOn()) return;
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    const registration = await navigator.serviceWorker?.ready;
    await registration?.showNotification(state.peer?.nickname || state.peer?.username || "Incoming call", {
      body: state.kind === "video" ? "Incoming video call" : "Incoming voice call",
      tag: `call-${state.callId}`,
      requireInteraction: true,
      renotify: true,
      vibrate: [300, 200, 300],
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { type: "call", callId: state.callId, url: "/" },
    });
  } catch (_) {}
}

async function closeCallNotifications(callId) {
  try {
    const registration = await navigator.serviceWorker?.ready;
    const open = await registration?.getNotifications({ tag: `call-${callId}` });
    open?.forEach((n) => n.close());
  } catch (_) {}
}

/**
 * Owns the CallManager for the signed-in user and bridges it to the app:
 * realtime events in, ringer/notifications/battery hooks out.
 */
export function CallProvider({ user, children }) {
  const supported = useMemo(() => isCallingSupported() && CHAT_PAGE_CONFIG.callsEnabled !== false, []);
  const [manager, setManager] = useState(null);
  const [minimized, setMinimized] = useState(false);
  const state = useManagerState(manager);
  const userId = user?.id || null;
  const username = user?.username || null;

  useEffect(() => {
    if (!supported || !userId) return undefined;
    const services = getE2eeServices();
    let channel = null;
    try {
      channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(BROADCAST_NAME) : null;
    } catch (_) {
      channel = null;
    }
    const next = new CallManager({
      selfUser: { id: userId, username },
      api: services.api,
      getIdentity: () => services.getIdentity(userId),
      directory: services.directory,
      broadcast: channel,
    });
    if (channel) channel.onmessage = (e) => next.handleBroadcast(e.data);
    setManager(next);

    const onEvent = (event) => next.handleEvent(event.detail);
    window.addEventListener(CALL_EVENT, onEvent);

    // A call may have started ringing while the page was closed or the realtime
    // connection was down (e.g. the user tapped a push notification).
    const checkPending = async () => {
      if (next.isBusy) return;
      try {
        const { call } = await services.api.fetchPendingCall();
        if (call) next.handleEvent({ type: "call_invite", ...call });
      } catch (_) {}
    };
    checkPending();
    // Invitations are not replayed: one sent while the realtime connection was
    // down (a network switch, a laptop waking up) is only found by asking.
    window.addEventListener(REALTIME_OPEN_EVENT, checkPending);

    const onVisibility = () => {
      next.setPageHidden(document.hidden);
      if (!document.hidden) checkPending();
    };
    const onPageHide = () => next.hangupOnUnload(endCallBeacon);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);

    return () => {
      window.removeEventListener(CALL_EVENT, onEvent);
      window.removeEventListener(REALTIME_OPEN_EVENT, checkPending);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      next.dispose();
      channel?.close();
      setManager(null);
    };
  }, [supported, userId, username]);

  // Ringer: only while something is actually ringing.
  const phase = state.phase;
  const ringingNow = Boolean(state.ringing);
  useEffect(() => {
    if (phase === CALL_PHASE.INCOMING && ringingNow) return startRingtone("incoming");
    if (phase === CALL_PHASE.OUTGOING && ringingNow) return startRingtone("outgoing");
    return undefined;
  }, [phase, ringingNow]);

  // Background alert for an incoming call while the tab is hidden. The
  // notification is closed whenever the call stops ringing here, however that
  // happens (answered, declined, answered on another device, caller gave up),
  // including the quiet reset to idle that carries no call id.
  const callId = state.callId;
  const ringingCallRef = useRef(null);
  useEffect(() => {
    if (phase === CALL_PHASE.INCOMING && callId) {
      ringingCallRef.current = callId;
      if (document.hidden) showIncomingNotification(state);
    } else if (ringingCallRef.current) {
      closeCallNotifications(ringingCallRef.current);
      ringingCallRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, callId]);

  useEffect(() => {
    if (phase === CALL_PHASE.IDLE) setMinimized(false);
  }, [phase]);

  const startCall = useCallback(
    (args) => manager?.startCall(args),
    [manager],
  );

  const value = useMemo(
    () => ({
      supported,
      manager,
      state,
      minimized,
      setMinimized,
      startCall,
      accept: () => manager?.accept(),
      decline: () => manager?.decline(),
      hangup: () => manager?.hangup(),
      setMuted: (muted) => manager?.setMuted(muted),
      setCameraEnabled: (enabled) => manager?.setCameraEnabled(enabled),
      // A call that has just ended only lingers on screen; a new one may start.
      inCall: phase !== CALL_PHASE.IDLE && phase !== CALL_PHASE.ENDED,
    }),
    [supported, manager, state, minimized, startCall, phase],
  );

  return <CallContext.Provider value={value}>{children}</CallContext.Provider>;
}
