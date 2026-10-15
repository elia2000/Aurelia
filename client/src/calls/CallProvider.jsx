import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { CallManager, CALL_PHASE } from "./callManager.js";
import { startRingtone } from "./ringtone.js";
import { endCallBeacon } from "../api/e2eeApi.js";
import { getE2eeServices, isCallingSupported } from "../e2ee/services.js";
import { CALL_EVENT, CallContext, IDLE_CALL_SNAPSHOT } from "./callContext.js";

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
  const supported = useMemo(() => isCallingSupported(), []);
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

    // Register this device's public keys as soon as the app is idle, so other
    // people can already send us encrypted video messages before we have ever
    // made or answered a call.
    const registerDevice = () => services.getIdentity(userId).catch(() => {});
    const idleHandle =
      typeof requestIdleCallback === "function"
        ? requestIdleCallback(registerDevice, { timeout: 4000 })
        : setTimeout(registerDevice, 1500);

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

    const onVisibility = () => {
      next.setPageHidden(document.hidden);
      if (!document.hidden) checkPending();
    };
    const onPageHide = () => next.hangupOnUnload(endCallBeacon);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);

    return () => {
      if (typeof cancelIdleCallback === "function" && typeof requestIdleCallback === "function") {
        cancelIdleCallback(idleHandle);
      } else {
        clearTimeout(idleHandle);
      }
      window.removeEventListener(CALL_EVENT, onEvent);
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

  // Background alert for an incoming call while the tab is hidden.
  const callId = state.callId;
  useEffect(() => {
    if (phase === CALL_PHASE.INCOMING && document.hidden) showIncomingNotification(state);
    if (phase !== CALL_PHASE.INCOMING && callId) closeCallNotifications(callId);
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
      inCall: phase !== CALL_PHASE.IDLE,
    }),
    [supported, manager, state, minimized, startCall, phase],
  );

  return <CallContext.Provider value={value}>{children}</CallContext.Provider>;
}
