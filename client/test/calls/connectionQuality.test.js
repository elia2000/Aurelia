import { describe, test, expect } from "vitest";
import {
  QUALITY_LEVELS,
  SAMPLES_TO_DROP,
  SAMPLES_TO_RISE,
  connectionRows,
  describeQuality,
  initialQualityState,
  nextConnectionQuality,
  qualityReportLine,
  rawQualityRank,
  roundConnectionStats,
  sameConnectionStats,
} from "../../src/calls/connectionQuality.js";

const POOR = 0;
const FAIR = 1;
const GOOD = 2;
const EXCELLENT = 3;

describe("rawQualityRank: one sample to one level", () => {
  // [description, sample, options, expected rank, what holds it back]
  const table = [
    ["a clean local call", { rttMs: 20, lossPct: 0, jitterMs: 2, availableKbps: 3000 }, {}, EXCELLENT, null],
    ["round trip just under 150 ms", { rttMs: 149, lossPct: 0 }, {}, EXCELLENT, null],
    ["round trip of 150 ms", { rttMs: 150, lossPct: 0 }, {}, GOOD, "rtt"],
    ["round trip of 299 ms", { rttMs: 299, lossPct: 0 }, {}, GOOD, "rtt"],
    ["round trip of 300 ms", { rttMs: 300, lossPct: 0 }, {}, FAIR, "rtt"],
    ["round trip of 599 ms", { rttMs: 599, lossPct: 0 }, {}, FAIR, "rtt"],
    ["round trip of 600 ms", { rttMs: 600, lossPct: 0 }, {}, POOR, "rtt"],
    ["loss under 1 %", { rttMs: 30, lossPct: 0.9 }, {}, EXCELLENT, null],
    ["loss of 1 %", { rttMs: 30, lossPct: 1 }, {}, GOOD, "loss"],
    ["loss of 3 %", { rttMs: 30, lossPct: 3 }, {}, FAIR, "loss"],
    ["loss of 8 %", { rttMs: 30, lossPct: 8 }, {}, POOR, "loss"],
    ["loss of 20 %", { rttMs: 30, lossPct: 20 }, {}, POOR, "loss"],
    ["jitter under 30 ms", { rttMs: 30, lossPct: 0, jitterMs: 29 }, {}, EXCELLENT, null],
    ["jitter of 30 ms", { rttMs: 30, lossPct: 0, jitterMs: 30 }, {}, GOOD, "jitter"],
    ["jitter of 60 ms", { rttMs: 30, lossPct: 0, jitterMs: 60 }, {}, FAIR, "jitter"],
    ["jitter of 120 ms", { rttMs: 30, lossPct: 0, jitterMs: 120 }, {}, POOR, "jitter"],
    ["the worst number decides: fine round trip, heavy loss", { rttMs: 10, lossPct: 12, jitterMs: 1, availableKbps: 5000 }, {}, POOR, "loss"],
    ["the worst number decides: fine loss, slow round trip", { rttMs: 450, lossPct: 0, jitterMs: 5 }, {}, FAIR, "rtt"],
    ["a voice call is not held back by a modest bandwidth estimate", { rttMs: 40, lossPct: 0, availableKbps: 60 }, {}, EXCELLENT, null],
    ["a voice call with almost no bandwidth is fair", { rttMs: 40, lossPct: 0, availableKbps: 40 }, {}, FAIR, "bitrate"],
    ["a voice call with less than voice needs is poor", { rttMs: 40, lossPct: 0, availableKbps: 20 }, {}, POOR, "bitrate"],
    ["a video call with 100 kbit/s is fair", { rttMs: 40, lossPct: 0, availableKbps: 100 }, { video: true }, FAIR, "bitrate"],
    ["a video call with 300 kbit/s is good", { rttMs: 40, lossPct: 0, availableKbps: 300 }, { video: true }, GOOD, "bitrate"],
    ["a video call with 50 kbit/s is poor", { rttMs: 40, lossPct: 0, availableKbps: 50 }, { video: true }, POOR, "bitrate"],
    ["a video call with plenty of bandwidth", { rttMs: 40, lossPct: 0, availableKbps: 2500 }, { video: true }, EXCELLENT, null],
    ["only the round trip is known", { rttMs: 80 }, {}, EXCELLENT, null],
    ["only loss is known", { lossPct: 5 }, {}, FAIR, "loss"],
  ];
  test.each(table)("%s", (_name, sample, options, rank, limitedBy) => {
    expect(rawQualityRank(sample, options)).toEqual({ rank, limitedBy });
  });

  test("a sample with nothing in it says nothing", () => {
    expect(rawQualityRank({})).toBeNull();
    expect(rawQualityRank(null)).toBeNull();
    expect(rawQualityRank({ rttMs: null, lossPct: 0, jitterMs: null, availableKbps: null })).toBeNull();
    expect(rawQualityRank({ rttMs: NaN, lossPct: NaN })).toBeNull();
  });

  test("the four levels are ordered worst to best, with 1 to 4 bars", () => {
    expect(QUALITY_LEVELS.map((level) => level.id)).toEqual(["poor", "fair", "good", "excellent"]);
    expect(QUALITY_LEVELS.map((level) => level.bars)).toEqual([1, 2, 3, 4]);
  });
});

describe("nextConnectionQuality: no flicker", () => {
  const sampleAt = (rank) => [{ rttMs: 600, lossPct: 0 }, { rttMs: 400, lossPct: 0 }, { rttMs: 200, lossPct: 0 }, { rttMs: 20, lossPct: 0 }][rank];
  const run = (ranks, start = initialQualityState()) => {
    const seen = [];
    let state = start;
    for (const rank of ranks) {
      const out = nextConnectionQuality(state, sampleAt(rank));
      state = out.state;
      seen.push(out.rank);
    }
    return { seen, state };
  };

  test("the first sample is shown as it is", () => {
    expect(run([FAIR]).seen).toEqual([FAIR]);
    expect(run([EXCELLENT]).seen).toEqual([EXCELLENT]);
  });

  test("one bad sample inside a good stretch changes nothing", () => {
    expect(run([EXCELLENT, EXCELLENT, POOR, EXCELLENT, EXCELLENT]).seen).toEqual([3, 3, 3, 3, 3]);
  });

  test("it drops after the second worse sample in a row, not before", () => {
    expect(SAMPLES_TO_DROP).toBe(2);
    expect(run([EXCELLENT, FAIR, FAIR]).seen).toEqual([EXCELLENT, EXCELLENT, FAIR]);
  });

  test("it rises only after three better samples in a row", () => {
    expect(SAMPLES_TO_RISE).toBe(3);
    expect(run([POOR, GOOD, GOOD, GOOD]).seen).toEqual([POOR, POOR, POOR, GOOD]);
  });

  test("a better sample in the middle of a drop starts it over", () => {
    expect(run([EXCELLENT, FAIR, EXCELLENT, FAIR, EXCELLENT]).seen).toEqual([3, 3, 3, 3, 3]);
  });

  test("a wobble between two worse levels drops to the milder of them", () => {
    expect(run([EXCELLENT, POOR, FAIR]).seen).toEqual([EXCELLENT, EXCELLENT, FAIR]);
  });

  test("a rise goes to the most cautious level of the run", () => {
    expect(run([POOR, EXCELLENT, GOOD, EXCELLENT]).seen).toEqual([POOR, POOR, POOR, GOOD]);
  });

  test("a flapping connection (good, fair, good, fair...) never moves", () => {
    const alternating = Array.from({ length: 20 }, (_, i) => (i % 2 ? FAIR : GOOD));
    expect(new Set(run(alternating).seen)).toEqual(new Set([GOOD]));
  });

  test("a sample with nothing in it keeps what is shown", () => {
    const first = nextConnectionQuality(initialQualityState(), sampleAt(GOOD));
    const after = nextConnectionQuality(first.state, {});
    expect(after.rank).toBe(GOOD);
    expect(after.state).toBe(first.state);
    expect(nextConnectionQuality(initialQualityState(), {}).rank).toBeNull();
  });

  test("what holds the level back follows the sample", () => {
    const out = nextConnectionQuality(initialQualityState(), { rttMs: 20, lossPct: 5 });
    expect(out).toMatchObject({ rank: FAIR, limitedBy: "loss" });
  });

  test("the video flag changes what a bandwidth estimate means", () => {
    const sample = { rttMs: 20, lossPct: 0, availableKbps: 120 };
    expect(nextConnectionQuality(initialQualityState(), sample, { video: false }).rank).toBe(EXCELLENT);
    expect(nextConnectionQuality(initialQualityState(), sample, { video: true }).rank).toBe(FAIR);
  });
});

describe("describeQuality", () => {
  test.each([
    [EXCELLENT, "excellent", 4, "ok", "Connection: Excellent"],
    [GOOD, "good", 3, "ok", "Connection: Good"],
    [FAIR, "fair", 2, "warn", "Connection: Fair"],
    [POOR, "poor", 1, "bad", "Connection: Poor"],
  ])("rank %i", (rank, id, bars, tone, text) => {
    expect(describeQuality({ rank })).toMatchObject({ id, bars, tone, text, title: text });
  });

  test("nothing measured yet", () => {
    expect(describeQuality({ rank: null })).toMatchObject({ id: "checking", bars: 0, tone: "muted", text: "Connection: Checking…" });
    expect(describeQuality()).toMatchObject({ id: "checking" });
  });

  test("a dropped connection says it is reconnecting, whatever the last level was", () => {
    expect(describeQuality({ rank: EXCELLENT, reconnecting: true })).toMatchObject({
      id: "reconnecting",
      bars: 0,
      tone: "warn",
      text: "Connection: Reconnecting…",
      title: "Connection: Reconnecting…",
    });
  });

  test("a relayed connection says so in the tooltip, and not in the label", () => {
    const shown = describeQuality({ rank: GOOD, relayed: true });
    expect(shown.text).toBe("Connection: Good");
    expect(shown.title).toBe("Connection: Good · relayed");
  });
});

describe("the numbers for the settings and the report", () => {
  test("stats are rounded so an unchanged picture is not redrawn", () => {
    expect(roundConnectionStats({ rttMs: 42.6, lossPct: 0.4567, jitterMs: 3.2, availableKbps: 1834.7 })).toEqual({
      rttMs: 43,
      lossPct: 0.5,
      jitterMs: 3,
      availableKbps: 1835,
    });
    expect(roundConnectionStats({})).toEqual({ rttMs: null, lossPct: 0, jitterMs: null, availableKbps: null });
    expect(sameConnectionStats(roundConnectionStats({ rttMs: 42.1 }), roundConnectionStats({ rttMs: 41.9 }))).toBe(true);
    expect(sameConnectionStats(roundConnectionStats({ rttMs: 42 }), roundConnectionStats({ rttMs: 44 }))).toBe(false);
    expect(sameConnectionStats(null, null)).toBe(true);
    expect(sameConnectionStats(null, roundConnectionStats({}))).toBe(false);
  });

  test("the rows carry units, a dash where nothing is known, and the path", () => {
    const rows = connectionRows({ rttMs: 43, lossPct: 0.5, jitterMs: 3, availableKbps: 1835 });
    expect(Object.fromEntries(rows.map((row) => [row.id, row.value]))).toEqual({
      rtt: "43 ms",
      loss: "0.5 %",
      jitter: "3 ms",
      bitrate: "1.8 Mbit/s",
      path: "Direct",
    });
    const sparse = Object.fromEntries(connectionRows({ rttMs: null, lossPct: 0, jitterMs: null, availableKbps: 320 }, { relayed: true }).map((row) => [row.id, row.value]));
    expect(sparse).toMatchObject({ rtt: "–", jitter: "–", bitrate: "320 kbit/s", path: "Relayed through your server" });
    expect(connectionRows(null).every((row) => row.id === "path" || row.value === "–")).toBe(true);
  });

  test("the report line has the level and the numbers and no addresses", () => {
    const line = qualityReportLine({ rank: FAIR, stats: { rttMs: 450, lossPct: 2.5, jitterMs: 40, availableKbps: 180 }, relayed: true });
    expect(line).toBe("Last measured quality: fair, relayed (round trip 450 ms, packet loss 2.5 %, jitter 40 ms, outgoing bandwidth 180 kbit/s)");
    expect(qualityReportLine()).toBe("Last measured quality: unknown");
  });
});
