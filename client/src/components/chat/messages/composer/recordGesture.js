// The gesture behind the record button, as a plain state machine so it can be
// tested without a DOM. The pointer / keyboard glue lives in useRecordingSession.js.
//
//   press ─┬─ release before holdMs (little movement) ─────────────► onTap        (switch mic <-> camera)
//          ├─ moved too far before holdMs ─────────────────────────► nothing      (a scroll or a stray drag)
//          └─ still down after holdMs ─► HOLDING  onHoldStart
//                  ├─ release ──────────────────────────────────────► onRelease   (stop and send)
//                  ├─ slide left  cancelDistancePx ────────────────► onCancel("slide")
//                  ├─ slide up    lockDistancePx ──────────────────► onLock       (hands-free)
//                  ├─ Escape ────────────────────────────────────────► onCancel("escape")
//                  └─ pointercancel / blur / page hidden ───────────► onInterrupt (stop, keep for review)
//
// After a cancel or a lock the finger may still be down; the machine waits for
// it to lift (SETTLED) or, for a lock, for the owner to call endLocked().

export const RECORD_GESTURE_CONFIG = Object.freeze({
  holdMs: 250,
  tapSlopPx: 12,
  cancelDistancePx: 90,
  lockDistancePx: 70,
});

export const GESTURE_STATE = Object.freeze({
  IDLE: "idle",
  PRESSED: "pressed",
  HOLDING: "holding",
  LOCKED: "locked",
  SETTLED: "settled",
});

const clamp01 = (value) => Math.max(0, Math.min(1, value));

const defaultClock = () => ({
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
});

/**
 * @param {object} options
 * @param {object} [options.handlers] onTap, onHoldStart, onProgress, onRelease,
 *   onCancel(reason), onLock, onInterrupt(reason), onChange(state).
 *   onHoldStart may return `false` to refuse the recording (e.g. a permission
 *   prompt is needed); the machine then ignores the rest of that press.
 * @param {{now: () => number, setTimeout: Function, clearTimeout: Function}} [options.clock]
 * @param {Partial<typeof RECORD_GESTURE_CONFIG>} [options.config]
 */
export function createRecordGesture({ handlers: initialHandlers = {}, clock, config } = {}) {
  let handlers = initialHandlers;
  const cfg = { ...RECORD_GESTURE_CONFIG, ...config };
  const time = { ...defaultClock(), ...clock };
  let state = GESTURE_STATE.IDLE;
  let source = "pointer";
  let origin = { x: 0, y: 0 };
  let pressedAt = 0;
  let holdStartedAt = 0;
  let timer = null;

  const call = (name, ...args) => handlers[name]?.(...args);

  const setState = (next) => {
    if (state === next) return;
    state = next;
    call("onChange", next);
  };

  const clearHoldTimer = () => {
    if (timer !== null) time.clearTimeout(timer);
    timer = null;
  };

  const beginHold = () => {
    clearHoldTimer();
    holdStartedAt = time.now();
    setState(GESTURE_STATE.HOLDING);
    const accepted = call("onHoldStart");
    // The handler may already have ended the gesture (cancel from inside).
    if (state === GESTURE_STATE.HOLDING && accepted === false) setState(GESTURE_STATE.SETTLED);
  };

  return {
    get state() {
      return state;
    },

    /** Swap the callbacks (a component passes fresh closures on every render). */
    setHandlers(next) {
      handlers = next || {};
    },

    /** A pointer went down or a key was pressed on the button. Returns whether it was accepted. */
    press({ x = 0, y = 0, source: from = "pointer" } = {}) {
      if (state !== GESTURE_STATE.IDLE) return false;
      source = from;
      origin = { x, y };
      pressedAt = time.now();
      setState(GESTURE_STATE.PRESSED);
      timer = time.setTimeout(() => {
        timer = null;
        if (state === GESTURE_STATE.PRESSED) beginHold();
      }, cfg.holdMs);
      return true;
    },

    move({ x = 0, y = 0 } = {}) {
      if (source === "keyboard") return;
      const dx = x - origin.x;
      const dy = y - origin.y;
      if (state === GESTURE_STATE.PRESSED) {
        if (Math.hypot(dx, dy) > cfg.tapSlopPx) {
          // Moved before the hold started: not a tap and not a recording.
          clearHoldTimer();
          setState(GESTURE_STATE.SETTLED);
        }
        return;
      }
      if (state !== GESTURE_STATE.HOLDING) return;
      const cancel = clamp01(-dx / cfg.cancelDistancePx);
      const lock = clamp01(-dy / cfg.lockDistancePx);
      call("onProgress", { dx, dy, cancel, lock });
      if (cancel >= 1) {
        setState(GESTURE_STATE.SETTLED);
        call("onCancel", "slide");
      } else if (lock >= 1) {
        setState(GESTURE_STATE.LOCKED);
        call("onLock");
      }
    },

    /** The pointer lifted or the key was released. */
    release() {
      switch (state) {
        case GESTURE_STATE.PRESSED: {
          clearHoldTimer();
          if (time.now() - pressedAt >= cfg.holdMs) {
            // The hold timer was late (busy main thread), but it was a hold.
            beginHold();
            if (state === GESTURE_STATE.HOLDING) {
              setState(GESTURE_STATE.IDLE);
              call("onRelease", { heldMs: time.now() - holdStartedAt });
            } else if (state === GESTURE_STATE.SETTLED) {
              setState(GESTURE_STATE.IDLE); // refused, and the finger is already up
            }
            return;
          }
          setState(GESTURE_STATE.IDLE);
          call("onTap");
          return;
        }
        case GESTURE_STATE.HOLDING:
          setState(GESTURE_STATE.IDLE);
          call("onRelease", { heldMs: time.now() - holdStartedAt });
          return;
        case GESTURE_STATE.SETTLED:
          setState(GESTURE_STATE.IDLE);
          return;
        default:
          // LOCKED: the finger that locked it lifting is not an action.
          return;
      }
    },

    /** Keyboard only: lock the recording (the keyboard cannot slide up). */
    lock() {
      if (state !== GESTURE_STATE.HOLDING) return;
      setState(GESTURE_STATE.LOCKED);
      call("onLock");
    },

    /** Escape. Cancels a press, a hold or a locked recording. */
    escape() {
      switch (state) {
        case GESTURE_STATE.PRESSED:
          clearHoldTimer();
          setState(GESTURE_STATE.SETTLED);
          return true;
        case GESTURE_STATE.HOLDING:
          setState(GESTURE_STATE.SETTLED);
          call("onCancel", "escape");
          return true;
        case GESTURE_STATE.LOCKED:
          setState(GESTURE_STATE.IDLE);
          call("onCancel", "escape");
          return true;
        default:
          return false;
      }
    },

    /**
     * The gesture was taken away: pointercancel, lost pointer capture, window
     * blur, page hidden. Recording is stopped but kept for the person to review.
     */
    interrupt(reason = "interrupted") {
      switch (state) {
        case GESTURE_STATE.PRESSED:
          clearHoldTimer();
          setState(GESTURE_STATE.IDLE);
          return;
        case GESTURE_STATE.HOLDING:
          setState(GESTURE_STATE.IDLE);
          call("onInterrupt", reason);
          return;
        case GESTURE_STATE.SETTLED:
          setState(GESTURE_STATE.IDLE);
          return;
        default:
          // A locked recording is hands-free: it does not depend on the finger.
          return;
      }
    },

    /** The owner finished (sent / deleted / stopped) a locked recording. */
    endLocked() {
      if (state === GESTURE_STATE.LOCKED) setState(GESTURE_STATE.IDLE);
    },

    /** Back to idle without any action callback (unmount, chat switch). */
    reset() {
      clearHoldTimer();
      setState(GESTURE_STATE.IDLE);
    },
  };
}
