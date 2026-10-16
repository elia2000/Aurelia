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
  maxaveragebitrate: 24000, // wideband voice; ~0.2 MB/min per direction while talking
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
  // What the camera is asked for when the call starts, and in Auto: 720p, which
  // the encoder scales down while the network is weak.
  video: {
    facingMode: "user",
    width: { ideal: 1280, max: 1280 },
    height: { ideal: 720, max: 720 },
    frameRate: { ideal: 30, max: 30 },
  },
});

/**
 * The sending levels, lowest first. "off" is audio only. `height` is the
 * picture height the level aims for; the bitrate is a ceiling, the browser's
 * own congestion control goes lower whenever the network needs it.
 */
export const VIDEO_TIERS = Object.freeze([
  { id: "off", label: "Audio only", short: "Off", height: 0, maxBitrate: 0, maxFramerate: 0 },
  { id: "low", label: "240p", short: "240p", height: 240, maxBitrate: 150_000, maxFramerate: 15 },
  { id: "mid", label: "360p", short: "360p", height: 360, maxBitrate: 400_000, maxFramerate: 24 },
  { id: "high", label: "480p", short: "480p", height: 480, maxBitrate: 800_000, maxFramerate: 30 },
  { id: "hd", label: "720p HD", short: "720p", height: 720, maxBitrate: 1_800_000, maxFramerate: 30 },
  { id: "fhd", label: "1080p Full HD", short: "1080p", height: 1080, maxBitrate: 4_000_000, maxFramerate: 30 },
]);
export const DEFAULT_VIDEO_TIER = "mid";
/** The highest level Auto climbs to; the top level is for people who ask for it. */
export const AUTO_MAX_TIER = "hd";

const tierIndex = (id) => Math.max(0, VIDEO_TIERS.findIndex((t) => t.id === id));
export const getVideoTier = (id) => VIDEO_TIERS[tierIndex(id)];

/** The fixed levels a person can pick, lowest first (the stops of the quality slider). */
export const FIXED_LEVELS = Object.freeze(VIDEO_TIERS.filter((t) => t.id !== "off"));
/** The level the slider starts at when Auto is switched off. */
export const DEFAULT_FIXED_LEVEL = "hd";

/** What a person can ask for when watching: Auto, or one fixed level. */
export const QUALITY_CHOICES = Object.freeze([
  { id: "auto", label: "Auto", hint: "Keeps the call smooth: adapts to the network" },
  ...VIDEO_TIERS.filter((t) => t.id !== "off").reverse().map((t) => ({
    id: t.id,
    label: t.label,
    hint: t.id === "fhd" ? "Best picture, needs a fast connection" : t.id === "low" ? "Saves data" : "",
  })),
]);
export const isQualityChoice = (value) => QUALITY_CHOICES.some((q) => q.id === value);

/** Camera settings that suit what is being sent (Auto and unknown ask for 720p). */
export function captureVideoConstraints(choice = "auto") {
  const base = { facingMode: "user" };
  switch (choice) {
    case "fhd":
      return { ...base, width: { ideal: 1920, max: 1920 }, height: { ideal: 1080, max: 1080 }, frameRate: { ideal: 30, max: 30 } };
    case "low":
      return { ...base, width: { ideal: 640, max: 1280 }, height: { ideal: 360, max: 720 }, frameRate: { ideal: 15, max: 30 } };
    case "mid":
      return { ...base, width: { ideal: 640, max: 1280 }, height: { ideal: 360, max: 720 }, frameRate: { ideal: 24, max: 30 } };
    case "high":
      return { ...base, width: { ideal: 960, max: 1280 }, height: { ideal: 540, max: 720 }, frameRate: { ideal: 30, max: 30 } };
    default:
      return CAPTURE_CONSTRAINTS.video;
  }
}

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

/**
 * The candidate pair the connection is actually using. Browsers list several
 * pairs that passed their connectivity check (a direct one and, when a relay
 * is configured, lower-priority relayed ones), so "succeeded" is not enough.
 */
function selectedCandidatePair(reports, byId) {
  for (const r of reports) {
    if (r.type === "transport" && r.selectedCandidatePairId) {
      const pair = byId.get(r.selectedCandidatePairId);
      if (pair) return pair;
    }
  }
  const pairs = reports.filter((r) => r.type === "candidate-pair");
  const flagged = pairs.find((p) => p.selected === true);
  if (flagged) return flagged;
  const nominated = pairs
    .filter((p) => p.nominated === true && (p.state === undefined || p.state === "succeeded"))
    .sort((a, b) => (b.bytesSent || 0) + (b.bytesReceived || 0) - ((a.bytesSent || 0) + (a.bytesReceived || 0)));
  return nominated[0] || null;
}

/** Reduces an `RTCStatsReport` (as an array) to what the adaptation needs. */
export function summarizeStats(reports) {
  let rttMs = null;
  let lossPct = 0;
  let relayed = false;
  let availableKbps = null;
  const byId = new Map(reports.map((r) => [r.id, r]));

  const pair = selectedCandidatePair(reports, byId);
  if (pair) {
    if (typeof pair.currentRoundTripTime === "number") rttMs = pair.currentRoundTripTime * 1000;
    if (typeof pair.availableOutgoingBitrate === "number") availableKbps = pair.availableOutgoingBitrate / 1000;
    const local = byId.get(pair.localCandidateId);
    const remote = byId.get(pair.remoteCandidateId);
    relayed = local?.candidateType === "relay" || remote?.candidateType === "relay";
  }
  let incoming = null;
  for (const r of reports) {
    if (r.type === "remote-inbound-rtp" && typeof r.fractionLost === "number") {
      lossPct = Math.max(lossPct, r.fractionLost * 100);
      if (rttMs === null && typeof r.roundTripTime === "number") rttMs = r.roundTripTime * 1000;
    }
    // The picture that is arriving: what the person is watching.
    if (r.type === "inbound-rtp" && (r.kind === "video" || r.mediaType === "video") && r.frameWidth > 0 && r.frameHeight > 0) {
      incoming = { width: r.frameWidth, height: r.frameHeight, fps: Math.round(r.framesPerSecond || 0) };
    }
  }
  return { rttMs, lossPct, relayed, availableKbps, ...(incoming ? { incoming } : {}) };
}

export const initialAdaptation = () => ({ bad: 0, good: 0 });

/**
 * Picks the next video tier from one stats sample. Steps down fast, up slowly
 * (hysteresis) so quality does not flap, and falls back to audio-only when
 * even the lowest tier keeps failing. It only climbs while the connection
 * reports room for the next level, and never above `maxId`.
 */
export function nextVideoTier(currentId, sample, state = initialAdaptation(), maxId = AUTO_MAX_TIER) {
  const rtt = sample.rttMs ?? 0;
  const bad = sample.lossPct > 8 || rtt > 600;
  const good = sample.lossPct < 2 && rtt < 250;
  let { bad: badCount, good: goodCount } = state;
  badCount = bad ? badCount + 1 : 0;
  goodCount = good ? goodCount + 1 : 0;

  const top = tierIndex(maxId);
  const roomFor = (index) => {
    const wanted = VIDEO_TIERS[index]?.maxBitrate;
    // A connection that does not say how much it can carry is given the benefit of the doubt.
    return !wanted || sample.availableKbps == null || sample.availableKbps * 1000 >= wanted * 1.3;
  };
  let idx = Math.min(tierIndex(currentId), top);
  if (bad && idx > 1) {
    idx -= 1;
    badCount = 0;
  } else if (bad && idx === 1 && badCount >= 3) {
    idx = 0;
    badCount = 0;
  } else if (good && idx === 0 && goodCount >= 6) {
    idx = 1;
    goodCount = 0;
  } else if (good && idx >= 1 && idx < top && goodCount >= 4 && roomFor(idx + 1)) {
    idx += 1;
    goodCount = 0;
  }
  return { tier: VIDEO_TIERS[idx].id, state: { bad: badCount, good: goodCount } };
}

/**
 * Sender encoding parameters for a tier. `capture` is the size of the picture
 * the camera delivers; it is scaled down so that its SHORTER side has the size
 * the tier aims for ("720p" is 720 on the short side: 1280x720 held sideways,
 * 720x1280 on a phone held upright). It is never scaled up.
 */
export function encodingForTier(id, capture = { width: 1280, height: 720 }) {
  const tier = getVideoTier(id);
  const short = Math.min(Number(capture?.width) || Infinity, Number(capture?.height) || Infinity);
  const scale = tier.height && Number.isFinite(short) ? Math.max(1, short / tier.height) : 1;
  return {
    maxBitrate: tier.maxBitrate,
    maxFramerate: tier.maxFramerate,
    scaleResolutionDownBy: Math.round(scale * 100) / 100,
    active: tier.id !== "off",
  };
}
