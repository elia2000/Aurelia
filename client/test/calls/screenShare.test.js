import { describe, test, expect, vi } from "vitest";
import {
  MAX_ANNOUNCED_SIZE,
  ScreenShare,
  canShareScreen,
  clampScreenSize,
  describeMediaSections,
  locateVideoLines,
  screenErrorReason,
  surfaceOf,
} from "../../src/calls/screenShare.js";
import { FakeStream, FakeTrack, makeGetDisplayMedia } from "./fakes.js";

const sdp = (...sections) =>
  [
    "v=0",
    "s=-",
    "t=0 0",
    "a=group:BUNDLE 0 1 2",
    ...sections.flatMap(({ kind, port = 9, mid, direction = "sendrecv" }) => [
      `m=${kind} ${port} UDP/TLS/RTP/SAVPF 96`,
      ...(mid === undefined ? [] : [`a=mid:${mid}`]),
      `a=${direction}`,
    ]),
    "",
  ].join("\r\n");

describe("canShareScreen", () => {
  test("is true only where the browser can capture a screen", () => {
    expect(canShareScreen({ mediaDevices: { getDisplayMedia() {} } })).toBe(true);
    expect(canShareScreen({ mediaDevices: {} })).toBe(false); // phones and iOS
    expect(canShareScreen({})).toBe(false);
    expect(canShareScreen(undefined)).toBe(false);
  });
});

describe("reading the media lines of an SDP", () => {
  test("lists them in order with their mid, direction and whether they were rejected", () => {
    const text = sdp({ kind: "audio", mid: "a" }, { kind: "video", mid: "b", direction: "recvonly" }, { kind: "video", port: 0, mid: "c", direction: "inactive" });
    expect(describeMediaSections(text)).toEqual([
      { kind: "audio", mid: "a", direction: "sendrecv", rejected: false },
      { kind: "video", mid: "b", direction: "recvonly", rejected: false },
      { kind: "video", mid: "c", direction: "inactive", rejected: true },
    ]);
    expect(describeMediaSections("")).toEqual([]);
    expect(describeMediaSections(null)).toEqual([]);
  });

  test("in a video call the first video line is the camera and the second the screen", () => {
    const text = sdp({ kind: "audio", mid: "0" }, { kind: "video", mid: "1" }, { kind: "video", mid: "2" });
    const { camera, screen } = locateVideoLines(text, "video");
    expect(camera.mid).toBe("1");
    expect(screen.mid).toBe("2");
  });

  test("in a voice call the only video line is the screen", () => {
    const { camera, screen } = locateVideoLines(sdp({ kind: "audio", mid: "0" }, { kind: "video", mid: "1" }), "audio");
    expect(camera).toBeNull();
    expect(screen.mid).toBe("1");
  });

  test("a missing, rejected or unnamed line is no line", () => {
    expect(locateVideoLines(sdp({ kind: "audio", mid: "0" }, { kind: "video", mid: "1" }), "video").screen).toBeNull();
    expect(locateVideoLines(sdp({ kind: "audio", mid: "0" }), "audio").screen).toBeNull();
    expect(locateVideoLines(sdp({ kind: "audio", mid: "0" }, { kind: "video", port: 0, mid: "1" }), "audio").screen).toBeNull();
    expect(locateVideoLines(sdp({ kind: "audio", mid: "0" }, { kind: "video" }), "audio").screen).toBeNull();
    expect(locateVideoLines(sdp({ kind: "audio", mid: "0" }, { kind: "video", mid: "1" }, { kind: "video", mid: "2" }), "video").screen.mid).toBe("2");
    expect(locateVideoLines("garbage", "video")).toEqual({ camera: null, screen: null });
  });
});

describe("why a capture did not start", () => {
  test("a refused or closed prompt is 'cancelled': a page cannot tell them apart", () => {
    for (const name of ["NotAllowedError", "SecurityError", "AbortError"]) {
      expect(screenErrorReason({ name })).toBe("cancelled");
    }
  });
  test("a browser without the feature is 'unsupported'; anything else 'failed'", () => {
    expect(screenErrorReason({ name: "TypeError" })).toBe("unsupported");
    expect(screenErrorReason({ name: "NotSupportedError" })).toBe("unsupported");
    expect(screenErrorReason({ name: "NotReadableError" })).toBe("failed");
    expect(screenErrorReason(null)).toBe("failed");
    expect(screenErrorReason("boom")).toBe("failed");
  });
});

describe("sizes the other side announces", () => {
  test("whole pixels in range pass, the rest is clamped or refused", () => {
    expect(clampScreenSize(1920)).toBe(1920);
    expect(clampScreenSize(1919.6)).toBe(1920);
    expect(clampScreenSize(1)).toBe(1);
    expect(clampScreenSize(1e9)).toBe(MAX_ANNOUNCED_SIZE);
    for (const bad of [0, 0.4, -3, NaN, Infinity, -Infinity, "1920", null, undefined, {}, [], true]) {
      expect(clampScreenSize(bad)).toBeNull();
    }
  });
});

describe("what is being captured", () => {
  test("is the whole screen, a window or a tab, as the browser says; anything else is unknown", () => {
    const track = (displaySurface) => new FakeTrack("video", "screen", { displaySurface });
    expect(surfaceOf(track("monitor"))).toBe("monitor");
    expect(surfaceOf(track("window"))).toBe("window");
    expect(surfaceOf(track("browser"))).toBe("browser");
    expect(surfaceOf(track("application"))).toBeNull();
    expect(surfaceOf(track(undefined))).toBeNull();
    expect(surfaceOf({ getSettings: () => { throw new Error("gone"); } })).toBeNull();
    expect(surfaceOf(null)).toBeNull();
  });
});

describe("the share on its own", () => {
  function setup({ getDisplayMedia = makeGetDisplayMedia(), live = true } = {}) {
    const sent = [];
    const patches = [];
    const sender = {
      track: null,
      params: { encodings: [{}] },
      replaceTrack: vi.fn(async (t) => {
        sender.track = t;
      }),
      getParameters: () => JSON.parse(JSON.stringify(sender.params)),
      setParameters: vi.fn(async (p) => {
        sender.params = p;
      }),
    };
    const transceiver = { mid: "2", sender, receiver: { track: new FakeTrack("video") } };
    const alive = { value: live };
    const share = new ScreenShare({
      getDisplayMedia,
      send: (m) => sent.push(m),
      emit: (p) => patches.push(p),
      isLive: () => alive.value,
      createMediaStream: () => new FakeStream(),
    });
    share.attachLine(transceiver);
    return { share, sent, patches, sender, transceiver, alive, getDisplayMedia };
  }

  test("it cannot start before the other app has said it can show a screen", async () => {
    const { share, sender, patches } = setup();
    expect(share.available).toBe(false);
    await share.want(true);
    expect(sender.replaceTrack).not.toHaveBeenCalled();
    expect(patches.at(-1)).toEqual({ screenError: "unavailable" });
    expect(share.wanted).toBe(false);
  });

  test("it is told apart from other lines by identity or by mid", () => {
    const { share, transceiver } = setup();
    expect(share.isLine(transceiver)).toBe(true);
    expect(share.isLine({ mid: "2" })).toBe(true);
    expect(share.isLine({ mid: "1" })).toBe(false);
    expect(share.isLine({ mid: null })).toBe(false);
    expect(share.isLine(null)).toBe(false);
  });

  test("the mid learnt from the offer is used before the browser has applied it", () => {
    const share = new ScreenShare({ getDisplayMedia: null, send() {}, emit() {}, isLive: () => true, createMediaStream: () => new FakeStream() });
    share.expectMid("5");
    expect(share.isLine({ mid: "5" })).toBe(true);
    expect(share.hasLine).toBe(false);
    expect(share.capabilityToAnnounce).toBe(false);
  });

  test("a call with no way to capture says 'unsupported'", async () => {
    const { share, patches } = setup({ getDisplayMedia: null });
    share.setPeerCapable(true);
    await share.want(true);
    expect(patches.at(-1)).toEqual({ screenError: "unsupported" });
  });

  test("a stream that holds no picture is released and reported as a failure", async () => {
    const { share, patches } = setup({ getDisplayMedia: vi.fn(async () => new FakeStream([])) });
    share.setPeerCapable(true);
    await share.want(true);
    expect(patches.some((p) => p.screenError === "failed")).toBe(true);
    expect(share.sharing).toBe(false);
  });

  test("a peer that says it can show a screen after the share began is told about it", async () => {
    const { share, sent } = setup();
    share.setPeerCapable(true);
    await share.want(true);
    const before = sent.length;
    share.setPeerCapable(false);
    share.setPeerCapable(true);
    expect(sent.length).toBe(before + 1);
    expect(sent.at(-1)).toMatchObject({ t: "screen", on: true });
  });

  test("a call that is over takes no more messages and sends none", async () => {
    const { share, sent, patches, alive, getDisplayMedia } = setup();
    share.setPeerCapable(true);
    await share.want(true);
    const track = getDisplayMedia.streams[0].getVideoTracks()[0];
    alive.value = false;
    const sentBefore = sent.length;
    const patchesBefore = patches.length;
    share.dispose();
    expect(track.stopped).toBe(true);
    expect(share.disposed).toBe(true);
    expect(sent.length).toBe(sentBefore);
    expect(patches.length).toBe(patchesBefore);
    await share.want(true);
    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
  });

  test("it only believes announcements once its own line exists", () => {
    const share = new ScreenShare({ getDisplayMedia: null, send() {}, emit: vi.fn(), isLive: () => true, createMediaStream: () => new FakeStream() });
    share.onRemoteMessage({ t: "screen", on: true });
    expect(share.hasLine).toBe(false);
  });

  describe("what the other person shares", () => {
    const remote = () => {
      const ctx = setup();
      ctx.share.setPeerCapable(true);
      ctx.patches.length = 0;
      const picture = new FakeTrack("video");
      return { ...ctx, picture, last: () => ctx.patches.filter((p) => "remoteScreenOn" in p).at(-1) };
    };

    test("the announcement and the picture can arrive in either order, and both are needed", () => {
      const { share, picture, last } = remote();
      share.onRemoteMessage({ t: "screen", on: true, w: 1280, h: 720 });
      expect(last()).toBeUndefined(); // no picture on the line yet
      share.attachRemoteTrack(picture);
      expect(last()).toMatchObject({ remoteScreenOn: true, remoteScreenSize: { w: 1280, h: 720 } });
      expect(last().remoteScreenStream.getVideoTracks()).toEqual([picture]);
    });

    test("a picture alone shows nothing, and the announcement ending closes the view", () => {
      const { share, picture, last } = remote();
      share.attachRemoteTrack(picture);
      expect(last()).toBeUndefined();
      share.onRemoteMessage({ t: "screen", on: true });
      expect(last().remoteScreenOn).toBe(true);
      share.onRemoteMessage({ t: "screen", on: false });
      expect(last()).toMatchObject({ remoteScreenOn: false, remoteScreenStream: null, remoteScreenSize: null });
    });

    test("a line whose picture has ended is not shown", () => {
      const { share, picture, last } = remote();
      share.attachRemoteTrack(picture);
      share.onRemoteMessage({ t: "screen", on: true });
      picture.stop();
      share.onRemoteMessage({ t: "screen", on: true, w: 640, h: 480 });
      expect(last().remoteScreenOn).toBe(false);
    });

    test("the same announcement twice changes nothing; a new size does", () => {
      const { share, picture, patches } = remote();
      share.attachRemoteTrack(picture);
      share.onRemoteMessage({ t: "screen", on: true, w: 800, h: 600 });
      const count = patches.length;
      share.onRemoteMessage({ t: "screen", on: true, w: 800, h: 600 });
      expect(patches.length).toBe(count);
      share.onRemoteMessage({ t: "screen", on: true, w: 1024, h: 768 });
      expect(patches.length).toBe(count + 1);
    });

    test("it can be shown again after it was closed", () => {
      const { share, picture, last } = remote();
      share.attachRemoteTrack(picture);
      share.onRemoteMessage({ t: "screen", on: true });
      share.onRemoteMessage({ t: "screen", on: false });
      share.onRemoteMessage({ t: "screen", on: true });
      expect(last().remoteScreenOn).toBe(true);
    });

    test("a missing message, or one with no 'on', counts as off", () => {
      const { share, picture, last } = remote();
      share.attachRemoteTrack(picture);
      share.onRemoteMessage({ t: "screen", on: true });
      share.onRemoteMessage(undefined);
      expect(last().remoteScreenOn).toBe(false);
      share.onRemoteMessage({ t: "screen", on: true });
      share.onRemoteMessage({ t: "screen" });
      expect(last().remoteScreenOn).toBe(false);
    });
  });
});
