import { createContext, useContext } from "react";

export const CallContext = createContext(null);

/** Window event the realtime hook dispatches for call_* server events. */
export const CALL_EVENT = "aurelle:call-event";

// Plain string on purpose: importing CALL_PHASE would drag the whole call
// engine into every chunk that merely reads the context.
export const IDLE_CALL_SNAPSHOT = Object.freeze({ phase: "idle" });

const fallback = Object.freeze({
  supported: false,
  manager: null,
  state: IDLE_CALL_SNAPSHOT,
  minimized: false,
  setMinimized: () => {},
  startCall: async () => {},
  accept: () => {},
  decline: () => {},
  hangup: () => {},
  setMuted: () => {},
  setCameraEnabled: () => {},
  inCall: false,
});

export function useCalls() {
  return useContext(CallContext) || fallback;
}
