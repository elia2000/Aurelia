import { vi } from "vitest";

// Helpers for the record-button tests: pointer sequences as the browser sends
// them, and a microphone / MediaRecorder that work without a device.

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitUntil(predicate, label, timeoutMs = 5000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out: ${label}`);
    await sleep(20);
  }
}

const pointerInit = (extra) => ({
  bubbles: true,
  cancelable: true,
  composed: true,
  pointerId: 7,
  isPrimary: true,
  pointerType: "mouse",
  button: 0,
  ...extra,
});

/** Where a pointer is when it presses `element` (the middle of it). */
export function centerOf(element) {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

/**
 * A finger or mouse that presses `element`, moves and lets go. The listeners
 * that follow a press are on the window, so moves and the lift go there.
 */
export function pointer(element, { pointerType = "mouse" } = {}) {
  const start = centerOf(element);
  const fire = (type, target, x, y) =>
    target.dispatchEvent(new PointerEvent(type, pointerInit({ pointerType, clientX: x, clientY: y })));
  let at = start;
  return {
    start,
    down: () => fire("pointerdown", element, start.x, start.y),
    moveBy: (dx, dy) => {
      at = { x: start.x + dx, y: start.y + dy };
      fire("pointermove", window, at.x, at.y);
    },
    up: () => fire("pointerup", window, at.x, at.y),
    cancel: () => fire("pointercancel", window, at.x, at.y),
  };
}

let tracks = [];
let recorders = [];
let originalRecorder;
let originalGetUserMedia;

class FakeRecorder {
  static isTypeSupported = () => true;
  constructor(stream, options) {
    this.stream = stream;
    this.options = options;
    this.state = "inactive";
    recorders.push(this);
  }
  start() {
    this.state = "recording";
    this.ondataavailable?.({ data: new Blob([new Uint8Array(3000)], { type: "audio/webm" }) });
  }
  requestData() {}
  stop() {
    if (this.state === "inactive") return;
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob([new Uint8Array(500)], { type: "audio/webm" }) });
    queueMicrotask(() => this.onstop?.());
  }
}

/** Replaces the microphone and MediaRecorder. Returns what the test needs to look at. */
export function installFakeMicrophone({ reject = null } = {}) {
  tracks = [];
  recorders = [];
  originalRecorder = globalThis.MediaRecorder;
  originalGetUserMedia = navigator.mediaDevices?.getUserMedia;
  globalThis.MediaRecorder = FakeRecorder;
  const getUserMedia = vi.fn(async () => {
    if (reject) throw Object.assign(new Error(reject), { name: reject });
    const track = { kind: "audio", stopped: false, onended: null, stop() { this.stopped = true; } };
    tracks.push(track);
    return { getTracks: () => [track], getAudioTracks: () => [track] };
  });
  Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
    value: getUserMedia,
    configurable: true,
    writable: true,
  });
  return {
    getUserMedia,
    get tracks() {
      return tracks;
    },
    get recorders() {
      return recorders;
    },
    allStopped: () => tracks.length > 0 && tracks.every((track) => track.stopped),
  };
}

export function restoreMicrophone() {
  if (originalRecorder === undefined) delete globalThis.MediaRecorder;
  else globalThis.MediaRecorder = originalRecorder;
  if (navigator.mediaDevices) {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      value: originalGetUserMedia,
      configurable: true,
      writable: true,
    });
  }
}
