// A small QR Code (ISO/IEC 18004, Model 2) encoder with no dependencies.
//
// Scope, on purpose: byte mode only (the text is UTF-8, no ECI header), error
// correction levels L/M/Q/H, versions 1 to 40, the eight masks chosen by the
// standard's penalty rules. Numeric, alphanumeric and kanji modes, Micro QR
// and structured append are not implemented: the safety-number code is a short
// ASCII string and byte mode is what every scanner reads.
//
//   encodeQr("aurelle-sn:1:...", { ecc: "M" })
//     -> { version, size, ecc, mask, modules }   modules[y][x] === true is dark
//
// The tables and the algorithm follow the standard; `test/utils/qr*.test.js`
// checks the result against an independent encoder (same version, level and
// mask give the same matrix) and against an independent decoder (jsQR).

/** Error correction levels, weakest to strongest: about 7%, 15%, 25% and 30% of the code can be lost. */
export const QR_ECC = Object.freeze({ L: 0, M: 1, Q: 2, H: 3 });

// The two format-information bits of each level (L=01, M=00, Q=11, H=10).
const FORMAT_BITS = [1, 0, 3, 2];

// Error correction codewords per block, then number of blocks, by level
// (L, M, Q, H) and version (index 0 is unused).
const ECC_CODEWORDS_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const NUM_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

const MIN_VERSION = 1;
const MAX_VERSION = 40;

// Penalty weights of the mask rules.
const PENALTY_RUN = 3;
const PENALTY_BLOCK = 3;
const PENALTY_FINDER = 40;
const PENALTY_BALANCE = 10;

const bit = (value, index) => ((value >>> index) & 1) !== 0;

/** Data modules of a version: everything that is not a function pattern. */
function rawDataModules(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

/** Codewords (bytes) that carry data, not error correction. */
function dataCodewords(version, ecc) {
  return (
    Math.floor(rawDataModules(version) / 8) -
    ECC_CODEWORDS_PER_BLOCK[ecc][version] * NUM_BLOCKS[ecc][version]
  );
}

/** Bytes of text that fit into a code of this version and level in byte mode. */
export function qrByteCapacity(version, ecc = "M") {
  const level = QR_ECC[ecc];
  if (level === undefined || !Number.isInteger(version) || version < MIN_VERSION || version > MAX_VERSION) {
    throw new RangeError("Unknown QR version or error correction level");
  }
  const countBits = version < 10 ? 8 : 16;
  const bits = dataCodewords(version, level) * 8 - 4 - countBits;
  const bytes = Math.floor(bits / 8);
  // The character count field limits the length too.
  return Math.min(bytes, (1 << countBits) - 1);
}

// ── Reed-Solomon over GF(256), polynomial 0x11D ──────────────────────────────

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
})();

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** Coefficients (highest power first, leading 1 left out) of the generator of this degree. */
function generator(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 2);
  }
  return result;
}

function remainder(data, gen) {
  const result = new Array(gen.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ result.shift();
    result.push(0);
    for (let i = 0; i < gen.length; i += 1) result[i] ^= gfMul(gen[i], factor);
  }
  return result;
}

// ── Building the data stream ────────────────────────────────────────────────

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (typeof input === "string") return new TextEncoder().encode(input);
  throw new TypeError("The QR data must be a string or a Uint8Array");
}

function buildCodewords(bytes, version, level) {
  const capacity = dataCodewords(version, level) * 8;
  const bits = [];
  const push = (value, count) => {
    for (let i = count - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4); // byte mode
  push(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) push(byte, 8);
  push(0, Math.min(4, capacity - bits.length)); // terminator
  while (bits.length % 8 !== 0) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let value = 0;
    for (let j = 0; j < 8; j += 1) value = (value << 1) | bits[i + j];
    data.push(value);
  }
  for (let pad = 0xec; data.length < capacity / 8; pad ^= 0xec ^ 0x11) data.push(pad);
  return data;
}

/** Splits the data into blocks, adds error correction and interleaves everything. */
function addEccAndInterleave(data, version, level) {
  const blocks = NUM_BLOCKS[level][version];
  const eccLen = ECC_CODEWORDS_PER_BLOCK[level][version];
  const raw = Math.floor(rawDataModules(version) / 8);
  const shortBlocks = blocks - (raw % blocks);
  const shortLen = Math.floor(raw / blocks);
  const gen = generator(eccLen);
  const dataBlocks = [];
  const eccBlocks = [];
  for (let i = 0, k = 0; i < blocks; i += 1) {
    const length = shortLen - eccLen + (i < shortBlocks ? 0 : 1);
    const block = data.slice(k, k + length);
    k += length;
    dataBlocks.push(block);
    eccBlocks.push(remainder(block, gen));
  }
  const result = [];
  const longest = shortLen - eccLen + 1;
  for (let i = 0; i < longest; i += 1) {
    for (const block of dataBlocks) if (i < block.length) result.push(block[i]);
  }
  for (let i = 0; i < eccLen; i += 1) {
    for (const block of eccBlocks) result.push(block[i]);
  }
  return result;
}

// ── The matrix ──────────────────────────────────────────────────────────────

function alignmentPositions(version) {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const size = version * 4 + 17;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const positions = [6];
  for (let pos = size - 7; positions.length < count; pos -= step) positions.splice(1, 0, pos);
  return positions;
}

function createGrid(size) {
  return Array.from({ length: size }, () => new Array(size).fill(false));
}

function drawFunctionPatterns(modules, isFunction, version, size) {
  const set = (x, y, dark) => {
    modules[y][x] = dark;
    isFunction[y][x] = true;
  };
  // Timing patterns.
  for (let i = 0; i < size; i += 1) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  // Finder patterns with their separators.
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, dist !== 2 && dist !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  // Alignment patterns.
  const positions = alignmentPositions(version);
  const last = positions.length - 1;
  for (let i = 0; i < positions.length; i += 1) {
    for (let j = 0; j < positions.length; j += 1) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          set(positions[i] + dx, positions[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }
  drawFormat(modules, isFunction, 0, 0, size); // reserve the area; drawn again with the real mask
  drawVersion(modules, isFunction, version, size);
}

function drawFormat(modules, isFunction, level, mask, size) {
  const set = (x, y, dark) => {
    modules[y][x] = dark;
    isFunction[y][x] = true;
  };
  const data = (FORMAT_BITS[level] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  for (let i = 0; i <= 5; i += 1) set(8, i, bit(bits, i));
  set(8, 7, bit(bits, 6));
  set(8, 8, bit(bits, 7));
  set(7, 8, bit(bits, 8));
  for (let i = 9; i < 15; i += 1) set(14 - i, 8, bit(bits, i));
  for (let i = 0; i < 8; i += 1) set(size - 1 - i, 8, bit(bits, i));
  for (let i = 8; i < 15; i += 1) set(8, size - 15 + i, bit(bits, i));
  set(8, size - 8, true); // the always-dark module
}

function drawVersion(modules, isFunction, version, size) {
  if (version < 7) return;
  let rem = version;
  for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (version << 12) | rem;
  for (let i = 0; i < 18; i += 1) {
    const dark = bit(bits, i);
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    modules[b][a] = dark;
    isFunction[b][a] = true;
    modules[a][b] = dark;
    isFunction[a][b] = true;
  }
}

function drawCodewords(modules, isFunction, codewords, size) {
  let i = 0;
  const total = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // the timing column is skipped
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y][x] && i < total) {
          modules[y][x] = bit(codewords[i >>> 3], 7 - (i & 7));
          i += 1;
        }
      }
    }
  }
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => ((((x + y) % 2) + ((x * y) % 3)) % 2) === 0,
];

function applyMask(modules, isFunction, mask, size) {
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!isFunction[y][x] && MASKS[mask](x, y)) modules[y][x] = !modules[y][x];
    }
  }
}

/** Counts finder-like 1:1:3:1:1 patterns with four light modules on a side in one line. */
function finderLikeCount(line) {
  // Outside the code counts as light.
  const padded = [false, false, false, false, ...line, false, false, false, false];
  let count = 0;
  for (let i = 0; i + 11 <= padded.length; i += 1) {
    const core =
      padded[i + 4] && !padded[i + 5] && padded[i + 6] && padded[i + 7] && padded[i + 8] && !padded[i + 9] && padded[i + 10];
    if (!core) continue;
    const before = !padded[i] && !padded[i + 1] && !padded[i + 2] && !padded[i + 3];
    if (before) count += 1;
  }
  // The pattern may also be followed by four light modules.
  for (let i = 0; i + 11 <= padded.length; i += 1) {
    const core =
      padded[i] && !padded[i + 1] && padded[i + 2] && padded[i + 3] && padded[i + 4] && !padded[i + 5] && padded[i + 6];
    if (!core) continue;
    const after = !padded[i + 7] && !padded[i + 8] && !padded[i + 9] && !padded[i + 10];
    if (after) count += 1;
  }
  return count;
}

function penalty(modules, size) {
  let result = 0;
  const lines = [];
  for (let y = 0; y < size; y += 1) lines.push(modules[y]);
  for (let x = 0; x < size; x += 1) lines.push(modules.map((row) => row[x]));
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= size; i += 1) {
      if (i < size && line[i] === line[i - 1]) {
        run += 1;
        continue;
      }
      if (run >= 5) result += PENALTY_RUN + (run - 5);
      run = 1;
    }
    result += finderLikeCount(line) * PENALTY_FINDER;
  }
  let dark = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (modules[y][x]) dark += 1;
      if (x + 1 < size && y + 1 < size) {
        const v = modules[y][x];
        if (v === modules[y][x + 1] && v === modules[y + 1][x] && v === modules[y + 1][x + 1]) {
          result += PENALTY_BLOCK;
        }
      }
    }
  }
  const total = size * size;
  const steps = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  return result + steps * PENALTY_BALANCE;
}

/**
 * @param {string|Uint8Array} input   text (encoded as UTF-8) or bytes
 * @param {object} [options]
 * @param {"L"|"M"|"Q"|"H"} [options.ecc="M"]  error correction level
 * @param {number} [options.minVersion=1]       never use a smaller version
 * @param {number} [options.maxVersion=40]      refuse data that needs a larger one
 * @param {number|null} [options.mask=null]     force mask 0-7 (the best one is picked otherwise)
 * @returns {{version: number, size: number, ecc: string, mask: number, modules: boolean[][]}}
 * @throws {RangeError} when the data does not fit
 */
export function encodeQr(input, { ecc = "M", minVersion = MIN_VERSION, maxVersion = MAX_VERSION, mask = null } = {}) {
  const level = QR_ECC[ecc];
  if (level === undefined) throw new RangeError("Unknown error correction level");
  if (mask !== null && !(Number.isInteger(mask) && mask >= 0 && mask <= 7)) {
    throw new RangeError("The mask must be a whole number from 0 to 7");
  }
  const low = Math.max(MIN_VERSION, Math.floor(minVersion));
  const high = Math.min(MAX_VERSION, Math.floor(maxVersion));
  const bytes = toBytes(input);

  let version = low;
  for (; version <= high; version += 1) {
    const countBits = version < 10 ? 8 : 16;
    const needed = 4 + countBits + bytes.length * 8;
    if (bytes.length < 1 << countBits && needed <= dataCodewords(version, level) * 8) break;
  }
  if (version > high) throw new RangeError("Data too long for a QR code");

  const size = version * 4 + 17;
  const codewords = addEccAndInterleave(buildCodewords(bytes, version, level), version, level);
  const base = createGrid(size);
  const isFunction = createGrid(size);
  drawFunctionPatterns(base, isFunction, version, size);
  drawCodewords(base, isFunction, codewords, size);

  const build = (candidate) => {
    const modules = base.map((row) => row.slice());
    applyMask(modules, isFunction, candidate, size);
    drawFormat(modules, isFunction, level, candidate, size);
    return modules;
  };

  let bestMask = mask;
  let best = null;
  if (mask === null) {
    let bestScore = Infinity;
    for (let candidate = 0; candidate < 8; candidate += 1) {
      const modules = build(candidate);
      const score = penalty(modules, size);
      if (score < bestScore) {
        bestScore = score;
        bestMask = candidate;
        best = modules;
      }
    }
  } else {
    best = build(mask);
  }
  return { version, size, ecc, mask: bestMask, modules: best };
}
