import {
  type CanonicalValue,
  type Command,
  type CommandOrigin,
  createWorld,
  type Seed,
  type World,
} from "../../src/index.ts";
import {
  defaultGenesis,
  type Genesis,
  genesisOf,
  genesisSeal,
  MAX_CELL,
  MAX_CHUNK,
  MIN_CELL,
  MIN_CHUNK,
  observableCatalog,
  prepareGenesis,
  timeLawIssues,
} from "../../src/worldgen/index.ts";
import type { ProbeGlobal } from "../fixtures/probe-ruleset.ts";
import type { SuiteRuleset } from "./determinism-records.ts";
import { Sfc32 } from "./sfc32.ts";

/**
 * Probe worlds (ADR 0021, "Proof without a production ruleset"; plan §12, test 13): the world
 * factory that runs the probe ruleset (fixtures/probe-ruleset.ts) under the determinism suite, the
 * calendar boundaries of its laws, and a seeded script of commands that materializes chunks and
 * measures observables. The suite test and the observer test share them.
 */

/** The simulated seconds each tick of a probe world lasts. */
export const PROBE_SECONDS_PER_TICK = 12;

/**
 * The day of a probe world: 600 seconds, 50 ticks, so that a run of a few hundred ticks crosses
 * many dawns and dusks. Its light period is ⌊600 × 550 / 1000⌋ = 330 seconds, which no tick of
 * 12 seconds starts at, so each dusk falls inside a tick.
 */
const PROBE_DAY = Object.freeze({ length: 600, daylight: 550 });

/**
 * The terrain seed of the probe world whose world seed is `seed`: a distinct one for each world
 * seed, so that the suite's interleaving, whose second world has the second seed, covers terrain.
 */
function terrainSeedOf(seed: Seed): number[] {
  return [seed[0], seed[1], 1, 2, 3, 4, 5, 6];
}

/**
 * The genesis of the probe world with the world seed `seed`: the default laws and terrain around
 * its terrain seed, with PROBE_DAY, validated and copied by prepareGenesis.
 */
export function probeGenesis(seed: Seed): Genesis {
  const base = defaultGenesis(terrainSeedOf(seed));
  return genesisOf(prepareGenesis({ ...base, laws: { ...base.laws, day: PROBE_DAY } }));
}

/** The global value of a new probe world under `genesis`: its seal, and no chunk watched. */
export function probeGlobal(genesis: Genesis): ProbeGlobal {
  return { genesis, genesisSeal: genesisSeal(genesis), watch: [] };
}

/**
 * A probe world at tick 0 with the world seed `seed`, running `ruleset`, under audit when `audit`
 * is true, as DeterminismSubject.world requires. It holds no chunk: the latent world is
 * materialized only by commands. validateGlobal cannot see the seconds per tick, so the factory
 * checks the time laws with timeLawIssues before createWorld, as the host contract requires.
 */
export function probeWorld(seed: Seed, ruleset: SuiteRuleset, audit: boolean): World {
  const genesis = probeGenesis(seed);
  const problems = timeLawIssues(genesis.laws, PROBE_SECONDS_PER_TICK);
  if (problems.length > 0) {
    throw new Error(`the probe world's time laws are invalid: ${JSON.stringify(problems)}`);
  }
  const init = {
    seed,
    simSecondsPerTick: PROBE_SECONDS_PER_TICK,
    global: probeGlobal(genesis),
    chunks: {},
    ruleset,
  };
  return createWorld(init, { audit });
}

/**
 * The ticks in [1, ticks] at which a probe world crosses a calendar boundary: each dawn, which
 * also starts a day, and each dusk. A boundary at simulated second s falls at the first tick at or
 * past it, ⌈s / 12⌉. Computed from PROBE_DAY with plain arithmetic, not with the calendar, so that
 * it checks the probe's use of the calendar instead of repeating it. Day 0's dawn is tick 0, which
 * no step computes.
 */
export function boundaryTicks(ticks: number): number[] {
  const light = Math.floor((PROBE_DAY.length * PROBE_DAY.daylight) / 1000);
  const found: number[] = [];
  for (let dawn = 0; ; dawn += PROBE_DAY.length) {
    for (const second of [dawn, dawn + light]) {
      const tick = Math.ceil(second / PROBE_SECONDS_PER_TICK);
      if (tick > ticks) return found;
      if (tick > 0) found.push(tick);
    }
  }
}

/** The ids of every observable of a probe world: the five fixed ones and two deposits. */
export const PROBE_IDS: readonly string[] = observableCatalog(
  prepareGenesis(probeGenesis([0, 0])),
).map(({ id }) => id);

/**
 * The chunks a script materializes first, in this order: the origin, its negative neighbors, the
 * midpoints of the four edges, and two corners of the world. Later chunks are drawn near the
 * origin.
 */
const FIRST_CHUNKS: readonly (readonly [number, number])[] = [
  [0, 0],
  [-1, -1],
  [MIN_CHUNK, 0],
  [0, MAX_CHUNK],
  [-1, 0],
  [MAX_CHUNK, MAX_CHUNK],
  [MIN_CHUNK, MIN_CHUNK],
  [0, MIN_CHUNK],
  [MAX_CHUNK, 0],
  [0, -1],
];

/** How far from the origin, in chunks, a script draws the chunks after FIRST_CHUNKS. */
const NEAR_CHUNKS = 24;

/** One tick in this many, on average, materializes a chunk, besides the forced ones. */
const MATERIALIZE_ODDS = 14;

/** One tick in this many, on average, measures an observable. */
const MEASURE_ODDS = 3;

/**
 * The commands that each script sends at a fixed tick and that are rejected: a chunk outside the
 * world, a chunk already materialized, a materialization sent by an inhabitant, and a query whose
 * id names no observable and whose cell lies outside the world.
 */
export const REJECTED = Object.freeze({
  outside: { tick: 7, payload: { x: MAX_CHUNK + 1, y: 0 } },
  duplicate: { tick: 9, payload: { x: 0, y: 0 } },
  inhabitant: { tick: 11, payload: { x: 5, y: 5 } },
  query: { tick: 13, payload: { id: "deposit.2", cell: { x: MAX_CELL + 1, y: 0 } } },
});

/** A probe script: the commands of each tick from tick 1, and the ticks that create a chunk. */
export type ProbeScript = {
  readonly commands: readonly (readonly Command[])[];
  /** The ticks whose materialization is accepted, each creating one chunk, in order. */
  readonly materializations: readonly number[];
};

/** Builds the commands of one tick, in seq order. */
class TickCommands {
  readonly tick: number;
  readonly commands: Command[] = [];

  constructor(tick: number) {
    this.tick = tick;
  }

  add(type: string, origin: CommandOrigin, payload: CanonicalValue): void {
    const seq = this.commands.length;
    this.commands.push({ applyTick: this.tick, seq, type, origin, payload });
  }
}

const ADMIN: CommandOrigin = { kind: "admin" };

/** The state of a script being generated: its random draws and what it has sent so far. */
class ScriptWriter {
  readonly random: Sfc32;
  readonly sent = new Set<string>();
  readonly materializations: number[] = [];
  #measures = 0;

  constructor(seed: number) {
    this.random = new Sfc32(seed);
  }

  /** The next chunk to materialize: FIRST_CHUNKS in order, then new chunks near the origin. */
  nextChunk(): { x: number; y: number } {
    for (;;) {
      const first = FIRST_CHUNKS[this.sent.size];
      const near = () => this.random.between(-NEAR_CHUNKS, NEAR_CHUNKS);
      const [x, y] = first ?? [near(), near()];
      if (!this.sent.has(`${x},${y}`)) return { x, y };
    }
  }

  /** Adds an accepted materialization of the next chunk to `tick`. */
  materialize(tick: TickCommands): void {
    const chunk = this.nextChunk();
    this.sent.add(`${chunk.x},${chunk.y}`);
    this.materializations.push(tick.tick);
    tick.add("probe.materialize", ADMIN, chunk);
  }

  /** A cell for a measurement: mostly near the origin, sometimes at the edges of the world. */
  cell(): { x: number; y: number } {
    const coordinate = () =>
      this.random.below(4) === 0
        ? this.random.pick([MIN_CELL, MAX_CELL, -1])
        : this.random.between(-1024, 1023);
    return { x: coordinate(), y: coordinate() };
  }

  /** Adds a measurement of the next observable in PROBE_IDS to `tick`, from a varying origin. */
  measure(tick: TickCommands): void {
    const id = PROBE_IDS[this.#measures % PROBE_IDS.length] ?? "elevation";
    this.#measures += 1;
    const actor = this.random.between(0, 9);
    const origin: CommandOrigin = actor === 0 ? ADMIN : { kind: "inhabitant", actor };
    tick.add("probe.measure", origin, { id, cell: this.cell() });
  }
}

/** Adds the rejected commands of REJECTED that fall at `tick`. */
function addRejected(tick: TickCommands): void {
  const { outside, duplicate, inhabitant, query } = REJECTED;
  if (tick.tick === outside.tick) tick.add("probe.materialize", ADMIN, outside.payload);
  if (tick.tick === duplicate.tick) tick.add("probe.materialize", ADMIN, duplicate.payload);
  if (tick.tick === inhabitant.tick) {
    tick.add("probe.materialize", { kind: "inhabitant", actor: 3 }, inhabitant.payload);
  }
  if (tick.tick === query.tick) tick.add("probe.measure", ADMIN, query.payload);
}

/**
 * The seeded script of a probe run of `ticks` ticks. Tick 1 and the first calendar boundary each
 * materialize a chunk, so that the boundaries change chunks from the first one on; other ticks
 * materialize one in MATERIALIZE_ODDS and measure one in MEASURE_ODDS, cycling through every
 * observable id at random cells; and the commands of REJECTED are sent at their ticks.
 */
export function probeScript(randomSeed: number, ticks: number): ProbeScript {
  const writer = new ScriptWriter(randomSeed);
  const forced = new Set([1, boundaryTicks(ticks)[0]]);
  const commands = Array.from({ length: ticks }, (_, index) => {
    const tick = new TickCommands(index + 1);
    addRejected(tick);
    const draw = writer.random.below(MATERIALIZE_ODDS) === 0;
    if (forced.has(tick.tick) || draw) writer.materialize(tick);
    if (writer.random.below(MEASURE_ODDS) === 0) writer.measure(tick);
    return tick.commands;
  });
  return { commands, materializations: writer.materializations };
}
