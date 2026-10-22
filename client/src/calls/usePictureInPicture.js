import { useCallback, useEffect, useRef, useState } from "react";
import {
  bindCallControls,
  callPipActive,
  enterPictureInPicture,
  leavePictureInPicture,
  pipSupported,
  setAutoPictureInPicture,
  setPictureInPictureArmed,
  togglePictureInPicture,
} from "./pip.js";

/**
 * Picture in picture for the call screen (see pip.js for what the browsers can do).
 *
 * `targetKey` names the picture that would float ("remote" for the other
 * person's camera, "screen" for the screen they share) and is null when none is
 * on screen; `getTarget()` returns its <video>. While one is on screen:
 *   - the PiP window gets the call's mute / camera / hang-up buttons (Media
 *     Session), and a browser that opens the window by itself when you switch
 *     to another tab (Chrome through the Media Session, Safari through
 *     `autoPictureInPicture`) may do so. Nothing is ever requested from a
 *     visibility change: a browser that wants a user gesture would refuse, so
 *     where the browser has no such hook only the button works;
 *   - when the picture changes (their screen starts) the window follows it, and
 *     when it goes (the call ends or is minimised) the window closes;
 *   - a window the browser opened by itself closes when you come back.
 *
 * @returns {{supported: boolean, available: boolean, inPip: boolean, toggle: () => Promise<"entered"|"left"|"failed">}}
 */
export function usePictureInPicture({ targetKey, getTarget, kind, muted, cameraOn, onToggleMicrophone, onToggleCamera, onHangup }) {
  const supported = pipSupported();
  const [inPip, setInPip] = useState(() => callPipActive());
  const autoEntered = useRef(false);
  const sessionRef = useRef(null);
  const latest = useRef({});
  useEffect(() => {
    latest.current = { getTarget, onToggleMicrophone, onToggleCamera, onHangup, muted, cameraOn };
  });

  // Whether the window is open, however it was opened or closed.
  useEffect(() => {
    const sync = () => {
      const open = callPipActive();
      if (!open) autoEntered.current = false;
      setInPip(open);
    };
    document.addEventListener("enterpictureinpicture", sync, true);
    document.addEventListener("leavepictureinpicture", sync, true);
    sync();
    return () => {
      document.removeEventListener("enterpictureinpicture", sync, true);
      document.removeEventListener("leavepictureinpicture", sync, true);
    };
  }, []);

  const floatable = supported && Boolean(targetKey);

  // The window's buttons and the browser's own "open it by itself" hook.
  useEffect(() => {
    if (!floatable) return undefined;
    const controls = bindCallControls({
      onToggleMicrophone: () => latest.current.onToggleMicrophone?.(),
      onToggleCamera: kind === "video" ? () => latest.current.onToggleCamera?.() : undefined,
      onHangup: () => latest.current.onHangup?.(),
      // The browser calls this when the person leaves for another tab, and treats it as a gesture.
      onEnterPictureInPicture: async () => {
        if (await enterPictureInPicture(latest.current.getTarget?.())) autoEntered.current = true;
      },
    });
    sessionRef.current = controls;
    setPictureInPictureArmed(controls.bound.includes("enterpictureinpicture"));
    controls.setState({ microphoneActive: !latest.current.muted, cameraActive: Boolean(latest.current.cameraOn) });
    const video = latest.current.getTarget?.();
    setAutoPictureInPicture(video, true);
    return () => {
      controls.dispose();
      setPictureInPictureArmed(false);
      sessionRef.current = null;
      setAutoPictureInPicture(video, false);
    };
  }, [floatable, targetKey, kind]);
  // The buttons of the window show whether the microphone and the camera are on.
  useEffect(() => {
    sessionRef.current?.setState({ microphoneActive: !muted, cameraActive: Boolean(cameraOn) });
  }, [muted, cameraOn]);

  // The picture changed or went away: the window follows it, or closes.
  useEffect(() => {
    if (!callPipActive()) return;
    const next = latest.current.getTarget?.();
    if (!next) void leavePictureInPicture();
    else if (document.pictureInPictureElement !== next) void enterPictureInPicture(next);
  }, [targetKey]);

  // Back in the tab: a window the browser opened by itself has done its job.
  useEffect(() => {
    const onVisible = () => {
      if (document.hidden || !autoEntered.current) return;
      autoEntered.current = false;
      void leavePictureInPicture();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  // Never leave the window behind when the call screen goes away for good.
  useEffect(
    () => () => {
      void leavePictureInPicture();
    },
    [],
  );

  const toggle = useCallback(async () => {
    const video = latest.current.getTarget?.();
    if (!video) return "failed";
    const result = await togglePictureInPicture(video);
    if (result !== "entered") autoEntered.current = false;
    return result;
  }, []);

  return { supported, available: floatable, inPip, toggle };
}
