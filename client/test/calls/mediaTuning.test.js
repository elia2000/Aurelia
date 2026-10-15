import { describe, test, expect } from "vitest";
import {
  encodingForTier,
  initialAdaptation,
  nextVideoTier,
  orderVideoCodecs,
  summarizeStats,
  tuneOpusSdp,
  VIDEO_TIERS,
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
  test("handles an empty report", () => {
    expect(summarizeStats([])).toEqual({ rttMs: null, lossPct: 0, relayed: false, availableKbps: null });
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
    expect(encodingForTier("off").active).toBe(false);
    expect(encodingForTier("high")).toMatchObject({ maxBitrate: 600000, active: true });
  });
});
