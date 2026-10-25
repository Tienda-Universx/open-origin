import { describe, expect, test } from "bun:test";
import { copyCanonical } from "../src/canonical/copy.ts";
import { type Issue, IssueList } from "../src/errors.ts";
import { createWorld, step } from "../src/index.ts";
import {
  CURVE_SCALE,
  dayCurve,
  dayPosition,
  diurnal,
  type Instant,
  radiance,
  readInstant,
} from "../src/worldgen/calendar.ts";
import {
  defaultGenesis,
  type Genesis,
  genesisIssues,
  lightPeriod,
  type PreparedGenesis,
  prepareGenesis,
  sharedGenesis,
} from "../src/worldgen/genesis.ts";
import { LATTICE_PURPOSES } from "../src/worldgen/lattice.ts";
import { noiseBound } from "../src/worldgen/noise.ts";
import {
  type Observable,
  type ObservableQuery,
  observableCatalog,
  observe,
} from "../src/worldgen/observables.ts";
import { type CellCoord, MAX_CELL, MIN_CELL, readCell } from "../src/worldgen/space.ts";
import {
  liquidLevel,
  sampleRegion,
  type TerrainRegion,
  THERMAL_NOISE,
} from "../src/worldgen/terrain.ts";
import { WORLDGEN_VERSION } from "../src/worldgen/version.ts";
import { GOLDEN_OBSERVATIONS } from "./fixtures/golden-observations.ts";
import { GOLDEN_WORLDGEN, maximumGenesis } from "./fixtures/golden-worldgen.ts";
import { engineErrorOf } from "./support/engine-error.ts";
import { revokedProxy } from "./support/revoked.ts";
import { Sfc32 } from "./support/sfc32.ts";
import { stepRuleset, system } from "./support/step-rulesets.ts";

/**
 * Primitive observables (ADR 0021, primitive observables; plan §6.2, §7, §12 tests 19 and 20,
 * invariants I5, I6, and I9): the catalog, the permanent layer of the static ids, the temporal
 * layer of the time ids, every observable within its catalog range, the validation of observe,
 * and the golden observation values of worldgen@1.
 */

const MAX = Number.MAX_SAFE_INTEGER;
const NOT_PREPARED = "the value is not a prepared genesis: prepareGenesis makes them";
const NOT_QUERY = "the query must be a record { id, cell, instant }";
const NOT_ID =
  "the id must be a string that names an observable: elevation, liquid.depth, substrate, thermal, radiance, or deposit.<k> for a deposit k of the genesis";
const ACCESSOR = "the property is an accessor: only data properties are read";

const GOLDEN_SEED = GOLDEN_WORLDGEN.seeds[GOLDEN_OBSERVATIONS.seedIndex] as readonly number[];
const DEFAULT_GENESIS = defaultGenesis(GOLDEN_SEED);
const DEFAULT = prepareGenesis(DEFAULT_GENESIS);
const MAXIMUM = prepareGenesis(maximumGenesis(GOLDEN_SEED));

/** The instant of `tick` at `simSecondsPerTick` seconds per tick. */
function at(tick: number, simSecondsPerTick = 12): Instant {
  return { tick, simSecondsPerTick };
}

/** The ids of the catalog of `prepared`, in order. */
function idsOf(prepared: PreparedGenesis): string[] {
  return observableCatalog(prepared).map(({ id }) => id);
}

/** The permanent fields of the cell `cell` of `prepared`: its 1×1 region. */
function terrainAt(prepared: PreparedGenesis, cell: CellCoord): TerrainRegion {
  return sampleRegion(prepared, { x: cell.x, y: cell.y, width: 1, height: 1 });
}

/**
 * The value of each static id at `cell` by its definition: the terrain field, or for liquid.depth
 * max(0, L − elevation).
 */
function staticValues(prepared: PreparedGenesis, genesis: Genesis, cell: CellCoord) {
  const region = terrainAt(prepared, cell);
  const elevation = region.elevation[0] as number;
  const values: Record<string, number> = {
    elevation,
    "liquid.depth": Math.max(0, liquidLevel(genesis) - elevation),
    substrate: region.substrate[0] as number,
  };
  region.deposits.forEach((field, k) => {
    values[`deposit.${k}`] = field[0] as number;
  });
  return values;
}

/** A random cell, at the edge of the world on each axis one time in four. */
function randomCell(random: Sfc32): CellCoord {
  const axis = () =>
    random.below(4) === 0 ? random.pick([MIN_CELL, MAX_CELL]) : random.between(MIN_CELL, MAX_CELL);
  return { x: axis(), y: axis() };
}

/** A random valid instant, within 100,000 ticks of the last safe tick one time in four. */
function randomInstant(random: Sfc32): Instant {
  const simSecondsPerTick = random.pick([1, 7, 12, 13, random.between(1, 100_000)]);
  const last = Math.floor(MAX / simSecondsPerTick);
  const tick = random.below(4) === 0 ? last - random.below(100_000) : random.below(2 ** 32);
  return at(tick, simSecondsPerTick);
}

/**
 * A random valid genesis, with the ends of each bound favored, time laws included. Its lapse is
 * drawn up to the steepest the genesis accepts, |num| × amplitude ≤ 2^28 × den.
 */
function randomGenesis(random: Sfc32): Genesis {
  const octaves = random.between(1, 12);
  const amplitude = random.pick([1, 2, 60_000, 2 ** 29, random.between(1, 2 ** 29)]);
  const den = random.pick([1, 1000, 2 ** 20, random.between(1, 2 ** 20)]);
  const steepest = Math.min(2 ** 20, Math.floor((2 ** 28 * den) / amplitude));
  // 0 − steepest, not −steepest, which is −0 for 0: a genesis refuses −0.
  const num = random.pick([0, steepest, 0 - steepest, random.between(0 - steepest, steepest)]);
  const peak = random.pick([1, 2 ** 20, random.between(1, 2 ** 20)]);
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
      // A day of 1,000 seconds or more has a light period of at least one second at any daylight.
      day: {
        length: random.pick([1000, 75_600, 2 ** 36, random.between(1000, 2 ** 32)]),
        daylight: random.pick([1, 999, random.between(1, 999)]),
      },
      liquid: { level: random.pick([100, 900, random.between(100, 900)]) },
      thermal: {
        base: random.pick([-(2 ** 20), 2 ** 20, random.between(-(2 ** 20), 2 ** 20)]),
        spread: random.pick([0, 1, 2 ** 20, random.between(0, 2 ** 20)]),
        lapse: { num, den },
        diurnal: random.pick([0, 2 ** 20, random.between(0, 2 ** 20)]),
      },
      radiance: { peak, night: random.pick([0, peak, random.between(0, peak)]) },
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

/** The default genesis around the golden seed with other deposits. */
function withDeposits(deposits: Genesis["terrain"]["deposits"]): PreparedGenesis {
  return prepareGenesis({
    ...DEFAULT_GENESIS,
    terrain: { ...DEFAULT_GENESIS.terrain, deposits },
  });
}

const A_DEPOSIT = { wavelength: 256, octaves: 3, threshold: 300, peak: 77 };

/** Cells around the origin and at the corners and edges of the world. */
const CELLS: readonly CellCoord[] = [
  { x: 0, y: 0 },
  { x: -1, y: -1 },
  { x: -3584, y: 0 },
  { x: MIN_CELL, y: MIN_CELL },
  { x: MAX_CELL, y: MAX_CELL },
  { x: MIN_CELL, y: MAX_CELL },
  { x: MAX_CELL, y: MIN_CELL },
  { x: 12_345, y: -678_901 },
];

/**
 * Instants of the default day and far beyond it: dawn, a quarter of the light period, mid-light
 * exactly (at 7 seconds per tick), the last tick before dusk and the first after it, deep night,
 * the dawn of day 1, the last safe tick, and a far tick at 1 second per tick.
 */
const INSTANTS: readonly Instant[] = [
  at(0),
  at(867),
  at(2970, 7),
  at(3464),
  at(3465),
  at(5000),
  at(6300),
  at(Math.floor(MAX / 12)),
  at(123_456_789_012, 1),
];

describe("the catalog", () => {
  test("is pinned for the default genesis: ids, dimensions, units, kinds, variation, exposure, ranges", () => {
    expect(observableCatalog(DEFAULT)).toEqual([
      {
        id: "elevation",
        dimension: "length",
        unit: "len",
        kind: "quantity",
        varies: "static",
        exposure: "surface",
        range: { min: -181_080, max: 181_080 },
      },
      {
        id: "liquid.depth",
        dimension: "length",
        unit: "len",
        kind: "quantity",
        varies: "static",
        exposure: "surface",
        range: { min: 0, max: 175_080 },
      },
      {
        id: "substrate",
        dimension: "category",
        kind: "category",
        varies: "static",
        exposure: "surface",
        range: { min: 0, max: 3 },
      },
      {
        id: "thermal",
        dimension: "thermal",
        unit: "tu",
        kind: "quantity",
        varies: "time",
        exposure: "measurement",
        range: { min: 79, max: 1342 },
      },
      {
        id: "radiance",
        dimension: "radiant",
        unit: "ru",
        kind: "quantity",
        varies: "time",
        exposure: "surface",
        range: { min: 40, max: 1000 },
      },
      {
        id: "deposit.0",
        dimension: "amount",
        unit: "qu",
        kind: "quantity",
        varies: "static",
        exposure: "measurement",
        range: { min: 0, max: 1000 },
      },
      {
        id: "deposit.1",
        dimension: "amount",
        unit: "qu",
        kind: "quantity",
        varies: "static",
        exposure: "measurement",
        range: { min: 0, max: 1000 },
      },
    ]);
  });

  test("entries hold only engineering fields, and a category has no unit", () => {
    const catalog = observableCatalog(MAXIMUM);
    expect(catalog).toHaveLength(5 + 8);
    for (const entry of catalog) {
      const fields = ["id", "dimension", "kind", "varies", "exposure", "range"];
      const expected = entry.kind === "category" ? fields : [...fields, "unit"];
      expect(Object.keys(entry).sort()).toEqual(expected.sort());
      expect(Object.keys(entry.range).sort()).toEqual(["max", "min"]);
    }
  });

  test("is frozen at every level", () => {
    const catalog = observableCatalog(DEFAULT);
    expect(Object.isFrozen(catalog)).toBe(true);
    for (const entry of catalog) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.range)).toBe(true);
    }
  });

  test("is a canonical value, so a projection can carry it", () => {
    const catalog = observableCatalog(MAXIMUM);
    expect(catalog).toHaveLength(5 + 8);
    expect(copyCanonical(catalog)).toEqual(catalog);
  });

  test("lists exactly the genesis's deposits, one id each, in their order, with their peaks", () => {
    const fixed = ["elevation", "liquid.depth", "substrate", "thermal", "radiance"];
    expect(idsOf(withDeposits([]))).toEqual(fixed);
    expect(idsOf(withDeposits([A_DEPOSIT]))).toEqual([...fixed, "deposit.0"]);
    const eight = Array.from({ length: 8 }, (_, k) => ({ ...A_DEPOSIT, peak: k + 1 }));
    const catalog = observableCatalog(withDeposits(eight));
    expect(catalog.map(({ id }) => id)).toEqual([...fixed, ...eight.map((_, k) => `deposit.${k}`)]);
    expect(catalog.slice(fixed.length).map(({ range }) => range.max)).toEqual(
      eight.map(({ peak }) => peak),
    );
  });

  test("does not depend on the terrain seed", () => {
    const [first, second, third] = GOLDEN_WORLDGEN.seeds.map((seed) =>
      observableCatalog(prepareGenesis(maximumGenesis(seed))),
    );
    expect(first).toHaveLength(5 + 8);
    expect(second).toEqual(first as readonly Observable[]);
    expect(third).toEqual(first as readonly Observable[]);
  });

  test("rejects a forged prepared genesis at /prepared", () => {
    for (const forged of [Object.create(DEFAULT), {}, null]) {
      const error = engineErrorOf(() => observableCatalog(forged as PreparedGenesis));
      expect(error.code).toBe("invalid_value");
      expect(error.issues).toEqual([{ path: "/prepared", message: NOT_PREPARED }]);
    }
  });
});

describe("the permanent layer (plan test 19, I9)", () => {
  test("each static id gives the same value at every instant, its terrain field or formula", () => {
    for (const genesis of [DEFAULT_GENESIS, maximumGenesis(GOLDEN_SEED)]) {
      const prepared = prepareGenesis(genesis);
      const statics = observableCatalog(prepared).filter(({ varies }) => varies === "static");
      expect(statics.length).toBe(3 + genesis.terrain.deposits.length);
      for (const cell of CELLS) {
        const expected = staticValues(prepared, genesis, cell);
        for (const { id } of statics) {
          const values = INSTANTS.map((instant) => observe(prepared, { id, cell, instant }));
          expect(values).toEqual(INSTANTS.map(() => expected[id] as number));
        }
      }
    }
  });

  test("the goldens include cells under and above the liquid, and a cell of each deposit", () => {
    const depths = GOLDEN_OBSERVATIONS.rows.map(({ values }) => values["liquid.depth"]);
    expect(depths.some((depth) => depth > 0)).toBe(true);
    expect(depths.some((depth) => depth === 0)).toBe(true);
    for (const id of ["deposit.0", "deposit.1"] as const) {
      expect(GOLDEN_OBSERVATIONS.rows.some(({ values }) => values[id] > 0)).toBe(true);
    }
  });
});

describe("the temporal layer (plan test 20, I9)", () => {
  test("thermal − thermalBase is diurnal(t), at random cells and instants", () => {
    const random = new Sfc32(0x7e47);
    for (const prepared of [DEFAULT, MAXIMUM]) {
      for (let round = 0; round < 60; round += 1) {
        const cell = randomCell(random);
        const instant = randomInstant(random);
        const thermal = observe(prepared, { id: "thermal", cell, instant });
        const thermalBase = terrainAt(prepared, cell).thermalBase[0] as number;
        expect(thermal - thermalBase).toBe(diurnal(prepared, instant));
      }
    }
  });

  test("radiance is the same at every cell, radiance(t), at random instants", () => {
    const random = new Sfc32(0x2ad1);
    for (let round = 0; round < 60; round += 1) {
      const instant = randomInstant(random);
      const cells = [...CELLS, randomCell(random), randomCell(random)];
      const values = cells.map((cell) => observe(DEFAULT, { id: "radiance", cell, instant }));
      expect(values).toEqual(cells.map(() => radiance(DEFAULT, instant)));
    }
  });

  test("each entry's varies matches its behavior, and each time id changes within one day", () => {
    // Day 0 of the default laws lasts 6,300 ticks of 12 seconds.
    const day = Array.from({ length: 64 }, (_, index) => at(index * 100));
    const catalog = observableCatalog(DEFAULT);
    expect(catalog.filter(({ varies }) => varies === "time").map(({ id }) => id)).toEqual([
      "thermal",
      "radiance",
    ]);
    for (const cell of CELLS) {
      for (const { id, varies } of catalog) {
        const values = day.map((instant) => observe(DEFAULT, { id, cell, instant }));
        expect({ id, changes: new Set(values).size > 1 }).toEqual({
          id,
          changes: varies === "time",
        });
      }
    }
  });
});

/** The documented catalog ranges of `genesis` by id, recomputed in BigInt from the bounds. */
function documentedRanges(genesis: Genesis): Record<string, readonly [number, number]> {
  const relief = BigInt(
    noiseBound({ purpose: LATTICE_PURPOSES.elevation, ...genesis.terrain.relief }),
  );
  const amplitude = BigInt(genesis.terrain.relief.amplitude);
  const scaled = amplitude * BigInt(2 * genesis.laws.liquid.level - 1000);
  // ⌊scaled / 1000⌋, rounding toward negative infinity.
  const level = scaled / 1000n - (scaled % 1000n < 0n ? 1n : 0n);
  const { base, spread, lapse, diurnal: swing } = genesis.laws.thermal;
  const noise =
    spread === 0
      ? 0n
      : BigInt(
          noiseBound({ purpose: LATTICE_PURPOSES.thermal, ...THERMAL_NOISE, amplitude: spread }),
        );
  const product = BigInt(lapse.num) * (relief - level);
  const den = BigInt(lapse.den);
  const steepest = product / den - (product % den < 0n ? 1n : 0n);
  const low = BigInt(base) - noise + (steepest < 0n ? steepest : 0n);
  const high = BigInt(base) + noise + (steepest > 0n ? steepest : 0n) + BigInt(swing);
  const ranges: Record<string, readonly [number, number]> = {
    elevation: [-Number(relief), Number(relief)],
    "liquid.depth": [0, Number(level + relief)],
    substrate: [0, genesis.terrain.substrate.weights.length - 1],
    thermal: [Number(low), Number(high)],
    radiance: [genesis.laws.radiance.night, genesis.laws.radiance.peak],
  };
  genesis.terrain.deposits.forEach((deposit, k) => {
    ranges[`deposit.${k}`] = [0, deposit.peak];
  });
  return ranges;
}

/**
 * The observations of `prepared` at `cell` and `instant` outside their catalog ranges, and a
 * problem when the catalog lacks one of the genesis's ids, so an empty catalog never passes.
 */
function outOfRange(prepared: PreparedGenesis, cell: CellCoord, instant: Instant): string[] {
  const catalog = observableCatalog(prepared);
  const ids = Object.keys(documentedRanges(sharedGenesis(prepared)));
  const missing = catalog.length === ids.length ? [] : [`the catalog has ${catalog.length} ids`];
  return missing.concat(
    catalog.flatMap(({ id, range }) => {
      const value = observe(prepared, { id, cell, instant });
      return value >= range.min && value <= range.max
        ? []
        : [`${id} at ${cell.x},${cell.y}: ${value} outside [${range.min}, ${range.max}]`];
    }),
  );
}

describe("ranges (I6)", () => {
  test("every observable stays within its catalog range under a fuzz of valid geneses and instants", () => {
    const random = new Sfc32(0x16a6);
    for (let round = 0; round < 60; round += 1) {
      const genesis = randomGenesis(random);
      expect(genesisIssues(genesis)).toEqual([]);
      const prepared = prepareGenesis(genesis);
      for (let probe = 0; probe < 4; probe += 1) {
        expect(outOfRange(prepared, randomCell(random), randomInstant(random))).toEqual([]);
      }
    }
  });

  test("the maximum genesis stays in range at every corner and instant", () => {
    for (const cell of CELLS) {
      for (const instant of INSTANTS) expect(outOfRange(MAXIMUM, cell, instant)).toEqual([]);
    }
  });

  test("each range is its documented derivation from the bounds, in safe integers", () => {
    const random = new Sfc32(0x2a9e);
    const geneses = [DEFAULT_GENESIS, maximumGenesis(GOLDEN_SEED)];
    for (let round = 0; round < 200; round += 1) geneses.push(randomGenesis(random));
    for (const genesis of geneses) {
      const catalog = observableCatalog(prepareGenesis(genesis));
      const ranges = Object.fromEntries(
        catalog.map(({ id, range }) => [id, [range.min, range.max] as const]),
      );
      expect(ranges).toEqual(documentedRanges(genesis));
      for (const { range } of catalog) {
        expect(Number.isSafeInteger(range.min) && Number.isSafeInteger(range.max)).toBe(true);
        expect(range.min).toBeLessThanOrEqual(range.max);
      }
    }
  });
});

/** The issues `read` reports to a fresh list. */
function issuesOf(read: (sink: IssueList) => unknown): Issue[] {
  const sink = new IssueList();
  read(sink);
  return sink.issues;
}

/** The issues observe reports for `query` under `prepared`. */
function observeIssues(prepared: unknown, query: unknown): readonly Issue[] {
  const error = engineErrorOf(() => observe(prepared as PreparedGenesis, query as ObservableQuery));
  expect(error.code).toBe("invalid_value");
  return error.issues;
}

const CELL = { x: 3, y: -4 };
const INSTANT = at(867);

describe("validation", () => {
  test("reports every problem at once, with its exact path", () => {
    const cell = { x: 2 ** 31, y: 1.5 };
    const instant = { tick: -1, simSecondsPerTick: 0 };
    const issues = observeIssues(Object.create(DEFAULT), { id: "nope", cell, instant });
    expect(issues.map(({ path }) => path)).toEqual([
      "/prepared",
      "/query/id",
      "/query/cell/x",
      "/query/cell/y",
      "/query/instant/tick",
      "/query/instant/simSecondsPerTick",
    ]);
    expect(issues).toEqual([
      { path: "/prepared", message: NOT_PREPARED },
      { path: "/query/id", message: NOT_ID },
      ...issuesOf((sink) => readCell(cell, "/query/cell", sink)),
      ...issuesOf((sink) => readInstant(instant, "/query/instant", sink)),
    ]);
  });

  test("rejects an id that names no observable", () => {
    const ids: unknown[] = [
      "",
      "Elevation",
      " elevation",
      "thermalBase",
      "diurnal",
      "deposit",
      "deposit.",
      "deposit.8",
      "deposit.01",
      "deposit.-1",
      "deposit.1.0",
      "deposit.0 ",
      5,
      null,
      undefined,
      ["elevation"],
      { id: "elevation" },
    ];
    for (const id of ids) {
      expect(observeIssues(DEFAULT, { id, cell: CELL, instant: INSTANT })).toEqual([
        { path: "/query/id", message: NOT_ID },
      ]);
    }
  });

  test("rejects a deposit id the genesis lacks, naming the ones it has", () => {
    const cases: [PreparedGenesis, string, string][] = [
      [
        withDeposits([]),
        "deposit.0",
        "the genesis defines no deposits, so no deposit id names an observable",
      ],
      [withDeposits([A_DEPOSIT]), "deposit.1", "the genesis defines one deposit, deposit.0"],
      [DEFAULT, "deposit.2", "the genesis defines 2 deposits, deposit.0 to deposit.1"],
      [DEFAULT, "deposit.7", "the genesis defines 2 deposits, deposit.0 to deposit.1"],
    ];
    for (const [prepared, id, message] of cases) {
      expect(observeIssues(prepared, { id, cell: CELL, instant: INSTANT })).toEqual([
        { path: "/query/id", message },
      ]);
    }
    expect(observe(DEFAULT, { id: "deposit.1", cell: CELL, instant: INSTANT })).toBeNumber();
  });

  test("rejects a cell outside the world, for every id", () => {
    expect(idsOf(DEFAULT)).toHaveLength(7);
    for (const id of idsOf(DEFAULT)) {
      const cell = { x: MIN_CELL - 1, y: MAX_CELL + 1 };
      expect(observeIssues(DEFAULT, { id, cell, instant: INSTANT })).toEqual(
        issuesOf((sink) => readCell(cell, "/query/cell", sink)),
      );
    }
  });

  test("requires a valid instant for every id, static ones included, with no default", () => {
    const last = Math.floor(MAX / 12);
    expect(idsOf(DEFAULT)).toHaveLength(7);
    for (const id of idsOf(DEFAULT)) {
      for (const instant of [undefined, null, {}, at(-1, 0), at(1.5, -2), at(last + 1, 12)]) {
        const issues = issuesOf((sink) => readInstant(instant, "/query/instant", sink));
        expect(issues.length).toBeGreaterThan(0);
        expect(observeIssues(DEFAULT, { id, cell: CELL, instant })).toEqual(issues);
      }
      expect(observe(DEFAULT, { id, cell: CELL, instant: at(last, 12) })).toBeNumber();
    }
    expect(observeIssues(DEFAULT, { id: "elevation", cell: CELL })).toEqual([
      {
        path: "/query/instant",
        message: "the instant must be a record { tick, simSecondsPerTick }",
      },
    ]);
  });

  test("rejects a query that is not a record, and one whose members are missing", () => {
    for (const query of [null, undefined, 5, "elevation", ["elevation", CELL, INSTANT]]) {
      expect(observeIssues(DEFAULT, query)).toEqual([{ path: "/query", message: NOT_QUERY }]);
    }
    expect(observeIssues(DEFAULT, {})).toEqual([
      { path: "/query/id", message: NOT_ID },
      { path: "/query/cell", message: "the cell must be a record { x, y }" },
      {
        path: "/query/instant",
        message: "the instant must be a record { tick, simSecondsPerTick }",
      },
    ]);
  });

  test("rejects a forged prepared genesis, alone or among other problems", () => {
    for (const forged of [Object.create(DEFAULT), {}, null, DEFAULT_GENESIS]) {
      expect(observeIssues(forged, { id: "elevation", cell: CELL, instant: INSTANT })).toEqual([
        { path: "/prepared", message: NOT_PREPARED },
      ]);
      // Without a genesis, a deposit id within the genesis bounds cannot be checked further.
      expect(observeIssues(forged, { id: "deposit.7", cell: CELL, instant: INSTANT })).toEqual([
        { path: "/prepared", message: NOT_PREPARED },
      ]);
    }
  });

  test("never runs an accessor, and reports a revoked Proxy as one issue with its cause", () => {
    let calls = 0;
    const query = {
      get id() {
        calls += 1;
        return "elevation";
      },
      cell: CELL,
      instant: INSTANT,
    };
    expect(observeIssues(DEFAULT, query)).toEqual([{ path: "/query/id", message: ACCESSOR }]);
    expect(calls).toBe(0);
    const error = engineErrorOf(() => observe(DEFAULT, revokedProxy() as ObservableQuery));
    expect(error.issues.map(({ path }) => path)).toEqual(["/query"]);
    expect(error.issues[0]?.message).toStartWith("the object threw while being read: TypeError");
    expect(error.cause).toBeInstanceOf(TypeError);
  });

  test("reads each member of the query, the cell, and the instant once, and measures what it read", () => {
    const reads: string[] = [];
    // A Proxy that records every descriptor read, which is how members are read.
    const recorded = <T extends object>(target: T): T =>
      new Proxy(target, {
        getOwnPropertyDescriptor(object, key) {
          reads.push(String(key));
          return Reflect.getOwnPropertyDescriptor(object, key);
        },
      });
    const cell = { x: -3584, y: 0 };
    const instant = at(1733);
    const query = recorded({ id: "thermal", cell: recorded(cell), instant: recorded(instant) });
    expect(observe(DEFAULT, query)).toBe(
      (terrainAt(DEFAULT, cell).thermalBase[0] as number) + diurnal(DEFAULT, instant),
    );
    expect(reads).toEqual(["id", "cell", "x", "y", "instant", "tick", "simSecondsPerTick"]);
  });
});

type GoldenRow = (typeof GOLDEN_OBSERVATIONS.rows)[number];

/** What each `where` of the goldens claims about its cell, given its terrain. */
const WHERE: Record<GoldenRow["where"], (cell: CellCoord, terrain: TerrainRegion) => boolean> = {
  liquid: (_, terrain) => (terrain.elevation[0] as number) < liquidLevel(DEFAULT_GENESIS),
  dry: (_, terrain) => (terrain.elevation[0] as number) >= liquidLevel(DEFAULT_GENESIS),
  deposit0: (_, terrain) => (terrain.deposits[0]?.[0] as number) > 0,
  deposit1: (_, terrain) => (terrain.deposits[1]?.[0] as number) > 0,
  minMin: ({ x, y }) => x === MIN_CELL && y === MIN_CELL,
  maxMax: ({ x, y }) => x === MAX_CELL && y === MAX_CELL,
  minMax: ({ x, y }) => x === MIN_CELL && y === MAX_CELL,
  maxMin: ({ x, y }) => x === MAX_CELL && y === MIN_CELL,
  minusOne: ({ x, y }) => x === -1 && y === -1,
};

const LIGHT = lightPeriod(DEFAULT_GENESIS.laws.day);
const DAY = DEFAULT_GENESIS.laws.day.length;

/** Whether `instant` is the first tick of day `dayIndex` at or past its second `second`. */
function firstAtOrPast(instant: Instant, dayIndex: number, second: number): boolean {
  const position = dayPosition(DEFAULT, instant);
  const { secondOfDay } = position;
  return (
    position.dayIndex === dayIndex &&
    secondOfDay >= second &&
    secondOfDay - instant.simSecondsPerTick < second
  );
}

/** What each `when` of the goldens claims about its instant, under the default laws. */
const WHEN: Record<GoldenRow["when"], (instant: Instant) => boolean> = {
  dawn: ({ tick }) => tick === 0,
  quarterLight: (instant) => firstAtOrPast(instant, 0, LIGHT / 4),
  midLight: (instant) => dayCurve(DEFAULT, instant) === CURVE_SCALE,
  lateLight: (instant) => {
    const { secondOfDay } = dayPosition(DEFAULT, instant);
    return secondOfDay >= 0.9 * LIGHT && dayCurve(DEFAULT, instant) > 0;
  },
  night: (instant) => dayPosition(DEFAULT, instant).secondOfDay >= LIGHT,
  nextMidLight: (instant) => firstAtOrPast(instant, 1, LIGHT / 2),
  drifting: ({ simSecondsPerTick }) => DAY % simSecondsPerTick !== 0,
  lightNearLimit: ({ tick, simSecondsPerTick }) =>
    dayCurve(DEFAULT, at(tick, simSecondsPerTick)) > 0 &&
    (tick + Math.ceil(DAY / simSecondsPerTick)) * simSecondsPerTick > MAX,
  lastSafe: ({ tick, simSecondsPerTick }) =>
    Number.isSafeInteger(tick * simSecondsPerTick) &&
    !Number.isSafeInteger((tick + 1) * simSecondsPerTick),
};

/** The observations of `prepared` at each golden row, by id: the ids of the default catalog. */
function observeRows(prepared: PreparedGenesis): Record<string, number>[] {
  return GOLDEN_OBSERVATIONS.rows.map(({ cell, instant }) =>
    Object.fromEntries(idsOf(DEFAULT).map((id) => [id, observe(prepared, { id, cell, instant })])),
  );
}

const STATIC_IDS = ["elevation", "liquid.depth", "substrate", "deposit.0", "deposit.1"] as const;

describe("golden observation values", () => {
  test("pin WORLDGEN_VERSION", () => {
    expect(GOLDEN_OBSERVATIONS.worldgenVersion).toBe(WORLDGEN_VERSION);
  });

  test("hold for every id of the catalog at every row", () => {
    const rows = GOLDEN_OBSERVATIONS.rows;
    expect(rows.length).toBeGreaterThanOrEqual(6);
    for (const { values } of rows) expect(Object.keys(values)).toEqual(idsOf(DEFAULT));
    expect(observeRows(DEFAULT)).toEqual(rows.map(({ values }) => ({ ...values })));
  });

  test("each row is the cell and the instant its names claim", () => {
    for (const { where, when, cell, instant } of GOLDEN_OBSERVATIONS.rows) {
      expect({ where, holds: WHERE[where](cell, terrainAt(DEFAULT, cell)) }).toEqual({
        where,
        holds: true,
      });
      expect({ when, holds: WHEN[when](instant) }).toEqual({ when, holds: true });
    }
  });

  test("span both layers: thermal with and without its diurnal swing, radiance at its floor and its peak", () => {
    const swings = GOLDEN_OBSERVATIONS.rows.map(({ instant }) => diurnal(DEFAULT, instant));
    expect(swings.some((swing) => swing === 0)).toBe(true);
    expect(swings.some((swing) => swing > 0)).toBe(true);
    const radiances: number[] = GOLDEN_OBSERVATIONS.rows.map(({ values }) => values.radiance);
    expect(radiances).toContain(DEFAULT_GENESIS.laws.radiance.night);
    expect(radiances).toContain(DEFAULT_GENESIS.laws.radiance.peak);
  });

  test("do not change with the world seed: inside the steps of worlds with different seeds", () => {
    // observe takes no world: the world seed can reach it only through some hidden state.
    const expected = GOLDEN_OBSERVATIONS.rows.map(({ values }) => ({ ...values }));
    const seeds: [number, number][] = [
      [1, 2],
      [0xdead_beef, 0x0bad_f00d],
    ];
    for (const seed of seeds) {
      const inside: Record<string, number>[][] = [];
      const ruleset = stepRuleset([system("observe", () => inside.push(observeRows(DEFAULT)))]);
      const world = createWorld({ seed, simSecondsPerTick: 12, global: {}, chunks: {}, ruleset });
      step(world, []);
      expect(inside).toEqual([expected]);
    }
  });

  test("the terrain seed alone decides the static values: other time laws keep them, other seeds change them", () => {
    const laws = {
      ...DEFAULT_GENESIS.laws,
      day: { length: 1000, daylight: 300 },
      thermal: { ...DEFAULT_GENESIS.laws.thermal, diurnal: 999 },
      radiance: { peak: 7, night: 3 },
    };
    const otherLaws = observeRows(prepareGenesis({ ...DEFAULT_GENESIS, laws }));
    GOLDEN_OBSERVATIONS.rows.forEach(({ values }, index) => {
      for (const id of STATIC_IDS) expect(otherLaws[index]?.[id]).toBe(values[id]);
    });
    const temporal = otherLaws.filter(
      (row, index) =>
        row.thermal !== GOLDEN_OBSERVATIONS.rows[index]?.values.thermal ||
        row.radiance !== GOLDEN_OBSERVATIONS.rows[index]?.values.radiance,
    );
    expect(temporal.length).toBe(GOLDEN_OBSERVATIONS.rows.length);
    for (const seed of [GOLDEN_WORLDGEN.seeds[0], GOLDEN_WORLDGEN.seeds[2]]) {
      const elsewhere = observeRows(prepareGenesis(defaultGenesis(seed as readonly number[])));
      const changed = elsewhere.filter(
        (row, index) => row.elevation !== GOLDEN_OBSERVATIONS.rows[index]?.values.elevation,
      );
      expect(changed.length).toBe(GOLDEN_OBSERVATIONS.rows.length);
    }
  });
});
