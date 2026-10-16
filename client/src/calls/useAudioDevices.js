import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildAudioModel, isDefaultOutput, loadOutputChoice, saveOutputChoice, sinkIdFor } from "./audioDevices.js";

const canRouteToSpeaker = () =>
  typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;

/**
 * The microphones, speakers and phone routes available during a call, kept up
 * to date as devices come and go, and the speaker choice applied to the
 * element that plays the other person's voice.
 *
 * @param {object} options
 * @param {boolean} options.active          a call is on screen
 * @param {string|null} options.microphoneId the microphone in use (re-lists when it changes:
 *                                           names only appear once permission was given)
 * @param {HTMLMediaElement|null} options.audioElement the element playing the call's sound
 */
export function useAudioDevices({ active, microphoneId, audioElement }) {
  const [devices, setDevices] = useState([]);
  const [chosenOutput, setChosenOutput] = useState(() => loadOutputChoice());
  const [outputError, setOutputError] = useState(false);
  const canSetSink = canRouteToSpeaker();

  // A warning about a speaker belongs to the call it happened in.
  const [wasActive, setWasActive] = useState(active);
  if (wasActive !== active) {
    setWasActive(active);
    if (!active) setOutputError(false);
  }

  // Only the newest answer counts: a slow list must not replace a newer one.
  const listing = useRef(0);
  const refresh = useCallback(async () => {
    const mine = ++listing.current;
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      if (mine === listing.current) setDevices(list);
    } catch (_) {
      if (mine === listing.current) setDevices([]);
    }
  }, []);

  useEffect(() => {
    if (!active || typeof navigator === "undefined" || !navigator.mediaDevices) return undefined;
    refresh();
    const media = navigator.mediaDevices;
    media.addEventListener?.("devicechange", refresh);
    return () => {
      media.removeEventListener?.("devicechange", refresh);
      listing.current += 1; // an answer that arrives after this point is not wanted
    };
  }, [active, refresh, microphoneId]);

  const model = useMemo(() => buildAudioModel(devices, { canPickOutput: canSetSink }), [devices, canSetSink]);

  // A speaker that has been unplugged since it was chosen counts as "default".
  const outputId =
    isDefaultOutput(chosenOutput) || model.outputs.some((output) => output.id === chosenOutput) ? chosenOutput || "default" : "default";

  // A speaker remembered from earlier (or put back after the call screen was
  // rebuilt) is applied without a tap, which some browsers refuse: that is not
  // worth a warning. The sound then stays on the default speaker, and that is
  // what the list shows; the choice is still remembered for the next call.
  useEffect(() => {
    if (!active || !canSetSink || !audioElement?.setSinkId) return;
    // Nothing to route until the browser has listed the speakers.
    if (!model.outputs.length && isDefaultOutput(outputId)) return;
    if ((audioElement.sinkId || "") === sinkIdFor(outputId)) return;
    audioElement.setSinkId(sinkIdFor(outputId)).catch(() => setChosenOutput("default"));
  }, [active, canSetSink, audioElement, outputId, model.outputs.length]);

  // A speaker the person picks is applied right here, inside the tap: Safari
  // only allows choosing a speaker while handling a user gesture. It counts as
  // chosen (and is remembered) only once the browser has accepted it.
  const chooseOutput = useCallback(
    async (id) => {
      if (!audioElement?.setSinkId) {
        setChosenOutput(id);
        saveOutputChoice(id);
        return;
      }
      try {
        await audioElement.setSinkId(sinkIdFor(id));
      } catch (_) {
        setOutputError(true);
        return;
      }
      setChosenOutput(id);
      saveOutputChoice(id);
      setOutputError(false);
    },
    [audioElement],
  );

  return { model, outputId, chooseOutput, outputError, refresh };
}
