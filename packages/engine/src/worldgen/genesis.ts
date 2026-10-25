/**
 * The genesis (ADR 0021, genesis): a world's terrain seed, laws, and terrain parameters, held in
 * its global value next to their seal. Every parameter is an integer within GENESIS_BOUNDS, and the
 * schema is strict: an unknown member is refused, so a misspelled law is never silently ignored.
 *
 * A genesis is read once, through copyCanonicalReported (canonical/copy.ts), so a getter never runs
 * and a Proxy cannot show validation one value and the copy another; the schema is then checked on
 * the copy, which the engine owns. Every problem is reported at once, with its JSON Pointer relative
 * to the genesis. No message prints a word of the terrain seed, which is C3 (ADR 0008): the
 * canonical walk's messages under /terrainSeed are withheld, since they print numbers.
 */
import { copyCanonical, copyCanonicalReported } from "../canonical/copy.ts";
import { sortedOwnKeys } from "../canonical/order.ts";
import { type IssueSink, pointer } from "../canonical/value.ts";
import { type Digest, digest } from "../digest/digest.ts";
import { EngineError, type Issue, IssueList } from "../errors.ts";
import { floorDiv, isU32, MAX_U32 } from "../int.ts";
import { expectRecord, readMember, UNREAD, under } from "../world/members.ts";
import { WORLDGEN_VERSION } from "./version.ts";

/** The length of a day in simulated seconds, and the share of it with daylight, in ‰. */
export type DayLaw = { readonly length: number; readonly daylight: number };

/** The equipotential level that liquid fills, in ‰ of the elevation range [−amplitude, amplitude]. */
export type LiquidLaw = { readonly level: number };

/** A signed rational number, num / den. */
export type Ratio = { readonly num: number; readonly den: number };

/** The thermal level: its base, its spatial spread, its lapse with elevation, its daily swing. */
export type ThermalLaw = {
  readonly base: number;
  readonly spread: number;
  readonly lapse: Ratio;
  readonly diurnal: number;
};

/** Incident light: its peak during the day, and its floor at night. */
export type RadianceLaw = { readonly peak: number; readonly night: number };

export type Laws = {
  readonly day: DayLaw;
  readonly liquid: LiquidLaw;
  readonly thermal: ThermalLaw;
  readonly radiance: RadianceLaw;
};

/** Elevation noise: its coarsest wavelength in cells, its octaves, and its amplitude. */
export type Relief = {
  readonly wavelength: number;
  readonly octaves: number;
  readonly amplitude: number;
};

/** Substrate regions: their Voronoi cell size, and one weight per substrate class. */
export type Substrate = { readonly cell: number; readonly weights: readonly number[] };

/** A deposit field: its noise, the threshold it must pass (in ‰), and its peak abundance. */
export type Deposit = {
  readonly wavelength: number;
  readonly octaves: number;
  readonly threshold: number;
  readonly peak: number;
};

export type TerrainParams = {
  readonly relief: Relief;
  readonly substrate: Substrate;
  readonly deposits: readonly Deposit[];
};

/** Everything a world's terrain and laws derive from (ADR 0021, genesis). */
export type Genesis = {
  /** Eight u32 words that the host draws from a CSPRNG. */
  readonly terrainSeed: readonly number[];
  readonly laws: Laws;
  readonly terrain: TerrainParams;
};

/** The integers from `min` to `max`, both included. */
export type IntRange = { readonly min: number; readonly max: number };

function range(min: number, max: number): IntRange {
  return Object.freeze({ min, max });
}

/** 2^20, the bound of the thermal and radiance laws. */
const TWO_POW_20 = 0x10_0000;

/** 2^16, the longest wavelength in cells. */
const MAX_WAVELENGTH = 0x1_0000;

/**
 * 2^36, the longest day in simulated seconds, so that the calendar's second of the day times 2^16
 * stays below 2^53 (calendar.ts).
 */
const MAX_DAY_LENGTH = 0x10_0000_0000;

/**
 * The bounds of every genesis parameter, which keep every intermediate value of worldgen a safe
 * integer. Two bounds depend on another parameter: a wavelength is at least 8·2^(octaves − 1), so
 * the finest octave spans 8 cells or more (its `min` here is for one octave), and radiance's night
 * is at most its peak. One rule joins the day's two parameters: its light period, lightPeriod(day),
 * lasts at least one second, so no day of 1 second is valid. Counts bound the lengths of the lists.
 * Frozen at every level.
 */
export const GENESIS_BOUNDS = Object.freeze({
  terrainSeedWords: range(8, 8),
  laws: Object.freeze({
    day: Object.freeze({ length: range(1, MAX_DAY_LENGTH), daylight: range(1, 999) }),
    liquid: Object.freeze({ level: range(100, 900) }),
    thermal: Object.freeze({
      base: range(-TWO_POW_20, TWO_POW_20),
      spread: range(0, TWO_POW_20),
      lapse: Object.freeze({ num: range(-TWO_POW_20, TWO_POW_20), den: range(1, TWO_POW_20) }),
      diurnal: range(0, TWO_POW_20),
    }),
    radiance: Object.freeze({ peak: range(1, TWO_POW_20), night: range(0, TWO_POW_20) }),
  }),
  terrain: Object.freeze({
    relief: Object.freeze({
      wavelength: range(8, MAX_WAVELENGTH),
      octaves: range(1, 12),
      amplitude: range(1, 0x4000_0000),
    }),
    substrate: Object.freeze({
      cell: range(8, 0x1000),
      classes: range(1, 16),
      weight: range(1, 1000),
    }),
    deposits: Object.freeze({
      count: range(0, 8),
      wavelength: range(8, MAX_WAVELENGTH),
      octaves: range(1, 6),
      threshold: range(0, 999),
      peak: range(1, TWO_POW_20),
    }),
  }),
});

const SEED_PATH = "/terrainSeed";
const SEED_WITHHELD =
  "the terrain seed is not canonical here; the details are withheld, as no message prints the terrain seed";
const SEED_WORD = `the word is not a u32: terrain seed words are integers from 0 to ${MAX_U32}`;
const MISSING = "the member is missing";

/** A sink that reports to `sink`, but withholds the messages of issues inside the terrain seed. */
function withholdingSeed(sink: IssueSink): IssueSink {
  return {
    report(path, message, cause) {
      const inSeed = path === SEED_PATH || path.startsWith(`${SEED_PATH}/`);
      sink.report(path, inSeed ? SEED_WITHHELD : message, cause);
    },
  };
}

/** What kind of canonical value `value` is, for a message: never the value itself. */
function kindOf(value: unknown): string {
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "a record";
  return `a ${typeof value}`;
}

function inRange(value: number, bounds: IntRange): boolean {
  return value >= bounds.min && value <= bounds.max;
}

/** Whether the positive integer `value` is a power of two; it loops once per bit of `value`. */
function isPowerOfTwo(value: number): boolean {
  let power = 1;
  while (power < value) power *= 2;
  return power === value;
}

/**
 * `value`, a member of the canonical copy, if it is a number, which the copy makes a safe integer;
 * undefined after an issue at `path`. Undefined stands for a member that is missing or that the
 * canonical walk rejected, both already reported, so it is skipped silently here and below.
 */
function numberAt(value: unknown, path: string, sink: IssueSink): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") return value;
  sink.report(path, `the value must be an integer, not ${kindOf(value)}`);
  return undefined;
}

/** `value` if it is an integer within `bounds`; undefined after an issue at `path`. */
function readInt(
  value: unknown,
  path: string,
  bounds: IntRange,
  sink: IssueSink,
): number | undefined {
  const number = numberAt(value, path, sink);
  if (number === undefined || inRange(number, bounds)) return number;
  sink.report(path, `${number} is out of bounds: it must be from ${bounds.min} to ${bounds.max}`);
  return undefined;
}

/** `value` if it is a power of two within `bounds`; undefined after an issue at `path`. */
function readPowerOfTwo(
  value: unknown,
  path: string,
  bounds: IntRange,
  sink: IssueSink,
): number | undefined {
  const number = numberAt(value, path, sink);
  if (number === undefined || (inRange(number, bounds) && isPowerOfTwo(number))) return number;
  sink.report(path, `${number} is not a power of two from ${bounds.min} to ${bounds.max}`);
  return undefined;
}

/** The members of a record of the canonical copy, after readRecord checked their names. */
class Members {
  readonly #record: object;
  readonly #keys: readonly string[];
  readonly #path: string;
  readonly #sink: IssueSink;

  constructor(record: object, keys: readonly string[], path: string, sink: IssueSink) {
    this.#record = record;
    this.#keys = keys;
    this.#path = path;
    this.#sink = sink;
  }

  /** The path of the member `name`. */
  at(name: string): string {
    return `${this.#path}/${name}`;
  }

  /** The member `name`; undefined when it is missing or the canonical walk rejected it. */
  value(name: string): unknown {
    if (!this.#keys.includes(name)) return undefined;
    return readMember(this.#record, name, this.at(name), this.#sink);
  }

  int(name: string, bounds: IntRange): number | undefined {
    return readInt(this.value(name), this.at(name), bounds, this.#sink);
  }

  powerOfTwo(name: string, bounds: IntRange): number | undefined {
    return readPowerOfTwo(this.value(name), this.at(name), bounds, this.#sink);
  }
}

/** Reports every key of `keys` that is not one of `names`, then every name missing from `keys`. */
function checkNames(
  keys: readonly string[],
  names: readonly string[],
  path: string,
  sink: IssueSink,
): void {
  for (const key of keys) {
    if (!names.includes(key)) {
      sink.report(
        `${path}${pointer([key])}`,
        `unknown member: the members here are ${names.join(", ")}`,
      );
    }
  }
  for (const name of names) {
    if (!keys.includes(name)) sink.report(`${path}/${name}`, MISSING);
  }
}

/**
 * The members of `value`, a part of the canonical copy, if it is a record; its members must be
 * exactly `names`, and each unknown or missing one is an issue. Undefined after an issue at `path`.
 */
function readRecord(
  value: unknown,
  path: string,
  names: readonly string[],
  sink: IssueSink,
): Members | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    sink.report(path, `the value must be a record { ${names.join(", ")} }, not ${kindOf(value)}`);
    return undefined;
  }
  const keys = sortedOwnKeys(value);
  checkNames(keys, names, path, sink);
  return new Members(value, keys, path, sink);
}

/** How a list is read: how many entries it may have, and how each entry is read. */
type ListSpec<T> = {
  readonly count: IntRange;
  readonly entry: (value: unknown, path: string) => T | undefined;
};

/**
 * The entries of `value`, a part of the canonical copy, if it is an array of `spec.count` entries
 * that `spec.entry` all accept; undefined after an issue. A list of the wrong length still has its
 * entries checked, so that every problem is reported.
 */
function readList<T>(
  value: unknown,
  path: string,
  spec: ListSpec<T>,
  sink: IssueSink,
): readonly T[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    sink.report(path, `the value must be an array, not ${kindOf(value)}`);
    return undefined;
  }
  const values: readonly unknown[] = value;
  const { min, max } = spec.count;
  let complete = inRange(values.length, spec.count);
  if (!complete) {
    const allowed = min === max ? `exactly ${min}` : `from ${min} to ${max}`;
    sink.report(path, `the array has ${values.length} entries: it must have ${allowed}`);
  }
  const entries: T[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const entry = spec.entry(values[index], `${path}/${index}`);
    if (entry === undefined) complete = false;
    else entries.push(entry);
  }
  return complete ? Object.freeze(entries) : undefined;
}

/** `value` if it is a word of the terrain seed; undefined after an issue that does not print it. */
function readSeedWord(value: unknown, path: string, sink: IssueSink): number | undefined {
  if (value === undefined) return undefined;
  if (isU32(value)) return value;
  sink.report(path, SEED_WORD);
  return undefined;
}

/**
 * How many seconds of a day under `day` have light: ⌊length·daylight / 1000⌋, from dawn, the day's
 * second 0. The night is the rest of the day, and always lasts at least one second: daylight is at
 * most 999‰, so the light period is shorter than the day. Exact: length·daylight is below 2^46.
 */
export function lightPeriod(day: DayLaw): number {
  return floorDiv(day.length * day.daylight, 1000);
}

/**
 * The day; its light period must last at least one second, so that the calendar never divides by
 * zero, even in a world whose host never called timeLawIssues (calendar.ts). The rule is checked
 * only when both members are in bounds, and reported at the day itself, as both decide it.
 */
function readDay(value: unknown, path: string, sink: IssueSink): DayLaw | undefined {
  const day = readRecord(value, path, ["length", "daylight"], sink);
  if (day === undefined) return undefined;
  const bounds = GENESIS_BOUNDS.laws.day;
  const length = day.int("length", bounds.length);
  const daylight = day.int("daylight", bounds.daylight);
  if (length === undefined || daylight === undefined) return undefined;
  const law = Object.freeze({ length, daylight });
  if (lightPeriod(law) >= 1) return law;
  sink.report(
    path,
    `the day has no light period: ${daylight}‰ of a day of ${length} seconds is less than one second, and the light period and the night must each last at least one second`,
  );
  return undefined;
}

function readLiquid(value: unknown, path: string, sink: IssueSink): LiquidLaw | undefined {
  const liquid = readRecord(value, path, ["level"], sink);
  const level = liquid?.int("level", GENESIS_BOUNDS.laws.liquid.level);
  return level === undefined ? undefined : Object.freeze({ level });
}

function readLapse(value: unknown, path: string, sink: IssueSink): Ratio | undefined {
  const lapse = readRecord(value, path, ["num", "den"], sink);
  if (lapse === undefined) return undefined;
  const bounds = GENESIS_BOUNDS.laws.thermal.lapse;
  const num = lapse.int("num", bounds.num);
  const den = lapse.int("den", bounds.den);
  if (num === undefined || den === undefined) return undefined;
  return Object.freeze({ num, den });
}

function readThermal(value: unknown, path: string, sink: IssueSink): ThermalLaw | undefined {
  const thermal = readRecord(value, path, ["base", "spread", "lapse", "diurnal"], sink);
  if (thermal === undefined) return undefined;
  const bounds = GENESIS_BOUNDS.laws.thermal;
  const base = thermal.int("base", bounds.base);
  const spread = thermal.int("spread", bounds.spread);
  const lapse = readLapse(thermal.value("lapse"), thermal.at("lapse"), sink);
  const diurnal = thermal.int("diurnal", bounds.diurnal);
  if (base === undefined || spread === undefined || lapse === undefined) return undefined;
  return diurnal === undefined ? undefined : Object.freeze({ base, spread, lapse, diurnal });
}

/** Radiance; night is checked against peak, or against the highest peak when peak is invalid. */
function readRadiance(value: unknown, path: string, sink: IssueSink): RadianceLaw | undefined {
  const radiance = readRecord(value, path, ["peak", "night"], sink);
  if (radiance === undefined) return undefined;
  const bounds = GENESIS_BOUNDS.laws.radiance;
  const peak = radiance.int("peak", bounds.peak);
  const night = radiance.int("night", { min: bounds.night.min, max: peak ?? bounds.night.max });
  if (peak === undefined || night === undefined) return undefined;
  return Object.freeze({ peak, night });
}

function readLaws(value: unknown, path: string, sink: IssueSink): Laws | undefined {
  const laws = readRecord(value, path, ["day", "liquid", "thermal", "radiance"], sink);
  if (laws === undefined) return undefined;
  const day = readDay(laws.value("day"), laws.at("day"), sink);
  const liquid = readLiquid(laws.value("liquid"), laws.at("liquid"), sink);
  const thermal = readThermal(laws.value("thermal"), laws.at("thermal"), sink);
  const radiance = readRadiance(laws.value("radiance"), laws.at("radiance"), sink);
  if (day === undefined || liquid === undefined || thermal === undefined) return undefined;
  return radiance === undefined ? undefined : Object.freeze({ day, liquid, thermal, radiance });
}

/** The coarsest wavelength that `octaves` octaves allow: `finest`·2^(octaves − 1). */
function lowestWavelength(finest: number, octaves: number): number {
  let wavelength = finest;
  for (let octave = 1; octave < octaves; octave += 1) wavelength *= 2;
  return wavelength;
}

/**
 * The octaves and the wavelength of a noise field. The wavelength must leave the finest octave at
 * least `bounds.wavelength.min` cells; it is checked for one octave when the octaves are invalid,
 * so that a bad octave count is not reported a second time through its wavelength.
 */
function readScale(
  members: Members,
  bounds: { readonly wavelength: IntRange; readonly octaves: IntRange },
): { readonly octaves: number | undefined; readonly wavelength: number | undefined } {
  const octaves = members.int("octaves", bounds.octaves);
  const lowest = lowestWavelength(bounds.wavelength.min, octaves ?? 1);
  const wavelength = members.powerOfTwo("wavelength", { min: lowest, max: bounds.wavelength.max });
  return { octaves, wavelength };
}

function readRelief(value: unknown, path: string, sink: IssueSink): Relief | undefined {
  const relief = readRecord(value, path, ["wavelength", "octaves", "amplitude"], sink);
  if (relief === undefined) return undefined;
  const bounds = GENESIS_BOUNDS.terrain.relief;
  const { octaves, wavelength } = readScale(relief, bounds);
  const amplitude = relief.int("amplitude", bounds.amplitude);
  if (wavelength === undefined || octaves === undefined || amplitude === undefined)
    return undefined;
  return Object.freeze({ wavelength, octaves, amplitude });
}

function readSubstrate(value: unknown, path: string, sink: IssueSink): Substrate | undefined {
  const substrate = readRecord(value, path, ["cell", "weights"], sink);
  if (substrate === undefined) return undefined;
  const bounds = GENESIS_BOUNDS.terrain.substrate;
  const cell = substrate.powerOfTwo("cell", bounds.cell);
  const weights = readList(
    substrate.value("weights"),
    substrate.at("weights"),
    { count: bounds.classes, entry: (weight, at) => readInt(weight, at, bounds.weight, sink) },
    sink,
  );
  if (cell === undefined || weights === undefined) return undefined;
  return Object.freeze({ cell, weights });
}

function readDeposit(value: unknown, path: string, sink: IssueSink): Deposit | undefined {
  const deposit = readRecord(value, path, ["wavelength", "octaves", "threshold", "peak"], sink);
  if (deposit === undefined) return undefined;
  const bounds = GENESIS_BOUNDS.terrain.deposits;
  const { octaves, wavelength } = readScale(deposit, bounds);
  const threshold = deposit.int("threshold", bounds.threshold);
  const peak = deposit.int("peak", bounds.peak);
  if (wavelength === undefined || octaves === undefined || threshold === undefined) {
    return undefined;
  }
  return peak === undefined ? undefined : Object.freeze({ wavelength, octaves, threshold, peak });
}

function readTerrain(value: unknown, path: string, sink: IssueSink): TerrainParams | undefined {
  const terrain = readRecord(value, path, ["relief", "substrate", "deposits"], sink);
  if (terrain === undefined) return undefined;
  const relief = readRelief(terrain.value("relief"), terrain.at("relief"), sink);
  const substrate = readSubstrate(terrain.value("substrate"), terrain.at("substrate"), sink);
  const deposits = readList(
    terrain.value("deposits"),
    terrain.at("deposits"),
    {
      count: GENESIS_BOUNDS.terrain.deposits.count,
      entry: (deposit, at) => readDeposit(deposit, at, sink),
    },
    sink,
  );
  if (relief === undefined || substrate === undefined || deposits === undefined) return undefined;
  return Object.freeze({ relief, substrate, deposits });
}

/**
 * Reads the host value `value` as a genesis and reports every problem to `sink`: first the
 * canonical walk's, in canonical order, then the schema's, in schema order. The genesis it returns
 * is a fresh copy, frozen at every level, and meaningful only when nothing was reported; it returns
 * undefined only after an issue.
 */
function readGenesis(value: unknown, sink: IssueSink): Genesis | undefined {
  const copy = copyCanonicalReported(value, withholdingSeed(sink));
  const genesis = readRecord(copy, "", ["terrainSeed", "laws", "terrain"], sink);
  if (genesis === undefined) return undefined;
  const terrainSeed = readList(
    genesis.value("terrainSeed"),
    SEED_PATH,
    {
      count: GENESIS_BOUNDS.terrainSeedWords,
      entry: (word, at) => readSeedWord(word, at, sink),
    },
    sink,
  );
  const laws = readLaws(genesis.value("laws"), "/laws", sink);
  const terrain = readTerrain(genesis.value("terrain"), "/terrain", sink);
  if (terrainSeed === undefined || laws === undefined || terrain === undefined) return undefined;
  return Object.freeze({ terrainSeed, laws, terrain });
}

/** A copy of `value` as a genesis. Throws EngineError("invalid_value") with every problem. */
function parseGenesis(value: unknown): Genesis {
  const issues = new IssueList();
  const genesis = readGenesis(value, issues);
  if (genesis === undefined || issues.count > 0) throw issues.toError("invalid_value");
  return genesis;
}

/**
 * Why `value` is not a genesis: every problem with its schema, its bounds, or its canonical form,
 * with JSON Pointers relative to the genesis, at most MAX_ISSUES of them. Empty when it is one.
 */
export function genesisIssues(value: unknown): Issue[] {
  const issues = new IssueList();
  readGenesis(value, issues);
  return issues.issues;
}

/**
 * The default genesis around `terrainSeed`: laws unlike Earth's (O-13; docs/architecture/
 * worldgen.md gives the reason for each). It is a fresh copy, frozen at every level. Throws
 * EngineError("invalid_value") when `terrainSeed` is not 8 u32 words, without printing them.
 */
export function defaultGenesis(terrainSeed: readonly number[]): Genesis {
  return parseGenesis({
    terrainSeed,
    laws: {
      day: { length: 75_600, daylight: 550 },
      liquid: { level: 450 },
      thermal: { base: 400, spread: 120, lapse: { num: 3, den: 1000 }, diurnal: 60 },
      radiance: { peak: 1000, night: 40 },
    },
    terrain: {
      relief: { wavelength: 2048, octaves: 7, amplitude: 60_000 },
      substrate: { cell: 64, weights: [5, 3, 2, 1] },
      deposits: [
        { wavelength: 256, octaves: 3, threshold: 600, peak: 1000 },
        { wavelength: 512, octaves: 2, threshold: 700, peak: 1000 },
      ],
    },
  });
}

/**
 * The seal of `genesis`, which the world's global value holds next to it:
 * digest(["genesis", WORLDGEN_VERSION, genesis]). It expects a genesis that prepareGenesis accepted:
 * for anything else it throws EngineError("invalid_value"), as digest does, and that error may print
 * the offending number, which the genesis reader withholds under /terrainSeed.
 */
export function genesisSeal(genesis: Genesis): Digest {
  return digest(["genesis", WORLDGEN_VERSION, genesis]);
}

function invalidValue(message: string): EngineError {
  return new EngineError("invalid_value", [{ path: "", message }]);
}

/** What a prepared genesis keeps: the genesis, frozen at every level, and its seal. */
type Internals = { readonly genesis: Genesis; readonly seal: Digest };

/**
 * Lets PreparedGenesis tell this module from a host that reached its constructor or its internals
 * through `.constructor`, as World does. A host cannot forge it: it is a fresh symbol, never
 * exported.
 */
const MADE_HERE: unique symbol = Symbol("PreparedGenesis");

/**
 * A genesis that prepareGenesis validated and copied, for worldgen to read without validating it
 * again. It keeps its state in an ES2022 private field: no reflection reaches it, and the brand
 * check rejects a forged object without running a Proxy trap. Hosts read it through genesisOf and
 * sealOf.
 */
export class PreparedGenesis {
  readonly #internals: Internals;

  /** Not for hosts: prepareGenesis prepares geneses. A call from anywhere else throws. */
  constructor(key: symbol, genesis: Genesis) {
    if (key !== MADE_HERE) {
      throw invalidValue(
        "prepared geneses are made by prepareGenesis, not by the PreparedGenesis constructor",
      );
    }
    this.#internals = Object.freeze({ genesis, seal: genesisSeal(genesis) });
  }

  /** Whether `value` is a prepared genesis. The private brand check runs no Proxy trap. */
  static isPreparedGenesis(value: unknown): value is PreparedGenesis {
    return typeof value === "object" && value !== null && #internals in value;
  }

  /**
   * Not for hosts: the internals of `value`, for this module's functions. Throws
   * EngineError("invalid_value") for a call without this module's key, and for a value that is not
   * a prepared genesis.
   */
  static internals(key: symbol, value: unknown): Internals {
    if (key !== MADE_HERE) {
      throw invalidValue("only the worldgen module reads the internals of a prepared genesis");
    }
    if (!PreparedGenesis.isPreparedGenesis(value)) {
      throw invalidValue("the value is not a prepared genesis: prepareGenesis makes them");
    }
    return value.#internals;
  }
}

/**
 * Validates and copies `value` once, for worldgen to reuse. Throws EngineError("invalid_value")
 * with every problem genesisIssues finds.
 */
export function prepareGenesis(value: unknown): PreparedGenesis {
  return new PreparedGenesis(MADE_HERE, parseGenesis(value));
}

/** A fresh copy of the genesis of `prepared`. Throws invalid_value for a forged object. */
export function genesisOf(prepared: PreparedGenesis): Genesis {
  // copyCanonical copies every member of a Genesis, so the copy is one.
  return copyCanonical(PreparedGenesis.internals(MADE_HERE, prepared).genesis) as Genesis;
}

/**
 * The seal of the genesis of `prepared`, computed once: it identifies the genesis, as a cache key
 * would need. Throws invalid_value for a forged object.
 */
export function sealOf(prepared: PreparedGenesis): Digest {
  return PreparedGenesis.internals(MADE_HERE, prepared).seal;
}

/**
 * Not for hosts, and not exported by worldgen/index.ts: the genesis of `prepared` itself, frozen
 * at every level and shared, for worldgen modules to read on hot paths without copying. Throws
 * invalid_value for a forged object.
 */
export function sharedGenesis(prepared: PreparedGenesis): Genesis {
  return PreparedGenesis.internals(MADE_HERE, prepared).genesis;
}

/** The genesis that the global value `global` holds; undefined after an issue at /genesis. */
function readGenesisMember(global: object, issues: IssueList): Genesis | undefined {
  const value = readMember(global, "genesis", "/genesis", issues);
  if (value === UNREAD) return undefined;
  if (value === undefined) {
    issues.report("/genesis", MISSING);
    return undefined;
  }
  const before = issues.count;
  const genesis = readGenesis(value, under(issues, "/genesis"));
  return issues.count === before ? genesis : undefined;
}

/** The seal that the global value `global` holds; undefined after an issue at /genesisSeal. */
function readSealMember(global: object, issues: IssueList): string | undefined {
  const value = readMember(global, "genesisSeal", "/genesisSeal", issues);
  if (value === UNREAD) return undefined;
  if (value === undefined) {
    issues.report("/genesisSeal", MISSING);
    return undefined;
  }
  if (typeof value === "string") return value;
  issues.report("/genesisSeal", `the seal must be a string, not ${typeof value}`);
  return undefined;
}

/**
 * Why `global`, a world's global value, does not hold a sealed genesis, for a ruleset's
 * validateGlobal: it must be a record whose own members `genesis` and `genesisSeal` hold a valid
 * genesis (its problems at /genesis/...) and its seal; other members are ruleset data. A seal that
 * does not match is one issue at /genesisSeal, which prints neither seal. Each member is read once,
 * through its own descriptor (world/members.ts).
 */
export function sealedGenesisIssues(global: unknown): Issue[] {
  const issues = new IssueList();
  const notRecord = "the global value must be a record that holds genesis and genesisSeal";
  if (!expectRecord(global, "", notRecord, issues)) return issues.issues;
  const genesis = readGenesisMember(global, issues);
  const seal = readSealMember(global, issues);
  if (genesis !== undefined && seal !== undefined && genesisSeal(genesis) !== seal) {
    issues.report(
      "/genesisSeal",
      "the seal does not match the genesis: the genesis changed after it was sealed, or the seal was made for another genesis",
    );
  }
  return issues.issues;
}
