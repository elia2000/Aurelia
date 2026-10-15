// In-memory registry of 1:1 calls.
//
// The registry only tracks WHO is calling WHOM and the call lifecycle so the
// server can authorize signaling relays, answer "busy" and expire unanswered
// calls. It never sees media or any SDP/ICE: those travel as opaque
// end-to-end encrypted blobs (see docs/calls).
//
// Calls are held per process. Deployments with several app instances must use
// sticky routing for /api/calls (documented).

export const CALL_STATES = Object.freeze({
  RINGING: "ringing",
  CONNECTING: "connecting",
  ACTIVE: "active",
  ENDED: "ended",
});

export const CALL_KINDS = Object.freeze(["audio", "video"]);

export const DEFAULT_RING_TIMEOUT_MS = 45 * 1000;
// A call that was accepted but never reached "connected" is dead after this.
export const DEFAULT_CONNECT_TIMEOUT_MS = 60 * 1000;
export const DEFAULT_MAX_CALL_MS = 6 * 60 * 60 * 1000;
// Active call with both participants disconnected from realtime this long.
export const DEFAULT_ORPHAN_MS = 90 * 1000;

const KEEP_ENDED_MS = 60 * 1000;

export class CallError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function createCallRegistry({
  now = () => Date.now(),
  ringTimeoutMs = DEFAULT_RING_TIMEOUT_MS,
  connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
  maxCallMs = DEFAULT_MAX_CALL_MS,
  orphanMs = DEFAULT_ORPHAN_MS,
} = {}) {
  const calls = new Map(); // callId -> call
  const activeByUserId = new Map(); // userId -> callId (non-ended calls)

  const isLive = (call) => call && call.state !== CALL_STATES.ENDED;

  function getLiveCallForUser(userId) {
    const callId = activeByUserId.get(userId);
    if (!callId) return null;
    const call = calls.get(callId);
    return isLive(call) ? call : null;
  }

  function invite({
    callId,
    caller,
    callee,
    chatId,
    kind,
    callerDeviceId,
    invitePayload = null,
  }) {
    if (!callId || !caller?.id || !callee?.id) {
      throw new CallError("invalid", "Invalid call.");
    }
    if (caller.id === callee.id) {
      throw new CallError("invalid", "You cannot call yourself.");
    }
    if (!CALL_KINDS.includes(kind)) {
      throw new CallError("invalid", "Invalid call type.");
    }
    if (calls.has(callId)) {
      throw new CallError("duplicate", "Call already exists.", 409);
    }
    if (getLiveCallForUser(caller.id)) {
      throw new CallError("busy_self", "You are already in a call.", 409);
    }
    if (getLiveCallForUser(callee.id)) {
      throw new CallError("busy", "User is busy.", 409);
    }
    const ts = now();
    const call = {
      id: callId,
      caller: { id: caller.id, username: caller.username },
      callee: { id: callee.id, username: callee.username },
      chatId: chatId || null,
      kind,
      state: CALL_STATES.RINGING,
      createdAt: ts,
      answeredAt: null,
      endedAt: null,
      endReason: null,
      callerDeviceId: callerDeviceId || null,
      calleeDeviceId: null,
      invitePayload,
      offlineSince: null,
    };
    calls.set(callId, call);
    activeByUserId.set(caller.id, callId);
    activeByUserId.set(callee.id, callId);
    return call;
  }

  function get(callId) {
    return calls.get(callId) || null;
  }

  /** @returns {{call: object, role: "caller" | "callee"} | null} */
  function authorize(callId, userId) {
    const call = calls.get(callId);
    if (!call || !userId) return null;
    if (call.caller.id === userId) return { call, role: "caller" };
    if (call.callee.id === userId) return { call, role: "callee" };
    return null;
  }

  function accept(callId, calleeId, deviceId) {
    const auth = authorize(callId, calleeId);
    if (!auth || auth.role !== "callee") {
      throw new CallError("forbidden", "Not your call.", 403);
    }
    const { call } = auth;
    if (call.state !== CALL_STATES.RINGING) {
      throw new CallError(
        "not_ringing",
        call.state === CALL_STATES.ENDED
          ? "Call already ended."
          : "Call already answered.",
        409,
      );
    }
    call.state = CALL_STATES.CONNECTING;
    call.answeredAt = now();
    call.calleeDeviceId = deviceId || null;
    return call;
  }

  function markActive(callId, userId) {
    const auth = authorize(callId, userId);
    if (!auth) throw new CallError("forbidden", "Not your call.", 403);
    if (auth.call.state === CALL_STATES.CONNECTING) {
      auth.call.state = CALL_STATES.ACTIVE;
    }
    return auth.call;
  }

  function end(callId, reason = "hangup") {
    const call = calls.get(callId);
    if (!call || call.state === CALL_STATES.ENDED) return null;
    call.state = CALL_STATES.ENDED;
    call.endedAt = now();
    call.endReason = reason;
    if (activeByUserId.get(call.caller.id) === callId) {
      activeByUserId.delete(call.caller.id);
    }
    if (activeByUserId.get(call.callee.id) === callId) {
      activeByUserId.delete(call.callee.id);
    }
    return call;
  }

  /**
   * End `callId` on behalf of `userId`.
   * - the caller cancelling a ringing call  -> "cancelled"
   * - the callee refusing a ringing call    -> "declined"
   * - anyone hanging up a running call      -> "hangup"
   */
  function endBy(callId, userId, requestedReason = null) {
    const auth = authorize(callId, userId);
    if (!auth) throw new CallError("forbidden", "Not your call.", 403);
    const { call, role } = auth;
    if (call.state === CALL_STATES.ENDED) return null;
    let reason = requestedReason || "hangup";
    if (call.state === CALL_STATES.RINGING) {
      reason = role === "caller" ? "cancelled" : "declined";
    } else if (!["hangup", "failed"].includes(reason)) {
      reason = "hangup";
    }
    return end(callId, reason);
  }

  /**
   * Expire stale calls. `isUserConnected(username)` lets the registry drop
   * running calls whose participants both vanished (closed tab, no signal).
   * @returns {Array<{call: object, reason: string}>} calls that were ended
   */
  function sweep(isUserConnected = null) {
    const ts = now();
    const ended = [];
    for (const call of calls.values()) {
      if (call.state === CALL_STATES.ENDED) {
        if (ts - call.endedAt > KEEP_ENDED_MS) calls.delete(call.id);
        continue;
      }
      let reason = null;
      if (call.state === CALL_STATES.RINGING && ts - call.createdAt > ringTimeoutMs) {
        reason = "missed";
      } else if (
        call.state === CALL_STATES.CONNECTING &&
        ts - call.answeredAt > connectTimeoutMs
      ) {
        reason = "failed";
      } else if (ts - call.createdAt > maxCallMs) {
        reason = "timeout";
      } else if (
        call.state !== CALL_STATES.RINGING &&
        typeof isUserConnected === "function"
      ) {
        const anyone =
          isUserConnected(call.caller.username) ||
          isUserConnected(call.callee.username);
        if (anyone) {
          call.offlineSince = null;
        } else if (call.offlineSince == null) {
          call.offlineSince = ts;
        } else if (ts - call.offlineSince > orphanMs) {
          reason = "failed";
        }
      }
      if (reason) {
        end(call.id, reason);
        ended.push({ call, reason });
      }
    }
    return ended;
  }

  return {
    invite,
    get,
    authorize,
    accept,
    markActive,
    end,
    endBy,
    sweep,
    getLiveCallForUser,
    /** For tests/diagnostics. */
    size: () => calls.size,
    /** Ringing call a user is the callee of (lets a reloaded client re-ring). */
    getPendingIncoming(userId) {
      const call = getLiveCallForUser(userId);
      return call && call.state === CALL_STATES.RINGING && call.callee.id === userId
        ? call
        : null;
    },
  };
}
