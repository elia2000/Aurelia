import { describe, test, expect, vi } from "vitest";
import { renderHook } from "vitest-browser-react";
import { act } from "react";
import { useCallSounds } from "../../../src/calls/useCallSounds.js";

// A sound maker that only remembers what it was asked: the mapping from the
// phases of a call to sounds is what is under test, not the audio.
function fakeSounds() {
  const stops = [];
  const make = (name) =>
    vi.fn(() => {
      const stop = vi.fn();
      stops.push({ name, stop });
      return stop;
    });
  return {
    stops,
    armUnlock: vi.fn(() => vi.fn()),
    startRingtone: make("ringtone"),
    startRingback: make("ringback"),
    playConnected: vi.fn(),
    playEnded: vi.fn(),
  };
}

async function mount(initial) {
  const sounds = fakeSounds();
  const hook = await renderHook((props) => useCallSounds(props.state, sounds), { initialProps: { state: initial } });
  const go = (state) => act(async () => hook.rerender({ state }));
  return { sounds, go, hook };
}

const incoming = (extra = {}) => ({ phase: "incoming", ringing: true, ...extra });
const outgoing = (extra = {}) => ({ phase: "outgoing", ringing: false, ...extra });
const ended = (endReason) => ({ phase: "ended", ringing: false, endReason });

describe("an incoming call", () => {
  test("rings while it rings here, and stops when it is answered", async () => {
    const { sounds, go } = await mount({ phase: "idle" });
    await go(incoming());
    expect(sounds.startRingtone).toHaveBeenCalledTimes(1);
    expect(sounds.startRingback).not.toHaveBeenCalled();
    const ring = sounds.stops[0].stop;
    expect(ring).not.toHaveBeenCalled();

    await go({ phase: "connecting", ringing: false });
    expect(ring).toHaveBeenCalledTimes(1);
    expect(sounds.playEnded).not.toHaveBeenCalled();
  });

  test("keeps ringing through unrelated state changes (one ring, not one per update)", async () => {
    const { sounds, go } = await mount({ phase: "idle" });
    await go(incoming());
    await go(incoming({ peer: { nickname: "Alice" } }));
    await go(incoming({ peer: { nickname: "Alice" }, trust: {} }));
    expect(sounds.startRingtone).toHaveBeenCalledTimes(1);
    expect(sounds.stops[0].stop).not.toHaveBeenCalled();
  });

  test.each([
    ["declined by this person", ended("declined_local")],
    ["cancelled by the caller", ended("cancelled")],
    ["not answered in time", ended("missed")],
    ["answered on another device (a quiet reset)", { phase: "idle" }],
  ])("stops at once when it is %s, with no ending sound", async (_, next) => {
    const { sounds, go } = await mount({ phase: "idle" });
    await go(incoming());
    await go(next);
    expect(sounds.stops[0].stop).toHaveBeenCalledTimes(1);
    expect(sounds.playEnded).not.toHaveBeenCalled();
    expect(sounds.playConnected).not.toHaveBeenCalled();
  });

  test("does not ring until the call has been verified and really rings", async () => {
    const { sounds, go } = await mount({ phase: "idle" });
    await go({ phase: "incoming", ringing: false });
    expect(sounds.startRingtone).not.toHaveBeenCalled();
  });

  test("a second call ringing after the first ended rings again", async () => {
    const { sounds, go } = await mount({ phase: "idle" });
    await go(incoming());
    await go(ended("missed"));
    await go({ phase: "idle" });
    await go(incoming({ callId: "second" }));
    expect(sounds.startRingtone).toHaveBeenCalledTimes(2);
  });
});

describe("an outgoing call", () => {
  test("is silent while it says Calling... or Waiting...", async () => {
    const { sounds, go } = await mount({ phase: "idle" });
    await go(outgoing());
    await go(outgoing({ waiting: true }));
    expect(sounds.startRingback).not.toHaveBeenCalled();
    expect(sounds.startRingtone).not.toHaveBeenCalled();
  });

  test("plays the ringback tone while it says Ringing..., and stops when it is answered", async () => {
    const { sounds, go } = await mount({ phase: "idle" });
    await go(outgoing());
    await go(outgoing({ ringing: true }));
    expect(sounds.startRingback).toHaveBeenCalledTimes(1);
    expect(sounds.startRingtone).not.toHaveBeenCalled();
    await go({ phase: "connecting", ringing: false });
    expect(sounds.stops[0].stop).toHaveBeenCalledTimes(1);
    expect(sounds.playConnected).not.toHaveBeenCalled(); // the blip comes when the call is up
  });

  test.each([
    ["declined", "declined"],
    ["busy", "busy"],
    ["no_answer", "ended"],
    ["cancelled_local", "ended"],
    ["connect_failed", "failed"],
  ])("stops the ringback when it ends (%s) and plays the %s sound", async (reason, sound) => {
    const { sounds, go } = await mount({ phase: "idle" });
    await go(outgoing({ ringing: true }));
    await go(ended(reason));
    expect(sounds.stops[0].stop).toHaveBeenCalledTimes(1);
    expect(sounds.playEnded).toHaveBeenCalledTimes(1);
    expect(sounds.playEnded).toHaveBeenCalledWith(sound);
  });
});

describe("a call in progress", () => {
  test("blips once when it connects, and ends with a short sound", async () => {
    const { sounds, go } = await mount({ phase: "idle" });
    await go(outgoing({ ringing: true }));
    await go({ phase: "connecting", ringing: false });
    await go({ phase: "connected", ringing: false });
    expect(sounds.playConnected).toHaveBeenCalledTimes(1);
    await go({ phase: "connected", ringing: false, muted: true });
    expect(sounds.playConnected).toHaveBeenCalledTimes(1);

    await go(ended("hangup"));
    expect(sounds.playEnded).toHaveBeenCalledWith("ended");
  });

  test("nothing rings while the person is in a call", async () => {
    const { sounds, go } = await mount({ phase: "connected", ringing: false });
    // Another invitation never reaches the screen (the manager answers busy), but even a stray flag stays silent.
    await go({ phase: "connected", ringing: true });
    expect(sounds.startRingtone).not.toHaveBeenCalled();
    expect(sounds.startRingback).not.toHaveBeenCalled();
  });

  test("a connection that breaks plays the failure sound", async () => {
    const { sounds, go } = await mount({ phase: "connected", ringing: false });
    await go(ended("connection_lost"));
    expect(sounds.playEnded).toHaveBeenCalledWith("failed");
  });

  test("being told you are already in a call is not sounded over the call", async () => {
    const { sounds, go } = await mount({ phase: "idle" });
    await go(outgoing());
    await go(ended("busy_self"));
    expect(sounds.playEnded).not.toHaveBeenCalled();
  });
});

describe("page load and unmount", () => {
  test("a call that is already over when the page loads makes no sound", async () => {
    const { sounds } = await mount(ended("hangup"));
    expect(sounds.playEnded).not.toHaveBeenCalled();
    expect(sounds.startRingtone).not.toHaveBeenCalled();
  });

  test("a call that is already connected when the hook mounts does not blip", async () => {
    const { sounds } = await mount({ phase: "connected", ringing: false });
    expect(sounds.playConnected).not.toHaveBeenCalled();
  });

  test("an ended call going back to idle is silent", async () => {
    const { sounds, go } = await mount(ended("hangup"));
    await go({ phase: "idle" });
    expect(sounds.playEnded).not.toHaveBeenCalled();
  });

  test("listens for the first tap on mount and stops listening when unmounted", async () => {
    const { sounds, hook } = await mount({ phase: "idle" });
    expect(sounds.armUnlock).toHaveBeenCalledTimes(1);
    const off = sounds.armUnlock.mock.results[0].value;
    expect(off).not.toHaveBeenCalled();
    await hook.unmount();
    expect(off).toHaveBeenCalledTimes(1);
  });

  test("unmounting while ringing stops the ring", async () => {
    const { sounds, go, hook } = await mount({ phase: "idle" });
    await go(incoming());
    await hook.unmount();
    expect(sounds.stops[0].stop).toHaveBeenCalledTimes(1);
  });
});
