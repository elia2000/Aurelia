// How good a call's connection is, as one of four levels, from the numbers a
// stats sample carries (see summarizeStats in mediaTuning.js): round-trip time,
// packet loss, jitter and the bandwidth the browser thinks it can send with.
// Everything here is a pure function so it can be tested with a table.
//
// Two steps:
//   1. rawQualityRank() turns ONE sample into a level (the worst of the
//      numbers decides: a call with a fine round trip and 10 % loss is poor);
//   2. nextConnectionQuality() decides what the indicator shows, with
//      hysteresis: a change needs several samples in a row (two to get worse,
//      three to get better), so a single odd sample never makes the bars flicker.

/** The levels, worst first. `bars` is how many of the 4 bars light up. */
export const QUALITY_LEVELS = Object.freeze([
  Object.freeze({ id: "poor", label: "Poor", bars: 1 }),
  Object.freeze({ id: "fair", label: "Fair", bars: 2 }),
  Object.freeze({ id: "good", label: "Good", bars: 3 }),
  Object.freeze({ id: "excellent", label: "Excellent", bars: 4 }),
]);

// Upper bounds, exclusive, of Excellent, Good and Fair: a value at or above the
// last one is Poor. The loss and round-trip bounds line up with what the video
// adaptation calls bad (more than 8 % loss, more than 600 ms).
const MAX_RTT_MS = Object.freeze([150, 300, 600]);
const MAX_LOSS_PCT = Object.freeze([1, 3, 8]);
const MAX_JITTER_MS = Object.freeze([30, 60, 120]);
// Lower bounds of the bandwidth the browser estimates for what we send, in
// kbit/s: under the first it is Poor, under the second Fair, and so on. A voice
// call needs next to nothing, and its estimate is a rough one (nothing is
// probing), so it only counts when it is really small.
const MIN_KBPS_AUDIO = Object.freeze([25, 50]);
const MIN_KBPS_VIDEO = Object.freeze([60, 200, 500]);

// Three bounds split the numbers into four levels: the more of them a value reaches, the worse (rtt, loss, jitter).
const rankFromUpperBounds = (value, bounds) => 3 - bounds.filter((bound) => value >= bound).length;
// The more bounds a value reaches, the better; reaching all of them means the number holds nothing back.
const rankFromLowerBounds = (value, bounds) => {
  const reached = bounds.filter((bound) => value >= bound).length;
  return reached === bounds.length ? 3 : reached;
};

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

/** Names for the number that holds the level back, for the details. */
export const QUALITY_LIMIT_TEXT = Object.freeze({
  rtt: "high delay",
  loss: "lost packets",
  jitter: "uneven delivery (jitter)",
  bitrate: "low bandwidth",
});

/**
 * The level one stats sample stands for.
 * @param {{rttMs?: number|null, lossPct?: number, jitterMs?: number|null, availableKbps?: number|null}} sample
 * @param {{video?: boolean}} [options] `video`: a picture is being sent (a camera or a screen)
 * @returns {{rank: 0|1|2|3, limitedBy: "rtt"|"loss"|"jitter"|"bitrate"|null}|null} null when the sample says nothing yet
 */
export function rawQualityRank(sample, { video = false } = {}) {
  const { rttMs = null, lossPct = 0, jitterMs = null, availableKbps = null } = sample || {};
  const measured = [
    ["rtt", isNumber(rttMs) ? rankFromUpperBounds(rttMs, MAX_RTT_MS) : null],
    ["loss", isNumber(lossPct) ? rankFromUpperBounds(lossPct, MAX_LOSS_PCT) : null],
    ["jitter", isNumber(jitterMs) ? rankFromUpperBounds(jitterMs, MAX_JITTER_MS) : null],
    [
      "bitrate",
      isNumber(availableKbps) ? rankFromLowerBounds(availableKbps, video ? MIN_KBPS_VIDEO : MIN_KBPS_AUDIO) : null,
    ],
  ].filter(([, rank]) => rank !== null);
  // Packet loss is 0 when the browser has not reported any yet, so on its own it is no news.
  if (!isNumber(rttMs) && !isNumber(jitterMs) && !isNumber(availableKbps) && !(isNumber(lossPct) && lossPct > 0)) return null;
  let worst = measured[0];
  for (const entry of measured) if (entry[1] < worst[1]) worst = entry;
  return { rank: worst[1], limitedBy: worst[1] < 3 ? worst[0] : null };
}

/** The state the hysteresis starts from: nothing measured yet. */
export const initialQualityState = () => ({ rank: null, down: null, up: null });

/** Samples in a row that must be worse (better) before the indicator drops (rises). */
export const SAMPLES_TO_DROP = 2;
export const SAMPLES_TO_RISE = 3;

/**
 * Moves the indicator by one stats sample. The first sample is taken as it
 * is. Later, a level is only left after SAMPLES_TO_DROP samples in a row that
 * are all worse (SAMPLES_TO_RISE for better), and it moves to the mildest of
 * them, so one bad sample inside a good stretch does nothing and a wobble
 * between two worse levels does not skip down to the worst.
 * @returns {{state: object, rank: 0|1|2|3|null, limitedBy: string|null}}
 */
export function nextConnectionQuality(state, sample, options) {
  const raw = rawQualityRank(sample, options);
  const previous = state || initialQualityState();
  if (!raw) return { state: previous, rank: previous.rank, limitedBy: previous.limitedBy ?? null };
  if (previous.rank === null || previous.rank === undefined) {
    return { state: { rank: raw.rank, limitedBy: raw.limitedBy, down: null, up: null }, rank: raw.rank, limitedBy: raw.limitedBy };
  }
  let { rank, limitedBy, down, up } = previous;
  if (raw.rank < rank) {
    up = null;
    // The mildest of the worse samples seen in this run decides where it drops to.
    down = down ? { n: down.n + 1, rank: Math.max(down.rank, raw.rank), limitedBy: down.rank >= raw.rank ? down.limitedBy : raw.limitedBy } : { n: 1, rank: raw.rank, limitedBy: raw.limitedBy };
    if (down.n >= SAMPLES_TO_DROP) {
      ({ rank, limitedBy } = down);
      down = null;
    }
  } else if (raw.rank > rank) {
    down = null;
    up = up ? { n: up.n + 1, rank: Math.min(up.rank, raw.rank), limitedBy: up.rank <= raw.rank ? up.limitedBy : raw.limitedBy } : { n: 1, rank: raw.rank, limitedBy: raw.limitedBy };
    if (up.n >= SAMPLES_TO_RISE) {
      ({ rank, limitedBy } = up);
      up = null;
    }
  } else {
    // Same level: what holds it back may still have changed, and a run ends.
    limitedBy = raw.limitedBy;
    down = null;
    up = null;
  }
  return { state: { rank, limitedBy, down, up }, rank, limitedBy };
}

/** The level object for a rank, or null. */
export const levelForRank = (rank) => QUALITY_LEVELS[rank] ?? null;

/**
 * What the indicator and its tooltip say. `reconnecting`: the media path
 * dropped and is being set up again (the connection is "disconnected").
 * @returns {{id: string, label: string, bars: number, tone: "ok"|"warn"|"bad"|"muted", text: string, title: string}}
 */
export function describeQuality({ rank = null, reconnecting = false, relayed = false } = {}) {
  const level = levelForRank(rank);
  const shown = reconnecting
    ? { id: "reconnecting", label: "Reconnecting…", bars: 0, tone: "warn" }
    : level
      ? { id: level.id, label: level.label, bars: level.bars, tone: level.bars >= 3 ? "ok" : level.bars === 2 ? "warn" : "bad" }
      : { id: "checking", label: "Checking…", bars: 0, tone: "muted" };
  const text = `Connection: ${shown.label}`;
  return { ...shown, text, title: relayed && level && !reconnecting ? `${text} · relayed` : text };
}

// ── the numbers, for the settings and the report ─────────────────────────────

/** A stats sample rounded for display, so that a number that did not really change does not redraw the screen. */
export function roundConnectionStats(sample) {
  const { rttMs = null, lossPct = 0, jitterMs = null, availableKbps = null } = sample || {};
  return {
    rttMs: isNumber(rttMs) ? Math.round(rttMs) : null,
    lossPct: isNumber(lossPct) ? Math.round(lossPct * 10) / 10 : 0,
    jitterMs: isNumber(jitterMs) ? Math.round(jitterMs) : null,
    availableKbps: isNumber(availableKbps) ? Math.round(availableKbps) : null,
  };
}

export const sameConnectionStats = (a, b) =>
  a === b || (Boolean(a) && Boolean(b) && a.rttMs === b.rttMs && a.lossPct === b.lossPct && a.jitterMs === b.jitterMs && a.availableKbps === b.availableKbps);

const formatKbps = (kbps) => (kbps >= 1000 ? `${Math.round(kbps / 100) / 10} Mbit/s` : `${kbps} kbit/s`);

/** The rows of the settings' Connection section: [{id, label, value}], "–" where nothing is known. */
export function connectionRows(stats, { relayed = false } = {}) {
  const s = stats || {};
  return [
    { id: "rtt", label: "Round trip", value: isNumber(s.rttMs) ? `${s.rttMs} ms` : "–" },
    { id: "loss", label: "Packet loss", value: isNumber(s.lossPct) ? `${s.lossPct} %` : "–" },
    { id: "jitter", label: "Jitter", value: isNumber(s.jitterMs) ? `${s.jitterMs} ms` : "–" },
    { id: "bitrate", label: "Outgoing bandwidth", value: isNumber(s.availableKbps) ? formatKbps(s.availableKbps) : "–" },
    { id: "path", label: "Path", value: relayed ? "Relayed through your server" : "Direct" },
  ];
}

/** One line for the call report: the quality and the numbers it came from (no addresses). */
export function qualityReportLine({ rank = null, stats = null, relayed = false } = {}) {
  const level = levelForRank(rank);
  const parts = connectionRows(stats, { relayed })
    .filter((row) => row.id !== "path" && row.value !== "–")
    .map((row) => `${row.label.toLowerCase()} ${row.value}`);
  return `Last measured quality: ${level ? level.label.toLowerCase() : "unknown"}${relayed ? ", relayed" : ""}${parts.length ? ` (${parts.join(", ")})` : ""}`;
}
