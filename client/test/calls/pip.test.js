import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import {
  bindCallControls,
  callPipActive,
  enterPictureInPicture,
  isCallVideo,
  leavePictureInPicture,
  pipSupported,
  setAutoPictureInPicture,
  togglePictureInPicture,
} from "../../src/calls/pip.js";

beforeEach(() => {
  vi.stubGlobal("HTMLVideoElement", class FakeVideo { requestPictureInPicture() {} });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const video = (view, extra = {}) => ({ dataset: { view }, requestPictureInPicture: vi.fn(async () => {}), disablePictureInPicture: false, ...extra });
const doc = (extra = {}) => ({ pictureInPictureEnabled: true, pictureInPictureElement: null, exitPictureInPicture: vi.fn(async () => {}), ...extra });

describe("pipSupported", () => {
  test("needs the browser to say picture in picture is enabled and to have the request", () => {
    expect(pipSupported(doc())).toBe(true);
    expect(pipSupported(doc({ pictureInPictureEnabled: false }))).toBe(false);
    expect(pipSupported(doc({ pictureInPictureEnabled: undefined }))).toBe(false); // Firefox
    expect(pipSupported(null)).toBe(false);
  });

  test("a browser whose video cannot request it is not supported", () => {
    vi.stubGlobal("HTMLVideoElement", class NoPip {});
    expect(pipSupported(doc())).toBe(false);
    vi.stubGlobal("HTMLVideoElement", undefined);
    expect(pipSupported(doc())).toBe(false);
  });
});

describe("which videos are the call's", () => {
  test("the other person's camera and screen are, the person's own picture is not", () => {
    expect(isCallVideo(video("remote"))).toBe(true);
    expect(isCallVideo(video("screen"))).toBe(true);
    expect(isCallVideo(video("local"))).toBe(false);
    expect(isCallVideo({ dataset: {} })).toBe(false);
    expect(isCallVideo(null)).toBe(false);
  });

  test("a video in the chat that is in picture in picture is not the call's window", () => {
    expect(callPipActive(doc({ pictureInPictureElement: { dataset: {} } }))).toBe(false);
    expect(callPipActive(doc({ pictureInPictureElement: video("remote") }))).toBe(true);
    expect(callPipActive(doc())).toBe(false);
  });
});

describe("enterPictureInPicture", () => {
  test("asks the video and says yes", async () => {
    const v = video("remote");
    expect(await enterPictureInPicture(v, doc())).toBe(true);
    expect(v.requestPictureInPicture).toHaveBeenCalledTimes(1);
  });

  test("is already there: nothing to ask", async () => {
    const v = video("remote");
    expect(await enterPictureInPicture(v, doc({ pictureInPictureElement: v }))).toBe(true);
    expect(v.requestPictureInPicture).not.toHaveBeenCalled();
  });

  test("a refusal is an answer, not an error (no user gesture, no picture yet)", async () => {
    const v = video("remote", { requestPictureInPicture: vi.fn(async () => { throw Object.assign(new Error("no"), { name: "NotAllowedError" }); }) });
    await expect(enterPictureInPicture(v, doc())).resolves.toBe(false);
  });

  test("nothing to show, no support, or a video that opted out", async () => {
    expect(await enterPictureInPicture(null, doc())).toBe(false);
    const v = video("remote");
    expect(await enterPictureInPicture(v, doc({ pictureInPictureEnabled: false }))).toBe(false);
    expect(await enterPictureInPicture(video("remote", { disablePictureInPicture: true }), doc())).toBe(false);
    expect(v.requestPictureInPicture).not.toHaveBeenCalled();
  });
});

describe("leavePictureInPicture and togglePictureInPicture", () => {
  test("closes the window of the call", async () => {
    const d = doc({ pictureInPictureElement: video("screen") });
    expect(await leavePictureInPicture(d)).toBe(true);
    expect(d.exitPictureInPicture).toHaveBeenCalledTimes(1);
  });

  test("leaves a window that is not the call's alone", async () => {
    const d = doc({ pictureInPictureElement: { dataset: {} } });
    expect(await leavePictureInPicture(d)).toBe(false);
    expect(d.exitPictureInPicture).not.toHaveBeenCalled();
  });

  test("a failure to close is silent", async () => {
    const d = doc({ pictureInPictureElement: video("remote"), exitPictureInPicture: vi.fn(async () => { throw new Error("x"); }) });
    await expect(leavePictureInPicture(d)).resolves.toBe(false);
  });

  test("the button opens, then closes", async () => {
    const v = video("remote");
    const d = doc();
    expect(await togglePictureInPicture(v, d)).toBe("entered");
    d.pictureInPictureElement = v;
    expect(await togglePictureInPicture(v, d)).toBe("left");
    expect(d.exitPictureInPicture).toHaveBeenCalledTimes(1);
  });

  test("the button reports a refusal", async () => {
    const v = video("remote", { requestPictureInPicture: vi.fn(async () => { throw new Error("no"); }) });
    expect(await togglePictureInPicture(v, doc())).toBe("failed");
  });

  test("the button switches the window to another picture of the call", async () => {
    const screen = video("screen");
    const d = doc({ pictureInPictureElement: video("remote") });
    expect(await togglePictureInPicture(screen, d)).toBe("entered");
    expect(screen.requestPictureInPicture).toHaveBeenCalled();
  });
});

describe("bindCallControls (Media Session)", () => {
  const session = () => ({
    handlers: {},
    setActionHandler: vi.fn(function set(action, handler) {
      this.handlers[action] = handler;
    }),
    setMicrophoneActive: vi.fn(),
    setCameraActive: vi.fn(),
  });

  test("registers mute, camera, hang up and the browser's open-by-itself hook", () => {
    const s = session();
    const onMute = vi.fn();
    const onHangup = vi.fn();
    const controls = bindCallControls({ session: s, onToggleMicrophone: onMute, onToggleCamera: vi.fn(), onHangup, onEnterPictureInPicture: vi.fn() });
    expect(controls.bound).toEqual(["togglemicrophone", "togglecamera", "hangup", "enterpictureinpicture"]);
    s.handlers.togglemicrophone();
    s.handlers.hangup();
    expect(onMute).toHaveBeenCalledTimes(1);
    expect(onHangup).toHaveBeenCalledTimes(1);
  });

  test("an action without a handler is not registered (a voice call has no camera)", () => {
    const s = session();
    const controls = bindCallControls({ session: s, onToggleMicrophone: vi.fn(), onHangup: vi.fn() });
    expect(controls.bound).toEqual(["togglemicrophone", "hangup"]);
    expect(s.handlers.togglecamera).toBeUndefined();
  });

  test("a browser that does not know an action ignores it, and the others still register", () => {
    const s = session();
    s.setActionHandler.mockImplementation(function set(action, handler) {
      if (action === "togglecamera" || action === "enterpictureinpicture") throw new TypeError("unsupported action");
      this.handlers[action] = handler;
    });
    const controls = bindCallControls({ session: s, onToggleMicrophone: vi.fn(), onToggleCamera: vi.fn(), onHangup: vi.fn(), onEnterPictureInPicture: vi.fn() });
    expect(controls.bound).toEqual(["togglemicrophone", "hangup"]);
  });

  test("shows whether the microphone and the camera are on", () => {
    const s = session();
    const controls = bindCallControls({ session: s, onToggleMicrophone: vi.fn() });
    controls.setState({ microphoneActive: false, cameraActive: true });
    expect(s.setMicrophoneActive).toHaveBeenCalledWith(false);
    expect(s.setCameraActive).toHaveBeenCalledWith(true);
    // A browser without these setters is fine.
    delete s.setMicrophoneActive;
    expect(() => controls.setState({ microphoneActive: true })).not.toThrow();
  });

  test("dispose takes every handler away", () => {
    const s = session();
    const controls = bindCallControls({ session: s, onToggleMicrophone: vi.fn(), onHangup: vi.fn() });
    controls.dispose();
    expect(s.handlers.togglemicrophone).toBeNull();
    expect(s.handlers.hangup).toBeNull();
    const calls = s.setActionHandler.mock.calls.length;
    controls.dispose(); // twice is harmless
    expect(s.setActionHandler.mock.calls.length).toBe(calls);
  });

  test("no Media Session: everything is a no-op", () => {
    const controls = bindCallControls({ session: null, onHangup: vi.fn() });
    expect(controls.bound).toEqual([]);
    expect(() => {
      controls.setState({ microphoneActive: true });
      controls.dispose();
    }).not.toThrow();
  });
});

describe("setAutoPictureInPicture", () => {
  test("sets the property where the browser has it", () => {
    const v = { autoPictureInPicture: false };
    setAutoPictureInPicture(v, true);
    expect(v.autoPictureInPicture).toBe(true);
    setAutoPictureInPicture(v, false);
    expect(v.autoPictureInPicture).toBe(false);
  });

  test("leaves a browser without it alone", () => {
    const v = {};
    setAutoPictureInPicture(v, true);
    expect("autoPictureInPicture" in v).toBe(false);
    expect(() => setAutoPictureInPicture(null, true)).not.toThrow();
  });
});
