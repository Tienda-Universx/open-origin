import { describe, expect, test } from "bun:test";
import { digest, hexOf } from "../src/digest/digest.ts";
import { murmur3x86_128 } from "../src/digest/murmur3.ts";
import { ChaCha20Key } from "../src/rng/chacha.ts";
import {
  defaultGenesis,
  type Genesis,
  genesisIssues,
  type PreparedGenesis,
  prepareGenesis,
  sharedGenesis,
} from "../src/worldgen/genesis.ts";
import { LATTICE_PURPOSES, setLatticeField, setLatticePoint } from "../src/worldgen/lattice.ts";
import {
  type CellRect,
  type NoiseSpec,
  noiseBound,
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
  DEPOSIT_AMPLITUDE,
  generateChunk,
  liquidLevel,
  sampleRegion,
  type TerrainChunk,
  type TerrainRegion,
  THERMAL_NOISE,
  terrainDigest,
} from "../src/worldgen/terrain.ts";
import { WORLDGEN_VERSION } from "../src/worldgen/version.ts";
import { GOLDEN_WORLDGEN, maximumGenesis } from "./fixtures/golden-worldgen.ts";
import {
  BROKEN_TERRAIN_VARIANTS,
  composeTerrain,
  FAITHFUL_KEYING,
  type TerrainKeying,
} from "./support/broken-worldgen.ts";
import { engineErrorOf } from "./support/engine-error.ts";
import { Sfc32 } from "./support/sfc32.ts";
import type { TerrainChildInput } from "./support/terrain-child.ts";
import {
  requestHistoryProblems,
  type TerrainSampler,
  terrainCompositionProblems,
  terrainFields,
  terrainSeedProblems,
  terrainValues,
} from "./support/worldgen-checks.ts";

/**
 * Terrain (ADR 0021, permanent and temporal layers; plan §5 D4, D6, D12, §6.2, §12 tests 8–11 and
 * 17): the permanent primary fields, their equalities between regions, chunks, and cells, their
 * laws and ranges, their independence from order, history, and process, their dependence on the
 * terrain seed, the digest's word layout, and the golden values of worldgen@1.
 */

/** Eight seed words from `seed`, through sfc32. */
function seedWords(seed: number): number[] {
  const random = new Sfc32(seed);
  return Array.from({ length: 8 }, () => random.next());
}

/** The default genesis around the seed words of `seed`, with `change` applied to a copy. */
function genesisWith(seed: number, change: (genesis: Genesis) => Partial<Genesis> = () => ({})) {
  const base = defaultGenesis(seedWords(seed));
  return prepareGenesis({ ...base, ...change(base) });
}

/** A genesis like `base` with other thermal laws. */
function thermalWith(base: Genesis, thermal: Partial<Genesis["laws"]["thermal"]>) {
  return { laws: { ...base.laws, thermal: { ...base.laws.thermal, ...thermal } } };
}

/** A genesis like `base` with another substrate. */
function substrateWith(base: Genesis, substrate: Partial<Genesis["terrain"]["substrate"]>) {
  return { terrain: { ...base.terrain, substrate: { ...base.terrain.substrate, ...substrate } } };
}

/** The real terrain sampler of `prepared`. */
function samplerOf(prepared: PreparedGenesis): TerrainSampler {
  return (rect) => sampleRegion(prepared, rect);
}

const DEFAULT = genesisWith(1);
const MAXIMUM = prepareGenesis(maximumGenesis(seedWords(1)));

/** The chunk at chunk coordinates `x`, `y`, as a region. */
function chunk(x: number, y: number): CellRect {
  return { x: chunkFirstCell(x), y: chunkFirstCell(y), width: CHUNK_CELLS, height: CHUNK_CELLS };
}

/** The 1×1 region of the cell `x`, `y`. */
function cell(x: number, y: number): CellRect {
  return { x, y, width: 1, height: 1 };
}

/** The four corner chunks of the world. */
const CORNERS: readonly CellRect[] = [
  chunk(MIN_CHUNK, MIN_CHUNK),
  chunk(MAX_CHUNK, MIN_CHUNK),
  chunk(MIN_CHUNK, MAX_CHUNK),
  chunk(MAX_CHUNK, MAX_CHUNK),
];

/** Regions around the origin and at every edge, where each law must hold as it does elsewhere. */
const LAW_RECTS: readonly CellRect[] = [
  { x: -40, y: -40, width: 80, height: 80 },
  { x: MIN_CELL, y: -16, width: 2 * CHUNK_CELLS, height: CHUNK_CELLS },
  { x: MAX_CELL - 2 * CHUNK_CELLS + 1, y: -16, width: 2 * CHUNK_CELLS, height: CHUNK_CELLS },
  ...CORNERS,
];

/** ⌊a / b⌋ for BigInts, rounding toward negative infinity, for b > 0. */
function floorDivBig(a: bigint, b: bigint): bigint {
  const quotient = a / b;
  return a % b < 0n ? quotient - 1n : quotient;
}

/** The documented level of liquid, in BigInt: ⌊amplitude × (2·level − 1000) / 1000⌋. */
function levelOf(genesis: Genesis): bigint {
  const amplitude = BigInt(genesis.terrain.relief.amplitude);
  return floorDivBig(amplitude * BigInt(2 * genesis.laws.liquid.level - 1000), 1000n);
}

/** The documented lapse term of a cell at `elevation`, in BigInt. */
function lapseOf(genesis: Genesis, elevation: number): bigint {
  const above = BigInt(elevation) - levelOf(genesis);
  const { num, den } = genesis.laws.thermal.lapse;
  return above > 0n ? floorDivBig(BigInt(num) * above, BigInt(den)) : 0n;
}

/** The thermal noise of `prepared` over `rect`, through the validated noise; 0 for spread 0. */
function thermalNoiseOf(prepared: PreparedGenesis, rect: CellRect): Int32Array {
  const { spread } = sharedGenesis(prepared).laws.thermal;
  if (spread === 0) return new Int32Array(rect.width * rect.height);
  const spec = { purpose: LATTICE_PURPOSES.thermal, ...THERMAL_NOISE, amplitude: spread };
  return sampleNoiseRegion(prepared, spec, rect);
}

/** The deposit `k` of `prepared` over `rect`, by its documented formula, in BigInt. */
function depositOf(prepared: PreparedGenesis, k: number, rect: CellRect): bigint[] {
  const deposit = sharedGenesis(prepared).terrain.deposits[k] as Genesis["terrain"]["deposits"][0];
  const spec: NoiseSpec = {
    purpose: LATTICE_PURPOSES.deposits[k] as number,
    wavelength: deposit.wavelength,
    octaves: deposit.octaves,
    amplitude: DEPOSIT_AMPLITUDE,
  };
  const bound = BigInt(noiseBound(spec));
  const threshold = floorDivBig(BigInt(deposit.threshold) * bound, 1000n);
  return Array.from(sampleNoiseRegion(prepared, spec, rect), (n) =>
    BigInt(n) > threshold
      ? floorDivBig((BigInt(n) - threshold) * BigInt(deposit.peak), bound - threshold)
      : 0n,
  );
}

/**
 * Cells where a field departs from its documented formula, computed in BigInt from the validated
 * noise: elevation is the relief noise; thermalBase − thermalNoise − lapseTerm is the base (I5);
 * each deposit is its scaled excess over its threshold.
 */
function formulaProblems(prepared: PreparedGenesis, rect: CellRect): string[] {
  const genesis = sharedGenesis(prepared);
  const region = sampleRegion(prepared, rect);
  const relief = { purpose: LATTICE_PURPOSES.elevation, ...genesis.terrain.relief };
  const elevation = sampleNoiseRegion(prepared, relief, rect);
  const thermal = thermalNoiseOf(prepared, rect);
  const base = BigInt(genesis.laws.thermal.base);
  const problems: string[] = [];
  for (let index = 0; index < elevation.length; index += 1) {
    const e = elevation[index] as number;
    if (region.elevation[index] !== e) problems.push(`elevation ${index}`);
    const t = BigInt(region.thermalBase[index] as number);
    if (t - BigInt(thermal[index] as number) - lapseOf(genesis, e) !== base) {
      problems.push(`thermalBase ${index}: ${t}`);
    }
  }
  genesis.terrain.deposits.forEach((_, k) => {
    const expected = depositOf(prepared, k, rect);
    const values = region.deposits[k] as Int32Array;
    expected.forEach((value, index) => {
      if (BigInt(values[index] as number) !== value) problems.push(`deposits/${k} ${index}`);
    });
  });
  return problems.slice(0, 5);
}

describe("fields", () => {
  test("a region holds every field in a typed array of width × height cells, row by row", () => {
    const rect = { x: -3, y: 5, width: 7, height: 2 };
    const region = sampleRegion(DEFAULT, rect);
    expect(region.elevation).toBeInstanceOf(Int32Array);
    expect(region.substrate).toBeInstanceOf(Uint8Array);
    expect(region.thermalBase).toBeInstanceOf(Int32Array);
    expect(region.deposits).toHaveLength(2);
    for (const [, values] of terrainFields(region)) expect(values).toHaveLength(14);
    const last = sampleRegion(DEFAULT, cell(3, 6));
    for (const [index, [, values]] of terrainFields(region).entries()) {
      expect(values[13]).toBe((terrainFields(last)[index] as [string, ArrayLike<number>])[1][0]);
    }
  });

  test("a chunk is the 32×32 region of its key, with that key", () => {
    const generated = generateChunk(DEFAULT, "-1,2");
    expect(generated.key).toBe("-1,2");
    expect(terrainValues(generated)).toEqual(terrainValues(sampleRegion(DEFAULT, chunk(-1, 2))));
    expect(Object.keys(generated)).toEqual([
      "key",
      "elevation",
      "substrate",
      "thermalBase",
      "deposits",
    ]);
  });

  test("every call returns fresh arrays: changing one result changes no other", () => {
    const first = sampleRegion(DEFAULT, chunk(0, 0));
    const expected = terrainValues(first);
    first.elevation.fill(0);
    first.deposits[0]?.fill(7);
    expect(terrainValues(sampleRegion(DEFAULT, chunk(0, 0)))).toEqual(expected);
  });

  test("a genesis without deposits has no deposit fields", () => {
    const bare = genesisWith(1, (base) => ({ terrain: { ...base.terrain, deposits: [] } }));
    expect(sampleRegion(bare, chunk(0, 0)).deposits).toEqual([]);
  });

  test("each field follows its documented formula, at the origin and at every edge", () => {
    for (const prepared of [DEFAULT, MAXIMUM]) {
      for (const rect of LAW_RECTS) expect(formulaProblems(prepared, rect)).toEqual([]);
    }
  });
});

describe("region equalities (I2)", () => {
  test("a 48×48 region equals the composition of the 4 chunks it covers, for every field", () => {
    const region = { x: -24, y: -24, width: 48, height: 48 };
    const chunks = [chunk(-1, -1), chunk(0, -1), chunk(-1, 0), chunk(0, 0)];
    for (const prepared of [DEFAULT, MAXIMUM]) {
      expect(terrainCompositionProblems(samplerOf(prepared), region, chunks)).toEqual([]);
    }
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
    const random = new Sfc32(41);
    const result = fixed.map(([x, y]) => ({ x: x as number, y: y as number }));
    while (result.length < 200) {
      result.push({
        x: random.between(MIN_CHUNK, MAX_CHUNK),
        y: random.between(MIN_CHUNK, MAX_CHUNK),
      });
    }
    return result;
  }

  /** The border cells of `rect` and 32 random cells inside it, as 1×1 regions. */
  function cellsOf(rect: CellRect, random: Sfc32): CellRect[] {
    const cells: CellRect[] = [];
    for (let offset = 0; offset < CHUNK_CELLS; offset += 1) {
      cells.push(cell(rect.x + offset, rect.y), cell(rect.x + offset, rect.y + CHUNK_CELLS - 1));
      if (offset > 0 && offset < CHUNK_CELLS - 1) {
        cells.push(cell(rect.x, rect.y + offset), cell(rect.x + CHUNK_CELLS - 1, rect.y + offset));
      }
    }
    for (let index = 0; index < 32; index += 1) {
      cells.push(cell(rect.x + random.below(CHUNK_CELLS), rect.y + random.below(CHUNK_CELLS)));
    }
    return cells;
  }

  test("each 1×1 region equals its chunk's cell in every field: borders and 32 random cells of 200 chunks", () => {
    const random = new Sfc32(43);
    const sampler = samplerOf(DEFAULT);
    for (const { x, y } of chunks()) {
      const rect = chunk(x, y);
      expect(terrainCompositionProblems(sampler, rect, cellsOf(rect, random))).toEqual([]);
    }
  });

  test("the same holds for the maximum genesis, at the corners and around the origin", () => {
    const random = new Sfc32(47);
    const sampler = samplerOf(MAXIMUM);
    for (const rect of [...CORNERS, chunk(0, 0), chunk(-1, -1)]) {
      expect(terrainCompositionProblems(sampler, rect, cellsOf(rect, random))).toEqual([]);
    }
  });
});

describe("uniform laws (I5)", () => {
  test("thermalBase − thermalNoise − lapseTerm is the base in every cell, for a lapse of each sign", () => {
    for (const lapse of [
      { num: 3, den: 1000 },
      { num: -3, den: 1000 },
      { num: 0, den: 1 },
      { num: -(2 ** 20), den: 2 ** 20 },
      { num: 7, den: 3 },
    ]) {
      const prepared = genesisWith(2, (base) => thermalWith(base, { lapse }));
      for (const rect of LAW_RECTS) expect(formulaProblems(prepared, rect)).toEqual([]);
    }
  });

  /** The lapse terms of the cells of `rect` above the level, thermalBase − base − noise. */
  function lapseTerms(prepared: PreparedGenesis, rect: CellRect): number[] {
    const genesis = sharedGenesis(prepared);
    const region = sampleRegion(prepared, rect);
    const noise = thermalNoiseOf(prepared, rect);
    const level = liquidLevel(genesis);
    const terms: number[] = [];
    region.elevation.forEach((e, index) => {
      const term = (region.thermalBase[index] as number) - genesis.laws.thermal.base;
      const lapse = term - (noise[index] as number);
      if (e > level) terms.push(lapse);
      else expect(lapse).toBe(0);
    });
    return terms;
  }

  test("the lapse term takes the sign of lapse.num above the level, and is 0 at or below it", () => {
    const rect = { x: -128, y: -128, width: 256, height: 256 };
    const rising = lapseTerms(DEFAULT, rect);
    const falling = lapseTerms(
      genesisWith(1, (base) => thermalWith(base, { lapse: { num: -3, den: 1000 } })),
      rect,
    );
    expect(rising.length).toBeGreaterThan(1000);
    expect(rising.every((term) => term >= 0)).toBe(true);
    expect(rising.some((term) => term > 0)).toBe(true);
    expect(falling).toHaveLength(rising.length);
    expect(falling.every((term) => term <= 0)).toBe(true);
    expect(falling.some((term) => term < 0)).toBe(true);
  });

  test("with a spread of 0 there is no thermal noise: thermalBase is the base plus the lapse term", () => {
    const flat = genesisWith(1, (base) => thermalWith(base, { spread: 0 }));
    const genesis = sharedGenesis(flat);
    for (const rect of LAW_RECTS) {
      const region = sampleRegion(flat, rect);
      region.elevation.forEach((e, index) => {
        const expected = BigInt(genesis.laws.thermal.base) + lapseOf(genesis, e);
        expect(BigInt(region.thermalBase[index] as number)).toBe(expected);
      });
    }
  });

  test("the level is ⌊amplitude × (2·level − 1000) / 1000⌋, rounding down below 0", () => {
    expect(liquidLevel(sharedGenesis(DEFAULT))).toBe(-6000);
    expect(liquidLevel(sharedGenesis(MAXIMUM))).toBe(-429_496_730);
    const odd = genesisWith(1, (base) => ({
      laws: { ...base.laws, liquid: { level: 499 } },
      terrain: { ...base.terrain, relief: { ...base.terrain.relief, amplitude: 3 } },
    }));
    expect(liquidLevel(sharedGenesis(odd))).toBe(-1);
  });
});

/**
 * A random valid genesis, with the ends of each bound favored. Its lapse is drawn up to the
 * steepest the genesis accepts, |num| × amplitude ≤ 2^28 × den, and that steepest one is favored.
 */
function randomGenesis(random: Sfc32): Genesis {
  const octaves = random.between(1, 12);
  const amplitude = random.pick([1, 2, 3, 60_000, 2 ** 29, random.between(1, 2 ** 29)]);
  const den = random.pick([1, 1000, 2 ** 20, random.between(1, 2 ** 20)]);
  // The floor of 2^28 × den / amplitude, exact below 2^20 where the cap does not apply.
  const steepest = Math.min(2 ** 20, Math.floor((2 ** 28 * den) / amplitude));
  // 0 − steepest, not −steepest, which is −0 for 0: a genesis refuses −0.
  const num = random.pick([0, steepest, 0 - steepest, random.between(0 - steepest, steepest)]);
  const deposit = () => {
    const depth = random.between(1, 6);
    return {
      wavelength: 2 ** random.between(2 + depth, 16),
      octaves: depth,
      threshold: random.pick([0, 999, random.between(0, 999)]),
      peak: random.pick([1, 2 ** 20, random.between(1, 2 ** 20)]),
    };
  };
  return {
    terrainSeed: Array.from({ length: 8 }, () => random.next()),
    laws: {
      day: { length: 75_600, daylight: 550 },
      liquid: { level: random.pick([100, 900, random.between(100, 900)]) },
      thermal: {
        base: random.pick([-(2 ** 20), 2 ** 20, random.between(-(2 ** 20), 2 ** 20)]),
        spread: random.pick([0, 1, 2 ** 20, random.between(0, 2 ** 20)]),
        lapse: { num, den },
        diurnal: 60,
      },
      radiance: { peak: 1000, night: 40 },
    },
    terrain: {
      relief: { wavelength: 2 ** random.between(2 + octaves, 16), octaves, amplitude },
      substrate: {
        cell: 2 ** random.between(3, 12),
        weights: Array.from({ length: random.between(1, 16) }, () => random.between(1, 1000)),
      },
      deposits: Array.from({ length: random.between(0, 8) }, deposit),
    },
  };
}

/** The documented range of each field of `genesis`, by name. */
function rangesOf(genesis: Genesis): Map<string, readonly [number, number]> {
  const relief = noiseBound({ purpose: LATTICE_PURPOSES.elevation, ...genesis.terrain.relief });
  const { base, spread } = genesis.laws.thermal;
  const noise =
    spread === 0
      ? 0
      : noiseBound({ purpose: LATTICE_PURPOSES.thermal, ...THERMAL_NOISE, amplitude: spread });
  // The lapse term grows with elevation, so its extreme is at the highest elevation.
  const steepest = Number(lapseOf(genesis, relief));
  const ranges = new Map<string, readonly [number, number]>([
    ["elevation", [-relief, relief]],
    ["substrate", [0, genesis.terrain.substrate.weights.length - 1]],
    ["thermalBase", [base - noise + Math.min(0, steepest), base + noise + Math.max(0, steepest)]],
  ]);
  for (const [k, deposit] of genesis.terrain.deposits.entries()) {
    ranges.set(`deposits/${k}`, [0, deposit.peak]);
  }
  return ranges;
}

/** Cells of `region` outside the documented ranges of `genesis`, or ranges beyond int32. */
function rangeProblems(genesis: Genesis, region: TerrainRegion): string[] {
  const ranges = rangesOf(genesis);
  const problems: string[] = [];
  for (const [name, values] of terrainFields(region)) {
    const [min, max] = ranges.get(name) ?? [1, 0];
    if (min < -(2 ** 31) || max > 2 ** 31 - 1) problems.push(`${name}: [${min}, ${max}]`);
    for (const value of Array.from(values)) {
      if (value < min || value > max) problems.push(`${name}: ${value} outside [${min}, ${max}]`);
    }
  }
  return problems.slice(0, 5);
}

describe("ranges (I6)", () => {
  /** A random region inside the world, at an edge one time in four. */
  function randomRect(random: Sfc32): CellRect {
    const width = random.between(1, 24);
    const height = random.between(1, 24);
    const edge = random.below(4) === 0;
    const x = edge
      ? random.pick([MIN_CELL, MAX_CELL - width + 1])
      : random.between(MIN_CELL, MAX_CELL - width + 1);
    const y = random.between(MIN_CELL, MAX_CELL - height + 1);
    return { x, y, width, height };
  }

  test("every field stays in its documented range, and follows its formula, under a fuzz of valid geneses", () => {
    const random = new Sfc32(53);
    for (let round = 0; round < 80; round += 1) {
      const genesis = randomGenesis(random);
      expect(genesisIssues(genesis)).toEqual([]);
      const prepared = prepareGenesis(genesis);
      const rect = randomRect(random);
      expect(rangeProblems(genesis, sampleRegion(prepared, rect))).toEqual([]);
      expect(formulaProblems(prepared, rect)).toEqual([]);
    }
  });

  test("the maximum genesis stays in range at every edge", () => {
    for (const rect of LAW_RECTS) {
      expect(rangeProblems(sharedGenesis(MAXIMUM), sampleRegion(MAXIMUM, rect))).toEqual([]);
    }
  });

  /**
   * The geneses with the widest thermalBase range for amplitudes around each power of two: the
   * maximum genesis, whose base, spread, and level are at the ends that widen it, with 12 octaves
   * of relief and the steepest lapse of each sign the genesis accepts.
   */
  function widestGeneses(): Genesis[] {
    const maximum = maximumGenesis(seedWords(1));
    const amplitudes = Array.from({ length: 30 }, (_, power) => [
      2 ** power - 1,
      2 ** power,
      2 ** power + 1,
    ]).flat();
    return amplitudes
      .filter((amplitude) => amplitude >= 1 && amplitude <= 2 ** 29)
      .flatMap((amplitude) =>
        [1, 2 ** 20].flatMap((den) => {
          const steepest = Math.min(2 ** 20, Math.floor((2 ** 28 * den) / amplitude));
          return [steepest, 0 - steepest].map((num) => ({
            ...maximum,
            laws: { ...maximum.laws, thermal: { ...maximum.laws.thermal, lapse: { num, den } } },
            terrain: {
              ...maximum.terrain,
              relief: { wavelength: 2 ** 16, octaves: 12, amplitude },
            },
          }));
        }),
      );
  }

  test("the genesis's lapse rule keeps the widest thermalBase range inside int32 for every amplitude", () => {
    const geneses = widestGeneses();
    expect(geneses).toHaveLength(2 * 2 * 88);
    for (const genesis of geneses) {
      expect(genesisIssues(genesis)).toEqual([]);
      const { num, den } = genesis.laws.thermal.lapse;
      if (num > 0 && num < 2 ** 20) {
        // One step steeper is refused, so this lapse is the steepest the genesis accepts.
        const steeper = { ...genesis.laws.thermal, lapse: { num: num + 1, den } };
        const refused = { ...genesis, laws: { ...genesis.laws, thermal: steeper } };
        expect(genesisIssues(refused).map((issue) => issue.path)).toEqual(["/laws/thermal/lapse"]);
      }
      const [min, max] = rangesOf(genesis).get("thermalBase") ?? [0, 0];
      expect(min).toBeGreaterThanOrEqual(-(2 ** 31));
      expect(max).toBeLessThanOrEqual(2 ** 31 - 1);
    }
  });
});

/** The terrainDigest of each chunk of `keys` under `prepared`. */
function digestsOf(prepared: PreparedGenesis, keys: readonly string[]): string[] {
  return keys.map((key) => terrainDigest(generateChunk(prepared, key)));
}

describe("order and history (I3)", () => {
  /** The chunks of a 6 × 5 block that straddles the origin. */
  const KEYS = Array.from({ length: 30 }, (_, index) => {
    return `${(index % 6) - 3},${Math.floor(index / 6) - 2}`;
  });

  test("5 seeded permutations of chunk requests give identical digests", () => {
    const digests = digestsOf(DEFAULT, KEYS);
    const expected = new Map(KEYS.map((key, index) => [key, digests[index]]));
    for (let seed = 0; seed < 5; seed += 1) {
      const random = new Sfc32(200 + seed);
      const order = [...KEYS];
      for (let index = order.length - 1; index > 0; index -= 1) {
        const other = random.below(index + 1);
        [order[index], order[other]] = [order[other] as string, order[index] as string];
      }
      for (const key of order) {
        expect(terrainDigest(generateChunk(DEFAULT, key))).toBe(expected.get(key) as string);
      }
    }
  });

  test("a chunk is the same before and after 2,000 other generations", () => {
    const before = terrainDigest(generateChunk(DEFAULT, "-7,9"));
    // Every tenth generation uses the maximum genesis, the others alternate two default ones.
    const other = genesisWith(5);
    const geneses = [
      MAXIMUM,
      ...Array.from({ length: 9 }, (_, i) => (i % 2 === 0 ? other : DEFAULT)),
    ];
    const random = new Sfc32(59);
    for (let index = 0; index < 2000; index += 1) {
      const key = `${random.between(MIN_CHUNK, MAX_CHUNK)},${random.between(MIN_CHUNK, MAX_CHUNK)}`;
      const genesis = geneses[index % 10] as PreparedGenesis;
      generateChunk(genesis, key);
      if (index % 7 === 0) sampleRegion(genesis, cell(random.between(-99, 99), 3));
    }
    expect(terrainDigest(generateChunk(DEFAULT, "-7,9"))).toBe(before);
  });

  test("a region's fields do not change with the requests served before it", () => {
    const sample = (rect: CellRect) => terrainValues(sampleRegion(DEFAULT, rect));
    const others = [chunk(0, 0), cell(-1, 3), chunk(MAX_CHUNK, MIN_CHUNK), cell(5, 5)];
    expect(requestHistoryProblems(sample, chunk(-1, -1), others)).toEqual([]);
  });

  test("the history check reports a region that comes back longer, even when the cells it had agree", () => {
    let calls = 0;
    const growing = () => (calls++ === 0 ? [1, 2] : [1, 2, 3]);
    expect(requestHistoryProblems(growing, cell(0, 0), [])).toEqual([
      "2 values before the other requests, 3 after",
    ]);
  });

  test("the history check reports a region that comes back shorter, and each changed cell they share", () => {
    let calls = 0;
    // Cells 0 and 2 change within the 3 values both requests give; cells 3 and 4 are gone.
    const shrinking = () => (calls++ === 0 ? [1, 2, 3, 4, 5] : [7, 2, 8]);
    expect(requestHistoryProblems(shrinking, cell(0, 0), [])).toEqual([
      "5 values before the other requests, 3 after",
      "cell 0: 1 before the other requests, 7 after",
      "cell 2: 3 before the other requests, 8 after",
    ]);
  });

  test("a child process, whose modules start fresh, gives the same digests", async () => {
    const keys = [...KEYS.slice(0, 6), ...CHUNK_KEYS_AT_EDGES];
    const geneses = [defaultGenesis(seedWords(1)), maximumGenesis(seedWords(1))];
    const input: TerrainChildInput = { geneses, keys };
    const child = Bun.spawn([process.execPath, CHILD], {
      cwd: REPO_ROOT,
      stdin: new Blob([JSON.stringify(input)]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(stdout)).toEqual([digestsOf(DEFAULT, keys), digestsOf(MAXIMUM, keys)]);
  });
});

const CHILD = Bun.fileURLToPath(new URL("./support/terrain-child.ts", import.meta.url));
const REPO_ROOT = Bun.fileURLToPath(new URL("../../../", import.meta.url));
const CHUNK_KEYS_AT_EDGES = [
  `${MIN_CHUNK},${MIN_CHUNK}`,
  `${MAX_CHUNK},${MAX_CHUNK}`,
  `${MIN_CHUNK},${MAX_CHUNK}`,
  `${MAX_CHUNK},${MIN_CHUNK}`,
];

describe("seeds (I7)", () => {
  const RECT = { x: -128, y: -128, width: 256, height: 256 };
  /**
   * Deposits with a threshold of 0, which about half the cells pass: deposits cluster, so with the
   * default thresholds one region may hold no cell of a deposit under either seed.
   */
  const withDeposits = (base: Genesis) => ({
    terrain: {
      ...base.terrain,
      deposits: base.terrain.deposits.map((deposit) => ({ ...deposit, threshold: 0 })),
    },
  });
  const ONE_SEED = genesisWith(1, withDeposits);
  const OTHER_SEED = genesisWith(1, (base) => ({
    ...withDeposits(base),
    terrainSeed: [...base.terrainSeed.slice(0, 7), ((base.terrainSeed[7] as number) ^ 1) >>> 0],
  }));

  test("changing one bit of the terrain seed changes every field", () => {
    expect(terrainSeedProblems(samplerOf(ONE_SEED), samplerOf(OTHER_SEED), RECT)).toEqual([]);
  });

  test("the faithful composition of the core equals sampleRegion", () => {
    for (const prepared of [DEFAULT, MAXIMUM]) {
      for (const rect of [RECT, ...CORNERS]) {
        expect(terrainValues(composeTerrain(prepared, FAITHFUL_KEYING)(rect))).toEqual(
          terrainValues(sampleRegion(prepared, rect)),
        );
      }
    }
  });

  /** The problems each property check finds in terrain keyed by `keying`, by check. */
  function problemsOf(keying: TerrainKeying): Record<string, string[]> {
    return {
      terrainSeed: terrainSeedProblems(
        composeTerrain(ONE_SEED, keying),
        composeTerrain(OTHER_SEED, keying),
        RECT,
      ),
    };
  }

  test("the real keying passes the seed check", () => {
    expect(problemsOf(FAITHFUL_KEYING)).toEqual({ terrainSeed: [] });
  });

  test.each(BROKEN_TERRAIN_VARIANTS.map((variant) => [variant.name, variant] as const))(
    "%s is caught by its property check, not by the golden values",
    (_, variant) => {
      const problems = problemsOf(variant.keying);
      expect(Object.keys(problems)).toContain(variant.caughtBy);
      expect(problems[variant.caughtBy]).not.toEqual([]);
    },
  );
});

describe("substrate", () => {
  /** A point of the substrate: its cell and its class. */
  type Point = { readonly x: number; readonly y: number; readonly substrate: number };

  /** The point of each square of `prepared`'s substrate, drawn as terrain.ts documents it. */
  function pointsOf(prepared: PreparedGenesis): (sx: number, sy: number) => Point {
    const genesis = sharedGenesis(prepared);
    const { cell: size, weights } = genesis.terrain.substrate;
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    const key = new ChaCha20Key(genesis.terrainSeed);
    const input = new Uint32Array(4);
    const block = new Uint32Array(16);
    const points = new Map<string, Point>();
    return (sx, sy) => {
      const cached = points.get(`${sx},${sy}`);
      if (cached !== undefined) return cached;
      setLatticeField(input, LATTICE_PURPOSES.substrate, 0);
      setLatticePoint(input, sx, sy);
      key.blockInto(input, block);
      let draw = Math.floor(((block[2] as number) * total) / 2 ** 32);
      let substrate = 0;
      while (draw >= (weights[substrate] as number)) draw -= weights[substrate++] as number;
      const x = sx * size + ((block[0] as number) % size);
      const point = { x, y: sy * size + ((block[1] as number) % size), substrate };
      points.set(`${sx},${sy}`, point);
      return point;
    };
  }

  /**
   * The nearest point among the (2·radius + 1)² squares around a cell's own, as nearestOf finds
   * it: its squared distance, its class, its square's offset from the cell's own as "a,b", and how
   * many points lie at that distance.
   */
  type Nearest = {
    readonly distance: number;
    readonly substrate: number;
    readonly offset: string;
    readonly count: number;
  };

  /**
   * For each cell, the nearest point among the (2·radius + 1)² squares around its own, ties to the
   * lowest square y, then x, and how many points lie at that distance.
   */
  function nearestOf(prepared: PreparedGenesis, radius: number): (x: number, y: number) => Nearest {
    const size = sharedGenesis(prepared).terrain.substrate.cell;
    const pointOf = pointsOf(prepared);
    // The square offsets, row by row: lowest y first, then lowest x.
    const side = 2 * radius + 1;
    const offsets = Array.from({ length: side * side }, (_, index) => [
      (index % side) - radius,
      Math.floor(index / side) - radius,
    ]);
    return (x, y) => {
      const [sx, sy] = [Math.floor(x / size), Math.floor(y / size)];
      let best: Nearest = {
        distance: Number.POSITIVE_INFINITY,
        substrate: -1,
        offset: "",
        count: 0,
      };
      for (const [a, b] of offsets as [number, number][]) {
        const point = pointOf(sx + a, sy + b);
        const distance = (point.x - x) ** 2 + (point.y - y) ** 2;
        if (distance === best.distance) best = { ...best, count: best.count + 1 };
        if (distance < best.distance) {
          best = { distance, substrate: point.substrate, offset: `${a},${b}`, count: 1 };
        }
      }
      return best;
    };
  }

  /**
   * The substrate of `prepared` over `rect` by brute force over (2·radius + 1)² squares, and how
   * many cells have two or more nearest points.
   */
  function bruteForce(prepared: PreparedGenesis, rect: CellRect, radius: number) {
    const nearest = nearestOf(prepared, radius);
    const classes = new Uint8Array(rect.width * rect.height);
    let ties = 0;
    classes.forEach((_, index) => {
      const [column, row] = [index % rect.width, Math.floor(index / rect.width)];
      const found = nearest(rect.x + column, rect.y + row);
      classes[index] = found.substrate;
      if (found.count > 1) ties += 1;
    });
    return { classes, ties };
  }

  /** Geneses with the smallest, the default, and the largest substrate cells. */
  const SIZES = [8, 64, 4096].map((size) =>
    genesisWith(3, (base) => substrateWith(base, { cell: size })),
  );
  const RECTS: readonly CellRect[] = [
    { x: -100, y: -100, width: 200, height: 200 },
    { x: MIN_CELL, y: MIN_CELL, width: 64, height: 64 },
    { x: MAX_CELL - 63, y: MAX_CELL - 63, width: 64, height: 64 },
    { x: MIN_CELL, y: MAX_CELL - 47, width: 48, height: 48 },
  ];

  test("each cell takes the class of its exact nearest point, as a brute force over 9×9 squares finds", () => {
    for (const prepared of SIZES) {
      for (const rect of RECTS) {
        expect(sampleRegion(prepared, rect).substrate).toEqual(
          bruteForce(prepared, rect, 4).classes,
        );
      }
    }
  });

  test("ties are common at the smallest cell, so the comparison above also checks the tie order", () => {
    const [smallest] = SIZES as [PreparedGenesis];
    // About 4% of cells have two or more nearest points when squares are 8 cells wide.
    expect(bruteForce(smallest, RECTS[0] as CellRect, 4).ties).toBeGreaterThan(1000);
  });

  /** The 12 squares 2 squares away from a cell's own that the search covers, as "a,b". */
  const OUTER_SQUARES = [
    ["-1,-2", "0,-2", "1,-2"],
    ["-2,-1", "2,-1", "-2,0", "2,0", "-2,1", "2,1"],
    ["-1,2", "0,2", "1,2"],
  ].flat();

  /**
   * Cells of the smallest-cell genesis whose nearest point lies 2 squares away, strictly nearer
   * than every point of the 3×3 squares around their own, with that point's square offset, as a
   * scan with the documented draw found them: a 3×3 search misses the nearest point of about 4
   * cells in 10^7 at this size, so random regions almost never reach one. The first 26 rows are
   * every such cell within 4,000 cells of the origin on each axis, and they reach 8 of the 12 outer
   * squares; the last 4, from a scan out to 11,000 cells, reach the other 4.
   */
  const BEYOND_3X3 = [
    [-2032, -3897, "-2,1"],
    [-2265, -3696, "0,-2"],
    [1296, -3433, "-2,0"],
    [-1272, -2801, "-2,0"],
    [3464, -2585, "-2,0"],
    [-896, -2497, "-2,1"],
    [600, -1823, "-2,0"],
    [2311, -1664, "1,-2"],
    [2312, -1664, "0,-2"],
    [1336, -1633, "0,2"],
    [-1569, -865, "0,2"],
    [3417, -841, "0,2"],
    [1983, -801, "2,1"],
    [-3289, -112, "0,-2"],
    [2752, -9, "0,2"],
    [935, 350, "2,0"],
    [-233, 496, "1,-2"],
    [1143, 856, "2,0"],
    [1143, 857, "2,0"],
    [-1416, 1040, "-1,-2"],
    [1911, 1463, "2,0"],
    [-3319, 1671, "0,2"],
    [3775, 2232, "1,-2"],
    [-768, 2895, "0,2"],
    [2502, 3032, "0,-2"],
    [-88, 3256, "-2,0"],
    [9271, 56, "2,-1"],
    [10744, 1080, "-2,-1"],
    [8607, 2767, "1,2"],
    [-10528, -9609, "-1,2"],
  ] as const;

  test("where the nearest point lies 2 squares away, beyond a 3×3 search, the cell still takes its class", () => {
    const [smallest] = SIZES as [PreparedGenesis];
    const exact = nearestOf(smallest, 4);
    const narrow = nearestOf(smallest, 1);
    const differing = new Set<string>();
    for (const [x, y, offset] of BEYOND_3X3) {
      expect(exact(x, y).offset).toBe(offset);
      expect(sampleRegion(smallest, cell(x, y)).substrate[0]).toBe(exact(x, y).substrate);
      if (narrow(x, y).substrate !== exact(x, y).substrate) differing.add(offset);
    }
    // For each of the 12 outer squares, a cell whose class a 3×3 search gets wrong.
    expect([...differing].sort()).toEqual([...OUTER_SQUARES].sort());
  });

  test("classes follow the weights: [5, 3, 2, 1] gives each its share of the cells within 0.03", () => {
    const prepared = genesisWith(4, (base) => substrateWith(base, { cell: 8 }));
    const counts = [0, 0, 0, 0];
    for (const x of [-512, 0, 4096, -9000]) {
      const region = sampleRegion(prepared, { x, y: x, width: 256, height: 256 });
      for (const substrate of region.substrate) counts[substrate] = (counts[substrate] ?? 0) + 1;
    }
    const cells = 4 * 256 * 256;
    [5, 3, 2, 1].forEach((weight, substrate) => {
      expect(Math.abs((counts[substrate] as number) / cells - weight / 11)).toBeLessThan(0.03);
    });
  });

  test("a single class covers every cell", () => {
    const single = genesisWith(1, (base) => substrateWith(base, { weights: [7] }));
    expect(sampleRegion(single, chunk(3, -3)).substrate.every((value) => value === 0)).toBe(true);
  });
});

/** The little-endian word of the 4 bytes of `bytes` from `at`, missing bytes read as 0. */
function wordAt(bytes: ArrayLike<number>, at: number): number {
  const byte = (offset: number) => bytes[at + offset] ?? 0;
  return byte(0) + 256 * (byte(1) + 256 * (byte(2) + 256 * byte(3)));
}

/** The digest of `chunk` from the documented word layout, written here independently. */
function documentedDigest(chunk: TerrainChunk): string {
  const words: number[] = [];
  const text = (value: string) => {
    const bytes = new TextEncoder().encode(value);
    words.push(bytes.length);
    for (let at = 0; at < bytes.length; at += 4) words.push(wordAt(bytes, at));
  };
  text("terrain");
  text(WORLDGEN_VERSION);
  const [x, y] = chunk.key.split(",").map(Number) as [number, number];
  words.push(x, y, ...chunk.elevation);
  for (let at = 0; at < chunk.substrate.length; at += 4) words.push(wordAt(chunk.substrate, at));
  words.push(...chunk.thermalBase, chunk.deposits.length);
  for (const field of chunk.deposits) words.push(...field);
  const bytes = new Uint8Array(4 * words.length);
  const view = new DataView(bytes.buffer);
  for (const [index, word] of words.entries()) view.setUint32(4 * index, word >>> 0, true);
  return hexOf(murmur3x86_128(bytes, 0));
}

describe("terrainDigest", () => {
  test("hashes the documented little-endian word layout with MurmurHash3 x86_128", () => {
    for (const key of ["0,0", "-1,-1", ...CHUNK_KEYS_AT_EDGES]) {
      for (const prepared of [DEFAULT, MAXIMUM]) {
        const generated = generateChunk(prepared, key);
        expect(terrainDigest(generated)).toBe(documentedDigest(generated));
      }
    }
  });

  test("changes with each field, with the key, and with the number of deposits", () => {
    const generated = generateChunk(DEFAULT, "2,3");
    const original = terrainDigest(generated);
    const changed = (change: (copy: TerrainChunk) => TerrainChunk) =>
      terrainDigest(change({ ...generated }));
    const bump = <T extends Int32Array | Uint8Array>(values: T, index: number): T => {
      const copy = values.slice() as T;
      copy[index] = (copy[index] as number) + 1;
      return copy;
    };
    const digests = [
      changed((copy) => ({ ...copy, key: "3,2" })),
      changed((copy) => ({ ...copy, elevation: bump(copy.elevation, 1023) })),
      changed((copy) => ({ ...copy, substrate: bump(copy.substrate, 0) })),
      changed((copy) => ({ ...copy, thermalBase: bump(copy.thermalBase, 500) })),
      changed((copy) => ({ ...copy, deposits: [bump(copy.deposits[0] as Int32Array, 7)] })),
      changed((copy) => ({ ...copy, deposits: copy.deposits.slice(0, 1) })),
      changed((copy) => ({ ...copy, deposits: [...copy.deposits, new Int32Array(1024)] })),
    ];
    expect(new Set([original, ...digests]).size).toBe(digests.length + 1);
  });

  test("depends only on the chunk: equal chunks of different calls give equal digests", () => {
    expect(terrainDigest(generateChunk(DEFAULT, "4,4"))).toBe(
      terrainDigest(generateChunk(DEFAULT, "4,4")),
    );
  });
});

describe("validation", () => {
  const NOT_PREPARED = {
    path: "/prepared",
    message: "the value is not a prepared genesis: prepareGenesis makes them",
  };

  test("sampleRegion throws invalid_value with every problem of the prepared genesis and the rect", () => {
    const error = engineErrorOf(() =>
      sampleRegion(
        {} as PreparedGenesis,
        {
          x: MAX_CELL + 1,
          y: "0",
          width: 0,
          height: 257,
        } as unknown as CellRect,
      ),
    );
    expect(error.code).toBe("invalid_value");
    expect(error.issues).toEqual([
      NOT_PREPARED,
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

  test("sampleRegion rejects a region whose last cell lies outside the world, and a rect that is not a record", () => {
    const outside = engineErrorOf(() =>
      sampleRegion(DEFAULT, { x: MAX_CELL, y: MIN_CELL, width: 2, height: 1 }),
    );
    expect(outside.issues).toEqual([
      {
        path: "/rect/width",
        message:
          "the region ends at the cell 2147483648, outside the world: cell coordinates lie from -2147483648 to 2147483647",
      },
    ]);
    const shape = engineErrorOf(() => sampleRegion(DEFAULT, [] as unknown as CellRect));
    expect(shape.issues).toEqual([
      { path: "/rect", message: "the region must be a record { x, y, width, height }" },
    ]);
  });

  test("generateChunk throws invalid_value with every problem of the prepared genesis and the key", () => {
    const error = engineErrorOf(() =>
      generateChunk({} as PreparedGenesis, `${MAX_CHUNK + 1},${MIN_CHUNK - 1}`),
    );
    expect(error.code).toBe("invalid_value");
    expect(error.issues).toEqual([
      NOT_PREPARED,
      {
        path: "/key",
        message:
          "the x of the chunk key, 67108864, is outside the world: chunk coordinates lie from -67108864 to 67108863",
      },
      {
        path: "/key",
        message:
          "the y of the chunk key, -67108865, is outside the world: chunk coordinates lie from -67108864 to 67108863",
      },
    ]);
    expect(engineErrorOf(() => generateChunk(DEFAULT, "1,a")).issues).toEqual([
      {
        path: "/key",
        message: "the y of the chunk key is not a safe integer in canonical decimal",
      },
    ]);
    expect(engineErrorOf(() => generateChunk(DEFAULT, 5 as unknown as string)).issues).toEqual([
      { path: "/key", message: "the chunk key must be a string, not number" },
    ]);
  });

  test("terrainDigest throws invalid_value with every problem of the chunk", () => {
    const generated = generateChunk(DEFAULT, "0,0");
    const error = engineErrorOf(() =>
      terrainDigest({
        key: "0,67108864",
        elevation: new Int32Array(1023),
        substrate: new Int8Array(1024),
        thermalBase: Array.from({ length: 1024 }, () => 0),
        deposits: [generated.elevation, new Uint32Array(1024)],
      } as unknown as TerrainChunk),
    );
    expect(error.code).toBe("invalid_value");
    expect(error.issues).toEqual([
      {
        path: "/key",
        message:
          "the y of the chunk key, 67108864, is outside the world: chunk coordinates lie from -67108864 to 67108863",
      },
      { path: "/elevation", message: "the field must be an Int32Array of 1024 cells" },
      { path: "/substrate", message: "the field must be a Uint8Array of 1024 cells" },
      { path: "/thermalBase", message: "the field must be an Int32Array of 1024 cells" },
      { path: "/deposits/1", message: "the field must be an Int32Array of 1024 cells" },
    ]);
  });

  test("terrainDigest rejects a value that is not a record, too many deposits, and accessors, without running them", () => {
    expect(engineErrorOf(() => terrainDigest(null as unknown as TerrainChunk)).issues).toEqual([
      {
        path: "",
        message: "the chunk must be a record { key, elevation, substrate, thermalBase, deposits }",
      },
    ]);
    const generated = generateChunk(genesisWith(1), "0,0");
    const nine = Array.from({ length: 9 }, () => new Int32Array(1024));
    expect(engineErrorOf(() => terrainDigest({ ...generated, deposits: nine })).issues).toEqual([
      { path: "/deposits", message: "the deposits must be an array of at most 8 fields" },
    ]);
    let ran = false;
    const accessor = Object.defineProperty({ ...generated }, "elevation", {
      enumerable: true,
      get: () => {
        ran = true;
        return generated.elevation;
      },
    });
    const issues = engineErrorOf(() => terrainDigest(accessor)).issues;
    expect(issues.map((issue) => issue.path)).toEqual(["/elevation"]);
    expect(ran).toBe(false);
  });
});

describe("golden values (worldgen@1)", () => {
  const GENESES = {
    default: (seed: readonly number[]) => prepareGenesis(defaultGenesis(seed)),
    maximum: (seed: readonly number[]) => prepareGenesis(maximumGenesis(seed)),
  } as const;

  /** The keys of the golden region's chunks, row by row. */
  const REGION_KEYS = Array.from({ length: 256 }, (_, index) => {
    const { first, side } = GOLDEN_WORLDGEN.regionChunks;
    return `${first + (index % side)},${first + Math.floor(index / side)}`;
  });

  test("pin the generator version", () => {
    expect(WORLDGEN_VERSION).toBe(GOLDEN_WORLDGEN.version);
  });

  test.each(["default", "maximum"] as const)("pin the chunk digests of the %s genesis", (name) => {
    const actual = GOLDEN_WORLDGEN.seeds.map((seed) =>
      digestsOf(GENESES[name](seed), GOLDEN_WORLDGEN.chunks),
    );
    expect(actual).toEqual(GOLDEN_WORLDGEN.digests[name].map((digests) => [...digests]));
  });

  /**
   * What the golden chunks and regions cover, pooled over every seed, for the non-vacuity checks:
   * the substrate classes, the elevation range, the cells at or below and above the level, each
   * deposit's nonzero cells, and, over the cells above the level, the correlation of thermalBase
   * with elevation, by Welford's method, which stays exact enough at the maximum genesis's scale.
   */
  class Coverage {
    readonly classes = new Set<number>();
    low = Number.POSITIVE_INFINITY;
    high = Number.NEGATIVE_INFINITY;
    cells = 0;
    below = 0;
    above = 0;
    nonzero: number[] = [];
    #mean = [0, 0];
    #moments = [0, 0, 0];

    add(generated: TerrainChunk, level: number): void {
      this.cells += generated.elevation.length;
      generated.elevation.forEach((e, index) => {
        this.classes.add(generated.substrate[index] as number);
        [this.low, this.high] = [Math.min(this.low, e), Math.max(this.high, e)];
        if (e > level) this.#pair(e, generated.thermalBase[index] as number);
        else this.below += 1;
        generated.deposits.forEach((field, k) => {
          this.nonzero[k] = (this.nonzero[k] ?? 0) + (field[index] === 0 ? 0 : 1);
        });
      });
    }

    #pair(x: number, y: number): void {
      this.above += 1;
      const [mx, my] = this.#mean as [number, number];
      const [dx, dy] = [x - mx, y - my];
      this.#mean = [mx + dx / this.above, my + dy / this.above];
      const [sxx, syy, sxy] = this.#moments as [number, number, number];
      const [ex, ey] = [x - (this.#mean[0] as number), y - (this.#mean[1] as number)];
      this.#moments = [sxx + dx * ex, syy + dy * ey, sxy + dx * ey];
    }

    /** The Pearson correlation of thermalBase with elevation above the level. */
    get correlation(): number {
      const [sxx, syy, sxy] = this.#moments as [number, number, number];
      return sxy / Math.sqrt(sxx * syy);
    }
  }

  type Golden = {
    readonly regions: string[];
    /** Every golden chunk and region chunk of every seed. */
    readonly coverage: Coverage;
    /** The region chunks of every seed. */
    readonly region: Coverage;
  };

  /** The region digest of each seed of `name`, and what the golden chunks cover; once. */
  const goldens = new Map<string, Golden>();
  function goldenOf(name: keyof typeof GENESES): Golden {
    const cached = goldens.get(name);
    if (cached !== undefined) return cached;
    const [coverage, region] = [new Coverage(), new Coverage()];
    const regions = GOLDEN_WORLDGEN.seeds.map((seed) => {
      const prepared = GENESES[name](seed);
      const level = liquidLevel(sharedGenesis(prepared));
      const cover = (key: string, inRegion: boolean) => {
        const generated = generateChunk(prepared, key);
        coverage.add(generated, level);
        if (inRegion) region.add(generated, level);
        return terrainDigest(generated);
      };
      for (const key of GOLDEN_WORLDGEN.chunks) cover(key, false);
      return digest(REGION_KEYS.map((key) => cover(key, true)));
    });
    const golden = { regions, coverage, region };
    goldens.set(name, golden);
    return golden;
  }

  test.each(["default", "maximum"] as const)(
    "pin the 16×16-chunk region digest of the %s genesis",
    (name) => {
      expect(goldenOf(name).regions).toEqual([...GOLDEN_WORLDGEN.regions[name]]);
    },
  );

  test.each(["default", "maximum"] as const)(
    "are not vacuous for the %s genesis: liquid above and below, wide relief, deposits, a thermal lapse",
    (name) => {
      const { coverage } = goldenOf(name);
      const amplitude = sharedGenesis(GENESES[name](seedWords(1))).terrain.relief.amplitude;
      expect(coverage.below).toBeGreaterThan(0);
      expect(coverage.above).toBeGreaterThan(0);
      expect(coverage.high - coverage.low).toBeGreaterThan(amplitude);
      expect(coverage.nonzero[0]).toBeGreaterThan(0);
      expect(coverage.correlation).toBeGreaterThan(0.5);
    },
  );

  test("hold all 4 substrate classes of the default genesis in its region, and 13 of the maximum's 16", () => {
    expect(defaultGenesis(seedWords(1)).terrain.substrate.weights).toHaveLength(4);
    expect(goldenOf("default").region.classes.size).toBe(4);
    expect(maximumGenesis(seedWords(1)).terrain.substrate.weights).toHaveLength(16);
    expect(goldenOf("maximum").coverage.classes.size).toBe(13);
  });

  test("each default deposit covers at least 1% of the region's cells, pooled over the seeds", () => {
    const { region } = goldenOf("default");
    expect(region.cells).toBe(GOLDEN_WORLDGEN.seeds.length * 256 * 1024);
    expect(region.nonzero).toHaveLength(2);
    for (const count of region.nonzero) expect(count / region.cells).toBeGreaterThanOrEqual(0.01);
  });
});
