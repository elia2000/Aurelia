import { describe, expect, test, beforeEach } from "vitest";
import {
  GESTURE_STATE,
  RECORD_GESTURE_CONFIG,
  createRecordGesture,
} from "../../src/components/chat/messages/composer/recordGesture.js";

// A clock the test drives by hand.
function makeClock() {
  let now = 1000;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = target;
    },
    // Time passes but no timer callback runs (a busy main thread).
    skip(ms) {
      now += ms;
    },
    get pending() {
      return timers.size;
    },
  };
}

let clock;
let events;
let gesture;

function make({ onHoldStart } = {}) {
  clock = makeClock();
  events = [];
  gesture = createRecordGesture({
    clock,
    handlers: {
      onTap: () => events.push("tap"),
      onHoldStart: () => {
        events.push("hold");
        return onHoldStart?.();
      },
      onProgress: (p) => events.push(`progress:${p.dx},${p.dy}`),
      onRelease: ({ heldMs }) => events.push(`release:${heldMs}`),
      onCancel: (reason) => events.push(`cancel:${reason}`),
      onLock: () => events.push("lock"),
      onInterrupt: (reason) => events.push(`interrupt:${reason}`),
    },
  });
}

const actions = () => events.filter((e) => !e.startsWith("progress:"));

beforeEach(() => make());

describe("record gesture: tap", () => {
  test("a quick press and release switches the mode and records nothing", () => {
    gesture.press({ x: 100, y: 100 });
    expect(gesture.state).toBe(GESTURE_STATE.PRESSED);
    clock.advance(120);
    gesture.release();
    expect(actions()).toEqual(["tap"]);
    expect(gesture.state).toBe(GESTURE_STATE.IDLE);
    expect(clock.pending).toBe(0);
  });

  test("a little jitter while tapping is still a tap", () => {
    gesture.press({ x: 100, y: 100 });
    gesture.move({ x: 104, y: 97 });
    clock.advance(80);
    gesture.release();
    expect(actions()).toEqual(["tap"]);
  });

  test("moving well away before the hold starts is neither a tap nor a recording", () => {
    gesture.press({ x: 100, y: 100 });
    gesture.move({ x: 100, y: 140 });
    expect(gesture.state).toBe(GESTURE_STATE.SETTLED);
    clock.advance(1000);
    gesture.release();
    expect(actions()).toEqual([]);
    expect(gesture.state).toBe(GESTURE_STATE.IDLE);
  });

  test("a second press while one is active is ignored", () => {
    expect(gesture.press({ x: 0, y: 0 })).toBe(true);
    expect(gesture.press({ x: 5, y: 5 })).toBe(false);
    clock.advance(RECORD_GESTURE_CONFIG.holdMs);
    expect(gesture.press({ x: 5, y: 5 })).toBe(false);
    expect(actions()).toEqual(["hold"]);
  });
});

describe("record gesture: hold and release", () => {
  test("holding for the threshold starts recording, releasing sends", () => {
    gesture.press({ x: 100, y: 100 });
    clock.advance(RECORD_GESTURE_CONFIG.holdMs - 1);
    expect(actions()).toEqual([]);
    clock.advance(1);
    expect(actions()).toEqual(["hold"]);
    expect(gesture.state).toBe(GESTURE_STATE.HOLDING);
    clock.advance(1500);
    gesture.release();
    expect(actions()).toEqual(["hold", "release:1500"]);
    expect(gesture.state).toBe(GESTURE_STATE.IDLE);
  });

  test("a hold whose timer ran late still counts as a hold when the finger lifts", () => {
    gesture.press({ x: 100, y: 100 });
    clock.skip(400);
    gesture.release();
    expect(actions()).toEqual(["hold", "release:0"]);
    expect(gesture.state).toBe(GESTURE_STATE.IDLE);
    expect(clock.pending).toBe(0);
  });

  test("a refused hold start ignores the rest of the press", () => {
    make({ onHoldStart: () => false });
    gesture.press({ x: 100, y: 100 });
    clock.advance(RECORD_GESTURE_CONFIG.holdMs);
    expect(gesture.state).toBe(GESTURE_STATE.SETTLED);
    gesture.move({ x: 0, y: 0 });
    gesture.release();
    expect(actions()).toEqual(["hold"]);
    expect(gesture.state).toBe(GESTURE_STATE.IDLE);
  });

  test("moves while holding report how far to cancel and to lock", () => {
    const seen = [];
    clock = makeClock();
    const g = createRecordGesture({
      clock,
      handlers: { onHoldStart: () => {}, onProgress: (p) => seen.push(p) },
    });
    g.press({ x: 200, y: 300 });
    clock.advance(300);
    g.move({ x: 155, y: 300 });
    g.move({ x: 200, y: 265 });
    expect(seen[0].cancel).toBeCloseTo(0.5, 5);
    expect(seen[0].lock).toBe(0);
    expect(seen[1].lock).toBeCloseTo(0.5, 5);
    expect(seen[1].cancel).toBe(0);
  });
});

describe("record gesture: slide to cancel and slide up to lock", () => {
  beforeEach(() => {
    gesture.press({ x: 300, y: 600 });
    clock.advance(RECORD_GESTURE_CONFIG.holdMs);
    events.length = 0;
  });

  test("sliding left past the cancel distance cancels, and the lift afterwards does nothing", () => {
    gesture.move({ x: 300 - RECORD_GESTURE_CONFIG.cancelDistancePx + 1, y: 600 });
    expect(actions()).toEqual([]);
    gesture.move({ x: 300 - RECORD_GESTURE_CONFIG.cancelDistancePx, y: 600 });
    expect(actions()).toEqual(["cancel:slide"]);
    expect(gesture.state).toBe(GESTURE_STATE.SETTLED);
    gesture.move({ x: 0, y: 0 });
    gesture.release();
    expect(actions()).toEqual(["cancel:slide"]);
    expect(gesture.state).toBe(GESTURE_STATE.IDLE);
  });

  test("sliding up past the lock distance locks, and lifting the finger keeps recording", () => {
    gesture.move({ x: 300, y: 600 - RECORD_GESTURE_CONFIG.lockDistancePx });
    expect(actions()).toEqual(["lock"]);
    expect(gesture.state).toBe(GESTURE_STATE.LOCKED);
    gesture.release();
    expect(actions()).toEqual(["lock"]);
    expect(gesture.state).toBe(GESTURE_STATE.LOCKED);
    // Nothing starts a second recording while it is locked.
    expect(gesture.press({ x: 1, y: 1 })).toBe(false);
  });

  test("the owner ending a locked recording makes the button usable again", () => {
    gesture.move({ x: 300, y: 500 });
    gesture.endLocked();
    expect(gesture.state).toBe(GESTURE_STATE.IDLE);
    expect(gesture.press({ x: 1, y: 1 })).toBe(true);
  });

  test("a mostly sideways slide that never reaches the distance neither cancels nor locks", () => {
    gesture.move({ x: 250, y: 560 });
    gesture.release();
    expect(actions()).toEqual(["release:0"]);
  });

  test("sliding left wins when the cancel distance is reached first", () => {
    gesture.move({ x: 200, y: 590 });
    expect(actions()).toEqual(["cancel:slide"]);
  });
});

describe("record gesture: interruptions never leave it stuck", () => {
  test("pointercancel before the hold starts is silent", () => {
    gesture.press({ x: 0, y: 0 });
    gesture.interrupt("pointercancel");
    expect(actions()).toEqual([]);
    expect(gesture.state).toBe(GESTURE_STATE.IDLE);
    expect(clock.pending).toBe(0);
  });

  test("pointercancel, blur or a hidden page while holding stops the recording for review", () => {
    for (const reason of ["pointercancel", "blur", "hidden", "lostpointercapture"]) {
      make();
      gesture.press({ x: 0, y: 0 });
      clock.advance(RECORD_GESTURE_CONFIG.holdMs);
      gesture.interrupt(reason);
      expect(actions()).toEqual(["hold", `interrupt:${reason}`]);
      expect(gesture.state).toBe(GESTURE_STATE.IDLE);
      gesture.release(); // a late pointerup changes nothing
      expect(actions()).toEqual(["hold", `interrupt:${reason}`]);
    }
  });

  test("a locked recording is hands-free and survives blur and pointercancel", () => {
    gesture.press({ x: 0, y: 100 });
    clock.advance(RECORD_GESTURE_CONFIG.holdMs);
    gesture.move({ x: 0, y: 0 });
    gesture.interrupt("blur");
    gesture.interrupt("pointercancel");
    expect(gesture.state).toBe(GESTURE_STATE.LOCKED);
    expect(actions()).toEqual(["hold", "lock"]);
  });

  test("an interrupt after a cancel just frees the button", () => {
    gesture.press({ x: 300, y: 0 });
    clock.advance(RECORD_GESTURE_CONFIG.holdMs);
    gesture.move({ x: 0, y: 0 });
    gesture.interrupt("pointercancel");
    expect(gesture.state).toBe(GESTURE_STATE.IDLE);
    expect(actions()).toEqual(["hold", "cancel:slide"]);
  });

  test("reset clears a pending hold timer without calling anything", () => {
    gesture.press({ x: 0, y: 0 });
    gesture.reset();
    clock.advance(1000);
    expect(actions()).toEqual([]);
    expect(gesture.state).toBe(GESTURE_STATE.IDLE);
  });
});

describe("record gesture: keyboard", () => {
  test("a short Space press toggles like a tap", () => {
    gesture.press({ source: "keyboard" });
    clock.advance(100);
    gesture.release();
    expect(actions()).toEqual(["tap"]);
  });

  test("holding Space past the threshold records and releasing sends", () => {
    gesture.press({ source: "keyboard" });
    clock.advance(RECORD_GESTURE_CONFIG.holdMs + 600);
    gesture.release();
    expect(actions()).toEqual(["hold", "release:600"]);
  });

  test("pointer moves are ignored for the keyboard", () => {
    gesture.press({ source: "keyboard" });
    clock.advance(RECORD_GESTURE_CONFIG.holdMs);
    gesture.move({ x: -500, y: -500 });
    expect(actions()).toEqual(["hold"]);
    expect(gesture.state).toBe(GESTURE_STATE.HOLDING);
  });

  test("the keyboard can lock a recording", () => {
    gesture.press({ source: "keyboard" });
    clock.advance(RECORD_GESTURE_CONFIG.holdMs);
    gesture.lock();
    expect(actions()).toEqual(["hold", "lock"]);
  });

  test("Escape cancels a hold, a locked recording and a press that has not started", () => {
    gesture.press({ source: "keyboard" });
    expect(gesture.escape()).toBe(true);
    expect(actions()).toEqual([]);
    gesture.release();

    make();
    gesture.press({ source: "keyboard" });
    clock.advance(RECORD_GESTURE_CONFIG.holdMs);
    expect(gesture.escape()).toBe(true);
    expect(actions()).toEqual(["hold", "cancel:escape"]);
    gesture.release();
    expect(gesture.state).toBe(GESTURE_STATE.IDLE);

    make();
    gesture.press({ source: "keyboard" });
    clock.advance(RECORD_GESTURE_CONFIG.holdMs);
    gesture.lock();
    expect(gesture.escape()).toBe(true);
    expect(actions()).toEqual(["hold", "lock", "cancel:escape"]);
    expect(gesture.state).toBe(GESTURE_STATE.IDLE);

    expect(gesture.escape()).toBe(false);
  });
});
