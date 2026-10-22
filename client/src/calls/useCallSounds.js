import { useEffect, useRef } from "react";
import { callSounds as defaultSounds, loopSoundFor, transitionSoundFor } from "./callSounds.js";

/**
 * Plays the sounds of the call whose state this is, as the call moves through
 * its phases:
 *  - rings while an incoming call rings here, and plays the ringback tone while
 *    the person called is ringing; both stop the moment that is no longer true
 *    (answered, declined, cancelled, timed out, answered on another device);
 *  - a blip when the call connects and a short sound when it ends.
 * Only a change seen while mounted makes a sound, so a call that is already
 * over when the page loads is silent, and nothing plays while another call is
 * what the person is in (an invitation then never reaches the screen).
 *
 * @param {{phase: string, ringing?: boolean, endReason?: string|null}} state
 * @param {object} [options]
 * @param {boolean} [options.enabled]  false where calls cannot happen at all: nothing then listens for a tap
 * @param {ReturnType<import("./callSounds.js").createCallSounds>} [options.sounds]
 */
export function useCallSounds(state, { enabled = true, sounds = defaultSounds } = {}) {
  const { phase, ringing, endReason } = state;

  // Audio may start only after the first tap or key press: listen for it.
  useEffect(() => (enabled ? sounds.armUnlock() : undefined), [enabled, sounds]);

  const loop = loopSoundFor(phase, Boolean(ringing));
  useEffect(() => {
    if (loop === "ringtone") return sounds.startRingtone();
    if (loop === "ringback") return sounds.startRingback();
    return undefined;
  }, [loop, sounds]);

  const previous = useRef(phase);
  useEffect(() => {
    const before = previous.current;
    previous.current = phase;
    const sound = transitionSoundFor(before, phase, endReason);
    if (sound === "connect") sounds.playConnected();
    else if (sound) sounds.playEnded(sound);
  }, [phase, endReason, sounds]);
}
