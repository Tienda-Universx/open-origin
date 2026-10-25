/**
 * Primitive observables (ADR 0021, primitive observables): what can be measured of a cell, and
 * the one way to measure it. observableCatalog lists, for a prepared genesis, each observable's
 * id, dimension, unit, kind, whether it varies with time, its exposure, and its range; observe
 * measures one observable at one cell and one instant, as an integer.
 *
 * | id | Dimension, unit | Kind | Varies | Exposure | Value at cell c and instant t |
 * |---|---|---|---|---|---|
 * | `elevation` | length, `len` | quantity | static | surface | elevation(c) |
 * | `liquid.depth` | length, `len` | quantity | static | surface | max(0, L − elevation(c)) |
 * | `substrate` | category, none | category | static | surface | substrate(c) |
 * | `thermal` | thermal, `tu` | quantity | time | measurement | thermalBase(c) + diurnal(t) |
 * | `radiance` | radiant, `ru` | quantity | time | surface | radiance(t), equal in every cell |
 * | `deposit.<k>` | amount, `qu` | quantity | static | measurement | deposits[k](c) |
 *
 * The catalog lists the five fixed ids in that order, then `deposit.0`, `deposit.1`, … for each
 * deposit of the genesis, in its order. L is the level of liquid (liquidLevel); the fields are
 * terrain.ts's, and diurnal and radiance calendar.ts's. A temporal observable is exactly its
 * permanent part plus its temporal part (I9). A category's values are classes, with no unit and
 * no order. For developers only: `tu` counts the thermal level, `ru` incident light, `qu` the
 * abundance of a deposit, and `len` heights; a `surface` observable is one the surface presents,
 * and a `measurement` one that takes measuring. T4 and T5 decide what each means for perception.
 *
 * **Ranges.** Each range is a true bound of every value the observable takes in any cell and at
 * any instant, derived from the bounds of terrain.ts and noise.ts, never from sampled values, so
 * the values of a world stay well inside it. With B = noiseBound(relief), so |elevation| ≤ B,
 * and L ≤ 0.8 × amplitude < B:
 *
 * | id | Range |
 * |---|---|
 * | `elevation` | [−B, B] |
 * | `liquid.depth` | [0, L + B] |
 * | `substrate` | [0, M − 1], for M substrate classes |
 * | `thermal` | [base − T + min(0, P), base + T + max(0, P) + diurnal] |
 * | `radiance` | [night, peak] |
 * | `deposit.<k>` | [0, peak of deposit k] |
 *
 * T is the bound of the thermal noise, 0 when `spread` is 0, and P = ⌊num × (B − L) / den⌋ is the
 * lapse term at the highest elevation: the lapse term is 0 at or below L and moves monotonically
 * toward P as elevation rises to B, since floorDiv is monotonic. Every bound is a safe integer:
 * |num × (B − L)| < 2^20 × 2^31 (terrain.ts, bounds).
 *
 * **Engineering names.** Ids, dimensions, units, kinds, and every other text of the catalog are
 * engineering names for code and operators. Perception (T4, T5) never passes them into a prompt
 * (plan §K.4, §K.7), and no field carries a human-language gloss of what a value is to us, so the
 * catalog injects no concept into a mind (AGENTS.md, rule 11).
 *
 * **Layers.** The catalog is observable data (ADR 0021, four layers of information). Its ranges
 * derive from the laws and terrain parameters of the genesis, which is C3, though never from the
 * terrain seed, so the catalog is not public by itself: T6 decides each projection.
 *
 * **observe.** The instant is required for every id, with no default and no implicit clock: a
 * static id ignores its value, but it is validated all the same. observe reads its query once,
 * reports every problem at once, and measures what it read: the cell's 1×1 terrain region from
 * sampleRegion, which radiance does not need, and the calendar's terms at the instant.
 */
import type { IssueSink } from "../canonical/value.ts";
import { IssueList } from "../errors.ts";
import { floorDiv } from "../int.ts";
import { expectRecord, readMember, UNREAD } from "../world/members.ts";
import { diurnal, type Instant, radiance, readInstant } from "./calendar.ts";
import {
  GENESIS_BOUNDS,
  type Genesis,
  type IntRange,
  type PreparedGenesis,
  readPreparedGenesis,
} from "./genesis.ts";
import { LATTICE_PURPOSES } from "./lattice.ts";
import { noiseBound } from "./noise.ts";
import { type CellCoord, readCell } from "./space.ts";
import { liquidLevel, sampleRegion, type TerrainRegion, THERMAL_NOISE } from "./terrain.ts";

/** What a quantity measures. */
export type QuantityDimension = "length" | "thermal" | "radiant" | "amount";

/** The world's own units (ADR 0021): one per quantity dimension, in that order. */
export type ObservableUnit = "len" | "tu" | "ru" | "qu";

/** Whether an observable is permanent, `static`, or changes with the instant, `time`. */
export type ObservableVariation = "static" | "time";

/** Whether an observable is one the surface presents, or one that takes measuring. */
export type ObservableExposure = "surface" | "measurement";

/** A quantity: an integer number of its unit, within its range. */
export type QuantityObservable = {
  readonly id: string;
  readonly dimension: QuantityDimension;
  readonly unit: ObservableUnit;
  readonly kind: "quantity";
  readonly varies: ObservableVariation;
  readonly exposure: ObservableExposure;
  readonly range: IntRange;
};

/** A category: a class within its range, with no unit and no order. */
export type CategoryObservable = {
  readonly id: string;
  readonly dimension: "category";
  readonly kind: "category";
  readonly varies: ObservableVariation;
  readonly exposure: ObservableExposure;
  readonly range: IntRange;
};

/** An entry of the catalog, frozen at every level. */
export type Observable = QuantityObservable | CategoryObservable;

/** What observe measures: the observable `id`, at the cell `cell`, at the instant `instant`. */
export type ObservableQuery = {
  readonly id: string;
  readonly cell: CellCoord;
  readonly instant: Instant;
};

/** An entry without its range, which depends on the genesis. */
type Descriptor = Omit<QuantityObservable, "range"> | Omit<CategoryObservable, "range">;

/** What the ranges of a genesis derive from: B, the relief's noise bound, and L, its level. */
type RangeBasis = { readonly genesis: Genesis; readonly relief: number; readonly level: number };

/** A validated measurement: the prepared genesis, its genesis, the cell, and the instant. */
type Reading = {
  readonly prepared: PreparedGenesis;
  readonly genesis: Genesis;
  readonly cell: CellCoord;
  readonly instant: Instant;
};

/** A fixed observable: its descriptor, its range for a genesis, and its value for a reading. */
type FixedObservable = {
  readonly descriptor: Descriptor;
  readonly range: (basis: RangeBasis) => IntRange;
  readonly value: (reading: Reading) => number;
};

/** The integers from `min` to `max`, frozen. */
function span(min: number, max: number): IntRange {
  return Object.freeze({ min, max });
}

/** The permanent fields of the reading's cell: its 1×1 terrain region. */
function cellTerrain(reading: Reading): TerrainRegion {
  const { x, y } = reading.cell;
  return sampleRegion(reading.prepared, { x, y, width: 1, height: 1 });
}

/** The value of a field of a 1×1 region. */
function only(field: Int32Array | Uint8Array): number {
  return field[0] as number;
}

/** max(0, L − elevation) at the reading's cell: how far below the level of liquid it lies. */
function liquidDepth(reading: Reading): number {
  const level = liquidLevel(reading.genesis);
  const elevation = only(cellTerrain(reading).elevation);
  return elevation < level ? level - elevation : 0;
}

/** thermalBase + diurnal: the cell's permanent part plus the instant's temporal part. */
function thermal(reading: Reading): number {
  const base = only(cellTerrain(reading).thermalBase);
  return base + diurnal(reading.prepared, reading.instant);
}

/** The range of `thermal`, as the module comment derives it. */
function thermalRange({ genesis, relief, level }: RangeBasis): IntRange {
  const { base, spread, lapse } = genesis.laws.thermal;
  const spec = { purpose: LATTICE_PURPOSES.thermal, ...THERMAL_NOISE, amplitude: spread };
  // A spread of 0 adds 0; the noise's precondition asks for an amplitude of at least 1.
  const noise = spread === 0 ? 0 : noiseBound(spec);
  // B > L, so P has the sign of num: a negative lapse lowers the floor, a positive one raises the
  // ceiling.
  const steepest = floorDiv(lapse.num * (relief - level), lapse.den);
  const low = base - noise + (lapse.num < 0 ? steepest : 0);
  const high = base + noise + (lapse.num > 0 ? steepest : 0) + genesis.laws.thermal.diurnal;
  return span(low, high);
}

/** The observables of every genesis, in catalog order. */
const FIXED_OBSERVABLES: readonly FixedObservable[] = [
  {
    descriptor: {
      id: "elevation",
      dimension: "length",
      unit: "len",
      kind: "quantity",
      varies: "static",
      exposure: "surface",
    },
    range: ({ relief }) => span(-relief, relief),
    value: (reading) => only(cellTerrain(reading).elevation),
  },
  {
    descriptor: {
      id: "liquid.depth",
      dimension: "length",
      unit: "len",
      kind: "quantity",
      varies: "static",
      exposure: "surface",
    },
    range: ({ relief, level }) => span(0, level + relief),
    value: liquidDepth,
  },
  {
    descriptor: {
      id: "substrate",
      dimension: "category",
      kind: "category",
      varies: "static",
      exposure: "surface",
    },
    range: ({ genesis }) => span(0, genesis.terrain.substrate.weights.length - 1),
    value: (reading) => only(cellTerrain(reading).substrate),
  },
  {
    descriptor: {
      id: "thermal",
      dimension: "thermal",
      unit: "tu",
      kind: "quantity",
      varies: "time",
      exposure: "measurement",
    },
    range: thermalRange,
    value: thermal,
  },
  {
    descriptor: {
      id: "radiance",
      dimension: "radiant",
      unit: "ru",
      kind: "quantity",
      varies: "time",
      exposure: "surface",
    },
    range: ({ genesis }) => span(genesis.laws.radiance.night, genesis.laws.radiance.peak),
    value: (reading) => radiance(reading.prepared, reading.instant),
  },
];

/** The descriptor of every deposit's observable, but its id. */
const DEPOSIT_DESCRIPTOR = {
  dimension: "amount",
  unit: "qu",
  kind: "quantity",
  varies: "static",
  exposure: "measurement",
} as const;

/** The id of the observable of deposit `k`. */
function depositId(k: number): string {
  return `deposit.${k}`;
}

/**
 * The catalog of `prepared`'s observables: the five fixed ones, then one per deposit of its
 * genesis, each with its range for that genesis, in a fresh array frozen at every level. It does
 * not depend on the terrain seed. Throws EngineError("invalid_value") at /prepared for a value
 * prepareGenesis did not make.
 */
export function observableCatalog(prepared: PreparedGenesis): readonly Observable[] {
  const issues = new IssueList();
  const genesis = readPreparedGenesis(prepared, issues);
  if (genesis === undefined) throw issues.toError("invalid_value");
  const relief = noiseBound({ purpose: LATTICE_PURPOSES.elevation, ...genesis.terrain.relief });
  const basis = { genesis, relief, level: liquidLevel(genesis) };
  const fixed = FIXED_OBSERVABLES.map(({ descriptor, range }) =>
    Object.freeze({ ...descriptor, range: range(basis) }),
  );
  const deposits = genesis.terrain.deposits.map((deposit, k) =>
    Object.freeze({ id: depositId(k), ...DEPOSIT_DESCRIPTOR, range: span(0, deposit.peak) }),
  );
  return Object.freeze([...fixed, ...deposits]);
}

const QUERY_PATH = "/query";
const ID_PATH = `${QUERY_PATH}/id`;
const CELL_PATH = `${QUERY_PATH}/cell`;
const INSTANT_PATH = `${QUERY_PATH}/instant`;
const NOT_QUERY = "the query must be a record { id, cell, instant }";
const NOT_ID = `the id must be a string that names an observable: ${FIXED_OBSERVABLES.map(({ descriptor }) => descriptor.id).join(", ")}, or deposit.<k> for a deposit k of the genesis`;

/** Why deposit ids beyond the first `count` name no deposit of the genesis. */
function lackingDeposit(count: number): string {
  if (count === 0) return "the genesis defines no deposits, so no deposit id names an observable";
  if (count === 1) return "the genesis defines one deposit, deposit.0";
  return `the genesis defines ${count} deposits, deposit.0 to ${depositId(count - 1)}`;
}

/** The deposit that `id` names among those any genesis may have; undefined for another id. */
function depositIndex(id: string): number | undefined {
  for (let k = 0; k < GENESIS_BOUNDS.terrain.deposits.count.max; k += 1) {
    if (id === depositId(k)) return k;
  }
  return undefined;
}

/** What a valid id names: a fixed observable, or the index of a deposit of the genesis. */
type Target = FixedObservable | number;

/**
 * What the host value `value` names as an id, for `genesis`; undefined after an issue at
 * /query/id. Without a genesis, after an issue at /prepared, a deposit id is checked only against
 * the most deposits a genesis may have.
 */
function readTarget(
  value: unknown,
  genesis: Genesis | undefined,
  sink: IssueSink,
): Target | undefined {
  if (value === UNREAD) return undefined;
  const id = typeof value === "string" ? value : undefined;
  const fixed = FIXED_OBSERVABLES.find(({ descriptor }) => descriptor.id === id);
  if (fixed !== undefined) return fixed;
  const k = id === undefined ? undefined : depositIndex(id);
  if (k === undefined) {
    sink.report(ID_PATH, NOT_ID);
    return undefined;
  }
  if (genesis === undefined) return undefined;
  const count = genesis.terrain.deposits.length;
  if (k < count) return k;
  sink.report(ID_PATH, lackingDeposit(count));
  return undefined;
}

/** A query whose members observe read and validated. */
type ValidQuery = { readonly target: Target; readonly cell: CellCoord; readonly instant: Instant };

/**
 * The host value `query`, read once member by member, as world/members.ts reads host objects;
 * undefined after every problem is reported under /query.
 */
function readQuery(
  query: unknown,
  genesis: Genesis | undefined,
  sink: IssueSink,
): ValidQuery | undefined {
  if (!expectRecord(query, QUERY_PATH, NOT_QUERY, sink)) return undefined;
  const target = readTarget(readMember(query, "id", ID_PATH, sink), genesis, sink);
  const cell = readCell(readMember(query, "cell", CELL_PATH, sink), CELL_PATH, sink);
  const instantValue = readMember(query, "instant", INSTANT_PATH, sink);
  const instant = readInstant(instantValue, INSTANT_PATH, sink);
  if (target === undefined || cell === undefined || instant === undefined) return undefined;
  return { target, cell, instant };
}

/**
 * The observable `query.id` of `prepared` at the cell `query.cell` and the instant
 * `query.instant`, an integer within its catalog range. The instant is required for every id;
 * a static id ignores its value.
 *
 * It validates its inputs once and throws EngineError("invalid_value") with every problem: at
 * /prepared, a value prepareGenesis did not make; at /query, a value that is not a record; at
 * /query/id, an id that names no observable, or a deposit the genesis lacks; under /query/cell,
 * what readCell rejects; under /query/instant, what readInstant rejects, a simulated second
 * beyond the safe integers included. Host objects are read once, member by member, and an
 * accessor never runs.
 */
export function observe(prepared: PreparedGenesis, query: ObservableQuery): number {
  const issues = new IssueList();
  const genesis = readPreparedGenesis(prepared, issues);
  const valid = readQuery(query, genesis, issues);
  if (genesis === undefined || valid === undefined || issues.count > 0) {
    throw issues.toError("invalid_value");
  }
  const { target, cell, instant } = valid;
  const reading = { prepared, genesis, cell, instant };
  if (typeof target !== "number") return target.value(reading);
  return only(cellTerrain(reading).deposits[target] as Int32Array);
}
