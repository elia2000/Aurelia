// Picture in picture for a call: the other person's video (or the screen they
// share) in a small floating window that stays on top of other apps. These are
// thin, testable wrappers over the browser's Picture-in-Picture API and the
// Media Session API; nothing here touches the call itself, so the end-to-end
// authentication and encryption are as they were (the window only shows what
// the call screen shows, decrypted on this device, and the call's audio keeps
// playing from its own element).
//
// Support (see docs): Chrome and Edge on a computer have the API, the PiP
// window's mute / camera / hang-up buttons (Media Session) and, from Chrome
// 134, opening it by itself when you switch to another tab. Safari on a Mac has
// the API and opens it by itself with `autoPictureInPicture`. Firefox has no
// page API (its own hover button works but has no call controls); phones'
// browsers do not offer it. Where `document.pictureInPictureEnabled` is not
// true the button is simply not shown.

const hasDocument = () => typeof document !== "undefined";

/** Whether this browser lets a page put a video in picture in picture. */
export function pipSupported(doc = hasDocument() ? document : null) {
  return Boolean(
    doc &&
      doc.pictureInPictureEnabled === true &&
      typeof HTMLVideoElement !== "undefined" &&
      typeof HTMLVideoElement.prototype.requestPictureInPicture === "function",
  );
}

/** A video of the call: the other person's camera or screen (the person's own picture is not one). */
export const isCallVideo = (element) => element?.dataset?.view === "remote" || element?.dataset?.view === "screen";

/** True when a video of the call is the one in picture in picture right now. */
export const callPipActive = (doc = hasDocument() ? document : null) => isCallVideo(doc?.pictureInPictureElement);

/**
 * Puts `video` in picture in picture. A browser may say no (no user gesture,
 * a video that has no picture yet, a policy): that is an answer, not an error.
 * @returns {Promise<boolean>} whether the video is in picture in picture now
 */
export async function enterPictureInPicture(video, doc = hasDocument() ? document : null) {
  if (!video || !pipSupported(doc) || video.disablePictureInPicture) return false;
  try {
    if (doc.pictureInPictureElement !== video) await video.requestPictureInPicture();
    return true;
  } catch (_) {
    return false;
  }
}

/** Closes the picture-in-picture window if a video of the call is in it. */
export async function leavePictureInPicture(doc = hasDocument() ? document : null) {
  if (!callPipActive(doc)) return false;
  try {
    await doc.exitPictureInPicture();
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * The button: opens the window, or closes it when this video is already in it.
 * @returns {Promise<"entered"|"left"|"failed">}
 */
export async function togglePictureInPicture(video, doc = hasDocument() ? document : null) {
  if (doc?.pictureInPictureElement && doc.pictureInPictureElement === video) {
    return (await leavePictureInPicture(doc)) ? "left" : "failed";
  }
  return (await enterPictureInPicture(video, doc)) ? "entered" : "failed";
}

const noControls = Object.freeze({ bound: [], setState() {}, dispose() {} });

/**
 * Wires the call to the Media Session API, so the picture-in-picture window
 * (and, on some systems, the media notification) offers the call's own
 * buttons: mute, camera and hang up, and so a browser can open the window by
 * itself when the person switches to another tab. Every action is optional
 * and every call is guarded: a browser that does not know an action ignores it.
 * @returns {{bound: string[], setState: (s: {microphoneActive?: boolean, cameraActive?: boolean}) => void, dispose: () => void}}
 */
export function bindCallControls({
  session = typeof navigator === "undefined" ? null : navigator.mediaSession,
  onToggleMicrophone,
  onToggleCamera,
  onHangup,
  onEnterPictureInPicture,
} = {}) {
  if (!session || typeof session.setActionHandler !== "function") return noControls;
  const bound = [];
  const bind = (action, handler) => {
    if (typeof handler !== "function") return;
    try {
      session.setActionHandler(action, handler);
      bound.push(action);
    } catch (_) {
      // This browser does not know the action.
    }
  };
  bind("togglemicrophone", onToggleMicrophone);
  bind("togglecamera", onToggleCamera);
  bind("hangup", onHangup);
  bind("enterpictureinpicture", onEnterPictureInPicture);
  return {
    bound: [...bound],
    setState({ microphoneActive, cameraActive } = {}) {
      try {
        if (typeof microphoneActive === "boolean") session.setMicrophoneActive?.(microphoneActive);
        if (typeof cameraActive === "boolean") session.setCameraActive?.(cameraActive);
      } catch (_) {
        // Not supported: the window shows its buttons without a state.
      }
    },
    dispose() {
      for (const action of bound.splice(0)) {
        try {
          session.setActionHandler(action, null);
        } catch (_) {
          // Nothing to undo.
        }
      }
    },
  };
}

// True while the call screen shows a picture that a browser may float by itself when
// the person leaves for another tab (see usePictureInPicture). The call provider reads it
// so that it does not release the camera for the moment before the window opens.
let armed = false;
export const setPictureInPictureArmed = (value) => {
  armed = Boolean(value);
};
export const pictureInPictureArmed = () => armed;

/** Lets Safari open the window by itself when the tab goes to the background; harmless where it is unknown. */
export function setAutoPictureInPicture(video, on) {
  try {
    if (video && "autoPictureInPicture" in video) video.autoPictureInPicture = Boolean(on);
  } catch (_) {
    // Not supported.
  }
}
