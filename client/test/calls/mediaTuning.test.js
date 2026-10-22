import { describe, test, expect } from "vitest";
import {
  CAPTURE_CONSTRAINTS,
  DEFAULT_FIXED_LEVEL,
  FIXED_LEVELS,
  QUALITY_CHOICES,
  SCREEN_CONTENT_HINT,
  SCREEN_PROFILES,
  VIDEO_TIERS,
  captureVideoConstraints,
  encodingForScreen,
  encodingForTier,
  getScreenProfile,
  initialAdaptation,
  initialScreenAdaptation,
  isQualityChoice,
  nextScreenProfile,
  nextVideoTier,
  orderVideoCodecs,
  screenCaptureRequest,
  summarizeStats,
  tuneOpusSdp,
} from "../../src/calls/mediaTuning.js";

const SDP = [
  "v=0",
  "o=- 1 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111 63 9",
  "c=IN IP4 0.0.0.0",
  "a=rtpmap:111 opus/48000/2",
  "a=fmtp:111 minptime=10;useinbandfec=1;maxaveragebitrate=510000",
  "a=rtpmap:63 red/48000/2",
  "a=ptime:20",
  "m=video 9 UDP/TLS/RTP/SAVPF 96",
  "a=rtpmap:96 VP8/90000",
  "a=ptime:20",
  "",
].join("\r\n");

describe("tuneOpusSdp", () => {
  const out = tuneOpusSdp(SDP);
  const lines = out.split("\r\n");

  test("enables DTX, FEC and mono voice at a low bitrate", () => {
    const fmtp = lines.find((l) => l.startsWith("a=fmtp:111"));
    expect(fmtp).toContain("usedtx=1");
    expect(fmtp).toContain("useinbandfec=1");
    expect(fmtp).toContain("maxaveragebitrate=24000");
    expect(fmtp).toContain("stereo=0");
    expect(fmtp).toContain("minptime=10"); // existing parameters are preserved
  });

  test("never raises a bitrate that the peer capped lower", () => {
    const capped = SDP.replace("maxaveragebitrate=510000", "maxaveragebitrate=16000");
    const fmtp = tuneOpusSdp(capped).split("\r\n").find((l) => l.startsWith("a=fmtp:111"));
    expect(fmtp).toContain("maxaveragebitrate=16000");
  });

  test("sets a 40 ms packet time in the audio section only, exactly once", () => {
    const audioStart = lines.findIndex((l) => l.startsWith("m=audio"));
    const videoStart = lines.findIndex((l) => l.startsWith("m=video"));
    const audio = lines.slice(audioStart, videoStart);
    expect(audio.filter((l) => l.startsWith("a=ptime:"))).toEqual(["a=ptime:40"]);
    expect(lines.slice(videoStart).filter((l) => l.startsWith("a=ptime:"))).toEqual(["a=ptime:20"]);
  });

  test("keeps the SDP structurally intact", () => {
    expect(out.startsWith("v=0\r\n")).toBe(true);
    expect(out.endsWith("\r\n")).toBe(true);
    expect(lines.filter((l) => l.startsWith("m="))).toHaveLength(2);
    expect(lines.filter((l) => l.startsWith("a=rtpmap:111"))).toHaveLength(1);
  });

  test("adds an fmtp line when the offer has none, and is a no-op without opus", () => {
    const bare = SDP.replace(/a=fmtp:111.*\r\n/, "");
    expect(tuneOpusSdp(bare)).toContain("a=fmtp:111 usedtx=1");
    const noOpus = "v=0\r\nm=audio 9 RTP/AVP 0\r\na=rtpmap:0 PCMU/8000\r\n";
    expect(tuneOpusSdp(noOpus)).toBe(noOpus);
  });

  test("is idempotent", () => {
    expect(tuneOpusSdp(out)).toBe(out);
  });

  test("works with LF-only SDP", () => {
    const lf = SDP.replace(/\r\n/g, "\n");
    expect(tuneOpusSdp(lf)).toContain("usedtx=1");
    expect(tuneOpusSdp(lf)).not.toContain("\r");
  });
});

describe("orderVideoCodecs", () => {
  const c = (mimeType, sdpFmtpLine = "") => ({ mimeType, sdpFmtpLine });
  test("prefers constrained-baseline H.264, then VP8, then VP9/AV1; helpers last", () => {
    const ordered = orderVideoCodecs([
      c("video/AV1"),
      c("video/VP9"),
      c("video/rtx"),
      c("video/VP8"),
      c("video/H264", "profile-level-id=640c1f"),
      c("video/H264", "profile-level-id=42e01f"),
      c("video/red"),
    ]).map((x) => `${x.mimeType}|${x.sdpFmtpLine}`);
    expect(ordered).toEqual([
      "video/H264|profile-level-id=42e01f",
      "video/H264|profile-level-id=640c1f",
      "video/VP8|",
      "video/VP9|",
      "video/AV1|",
      "video/rtx|",
      "video/red|",
    ]);
  });
  test("keeps every codec (setCodecPreferences needs the full list)", () => {
    const input = [c("video/VP9"), c("video/foo"), c("video/VP8")];
    expect(orderVideoCodecs(input)).toHaveLength(3);
  });
});

describe("summarizeStats", () => {
  test("reads RTT, loss and whether the path is relayed", () => {
    const out = summarizeStats([
      { id: "p", type: "candidate-pair", nominated: true, currentRoundTripTime: 0.12, availableOutgoingBitrate: 800000, localCandidateId: "l", remoteCandidateId: "r" },
      { id: "l", type: "local-candidate", candidateType: "relay" },
      { id: "r", type: "remote-candidate", candidateType: "host" },
      { id: "x", type: "remote-inbound-rtp", fractionLost: 0.05 },
    ]);
    expect(out.rttMs).toBeCloseTo(120);
    expect(out.lossPct).toBeCloseTo(5);
    expect(out.relayed).toBe(true);
    expect(out.availableKbps).toBe(800);
  });
  test("only the pair the connection uses counts, not every pair that passed its check", () => {
    const direct = { id: "p1", type: "candidate-pair", nominated: true, state: "succeeded", currentRoundTripTime: 0.03, localCandidateId: "l1", remoteCandidateId: "r1", bytesSent: 900000 };
    const spare = { id: "p2", type: "candidate-pair", nominated: false, state: "succeeded", currentRoundTripTime: 0.4, localCandidateId: "l2", remoteCandidateId: "r2", bytesSent: 0 };
    const reports = [
      direct,
      spare,
      { id: "l1", type: "local-candidate", candidateType: "host" },
      { id: "r1", type: "remote-candidate", candidateType: "host" },
      { id: "l2", type: "local-candidate", candidateType: "relay" },
      { id: "r2", type: "remote-candidate", candidateType: "host" },
    ];
    // Whatever the order, the spare relayed pair must not turn the badge on.
    for (const order of [reports, [...reports].reverse()]) {
      const out = summarizeStats(order);
      expect(out.relayed).toBe(false);
      expect(out.rttMs).toBeCloseTo(30);
    }
    // The transport names the selected pair explicitly.
    const viaTransport = summarizeStats([{ id: "t", type: "transport", selectedCandidatePairId: "p2" }, ...reports]);
    expect(viaTransport.relayed).toBe(true);
    expect(viaTransport.rttMs).toBeCloseTo(400);
  });
  test("handles an empty report", () => {
    expect(summarizeStats([])).toEqual({ rttMs: null, lossPct: 0, relayed: false, availableKbps: null, jitterMs: null });
  });
  test("reads the voice's jitter in milliseconds, from both directions, and ignores the picture's", () => {
    const out = summarizeStats([
      { id: "a", type: "inbound-rtp", kind: "audio", jitter: 0.012 },
      { id: "b", type: "remote-inbound-rtp", kind: "audio", jitter: 0.031, fractionLost: 0 },
      // Video arrives a frame at a time, so its jitter looks high even on a perfect line.
      { id: "v", type: "inbound-rtp", kind: "video", jitter: 0.2, frameWidth: 640, frameHeight: 360 },
      { id: "w", type: "remote-inbound-rtp", kind: "video", jitter: 0.3, fractionLost: 0 },
    ]);
    expect(out.jitterMs).toBeCloseTo(31);
    expect(summarizeStats([{ id: "o", type: "inbound-rtp", mediaType: "audio", jitter: 0.004 }]).jitterMs).toBeCloseTo(4);
    expect(summarizeStats([{ id: "v", type: "inbound-rtp", kind: "video", jitter: 0.2 }]).jitterMs).toBeNull();
  });
});

describe("nextVideoTier", () => {
  const good = { lossPct: 0.5, rttMs: 80 };
  const bad = { lossPct: 12, rttMs: 90 };
  const run = (start, samples) => {
    let tier = start;
    let state = initialAdaptation();
    const seen = [];
    for (const s of samples) {
      ({ tier, state } = nextVideoTier(tier, s, state));
      seen.push(tier);
    }
    return seen;
  };

  test("steps down one tier immediately on a bad sample", () => {
    expect(run("high", [bad])).toEqual(["mid"]);
    expect(run("mid", [bad, bad])).toEqual(["low", "low"]);
  });

  test("falls back to audio only after sustained trouble at the lowest tier", () => {
    expect(run("low", [bad, bad, bad])).toEqual(["low", "low", "off"]);
  });

  test("climbs back slowly: 4 good samples per step, 6 to leave audio-only", () => {
    expect(run("mid", [good, good, good, good])).toEqual(["mid", "mid", "mid", "high"]);
    expect(run("off", Array(6).fill(good))[5]).toBe("low");
    expect(run("off", Array(5).fill(good))[4]).toBe("off");
  });

  test("an in-between sample resets the good streak (no flapping)", () => {
    const meh = { lossPct: 4, rttMs: 300 };
    expect(run("mid", [good, good, good, meh, good])).toEqual(["mid", "mid", "mid", "mid", "mid"]);
  });

  test("high RTT alone counts as bad", () => {
    expect(run("high", [{ lossPct: 0, rttMs: 900 }])).toEqual(["mid"]);
  });
});

describe("encodingForTier", () => {
  test("every tier lowers cost monotonically", () => {
    const rates = VIDEO_TIERS.map((t) => t.maxBitrate);
    expect([...rates].sort((a, b) => a - b)).toEqual(rates);
    expect(VIDEO_TIERS.map((t) => t.id)).toEqual(["off", "low", "mid", "high", "hd", "fhd"]);
    expect(encodingForTier("off").active).toBe(false);
    expect(encodingForTier("high")).toMatchObject({ maxBitrate: 800_000, maxFramerate: 30, active: true });
    expect(encodingForTier("fhd")).toMatchObject({ maxBitrate: 4_000_000, active: true });
  });

  test("a phone held upright sends a tall picture: the tier's size is its shorter side, so 720p is 720 wide", () => {
    // 720 x 1280 from the camera is "720p" in portrait.
    expect(encodingForTier("hd", { width: 720, height: 1280 }).scaleResolutionDownBy).toBe(1);
    expect(encodingForTier("mid", { width: 720, height: 1280 }).scaleResolutionDownBy).toBe(2);
    expect(encodingForTier("fhd", { width: 1080, height: 1920 }).scaleResolutionDownBy).toBe(1);
    expect(encodingForTier("hd", { width: 1080, height: 1920 }).scaleResolutionDownBy).toBe(1.5);
    // The same camera held sideways.
    expect(encodingForTier("hd", { width: 1280, height: 720 }).scaleResolutionDownBy).toBe(1);
  });

  test("scales the picture the camera delivers down to the height of the tier, never up", () => {
    expect(encodingForTier("hd", { width: 1280, height: 720 }).scaleResolutionDownBy).toBe(1);
    expect(encodingForTier("mid", { width: 1280, height: 720 }).scaleResolutionDownBy).toBe(2);
    expect(encodingForTier("low", { width: 1280, height: 720 }).scaleResolutionDownBy).toBe(3);
    expect(encodingForTier("high", { width: 1280, height: 720 }).scaleResolutionDownBy).toBe(1.5);
    expect(encodingForTier("fhd", { width: 1280, height: 720 }).scaleResolutionDownBy).toBe(1); // a 720p camera is not stretched
    expect(encodingForTier("hd", { width: 1920, height: 1080 }).scaleResolutionDownBy).toBe(1.5);
    expect(encodingForTier("mid", { width: 1920, height: 1080 }).scaleResolutionDownBy).toBe(3);
  });
});

describe("the quality slider", () => {
  test("has five stops, lowest first, each with a short name for under the slider", () => {
    expect(FIXED_LEVELS.map((l) => l.id)).toEqual(["low", "mid", "high", "hd", "fhd"]);
    expect(FIXED_LEVELS.map((l) => l.short)).toEqual(["240p", "360p", "480p", "720p", "1080p"]);
    expect(DEFAULT_FIXED_LEVEL).toBe("hd");
    expect(FIXED_LEVELS.some((l) => l.id === "off")).toBe(false);
  });
});

describe("what to ask the camera for", () => {
  test("Auto and unknown ask for 720p at 30 frames", () => {
    expect(captureVideoConstraints("auto")).toBe(CAPTURE_CONSTRAINTS.video);
    expect(captureVideoConstraints("nonsense")).toBe(CAPTURE_CONSTRAINTS.video);
    expect(CAPTURE_CONSTRAINTS.video.height.ideal).toBe(720);
  });
  test("the top level asks for 1080p and the lowest ones do not wake a big sensor", () => {
    expect(captureVideoConstraints("fhd")).toMatchObject({ width: { ideal: 1920 }, height: { ideal: 1080 } });
    expect(captureVideoConstraints("hd").height.ideal).toBe(720);
    expect(captureVideoConstraints("low").height.ideal).toBe(360);
    expect(captureVideoConstraints("low").frameRate.ideal).toBe(15);
  });
});

describe("quality choices", () => {
  test("Auto first, then the fixed levels from the highest down; audio-only is not a choice", () => {
    expect(QUALITY_CHOICES.map((q) => q.id)).toEqual(["auto", "fhd", "hd", "high", "mid", "low"]);
    expect(QUALITY_CHOICES.find((q) => q.id === "fhd").label).toBe("1080p Full HD");
    expect(isQualityChoice("auto")).toBe(true);
    expect(isQualityChoice("hd")).toBe(true);
    expect(isQualityChoice("off")).toBe(false);
    expect(isQualityChoice("__proto__")).toBe(false);
    expect(isQualityChoice(undefined)).toBe(false);
  });
});

describe("Auto climbing higher", () => {
  const good = { lossPct: 0.2, rttMs: 60 };
  const climb = (start, sample, count, maxId) => {
    let tier = start;
    let state = initialAdaptation();
    for (let i = 0; i < count; i += 1) ({ tier, state } = nextVideoTier(tier, sample, state, maxId));
    return tier;
  };

  test("a healthy connection takes Auto up to 720p and no further", () => {
    expect(climb("mid", good, 4)).toBe("high");
    expect(climb("mid", good, 8)).toBe("hd");
    expect(climb("mid", good, 40)).toBe("hd");
  });

  test("a different ceiling is respected", () => {
    expect(climb("mid", good, 40, "high")).toBe("high");
    expect(climb("mid", good, 40, "fhd")).toBe("fhd");
  });

  test("it only climbs while the connection says there is room for the next level", () => {
    const narrow = { ...good, availableKbps: 700 }; // < 1.3 x 800 kbps for 480p
    expect(climb("mid", narrow, 40)).toBe("mid");
    const roomy = { ...good, availableKbps: 1100 }; // enough for 480p, not for 720p
    expect(climb("mid", roomy, 40)).toBe("high");
    expect(climb("mid", { ...good, availableKbps: 5000 }, 40)).toBe("hd");
  });

  test("a level above the ceiling is brought down to it", () => {
    expect(nextVideoTier("fhd", good, initialAdaptation(), "hd").tier).toBe("hd");
  });

  test("a bad sample still steps down from the top", () => {
    expect(nextVideoTier("hd", { lossPct: 12, rttMs: 90 }).tier).toBe("high");
  });
});

describe("the picture that arrives", () => {
  test("is read from the incoming video stream", () => {
    const sample = summarizeStats([
      { id: "a", type: "inbound-rtp", kind: "audio" },
      { id: "v", type: "inbound-rtp", kind: "video", frameWidth: 1280, frameHeight: 720, framesPerSecond: 29.6 },
    ]);
    expect(sample.incoming).toEqual({ width: 1280, height: 720, fps: 30 });
  });
  test("is absent while no picture arrives", () => {
    expect(summarizeStats([{ id: "v", type: "inbound-rtp", kind: "video", frameWidth: 0, frameHeight: 0 }])).not.toHaveProperty("incoming");
  });
});

describe("the screen is told apart from the camera in the stats", () => {
  const camera = { id: "cam", type: "inbound-rtp", kind: "video", trackIdentifier: "t-cam", mid: "1", frameWidth: 640, frameHeight: 360, framesPerSecond: 24 };
  const screen = { id: "scr", type: "inbound-rtp", kind: "video", trackIdentifier: "t-scr", mid: "2", frameWidth: 1920, frameHeight: 1080, framesPerSecond: 9.6 };

  test("by the id of the receiving track", () => {
    const sample = summarizeStats([camera, screen], { screenTrackId: "t-scr" });
    expect(sample.incoming).toEqual({ width: 640, height: 360, fps: 24 });
    expect(sample.screenIncoming).toEqual({ width: 1920, height: 1080, fps: 10 });
  });

  test("or by the mid of its line", () => {
    const sample = summarizeStats([screen, camera], { screenMid: "2" });
    expect(sample.incoming).toEqual({ width: 640, height: 360, fps: 24 });
    expect(sample.screenIncoming).toEqual({ width: 1920, height: 1080, fps: 10 });
  });

  test("without a screen line everything is the camera's, as before", () => {
    const sample = summarizeStats([camera]);
    expect(sample.incoming).toEqual({ width: 640, height: 360, fps: 24 });
    expect(sample).not.toHaveProperty("screenIncoming");
    expect(summarizeStats([screen], { screenTrackId: "t-scr" })).not.toHaveProperty("incoming");
    expect(summarizeStats([camera], null).incoming).toBeTruthy();
  });
});

describe("a shared screen is sent for detail", () => {
  test("it is captured without sound at a low frame rate, and asks the browser not to offer this tab", () => {
    const request = screenCaptureRequest();
    expect(request.audio).toBe(false);
    expect(request.video.frameRate).toEqual({ ideal: 15, max: 15 });
    expect(request.selfBrowserSurface).toBe("exclude");
    expect(SCREEN_CONTENT_HINT).toBe("detail");
  });

  test("the best level is 15 fps at about 2.5 Mbps and the levels only get lighter", () => {
    expect(SCREEN_PROFILES[0]).toMatchObject({ id: "full", maxFramerate: 15, maxBitrate: 2_500_000 });
    for (let i = 1; i < SCREEN_PROFILES.length; i += 1) {
      expect(SCREEN_PROFILES[i].maxFramerate).toBeLessThanOrEqual(SCREEN_PROFILES[i - 1].maxFramerate);
      expect(SCREEN_PROFILES[i].maxBitrate).toBeLessThanOrEqual(SCREEN_PROFILES[i - 1].maxBitrate);
    }
    expect(SCREEN_PROFILES.every((p) => p.maxFramerate > 0 && p.maxBitrate > 0)).toBe(true); // never "off"
    expect(getScreenProfile("nonsense")).toBe(SCREEN_PROFILES[0]);
  });

  test("a picture up to Full HD is sent as it is, a bigger one is scaled down to fit", () => {
    expect(encodingForScreen("full", { width: 1920, height: 1080 })).toMatchObject({ scaleResolutionDownBy: 1, maxFramerate: 15, maxBitrate: 2_500_000, active: true });
    expect(encodingForScreen("full", { width: 1280, height: 720 }).scaleResolutionDownBy).toBe(1);
    expect(encodingForScreen("full", { width: 3840, height: 2160 }).scaleResolutionDownBy).toBe(2);
    expect(encodingForScreen("full", { width: 2560, height: 1440 }).scaleResolutionDownBy).toBe(1.33);
    expect(encodingForScreen("full", { width: 3440, height: 1440 }).scaleResolutionDownBy).toBe(1.79); // ultra-wide: by the long side
    expect(encodingForScreen("full", { width: 1080, height: 1920 }).scaleResolutionDownBy).toBe(1); // upright stays upright
    expect(encodingForScreen("full", {}).scaleResolutionDownBy).toBe(1);
    expect(encodingForScreen("full").scaleResolutionDownBy).toBe(1);
  });

  test("the lowest levels also shrink the picture, never enlarge it", () => {
    expect(encodingForScreen("floor", { width: 800, height: 600 }).scaleResolutionDownBy).toBe(2);
    expect(encodingForScreen("thin", { width: 800, height: 600 }).scaleResolutionDownBy).toBe(1.5);
    expect(encodingForScreen("full", { width: 320, height: 200 }).scaleResolutionDownBy).toBe(1);
  });
});

describe("adapting a shared screen to the network", () => {
  const good = { lossPct: 0, rttMs: 40, availableKbps: 8000 };
  const bad = { lossPct: 15, rttMs: 700, availableKbps: 200 };
  const run = (start, sample, steps) => {
    let id = start;
    let state = initialScreenAdaptation();
    for (let i = 0; i < steps; i += 1) ({ profile: id, state } = nextScreenProfile(id, sample, state));
    return id;
  };

  test("a bad sample lowers it at once, one level at a time, down to a floor", () => {
    expect(run("full", bad, 1)).toBe("smooth");
    expect(run("full", bad, 2)).toBe("light");
    expect(run("full", bad, 50)).toBe(SCREEN_PROFILES.at(-1).id);
  });

  test("the frame rate falls before the bitrate", () => {
    const [full, smooth, light, lean] = SCREEN_PROFILES;
    expect(smooth.maxFramerate).toBeLessThan(full.maxFramerate);
    expect(smooth.maxBitrate).toBe(full.maxBitrate);
    expect(light.maxBitrate).toBe(full.maxBitrate);
    expect(lean.maxBitrate).toBeLessThan(light.maxBitrate);
  });

  test("a link that cannot carry the level (but is not lossy) lowers it after two samples", () => {
    const narrow = { lossPct: 0, rttMs: 50, availableKbps: 800 };
    expect(run("full", narrow, 1)).toBe("full");
    expect(run("full", narrow, 2)).toBe("smooth");
  });

  test("it climbs back only after a run of good samples and room for the next level", () => {
    expect(run("light", good, 3)).toBe("light");
    expect(run("light", good, 4)).toBe("smooth");
    expect(run("light", { ...good, availableKbps: 2600 }, 4)).toBe("light"); // not 1.3 x the next level
    expect(run("light", { lossPct: 0, rttMs: 40, availableKbps: null }, 4)).toBe("smooth"); // benefit of the doubt
    expect(run("full", good, 20)).toBe("full");
  });

  test("a bad sample in the middle starts the count again", () => {
    let state = initialScreenAdaptation();
    let id = "light";
    for (const sample of [good, good, good, bad]) ({ profile: id, state } = nextScreenProfile(id, sample, state));
    expect(id).toBe("lean");
    expect(state.good).toBe(0);
  });
});
