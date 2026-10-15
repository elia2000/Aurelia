// Battery- and data-saving media settings for calls. Everything here is a pure
// function over SDP text, codec lists or stats so it can be tested without a
// browser.
//
// What matters for battery on a phone, roughly in order:
//   1. video encode/decode  -> prefer hardware-accelerated codecs (H.264, VP8),
//                              cap resolution, frame rate and bitrate, and
//                              drop to audio-only on a bad network;
//   2. radio wake-ups       -> fewer, larger audio packets (40 ms), DTX so
//                              silence costs ~nothing, batched signaling;
//   3. screen + camera      -> stop the camera when the app is backgrounded.

export const OPUS_VOICE = Object.freeze({
  usedtx: 1, // silence suppression: no packets while nobody talks
  useinbandfec: 1, // loss concealment without retransmission round trips
  maxaveragebitrate: 24000, // wideband voice; ~11 kB/min per direction
  stereo: 0,
  "sprop-stereo": 0,
  cbr: 0,
});
export const AUDIO_PTIME_MS = 40;

export const CAPTURE_CONSTRAINTS = Object.freeze({
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
  },
  video: {
    facingMode: "user",
    width: { ideal: 640, max: 1280 },
    height: { ideal: 360, max: 720 },
    frameRate: { ideal: 24, max: 30 },
  },
});

export const VIDEO_TIERS = Object.freeze([
  { id: "off", maxBitrate: 0, maxFramerate: 0, scaleResolutionDownBy: 1 },
  { id: "low", maxBitrate: 120_000, maxFramerate: 12, scaleResolutionDownBy: 2 },
  { id: "mid", maxBitrate: 300_000, maxFramerate: 20, scaleResolutionDownBy: 1.5 },
  { id: "high", maxBitrate: 600_000, maxFramerate: 24, scaleResolutionDownBy: 1 },
]);
export const DEFAULT_VIDEO_TIER = "mid";

const tierIndex = (id) => Math.max(0, VIDEO_TIERS.findIndex((t) => t.id === id));
export const getVideoTier = (id) => VIDEO_TIERS[tierIndex(id)];

/** Tunes the Opus payload of a local SDP for voice at low bitrate. */
export function tuneOpusSdp(sdp, params = OPUS_VOICE, ptime = AUDIO_PTIME_MS) {
  const eol = sdp.includes("\r\n") ? "\r\n" : "\n";
  const lines = sdp.split(/\r?\n/);
  const rtpmapIdx = lines.findIndex((l) => /^a=rtpmap:\d+ opus\/48000\/2/i.test(l));
  if (rtpmapIdx === -1) return sdp;
  const pt = lines[rtpmapIdx].match(/^a=rtpmap:(\d+) /)[1];

  const fmtpIdx = lines.findIndex((l) => l.startsWith(`a=fmtp:${pt} `));
  const existing = {};
  if (fmtpIdx !== -1) {
    lines[fmtpIdx]
      .slice(`a=fmtp:${pt} `.length)
      .split(";")
      .forEach((pair) => {
        const [k, v] = pair.split("=");
        if (k && v !== undefined) existing[k.trim()] = v.trim();
      });
  }
  const merged = { ...existing, ...params };
  // Never raise a bitrate the other side asked to be lower.
  if (existing.maxaveragebitrate) {
    merged.maxaveragebitrate = Math.min(
      Number(existing.maxaveragebitrate),
      Number(params.maxaveragebitrate),
    );
  }
  const fmtp = `a=fmtp:${pt} ${Object.entries(merged)
    .map(([k, v]) => `${k}=${v}`)
    .join(";")}`;

  let insertAt = rtpmapIdx + 1;
  if (fmtpIdx !== -1) {
    lines[fmtpIdx] = fmtp;
    insertAt = fmtpIdx + 1;
  } else {
    lines.splice(insertAt, 0, fmtp);
    insertAt += 1;
  }
  // `a=ptime` is a media-level attribute; keep a single occurrence in the audio section.
  let sectionStart = rtpmapIdx;
  while (sectionStart > 0 && !lines[sectionStart].startsWith("m=")) sectionStart -= 1;
  let sectionEnd = lines.findIndex((l, i) => i > sectionStart && l.startsWith("m="));
  if (sectionEnd === -1) sectionEnd = lines.length;
  for (let i = sectionEnd - 1; i > sectionStart; i -= 1) {
    if (lines[i].startsWith("a=ptime:")) lines.splice(i, 1);
  }
  const ptimeInsertAt = lines.findIndex(
    (l, i) => i >= insertAt - 1 && l.startsWith(`a=fmtp:${pt} `),
  );
  lines.splice(ptimeInsertAt + 1, 0, `a=ptime:${ptime}`);
  return lines.join(eol);
}

const MEDIA_CODEC_RANK = [/^video\/h264$/i, /^video\/vp8$/i, /^video\/vp9$/i, /^video\/av1$/i];
const AUXILIARY = /^video\/(rtx|red|ulpfec|flexfec-03)$/i;
const isConstrainedBaseline = (c) => /profile-level-id=42[0-9a-f]{2}/i.test(c.sdpFmtpLine || "");

/**
 * Orders codecs for `RTCRtpTransceiver.setCodecPreferences`: hardware-friendly
 * H.264 (constrained baseline first), then VP8, then the software-heavy VP9
 * and AV1, with retransmission/FEC helper codecs last.
 */
export function orderVideoCodecs(codecs) {
  const rank = (c) => {
    if (AUXILIARY.test(c.mimeType)) return 100;
    const idx = MEDIA_CODEC_RANK.findIndex((re) => re.test(c.mimeType));
    return idx === -1 ? 50 : idx;
  };
  return codecs
    .map((codec, index) => ({ codec, index }))
    .sort(
      (a, b) =>
        rank(a.codec) - rank(b.codec) ||
        Number(isConstrainedBaseline(b.codec)) - Number(isConstrainedBaseline(a.codec)) ||
        a.index - b.index,
    )
    .map((x) => x.codec);
}

/** Reduces an `RTCStatsReport` (as an array) to what the adaptation needs. */
export function summarizeStats(reports) {
  let rttMs = null;
  let lossPct = 0;
  let relayed = false;
  let availableKbps = null;
  const byId = new Map(reports.map((r) => [r.id, r]));

  for (const r of reports) {
    if (r.type === "candidate-pair" && (r.nominated || r.state === "succeeded") && r.selected !== false) {
      if (typeof r.currentRoundTripTime === "number") rttMs = r.currentRoundTripTime * 1000;
      if (typeof r.availableOutgoingBitrate === "number") availableKbps = r.availableOutgoingBitrate / 1000;
      const local = byId.get(r.localCandidateId);
      const remote = byId.get(r.remoteCandidateId);
      relayed = local?.candidateType === "relay" || remote?.candidateType === "relay";
    }
    if (r.type === "remote-inbound-rtp" && typeof r.fractionLost === "number") {
      lossPct = Math.max(lossPct, r.fractionLost * 100);
      if (rttMs === null && typeof r.roundTripTime === "number") rttMs = r.roundTripTime * 1000;
    }
  }
  return { rttMs, lossPct, relayed, availableKbps };
}

export const initialAdaptation = () => ({ bad: 0, good: 0 });

/**
 * Picks the next video tier from one stats sample. Steps down fast, up slowly
 * (hysteresis) so quality does not flap, and falls back to audio-only when
 * even the lowest tier keeps failing.
 */
export function nextVideoTier(currentId, sample, state = initialAdaptation()) {
  const rtt = sample.rttMs ?? 0;
  const bad = sample.lossPct > 8 || rtt > 600;
  const good = sample.lossPct < 2 && rtt < 250;
  let { bad: badCount, good: goodCount } = state;
  badCount = bad ? badCount + 1 : 0;
  goodCount = good ? goodCount + 1 : 0;

  let idx = tierIndex(currentId);
  if (bad && idx > 1) {
    idx -= 1;
    badCount = 0;
  } else if (bad && idx === 1 && badCount >= 3) {
    idx = 0;
    badCount = 0;
  } else if (good && idx === 0 && goodCount >= 6) {
    idx = 1;
    goodCount = 0;
  } else if (good && idx >= 1 && idx < VIDEO_TIERS.length - 1 && goodCount >= 4) {
    idx += 1;
    goodCount = 0;
  }
  return { tier: VIDEO_TIERS[idx].id, state: { bad: badCount, good: goodCount } };
}

/** Sender encoding parameters for a tier. */
export function encodingForTier(id) {
  const tier = getVideoTier(id);
  return {
    maxBitrate: tier.maxBitrate,
    maxFramerate: tier.maxFramerate,
    scaleResolutionDownBy: tier.scaleResolutionDownBy,
    active: tier.id !== "off",
  };
}
