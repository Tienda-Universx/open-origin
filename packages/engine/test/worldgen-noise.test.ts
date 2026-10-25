import { describe, expect, test } from "bun:test";
import {
  CHACHA20_BLOCK_WORDS,
  CHACHA20_INPUT_WORDS,
  ChaCha20Key,
  chacha20Block,
} from "../src/rng/chacha.ts";
import {
  defaultGenesis,
  GENESIS_BOUNDS,
  type PreparedGenesis,
  prepareGenesis,
  sharedGenesis,
} from "../src/worldgen/genesis.ts";
import {
  LATTICE_PURPOSES,
  NOISE_PURPOSES,
  setLatticeField,
  setLatticePoint,
} from "../src/worldgen/lattice.ts";
import {
  type CellRect,
  fade,
  gradientAt,
  gradientDot,
  interpolate,
  latticeCell,
  latticeFraction,
  NOISE_BOUNDS,
  NOISE_PEAK,
  type NoiseSpec,
  noiseBound,
  octaveOffsets,
  Q16,
  sampleNoiseRegion,
} from "../src/worldgen/noise.ts";
import {
  CHUNK_CELLS,
  chunkFirstCell,
  MAX_CELL,
  MAX_CHUNK,
  MIN_CELL,
  MIN_CHUNK,
} from "../src/worldgen/space.ts";
import {
  BROKEN_VARIANTS,
  composeSampler,
  FAITHFUL_PARTS,
  type NoiseParts,
} from "./support/broken-worldgen.ts";
import { engineErrorOf } from "./support/engine-error.ts";
import { oracleNoise, oracleTolerance } from "./support/noise-oracle.ts";
import { revokedProxy } from "./support/revoked.ts";
import { Sfc32 } from "./support/sfc32.ts";
import {
  compositionProblems,
  fadeProblems,
  historyProblems,
  lipschitzBound,
  lipschitzProblems,
  octaveDetailProblems,
  oracleProblems,
  packingCollisions,
  type RegionSampler,
  rangeProblems,
  seamProblems,
  seamStatistics,
  sharedOriginProblems,
  valueAt,
} from "./support/worldgen-checks.ts";

/**
 * Integer gradient noise (ADR 0021, noise; plan §5 D4 and D6, §12 tests 5–7, 9, 10, and 17): the
 * Horner fade, exact interpolation, per-octave offsets, the fBm's bounds, and sampleNoiseRegion,
 * whose regions must equal the composition of their chunks and cells. No value here is golden: the
 * plan freezes them in T3-5, so every check is a property.
 */

/** Eight seed words from `seed`, through sfc32. */
function seedWords(seed: number): number[] {
  const random = new Sfc32(seed);
  return Array.from({ length: 8 }, () => random.next());
}

/** A prepared default genesis whose terrain seed comes from `seed`. */
function genesisOf(seed: number): PreparedGenesis {
  return prepareGenesis(defaultGenesis(seedWords(seed)));
}

/** The real sampler of `prepared`. */
function samplerOf(prepared: PreparedGenesis): RegionSampler {
  return (spec, rect) => sampleNoiseRegion(prepared, spec, rect);
}

const GENESIS = genesisOf(1);
const SAMPLE = samplerOf(GENESIS);

/** The default genesis's relief, as elevation noise: wavelength 2048, 7 octaves. */
const RELIEF: NoiseSpec = {
  purpose: LATTICE_PURPOSES.elevation,
  ...sharedGenesis(GENESIS).terrain.relief,
};

/** A small field whose lattice every check can afford to cover. */
const SMALL: NoiseSpec = {
  purpose: LATTICE_PURPOSES.thermal,
  wavelength: 64,
  octaves: 3,
  amplitude: 2 ** 20,
};

/** The largest field the bounds allow. */
const LARGEST: NoiseSpec = {
  purpose: LATTICE_PURPOSES.deposits[7] as number,
  wavelength: 2 ** 16,
  octaves: 12,
  amplitude: NOISE_BOUNDS.amplitude.max,
};

/** One octave whose fBm value is its noise in Q16 units: floorDiv(n · 2^16, 2^16) = n. */
const UNIT: NoiseSpec = {
  purpose: LATTICE_PURPOSES.elevation,
  wavelength: 64,
  octaves: 1,
  amplitude: Q16,
};

/** The chunk at chunk coordinates `x`, `y`, as a region. */
function chunk(x: number, y: number): CellRect {
  return { x: chunkFirstCell(x), y: chunkFirstCell(y), width: CHUNK_CELLS, height: CHUNK_CELLS };
}

/** The 1×1 region of the cell `x`, `y`. */
function cell(x: number, y: number): CellRect {
  return { x, y, width: 1, height: 1 };
}

/** The two outermost chunks at each edge of the world, and the four corners. */
const EDGE_RECTS: readonly CellRect[] = [
  { x: MIN_CELL, y: -16, width: 2 * CHUNK_CELLS, height: CHUNK_CELLS },
  { x: MAX_CELL - 2 * CHUNK_CELLS + 1, y: -16, width: 2 * CHUNK_CELLS, height: CHUNK_CELLS },
  { x: -16, y: MIN_CELL, width: CHUNK_CELLS, height: 2 * CHUNK_CELLS },
  { x: -16, y: MAX_CELL - 2 * CHUNK_CELLS + 1, width: CHUNK_CELLS, height: 2 * CHUNK_CELLS },
  { x: MIN_CELL, y: MIN_CELL, width: CHUNK_CELLS, height: CHUNK_CELLS },
  chunk(MAX_CHUNK, MAX_CHUNK),
  chunk(MIN_CHUNK, MAX_CHUNK),
  chunk(MAX_CHUNK, MIN_CHUNK),
];

/** The exact fade S·f(t / S), times S⁴, as a BigInt. */
function exactFadeTimesS4(t: number): bigint {
  const T = BigInt(t);
  const S = BigInt(Q16);
  return T * T * T * (6n * T * T - 15n * T * S + 10n * S * S);
}

describe("fade", () => {
  test("keeps its contract over all 65,537 inputs", () => {
    expect(fadeProblems(fade)).toEqual([]);
  });

  test("is within 1/2 + 2^-16 of the exact value, inside the 1 the noise's error bound assumes", () => {
    const S4 = BigInt(Q16) ** 4n;
    let worst = 0n;
    for (let t = 0; t <= Q16; t += 1) {
      const error = BigInt(fade(t)) * S4 - exactFadeTimesS4(t);
      const magnitude = error < 0n ? -error : error;
      if (magnitude > worst) worst = magnitude;
    }
    expect(worst).toBeLessThanOrEqual(S4 / 2n + S4 / BigInt(Q16));
    // Not vacuous: rounding to the nearest Q16 unit leaves errors close to 1/2.
    expect(worst).toBeGreaterThan(S4 / 4n);
  });

  test("is exact where the quintic is an integer: 0, the middle, and 1", () => {
    expect([fade(0), fade(Q16 / 2), fade(Q16)]).toEqual([0, Q16 / 2, Q16]);
  });

  test("its Horner steps stay below 2^53 at their worst inputs", () => {
    // |6t − 15| ≤ 15 in Q32, times t ≤ 2^16; then 6t² − 15t + 10 ≤ 10 in Q32, times t.
    expect(15 * 2 ** 32 * Q16).toBeLessThan(2 ** 53);
    expect(10 * 2 ** 32 * Q16).toBeLessThan(2 ** 53);
  });
});

describe("interpolate", () => {
  test("gives its ends exactly at 0 and 2^16", () => {
    expect([interpolate(-7, 300, 0), interpolate(-7, 300, Q16)]).toEqual([-7, 300]);
  });

  test("rounds toward negative infinity", () => {
    expect(interpolate(0, -1, 1)).toBe(-1);
    expect(interpolate(0, 1, Q16 - 1)).toBe(0);
    expect(interpolate(10, 0, Q16 / 2)).toBe(5);
  });

  test("stays between its ends, at the largest differences noise reaches", () => {
    const random = new Sfc32(7);
    for (let index = 0; index < 10_000; index += 1) {
      const a = random.between(-3 * Q16, 3 * Q16);
      const b = random.between(-3 * Q16, 3 * Q16);
      const value = interpolate(a, b, random.between(0, Q16));
      expect(value).toBeGreaterThanOrEqual(Math.min(a, b));
      expect(value).toBeLessThanOrEqual(Math.max(a, b));
    }
  });
});

describe("gradients", () => {
  test("are the 8 vectors (±1, ±2) and (±2, ±1), in the documented order of their indexes", () => {
    const vectors = Array.from({ length: 8 }, (_, index) => [
      gradientDot(index, 1, 0),
      gradientDot(index, 0, 1),
    ]);
    expect(vectors).toEqual([
      [1, 2],
      [-1, 2],
      [1, -2],
      [-1, -2],
      [2, 1],
      [-2, 1],
      [2, -1],
      [-2, -1],
    ]);
  });

  test("give the dot product with a cell's offset, and never -0", () => {
    const random = new Sfc32(5);
    for (let index = 0; index < 1000; index += 1) {
      const gradient = random.below(8);
      const dx = random.between(-Q16, Q16);
      const dy = random.between(-Q16, Q16);
      const [gx, gy] = [gradientDot(gradient, 1, 0), gradientDot(gradient, 0, 1)];
      expect(gradientDot(gradient, dx, dy)).toBe(gx * dx + gy * dy);
    }
    for (let gradient = 0; gradient < 8; gradient += 1) {
      expect(Object.is(gradientDot(gradient, 0, 0), 0)).toBe(true);
    }
  });

  test("come from the low 3 bits of word 0 of the lattice point's block", () => {
    const seed = seedWords(3);
    const key = new ChaCha20Key(seed);
    const input = new Uint32Array(CHACHA20_INPUT_WORDS);
    const block = new Uint32Array(CHACHA20_BLOCK_WORDS);
    const seen = new Set<number>();
    for (let x = -50; x < 50; x += 1) {
      setLatticeField(input, LATTICE_PURPOSES.elevation, 2);
      setLatticePoint(input, x, -x);
      const index = gradientAt(key, input, block);
      expect(index).toBe((chacha20Block(seed, [...input])[0] as number) % 8);
      seen.add(index);
    }
    expect(seen.size).toBe(8);
  });
});

describe("lattice positions", () => {
  test.each([
    [0, 8, 0, 0],
    [7, 8, 0, (7 * Q16) / 8],
    [8, 8, 1, 0],
    [-1, 8, -1, (7 * Q16) / 8],
    [-8, 8, -1, 0],
    [-9, 8, -2, (7 * Q16) / 8],
    [MIN_CELL, 2 ** 16, -(2 ** 15), 0],
    [MAX_CELL + 2 ** 16 - 1, 2 ** 16, 2 ** 15, Q16 - 2],
  ])(
    "position %d at wavelength %d lies in cell %d at fraction %d",
    (position, wavelength, cell_, fraction) => {
      expect(latticeCell(position, wavelength)).toBe(cell_);
      expect(latticeFraction(position, wavelength)).toBe(fraction);
    },
  );
});

describe("octave offsets", () => {
  const key = new ChaCha20Key(sharedGenesis(GENESIS).terrainSeed);

  test("lie below each octave's wavelength", () => {
    for (const purpose of NOISE_PURPOSES) {
      for (let octave = 0; octave < 12; octave += 1) {
        const wavelength = 2 ** (16 - octave);
        for (const offset of octaveOffsets(key, { purpose, octave }, wavelength)) {
          expect(Number.isInteger(offset) && offset >= 0 && offset < wavelength).toBe(true);
        }
      }
    }
  });

  test("differ between octaves and fields", () => {
    const offsets = new Set<string>();
    for (const purpose of NOISE_PURPOSES) {
      for (let octave = 0; octave < 12; octave += 1) {
        offsets.add(String(octaveOffsets(key, { purpose, octave }, 2 ** 16)));
      }
    }
    expect(offsets.size).toBe(NOISE_PURPOSES.length * 12);
  });
});

describe("bounds", () => {
  test("pin the noise's own bounds", () => {
    expect(NOISE_BOUNDS).toEqual({
      octaves: { min: 1, max: 12 },
      wavelength: { min: 8, max: 2 ** 16 },
      amplitude: { min: 1, max: 2 ** 29 },
      regionSide: { min: 1, max: 256 },
    });
    expect(Object.isFrozen(NOISE_BOUNDS) && Object.isFrozen(NOISE_BOUNDS.amplitude)).toBe(true);
  });

  test("NOISE_PEAK is ⌊73·2^16 / 48⌋ + 2: the bound 73/48 of the real noise, plus the floors", () => {
    expect(NOISE_PEAK).toBe(Math.floor((73 * Q16) / 48) + 2);
    expect(NOISE_PEAK).toBe(99_671);
  });

  test("one octave's noise reaches 1.45·2^16, within 5% of NOISE_PEAK, so the bound is tight", () => {
    // UNIT's fBm is its noise; a 256×256 region holds 1,024 lattice cells of wavelength 8.
    const spec = { ...UNIT, wavelength: 8 };
    let peak = 0;
    for (let seed = 0; seed < 4; seed += 1) {
      for (const value of sampleNoiseRegion(genesisOf(seed), spec, {
        x: -128,
        y: -128,
        width: 256,
        height: 256,
      })) {
        peak = Math.max(peak, Math.abs(value));
      }
    }
    expect(peak).toBeLessThanOrEqual(NOISE_PEAK);
    expect(peak).toBeGreaterThanOrEqual(1.45 * Q16);
  });

  test("noiseBound sums ⌈NOISE_PEAK·A_o / 2^16⌉ over the octaves whose amplitude is not 0", () => {
    expect(noiseBound({ ...UNIT, amplitude: 1 })).toBe(2);
    expect(noiseBound({ ...UNIT, amplitude: Q16 })).toBe(NOISE_PEAK);
    // ⌈1.52·3⌉ + ⌈1.52·1⌉; the third octave's amplitude is 0.
    expect(noiseBound({ ...LARGEST, octaves: 3, amplitude: 3 })).toBe(5 + 2);
  });

  test("an amplitude of 1 reaches -2, which is -noiseBound: the bound must round up", () => {
    const spec = { ...UNIT, wavelength: 8, amplitude: 1 };
    const values = SAMPLE(spec, { x: 0, y: 0, width: 64, height: 64 });
    expect(Math.min(...values)).toBe(-noiseBound(spec));
    expect(Math.max(...values)).toBe(1);
  });

  test("noiseBound is at most 4·amplitude (K = 4) for every amplitude up to 2^12 and every octave count", () => {
    for (let amplitude = 1; amplitude <= 2 ** 12; amplitude += 1) {
      for (let octaves = 1; octaves <= 12; octaves += 1) {
        const bound = noiseBound({ ...LARGEST, octaves, amplitude });
        if (bound > 4 * amplitude)
          throw new Error(`noiseBound is ${bound} for ${amplitude}, ${octaves}`);
      }
    }
  });

  test("noiseBound of the largest spec fits int32, and every intermediate stays below 2^53", () => {
    expect(noiseBound(LARGEST)).toBeLessThanOrEqual(2 ** 31 - 1);
    expect(noiseBound(LARGEST)).toBeLessThanOrEqual(4 * LARGEST.amplitude);
    // Why the amplitude stops at 2^29: at 2^30, the genesis's former bound, noiseBound passes int32.
    expect(noiseBound({ ...LARGEST, amplitude: 2 ** 30 })).toBeGreaterThan(2 ** 31 - 1);
    // A corner's dot product is at most 3·S; an interpolation multiplies a difference of two by a
    // fade; an octave multiplies its noise by its amplitude, even at 2^30, the genesis's former
    // bound.
    expect(6 * Q16 * Q16).toBeLessThan(2 ** 53);
    expect(NOISE_PEAK * 2 ** 30).toBeLessThan(2 ** 53);
  });
});

describe("sampleNoiseRegion", () => {
  test("returns an Int32Array of width × height values", () => {
    const values = SAMPLE(SMALL, { x: -3, y: 5, width: 7, height: 2 });
    expect(values).toBeInstanceOf(Int32Array);
    expect(values).toHaveLength(14);
  });

  test("lays out cells row by row", () => {
    const rect = { x: -3, y: 5, width: 7, height: 2 };
    const values = SAMPLE(SMALL, rect);
    expect(valueAt(values, rect, 1, 6)).toBe(values[1 * 7 + 4] as number);
    expect(SAMPLE(SMALL, cell(1, 6))[0]).toBe(values[1 * 7 + 4] as number);
  });

  test("depends on the terrain seed and the purpose", () => {
    const rect = chunk(0, 0);
    const base = SAMPLE(RELIEF, rect);
    expect(sampleNoiseRegion(genesisOf(2), RELIEF, rect)).not.toEqual(base);
    expect(SAMPLE({ ...RELIEF, purpose: LATTICE_PURPOSES.thermal }, rect)).not.toEqual(base);
  });

  test("returns a fresh array and keeps nothing between calls: changing one result changes no other", () => {
    const rect = chunk(2, 2);
    const first = SAMPLE(RELIEF, rect);
    const copy = first.slice();
    first.fill(0);
    expect(SAMPLE(RELIEF, rect)).toEqual(copy);
  });

  test("is not constant: the default relief varies inside a chunk", () => {
    expect(new Set(SAMPLE(RELIEF, chunk(3, -4))).size).toBeGreaterThan(100);
  });
});

describe("Lipschitz", () => {
  const specs: readonly NoiseSpec[] = [RELIEF, SMALL, LARGEST, { ...UNIT, wavelength: 8 }];

  test.each(specs.map((spec) => [JSON.stringify(spec), spec] as const))(
    "|Δ| stays within the bound along both axes around the origin (%s)",
    (_, spec) => {
      expect(lipschitzProblems(SAMPLE, spec, { x: -100, y: -60, width: 200, height: 120 })).toEqual(
        [],
      );
    },
  );

  test.each(specs.map((spec) => [JSON.stringify(spec), spec] as const))(
    "|Δ| stays within the bound in the two outermost chunks at each edge (%s)",
    (_, spec) => {
      for (const rect of EDGE_RECTS) expect(lipschitzProblems(SAMPLE, spec, rect)).toEqual([]);
    },
  );

  test("|Δ| stays within the bound across the lattice lines of every octave", () => {
    const key = new ChaCha20Key(sharedGenesis(GENESIS).terrainSeed);
    for (const spec of [RELIEF, SMALL]) {
      for (let octave = 0; octave < spec.octaves; octave += 1) {
        const wavelength = spec.wavelength / 2 ** octave;
        const [offsetX, offsetY] = octaveOffsets(
          key,
          { purpose: spec.purpose, octave },
          wavelength,
        );
        // The lattice line at the cell where (cell + offset) is a multiple of the wavelength.
        const lineX = wavelength - offsetX;
        const lineY = wavelength - offsetY;
        expect(latticeFraction(lineX + offsetX, wavelength)).toBe(0);
        const across = { x: lineX - 2, y: lineY - 2, width: 4, height: 4 };
        expect(lipschitzProblems(SAMPLE, spec, across)).toEqual([]);
      }
    }
  });

  test("the bound is not vacuous: neighbors differ by more than a quarter of it somewhere", () => {
    for (const spec of [{ ...UNIT, wavelength: 8 }, SMALL]) {
      const rect = { x: -64, y: -64, width: 128, height: 128 };
      const values = SAMPLE(spec, rect);
      let largest = 0;
      for (let index = 1; index < values.length; index += 1) {
        if (index % rect.width !== 0) {
          largest = Math.max(
            largest,
            Math.abs((values[index] as number) - (values[index - 1] as number)),
          );
        }
      }
      expect(largest).toBeGreaterThan(lipschitzBound(spec) / 4);
    }
  });
});

describe("float oracle", () => {
  const oracle = (spec: NoiseSpec, rect: CellRect) => oracleNoise(GENESIS, spec, rect);

  test("one octave agrees within a few Q16 units on random cells of the world", () => {
    const random = new Sfc32(11);
    for (const wavelength of [8, 64, 2 ** 16]) {
      const spec = { ...UNIT, wavelength };
      for (let index = 0; index < 300; index += 1) {
        const at = cell(random.between(MIN_CELL, MAX_CELL), random.between(MIN_CELL, MAX_CELL));
        expect(oracleProblems(SAMPLE, oracle, spec, at)).toEqual([]);
      }
    }
    // 14 Q16 units of integer error, 1 for the floor, and the oracle's own rounding.
    expect(oracleTolerance(UNIT)).toBe(14 + 1 + 2 ** -10);
  });

  test("the fBm agrees within its tolerance near the origin and at every edge", () => {
    for (const spec of [RELIEF, SMALL, LARGEST]) {
      expect(
        oracleProblems(SAMPLE, oracle, spec, { x: -20, y: -20, width: 40, height: 40 }),
      ).toEqual([]);
    }
    for (const rect of EDGE_RECTS) {
      for (const spec of [RELIEF, SMALL])
        expect(oracleProblems(SAMPLE, oracle, spec, rect)).toEqual([]);
    }
    // The largest spec draws 12 octaves of lattice points per cell: two opposite corners suffice.
    for (const rect of [chunk(MIN_CHUNK, MIN_CHUNK), chunk(MAX_CHUNK, MAX_CHUNK)]) {
      expect(oracleProblems(SAMPLE, oracle, LARGEST, rect)).toEqual([]);
    }
  });
});

describe("continuity", () => {
  test("a 48×48 region equals the composition of the 4 chunks it covers", () => {
    const region = { x: -24, y: -24, width: 48, height: 48 };
    const chunks = [chunk(-1, -1), chunk(0, -1), chunk(-1, 0), chunk(0, 0)];
    expect(compositionProblems(SAMPLE, RELIEF, region, chunks)).toEqual([]);
    expect(compositionProblems(SAMPLE, SMALL, region, chunks)).toEqual([]);
  });

  /** 200 chunks: the origin, negative ones, the edges and corners, and random ones. */
  function chunks(): { x: number; y: number }[] {
    const fixed = [
      [0, 0],
      [-1, -1],
      [-1, 0],
      [0, -1],
      [MIN_CHUNK, 0],
      [MAX_CHUNK, 0],
      [0, MIN_CHUNK],
      [0, MAX_CHUNK],
      [MIN_CHUNK, MIN_CHUNK],
      [MAX_CHUNK, MAX_CHUNK],
      [MIN_CHUNK, MAX_CHUNK],
      [MAX_CHUNK, MIN_CHUNK],
    ];
    const random = new Sfc32(13);
    const result = fixed.map(([x, y]) => ({ x: x as number, y: y as number }));
    while (result.length < 200) {
      result.push({
        x: random.between(MIN_CHUNK, MAX_CHUNK),
        y: random.between(MIN_CHUNK, MAX_CHUNK),
      });
    }
    return result;
  }

  test("each 1×1 region equals its chunk's cell: borders and 32 random cells of 200 chunks", () => {
    const random = new Sfc32(17);
    for (const { x, y } of chunks()) {
      const rect = chunk(x, y);
      const cells: CellRect[] = [];
      for (let offset = 0; offset < CHUNK_CELLS; offset += 1) {
        cells.push(cell(rect.x + offset, rect.y), cell(rect.x + offset, rect.y + CHUNK_CELLS - 1));
        if (offset > 0 && offset < CHUNK_CELLS - 1) {
          cells.push(
            cell(rect.x, rect.y + offset),
            cell(rect.x + CHUNK_CELLS - 1, rect.y + offset),
          );
        }
      }
      for (let index = 0; index < 32; index += 1) {
        cells.push(cell(rect.x + random.below(CHUNK_CELLS), rect.y + random.below(CHUNK_CELLS)));
      }
      expect(compositionProblems(SAMPLE, RELIEF, rect, cells)).toEqual([]);
    }
  });

  test("seams look like the interior: mean |Δ| within ±10%, maximum within the bound", () => {
    // One block of 2×2 chunks from each of 100 worlds: within one world every seam sits at the
    // same phase of the finest octaves, which biases its seams (worldgen-checks.ts, seamProblems).
    const random = new Sfc32(19);
    const samples = Array.from({ length: 100 }, () => ({
      sampler: samplerOf(genesisOf(random.next())),
      x: chunkFirstCell(random.between(MIN_CHUNK, MAX_CHUNK - 1)),
      y: chunkFirstCell(random.between(MIN_CHUNK, MAX_CHUNK - 1)),
    }));
    for (const spec of [RELIEF, SMALL]) {
      expect(seamProblems(spec, samples)).toEqual([]);
      expect(seamStatistics(spec, samples).seamPairs).toBe(100 * 2 * 64);
    }
  });
});

describe("order", () => {
  /** The chunks of a 6 × 5 block that straddles the origin. */
  const keys = Array.from({ length: 30 }, (_, index) => ({
    x: (index % 6) - 3,
    y: Math.floor(index / 6) - 2,
  }));

  test("5 seeded permutations of chunk requests give identical chunks", () => {
    const expected = new Map(keys.map(({ x, y }) => [`${x},${y}`, SAMPLE(RELIEF, chunk(x, y))]));
    for (let seed = 0; seed < 5; seed += 1) {
      const random = new Sfc32(100 + seed);
      const order = [...keys];
      for (let index = order.length - 1; index > 0; index -= 1) {
        const other = random.below(index + 1);
        [order[index], order[other]] = [
          order[other] as (typeof keys)[number],
          order[index] as (typeof keys)[number],
        ];
      }
      for (const { x, y } of order)
        expect(SAMPLE(RELIEF, chunk(x, y))).toEqual(expected.get(`${x},${y}`) as Int32Array);
    }
  });

  test("a chunk is the same before and after 2,000 other generations", () => {
    const target = chunk(-7, 9);
    const before = SAMPLE(RELIEF, target);
    const random = new Sfc32(23);
    const other = genesisOf(5);
    for (let index = 0; index < 2000; index += 1) {
      const rect = chunk(
        random.between(MIN_CHUNK, MAX_CHUNK),
        random.between(MIN_CHUNK, MAX_CHUNK),
      );
      sampleNoiseRegion(index % 2 === 0 ? GENESIS : other, index % 3 === 0 ? SMALL : RELIEF, rect);
    }
    expect(SAMPLE(RELIEF, target)).toEqual(before);
  });
});

describe("range", () => {
  /** A random valid spec: random purpose, octaves, wavelength, and amplitude, with edges favored. */
  function randomSpec(random: Sfc32): NoiseSpec {
    const octaves = random.between(1, 12);
    const wavelength = 2 ** random.between(2 + octaves, 16);
    const amplitudes = [
      1,
      2,
      3,
      Q16,
      NOISE_BOUNDS.amplitude.max,
      random.between(1, NOISE_BOUNDS.amplitude.max),
    ];
    return {
      purpose: random.pick(NOISE_PURPOSES),
      wavelength,
      octaves,
      amplitude: random.pick(amplitudes),
    };
  }

  /** A random region inside the world, near an edge one time in four. */
  function randomRect(random: Sfc32): CellRect {
    const width = random.between(1, 40);
    const height = random.between(1, 40);
    const edge = random.below(4) === 0;
    const x = edge
      ? random.pick([MIN_CELL, MAX_CELL - width + 1])
      : random.between(MIN_CELL, MAX_CELL - width + 1);
    const y = random.between(MIN_CELL, MAX_CELL - height + 1);
    return { x, y, width, height };
  }

  test("every output stays within ±noiseBound, under a fuzz of valid geneses and specs", () => {
    const random = new Sfc32(29);
    for (let round = 0; round < 150; round += 1) {
      const sampler = samplerOf(prepareGenesis(defaultGenesis(seedWords(random.next()))));
      const spec = randomSpec(random);
      expect(rangeProblems(sampler, spec, randomRect(random))).toEqual([]);
    }
  });

  test("the largest spec stays within its bound and int32 at every edge", () => {
    for (const rect of EDGE_RECTS) expect(rangeProblems(SAMPLE, LARGEST, rect)).toEqual([]);
  });
});

describe("independence of fields", () => {
  test("elevation and thermal noise with the same spec are uncorrelated", () => {
    const spec = { ...UNIT, wavelength: 8 };
    const rect = { x: -64, y: -64, width: 128, height: 128 };
    const a = SAMPLE(spec, rect);
    const b = SAMPLE({ ...spec, purpose: LATTICE_PURPOSES.thermal }, rect);
    const mean = (values: Int32Array) =>
      values.reduce((sum, value) => sum + value, 0) / values.length;
    const [ma, mb] = [mean(a), mean(b)];
    let covariance = 0;
    let va = 0;
    let vb = 0;
    for (let index = 0; index < a.length; index += 1) {
      const da = (a[index] as number) - ma;
      const db = (b[index] as number) - mb;
      covariance += da * db;
      va += da * da;
      vb += db * db;
    }
    expect(Math.abs(covariance / Math.sqrt(va * vb))).toBeLessThan(0.2);
  });
});

describe("validation", () => {
  const RECT = { x: 0, y: 0, width: 2, height: 2 };
  const issuesOf = (prepared: unknown, spec: unknown, rect: unknown) =>
    engineErrorOf(() =>
      sampleNoiseRegion(prepared as PreparedGenesis, spec as NoiseSpec, rect as CellRect),
    );

  test("throws invalid_value with every problem of the prepared genesis, the spec, and the rect", () => {
    const error = issuesOf(
      {},
      { purpose: 3, wavelength: 1000, octaves: 13, amplitude: 0 },
      {
        x: MAX_CELL + 1,
        y: "0",
        width: 0,
        height: 257,
      },
    );
    expect(error.code).toBe("invalid_value");
    expect(error.issues).toEqual([
      {
        path: "/prepared",
        message: "the value is not a prepared genesis: prepareGenesis makes them",
      },
      {
        path: "/spec/purpose",
        message: "3 is not a noise purpose: the noise purposes are 1, 2, 4, 5, 6, 7, 8, 9, 10, 11",
      },
      { path: "/spec/octaves", message: "13 is out of bounds: it must be from 1 to 12" },
      { path: "/spec/wavelength", message: "1000 is not a power of two from 8 to 65536" },
      { path: "/spec/amplitude", message: "0 is out of bounds: it must be from 1 to 536870912" },
      {
        path: "/rect/x",
        message:
          "2147483648 is outside the world: cell coordinates lie from -2147483648 to 2147483647",
      },
      { path: "/rect/y", message: "a value of type string is not a safe integer" },
      { path: "/rect/width", message: "0 is out of bounds: it must be from 1 to 256" },
      { path: "/rect/height", message: "257 is out of bounds: it must be from 1 to 256" },
    ]);
  });

  test("checks the wavelength against the octaves: the finest octave spans 8 cells or more", () => {
    const error = issuesOf(GENESIS, { ...SMALL, wavelength: 16, octaves: 3 }, RECT);
    expect(error.issues).toEqual([
      { path: "/spec/wavelength", message: "16 is not a power of two from 32 to 65536" },
    ]);
    expect(SAMPLE({ ...SMALL, wavelength: 32, octaves: 3 }, RECT)).toHaveLength(4);
  });

  test("accepts each bound's ends and rejects one past each", () => {
    const accepted: NoiseSpec[] = [
      { ...SMALL, octaves: 1, wavelength: 8, amplitude: 1 },
      { ...SMALL, octaves: 12, wavelength: 2 ** 16, amplitude: 2 ** 29 },
    ];
    for (const spec of accepted) expect(SAMPLE(spec, RECT)).toHaveLength(4);
    const rejected: [Partial<NoiseSpec>, string][] = [
      [{ octaves: 0 }, "/spec/octaves"],
      [{ wavelength: 2 ** 17 }, "/spec/wavelength"],
      [{ amplitude: 2 ** 29 + 1 }, "/spec/amplitude"],
      [{ purpose: 12 }, "/spec/purpose"],
      [{ purpose: LATTICE_PURPOSES.octaveOffset }, "/spec/purpose"],
    ];
    for (const [change, path] of rejected) {
      expect(
        issuesOf(GENESIS, { ...SMALL, ...change }, RECT).issues.map((issue) => issue.path),
      ).toEqual([path]);
    }
  });

  test("accepts regions that touch the world's edges, and rejects one cell past them", () => {
    const top = { x: MAX_CELL - 255, y: MAX_CELL - 255, width: 256, height: 256 };
    expect(SAMPLE(SMALL, top)).toHaveLength(256 * 256);
    expect(SAMPLE(SMALL, { x: MIN_CELL, y: MIN_CELL, width: 1, height: 1 })).toHaveLength(1);
    const error = issuesOf(GENESIS, SMALL, { ...top, x: top.x + 1, y: top.y + 1 });
    const outside =
      "the region ends at the cell 2147483648, outside the world: cell coordinates lie from -2147483648 to 2147483647";
    expect(error.issues).toEqual([
      { path: "/rect/width", message: outside },
      { path: "/rect/height", message: outside },
    ]);
  });

  test("rejects values that are not safe integers, and -0", () => {
    const error = issuesOf(
      GENESIS,
      { ...SMALL, octaves: 1.5, amplitude: -0, wavelength: "64" },
      RECT,
    );
    expect(error.issues).toEqual([
      { path: "/spec/octaves", message: "1.5 is not a safe integer" },
      { path: "/spec/wavelength", message: "a value of type string is not a safe integer" },
      { path: "/spec/amplitude", message: "-0 is not canonical: use 0" },
    ]);
  });

  test("rejects records of the wrong shape, and missing members", () => {
    expect(issuesOf(GENESIS, [], RECT).issues).toEqual([
      {
        path: "/spec",
        message: "the noise spec must be a record { purpose, wavelength, octaves, amplitude }",
      },
    ]);
    expect(issuesOf(GENESIS, SMALL, null).issues).toEqual([
      { path: "/rect", message: "the region must be a record { x, y, width, height }" },
    ]);
    expect(
      issuesOf(GENESIS, { purpose: 1, wavelength: 8, octaves: 1 }, { x: 0, y: 0, width: 1 }).issues,
    ).toEqual([
      { path: "/spec/amplitude", message: "the member is missing" },
      { path: "/rect/height", message: "the member is missing" },
    ]);
  });

  test("reads each member once, through its own descriptor: no accessor runs, inherited members are missing", () => {
    let reads = 0;
    const spec = {
      ...SMALL,
      get amplitude() {
        reads += 1;
        return 1;
      },
    };
    const rect = Object.assign(Object.create({ height: 2 }), { x: 0, y: 0, width: 2 });
    const error = issuesOf(GENESIS, spec, rect);
    expect(reads).toBe(0);
    expect(error.issues.map((issue) => issue.path)).toEqual(["/spec/amplitude", "/rect/height"]);
  });

  test("reports a revoked Proxy as one issue at its path", () => {
    const error = issuesOf(revokedProxy(), revokedProxy(), revokedProxy());
    expect(error.issues.map((issue) => issue.path)).toEqual(["/prepared", "/spec", "/rect"]);
  });
});

describe("sensitivity: property checks catch every broken variant", () => {
  const oracle = (spec: NoiseSpec, rect: CellRect) => oracleNoise(GENESIS, spec, rect);
  const AROUND_ORIGIN = { x: -40, y: -40, width: 80, height: 80 };
  const TOP_EDGE = { x: MAX_CELL - 63, y: MAX_CELL - 7, width: 64, height: 8 };
  const random = new Sfc32(31);
  const SEAM_ORIGINS = Array.from({ length: 12 }, () => ({
    x: chunkFirstCell(random.between(-1000, 1000)),
    y: chunkFirstCell(random.between(-1000, 1000)),
  }));
  /** Wavelengths far above 64, so that one world's seams show no phase (seamProblems). */
  const SEAM_SPEC = { ...SMALL, wavelength: 4096 };
  const SHARED_ORIGIN_SPEC = { ...SMALL, wavelength: 32 };
  const DETAIL_SPEC = { ...SMALL, wavelength: 64, octaves: 4 };

  /** The problems each property check finds in `parts`, by check. */
  function problemsOf(parts: NoiseParts): Record<string, string[]> {
    const sampler = composeSampler(GENESIS, parts);
    return {
      fade: fadeProblems(parts.fade),
      packing: packingCollisions(parts.pack),
      lipschitz: lipschitzProblems(sampler, SMALL, AROUND_ORIGIN),
      range: rangeProblems(sampler, SMALL, AROUND_ORIGIN),
      composition: compositionProblems(sampler, SMALL, AROUND_ORIGIN, [
        chunk(-1, -1),
        chunk(0, 0),
        cell(-1, 3),
      ]),
      history: historyProblems(sampler, SMALL, chunk(-1, -1), [chunk(0, 0), cell(-1, 3)]),
      seams: seamProblems(
        SEAM_SPEC,
        SEAM_ORIGINS.map((origin) => ({ sampler, ...origin })),
      ),
      oracle: [
        ...oracleProblems(sampler, oracle, SMALL, AROUND_ORIGIN),
        ...oracleProblems(sampler, oracle, SMALL, TOP_EDGE),
      ],
      sharedOrigins: sharedOriginProblems(sampler, SHARED_ORIGIN_SPEC, {
        x: -64,
        y: -64,
        width: 128,
        height: 128,
      }),
      octaveDetail: octaveDetailProblems(sampler, DETAIL_SPEC, {
        x: -32,
        y: -32,
        width: 64,
        height: 64,
      }),
    };
  }

  test("the faithful composition equals sampleNoiseRegion, at the origin and at the edges", () => {
    const composed = composeSampler(GENESIS, FAITHFUL_PARTS);
    for (const spec of [RELIEF, SMALL, LARGEST]) {
      for (const rect of [AROUND_ORIGIN, TOP_EDGE, ...EDGE_RECTS.slice(0, 4)]) {
        expect(composed(spec, rect)).toEqual(SAMPLE(spec, rect));
      }
    }
  });

  test("the real parts pass every check", () => {
    const problems = problemsOf(FAITHFUL_PARTS);
    for (const [check, found] of Object.entries(problems))
      expect({ check, found }).toEqual({ check, found: [] });
  });

  test.each(BROKEN_VARIANTS.map((variant) => [variant.name, variant] as const))(
    "%s is caught by its property check",
    (_, variant) => {
      const problems = problemsOf(variant.parts);
      expect(Object.keys(problems)).toContain(variant.caughtBy);
      expect(problems[variant.caughtBy]).not.toEqual([]);
    },
  );
});

describe("the genesis bounds and the noise bounds", () => {
  test("agree: every relief and every deposit the genesis accepts is a noise spec", () => {
    const { relief, deposits } = GENESIS_BOUNDS.terrain;
    for (const field of [relief, deposits]) {
      expect(field.octaves.min).toBeGreaterThanOrEqual(NOISE_BOUNDS.octaves.min);
      expect(field.octaves.max).toBeLessThanOrEqual(NOISE_BOUNDS.octaves.max);
      expect(field.wavelength.min).toBeGreaterThanOrEqual(NOISE_BOUNDS.wavelength.min);
      expect(field.wavelength.max).toBeLessThanOrEqual(NOISE_BOUNDS.wavelength.max);
    }
    expect(relief.amplitude.max).toBeLessThanOrEqual(NOISE_BOUNDS.amplitude.max);
    expect(deposits.peak.max).toBeLessThanOrEqual(NOISE_BOUNDS.amplitude.max);
  });
});
