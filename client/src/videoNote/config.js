// Recording settings for round video messages, tuned for small files and low
// battery use: a 384-px square at 24 fps and ~350 kbps is about 2.6 MB per
// minute (a typical phone clip is 10-20x that).

export const VIDEO_NOTE_MAX_MS = 60_000;
export const VIDEO_NOTE_MIN_MS = 800;
export const VIDEO_BITS_PER_SECOND = 350_000;
export const AUDIO_BITS_PER_SECOND = 32_000;
export const POSTER_SIZE_PX = 96;
export const POSTER_QUALITY = 0.55;

export const VIDEO_NOTE_CONSTRAINTS = Object.freeze({
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
  },
  video: {
    facingMode: "user",
    width: { ideal: 384, max: 640 },
    height: { ideal: 384, max: 640 },
    aspectRatio: { ideal: 1 },
    frameRate: { ideal: 24, max: 30 },
  },
});

// Preference order, with the reason for each:
//  1. H.264/AAC in MP4  - hardware encoders on almost every phone (best battery),
//                         and plays everywhere.
//  2. VP8/Opus in WebM  - light software encode, hardware on many Android SoCs.
//  3. VP9/Opus in WebM  - heavy software encode; last resort.
//  4. whatever the browser picks.
const FORMAT_PREFERENCE = [
  { mimeType: "video/mp4;codecs=avc1.42E01E,mp4a.40.2", container: "video/mp4" },
  { mimeType: "video/mp4;codecs=avc1,mp4a.40.2", container: "video/mp4" },
  { mimeType: "video/webm;codecs=vp8,opus", container: "video/webm" },
  { mimeType: "video/webm;codecs=vp9,opus", container: "video/webm" },
  { mimeType: "video/webm", container: "video/webm" },
  { mimeType: "video/mp4", container: "video/mp4" },
];

/**
 * @param {(mime: string) => boolean} isTypeSupported MediaRecorder.isTypeSupported
 * @returns {{mimeType: string, container: string, videoBitsPerSecond: number, audioBitsPerSecond: number} | null}
 */
export function pickRecorderFormat(isTypeSupported) {
  for (const candidate of FORMAT_PREFERENCE) {
    let ok = false;
    try {
      ok = Boolean(isTypeSupported(candidate.mimeType));
    } catch {
      ok = false;
    }
    if (ok) {
      return {
        ...candidate,
        videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
        audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
      };
    }
  }
  return null;
}

/** The container the server accepts for an envelope, from a Blob/recorder type. */
export function normalizeContainer(mimeType) {
  const base = String(mimeType || "").split(";")[0].trim().toLowerCase();
  if (base === "video/mp4" || base === "video/webm" || base === "video/quicktime") return base;
  return "video/webm";
}

export function formatDurationMs(ms) {
  const total = Math.max(0, Math.round(Number(ms || 0) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
