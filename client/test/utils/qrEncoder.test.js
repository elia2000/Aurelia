import { describe, test, expect } from "vitest";
import { encodeQr, qrByteCapacity, QR_ECC } from "../../src/utils/qr/qrEncoder.js";
import { qrToSvgPath, QUIET_ZONE_MODULES } from "../../src/utils/qr/qrSvg.js";
import { GOLDEN_QR } from "./qrGolden.js";

const rowsOf = (q) => q.modules.map((row) => row.map((dark) => (dark ? "1" : "0")).join(""));

// ── A tiny independent reader (written from the standard, sharing no code or
// tables with the encoder) for the single-block versions. It checks what a
// scanner would: the format information, the unmasked data, the Reed-Solomon
// remainder, and the text.

// ISO/IEC 18004 Table 9: total codewords and data codewords per level.
const SINGLE_BLOCK = {
  1: { total: 26, data: { L: 19, M: 16, Q: 13, H: 9 } },
  2: { total: 44, data: { L: 34, M: 28, Q: 22, H: 16 } },
  3: { total: 70, data: { L: 55, M: 44 } },
};
const FORMAT_LEVEL = { 1: "L", 0: "M", 3: "Q", 2: "H" };
const MASK_TESTS = [
  (i, j) => (i + j) % 2 === 0,
  (i) => i % 2 === 0,
  (i, j) => j % 3 === 0,
  (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
  (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
  (i, j) => (((i + j) % 2) + ((i * j) % 3)) % 2 === 0,
];
// Read order of the 15 format bits, most significant first: (x, y).
const FORMAT_CELLS = [
  [0, 8], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8], [7, 8], [8, 8],
  [8, 7], [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0],
];

function gfMulSlow(a, b) {
  let result = 0;
  while (b) {
    if (b & 1) result ^= a;
    a <<= 1;
    if (a & 0x100) a ^= 0x11d;
    b >>= 1;
  }
  return result;
}

function formatWord(data) {
  let bits = data << 10;
  for (let i = 14; i >= 10; i -= 1) if ((bits >> i) & 1) bits ^= 0x537 << (i - 10);
  return ((data << 10) | (bits & 0x3ff)) ^ 0x5412;
}

function readSingleBlock(q) {
  const n = q.size;
  const isFunction = Array.from({ length: n }, () => new Array(n).fill(false));
  const mark = (x0, y0, x1, y1) => {
    for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) isFunction[y][x] = true;
  };
  mark(0, 0, 8, 8);
  mark(n - 8, 0, n - 1, 8);
  mark(0, n - 8, 8, n - 1);
  for (let i = 0; i < n; i += 1) {
    isFunction[6][i] = true;
    isFunction[i][6] = true;
  }
  if (q.version >= 2) mark(n - 9, n - 9, n - 5, n - 5);

  let word = 0;
  for (const [x, y] of FORMAT_CELLS) word = (word << 1) | (q.modules[y][x] ? 1 : 0);
  const data = [...Array(32).keys()].find((candidate) => formatWord(candidate) === word);
  if (data === undefined) throw new Error("no valid format information");
  const level = FORMAT_LEVEL[data >> 3];
  const mask = data & 7;

  const bits = [];
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const columnIndex = right > 6 ? (n - 1 - right) / 2 : (n - 2 - right) / 2;
    const goesUp = columnIndex % 2 === 0;
    for (let step = 0; step < n; step += 1) {
      const y = goesUp ? n - 1 - step : step;
      for (const x of [right, right - 1]) {
        if (isFunction[y][x]) continue;
        const dark = q.modules[y][x] !== MASK_TESTS[mask](y, x);
        bits.push(dark ? 1 : 0);
      }
    }
  }
  const codewords = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) codewords.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  const spec = SINGLE_BLOCK[q.version];
  const total = spec.total;
  const dataLength = spec.data[level];
  const word8 = codewords.slice(0, total);

  // Syndromes of the whole codeword (data then remainder) must all be zero.
  const syndromes = [];
  let alpha = 1;
  for (let j = 0; j < total - dataLength; j += 1) {
    let value = 0;
    for (const codeword of word8) value = gfMulSlow(value, alpha) ^ codeword;
    syndromes.push(value);
    alpha = gfMulSlow(alpha, 2);
  }

  const stream = word8.slice(0, dataLength).flatMap((byte) => [...Array(8).keys()].map((k) => (byte >> (7 - k)) & 1));
  const take = (count) => stream.splice(0, count).reduce((a, b) => (a << 1) | b, 0);
  const modeBits = take(4);
  const length = take(8);
  const bytes = Array.from({ length }, () => take(8));
  return { level, mask, syndromes, modeBits, text: new TextDecoder().decode(new Uint8Array(bytes)) };
}

describe("qrByteCapacity (ISO/IEC 18004 table of byte-mode capacities)", () => {
  const TABLE = {
    1: [17, 14, 11, 7],
    2: [32, 26, 20, 14],
    5: [106, 84, 60, 44],
    7: [154, 122, 86, 64],
    8: [192, 152, 108, 84],
    10: [271, 213, 151, 119],
    20: [858, 666, 482, 382],
    40: [2953, 2331, 1663, 1273],
  };
  for (const [version, expected] of Object.entries(TABLE)) {
    test(`version ${version}`, () => {
      expect(["L", "M", "Q", "H"].map((ecc) => qrByteCapacity(Number(version), ecc))).toEqual(expected);
    });
  }

  test("rejects a version or level that does not exist", () => {
    expect(() => qrByteCapacity(0, "M")).toThrow(RangeError);
    expect(() => qrByteCapacity(41, "M")).toThrow(RangeError);
    expect(() => qrByteCapacity(1.5, "M")).toThrow(RangeError);
    expect(() => qrByteCapacity(5, "X")).toThrow(RangeError);
  });
});

describe("encodeQr against reference matrices from an independent encoder", () => {
  for (const golden of GOLDEN_QR) {
    test(golden.name, () => {
      const q = encodeQr(golden.text, { ecc: golden.ecc });
      expect(q.version).toBe(golden.version);
      expect(q.mask).toBe(golden.mask);
      expect(q.size).toBe(golden.rows.length);
      expect(rowsOf(q)).toEqual(golden.rows);
    });

    test(`${golden.name}: forcing the same version and mask gives the same code`, () => {
      const q = encodeQr(golden.text, { ecc: golden.ecc, minVersion: golden.version, mask: golden.mask });
      expect(rowsOf(q)).toEqual(golden.rows);
    });
  }
});

describe("encodeQr read back like a scanner would", () => {
  const cases = [];
  for (const [version, spec] of Object.entries(SINGLE_BLOCK)) {
    for (const level of Object.keys(spec.data)) {
      for (const mask of [0, 1, 2, 3, 4, 5, 6, 7]) cases.push([Number(version), level, mask]);
    }
  }
  test.each(cases)("version %i level %s mask %i: format, Reed-Solomon remainder and text", (version, level, mask) => {
    const capacity = qrByteCapacity(version, level);
    for (const length of [0, 1, Math.floor(capacity / 2), capacity]) {
      const text = Array.from({ length }, (_, i) => String.fromCharCode(32 + ((i * 11 + mask) % 95))).join("");
      const q = encodeQr(text, { ecc: level, minVersion: version, mask });
      expect(q.version).toBe(version);
      const read = readSingleBlock(q);
      expect(read.level).toBe(level);
      expect(read.mask).toBe(mask);
      expect(read.modeBits).toBe(0b0100);
      expect(read.syndromes.every((s) => s === 0)).toBe(true);
      expect(read.text).toBe(text);
    }
  });

  test("a damaged module is caught by the remainder", () => {
    const q = encodeQr("tamper", { ecc: "M", mask: 3 });
    q.modules[q.size - 1][q.size - 1] = !q.modules[q.size - 1][q.size - 1];
    expect(readSingleBlock(q).syndromes.some((s) => s !== 0)).toBe(true);
  });
});

describe("encodeQr choices", () => {
  const payload = `aurelle-sn:1:${"a".repeat(36)}:${"b".repeat(36)}:${"1".repeat(60)}`;

  test("picks the smallest version that fits, per level", () => {
    expect(payload).toHaveLength(147);
    expect(encodeQr(payload, { ecc: "L" }).version).toBe(7);
    expect(encodeQr(payload, { ecc: "M" }).version).toBe(8);
    expect(encodeQr(payload, { ecc: "Q" }).version).toBe(10);
    expect(encodeQr(payload, { ecc: "H" }).version).toBe(12);
  });

  test("every size is 4 * version + 17 and the finder patterns are in the three corners", () => {
    for (const text of ["", "x", payload, "y".repeat(500)]) {
      const q = encodeQr(text);
      expect(q.size).toBe(q.version * 4 + 17);
      for (const [ox, oy] of [[0, 0], [q.size - 7, 0], [0, q.size - 7]]) {
        for (let d = 0; d < 7; d += 1) {
          expect(q.modules[oy][ox + d]).toBe(true);
          expect(q.modules[oy + 6][ox + d]).toBe(true);
          expect(q.modules[oy + d][ox]).toBe(true);
          expect(q.modules[oy + d][ox + 6]).toBe(true);
        }
        expect(q.modules[oy + 3][ox + 3]).toBe(true);
        expect(q.modules[oy + 1][ox + 1]).toBe(false);
      }
      // The module that is always dark.
      expect(q.modules[q.size - 8][8]).toBe(true);
    }
  });

  test("an empty text is a valid code", () => {
    expect(encodeQr("").version).toBe(1);
  });

  test("text is UTF-8, and bytes give the same code as the text they spell", () => {
    const text = "سلام 🔐";
    const bytes = new TextEncoder().encode(text);
    expect(rowsOf(encodeQr(bytes))).toEqual(rowsOf(encodeQr(text)));
  });

  test("the same input always gives the same code", () => {
    expect(rowsOf(encodeQr(payload))).toEqual(rowsOf(encodeQr(payload)));
  });

  test("minVersion keeps the code from getting smaller", () => {
    expect(encodeQr("x", { minVersion: 5 }).version).toBe(5);
  });

  test("the largest codes work: version 40 at every level holds its full capacity", () => {
    for (const ecc of Object.keys(QR_ECC)) {
      const capacity = qrByteCapacity(40, ecc);
      const q = encodeQr("z".repeat(capacity), { ecc });
      expect(q.version).toBe(40);
      expect(q.size).toBe(177);
      expect(() => encodeQr("z".repeat(capacity + 1), { ecc })).toThrow(RangeError);
    }
  });

  test("refuses data that does not fit within maxVersion", () => {
    expect(() => encodeQr("x".repeat(100), { maxVersion: 3 })).toThrow(/too long/i);
  });

  test("refuses nonsense options and inputs", () => {
    expect(() => encodeQr("x", { ecc: "Z" })).toThrow(RangeError);
    expect(() => encodeQr("x", { mask: 8 })).toThrow(RangeError);
    expect(() => encodeQr("x", { mask: -1 })).toThrow(RangeError);
    expect(() => encodeQr("x", { mask: 1.5 })).toThrow(RangeError);
    expect(() => encodeQr(12345)).toThrow(TypeError);
    expect(() => encodeQr(null)).toThrow(TypeError);
    expect(() => encodeQr({ length: 3 })).toThrow(TypeError);
  });
});

describe("qrToSvgPath", () => {
  /** Reads a path made of M x y h n v1 h-n z back into a matrix. */
  function paint(path, size, quiet) {
    const matrix = Array.from({ length: size }, () => new Array(size).fill(false));
    const commands = [...path.matchAll(/M(\d+) (\d+)h(\d+)v1h-(\d+)z/g)];
    expect(commands.map((c) => c[0]).join("")).toBe(path);
    for (const [, x, y, run, back] of commands) {
      expect(run).toBe(back);
      for (let i = 0; i < Number(run); i += 1) matrix[Number(y) - quiet][Number(x) - quiet + i] = true;
    }
    return matrix;
  }

  test("draws exactly the dark modules, inside a four-module quiet zone", () => {
    const q = encodeQr(`aurelle-sn:1:${"a".repeat(36)}:${"b".repeat(36)}:${"7".repeat(60)}`);
    const { size, d } = qrToSvgPath(q.modules);
    expect(QUIET_ZONE_MODULES).toBe(4);
    expect(size).toBe(q.size + 8);
    expect(paint(d, q.size, 4)).toEqual(q.modules);
  });

  test("a run never spills over the edge or touches the quiet zone", () => {
    const q = encodeQr("edge", { ecc: "H" });
    const { size, d } = qrToSvgPath(q.modules);
    for (const [, x, y, run] of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
      expect(Number(x)).toBeGreaterThanOrEqual(4);
      expect(Number(y)).toBeGreaterThanOrEqual(4);
      expect(Number(x) + Number(run)).toBeLessThanOrEqual(size - 4);
      expect(Number(y)).toBeLessThan(size - 4);
    }
  });

  test("an all-light matrix gives an empty path", () => {
    expect(qrToSvgPath([[false, false], [false, false]])).toEqual({ size: 10, d: "" });
  });
});
