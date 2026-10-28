/**
 * The worlds and the measurements of the scale benchmark (bench/beings.ts; plan §7): beings
 * dispersed one to a chunk or concentrated in one chunk or nine, sleeping beings beside active
 * ones, and explored worlds, each run under `utility@1` and the frozen default laws, audit off.
 *
 * The terrain is the default genesis of the public label `open-origin/t4/bench`, whose seeds come
 * from SHA-256 of the label as the preregistration's do. It is no label of the preregistration:
 * measuring cost on it burns nothing. Beings are placed by rule, never by hand, around the center
 * chunk of the label's spawn area, which the preregistration's rule finds (benchCenter): dispersed
 * ones on the dry cell with the most food of each chunk, chunks taken in rings around the center.
 */
import {
  beings,
  type Command,
  canonicalize,
  createWorld,
  readView,
  type StepResult,
  snapshotBytes,
  step,
  worldgen,
} from "@open-origin/engine";
import { liveHeap } from "../../engine/bench/measure.ts";
import { sleeper } from "../../engine/test/support/beings-cost.ts";
import { Sfc32 } from "../../engine/test/support/sfc32.ts";
import { utilityController } from "../src/index.ts";
import { labelSeeds, terrainOf } from "../test/support/scenario.ts";

/** The label whose seeds give the benchmark's terrain and world. */
export const BENCH_LABEL = "open-origin/t4/bench";
/** The seconds of a tick, as in the preregistered scenario, and the ticks of a simulated day. */
export const SPS = 12;
export const DAY_TICKS = 75_600 / SPS;

const SEEDS = labelSeeds(BENCH_LABEL);
/** The benchmark's genesis, prepared once. */
export const PREPARED = worldgen.prepareGenesis(worldgen.defaultGenesis(SEEDS.terrain));
const LEVEL = worldgen.liquidLevel(worldgen.genesisOf(PREPARED));
const SIDE = worldgen.CHUNK_CELLS;

/** The species of the default laws, and the sleeping species beside it in the sleeping worlds. */
const [ACTIVE] = beings.defaultLife().species as [beings.Species];
// A copy: a canonical value is a tree, so the two species may share no member.
const SLEEPING: beings.Species = { ...structuredClone(ACTIVE), id: "s2", senses: { radius: 1 } };

export type Cell = readonly [number, number];
export type BenchWorld = ReturnType<typeof benchWorld>;

/** The center chunk of the spawn area of BENCH_LABEL, found once. */
let center: Cell | undefined;

/**
 * The center chunk of the spawn area that the preregistration's rule finds on BENCH_LABEL's
 * terrain (docs/architecture/beings.md, "Scenario"): (22, −22), about 700 cells from the origin,
 * which lies under the sea. Finding it measures the terrain's food coverage, about a second.
 */
export function benchCenter(): Cell {
  center ??= terrainOf(BENCH_LABEL).area?.center;
  if (center === undefined) throw new Error(`${BENCH_LABEL} has no spawn area`);
  return center;
}

/** The chunks around chunk `around`, ring by ring, each ring by y then x, `stride` chunks apart. */
export function* rings(stride: number, around: Cell): Generator<Cell> {
  for (let ring = 0; ; ring += 1) {
    for (let j = -ring; j <= ring; j += 1) {
      for (let i = -ring; i <= ring; i += 1) {
        // Adding the center turns the -0 of the first ring into 0, which worldgen requires.
        if (Math.max(Math.abs(i), Math.abs(j)) === ring)
          yield [around[0] + i * stride, around[1] + j * stride];
      }
    }
  }
}

/**
 * The surface of chunk `chunk` of `prepared`: each cell's elevation and food, by index y·32 + x.
 */
function surfaceOf(chunk: Cell, prepared: worldgen.PreparedGenesis = PREPARED) {
  const rect = { x: chunk[0] * SIDE, y: chunk[1] * SIDE, width: SIDE, height: SIDE };
  return worldgen.sampleSurface(prepared, rect, ACTIVE.diet.deposit);
}

/** The cell of chunk `chunk` at index `index`. */
const cellAt = (chunk: Cell, index: number): Cell => [
  chunk[0] * SIDE + (index % SIDE),
  chunk[1] * SIDE + Math.floor(index / SIDE),
];

/**
 * The dry cell of `chunk` of `prepared` with the most food, the lowest index on a tie; undefined
 * when none is dry.
 */
function bestCell(chunk: Cell, prepared: worldgen.PreparedGenesis): Cell | undefined {
  const { elevation, deposit } = surfaceOf(chunk, prepared);
  const level = prepared === PREPARED ? LEVEL : worldgen.liquidLevel(worldgen.genesisOf(prepared));
  let best = -1;
  for (let index = 0; index < SIDE * SIDE; index += 1) {
    if ((elevation[index] as number) < level) continue;
    if (best < 0 || (deposit[index] as number) > (deposit[best] as number)) best = index;
  }
  return best < 0 ? undefined : cellAt(chunk, best);
}

/**
 * The cells of `count` dispersed beings: the best cell of chunks two apart, in rings, on the
 * terrain `prepared`, the benchmark's own unless another is given.
 */
export function dispersedCells(
  count: number,
  around: Cell,
  prepared: worldgen.PreparedGenesis = PREPARED,
): Cell[] {
  const cells: Cell[] = [];
  for (const chunk of rings(2, around)) {
    if (cells.length === count) break;
    const cell = bestCell(chunk, prepared);
    if (cell !== undefined) cells.push(cell);
  }
  return cells;
}

/** The dry cells of `chunk`, by index. */
function dryCells(chunk: Cell): Cell[] {
  const { elevation } = surfaceOf(chunk);
  const cells: Cell[] = [];
  for (let index = 0; index < SIDE * SIDE; index += 1)
    if ((elevation[index] as number) >= LEVEL) cells.push(cellAt(chunk, index));
  return cells;
}

/**
 * The cells of `count` concentrated beings in a block of `side` × `side` chunks: the first block,
 * by rings around its center chunk, of which at least half of the cells are dry, the share of land
 * the preregistered spawn area needs; its dry cells, listed by chunk, then by index, are dealt out
 * evenly, so beings share cells once there are more beings than dry cells.
 */
export function concentratedCells(count: number, side: 1 | 3, around: Cell): Cell[] {
  const known = new Map<string, Cell[]>();
  const dryOf = (chunk: Cell) => {
    const key = `${chunk[0]},${chunk[1]}`;
    const cells = known.get(key) ?? dryCells(chunk);
    known.set(key, cells);
    return cells;
  };
  const half = (side - 1) / 2;
  for (const middle of rings(1, around)) {
    const block: Cell[] = [];
    for (let j = -half; j <= half; j += 1)
      for (let i = -half; i <= half; i += 1) block.push([middle[0] + i, middle[1] + j]);
    const dry = block.flatMap(dryOf);
    if (2 * dry.length < side * side * SIDE * SIDE) continue;
    const step = Math.max(1, Math.floor(dry.length / count));
    return Array.from({ length: count }, (_, n) => dry[(n * step) % dry.length] as Cell);
  }
  throw new Error("no block of dry chunks");
}

/**
 * The cells of `count` sleeping beings, one to a chunk: the middle cell of chunks taken in rings,
 * when it is dry, skipping the chunks of `taken`.
 */
export function sleepingCells(count: number, taken: readonly Cell[], around: Cell): Cell[] {
  const used = new Set(taken.map((cell) => chunkKeyOf(cell)));
  const cells: Cell[] = [];
  for (const chunk of rings(1, around)) {
    if (cells.length === count) break;
    const cell: Cell = [chunk[0] * SIDE + SIDE / 2, chunk[1] * SIDE + SIDE / 2];
    if (used.has(chunkKeyOf(cell))) continue;
    const rect = { x: cell[0], y: cell[1], width: 1, height: 1 };
    const [elevation = 0] = worldgen.sampleSurface(PREPARED, rect, ACTIVE.diet.deposit).elevation;
    if (elevation >= LEVEL) cells.push(cell);
  }
  return cells;
}

/** The key of the chunk of `cell`. */
export const chunkKeyOf = (cell: Cell) =>
  `${worldgen.chunkOfCell(cell[0])},${worldgen.chunkOfCell(cell[1])}`;

/**
 * Admin spawns at tick 1 of `species` on `cells`, with needs and traits drawn as the
 * preregistration draws them, from the test generator seeded with the label's spawn seed:
 * nutrition and rest in [600,000, 900,000], traits in the species' bounds; so the first ten
 * beings of every scenario on the same cells are the same beings. Sleeping beings start with full
 * nutrition and rest 400,000: their sleep to full rest lasts 1,323 ticks and crosses no level of
 * their body, so none wakes before tick 1,325.
 */
export function spawnsOf(species: "s1" | "s2", cells: readonly Cell[]): Command[] {
  const random = new Sfc32(SEEDS.spawn);
  const trait = () => random.between(ACTIVE.traits.min, ACTIVE.traits.max);
  return cells.map((cell, seq) => {
    const needs =
      species === "s2"
        ? { nutrition: beings.NEED_MAX, rest: 400_000 }
        : { nutrition: random.between(600_000, 900_000), rest: random.between(600_000, 900_000) };
    const traits = { appetite: trait(), sleepiness: trait(), curiosity: trait() };
    return {
      applyTick: 1,
      seq,
      type: "beings.spawn",
      origin: { kind: "admin" },
      payload: { species, cell: [cell[0], cell[1]], needs, traits },
    };
  });
}

/** A brain that times and counts its decisions: `inner` decides, unchanged. */
function timedBrain(inner: beings.Controller) {
  const record = { decisions: 0, times: [] as number[] };
  const controller: beings.Controller = {
    brain: inner.brain,
    decide: (senses) => {
      const start = Bun.nanoseconds();
      const intention = inner.decide(senses);
      record.times.push(Bun.nanoseconds() - start);
      record.decisions += 1;
      return intention;
    },
  };
  return { controller, record };
}

/**
 * A world of the benchmark at tick 0: `utility@1`, timed, for the default species, and the
 * sleeper for the sleeping species when `sleeping` is set; `chunks` already materialized.
 */
export function benchWorld(options: {
  readonly sleeping?: boolean;
  readonly chunks?: { [key: string]: beings.BeingsChunk };
}) {
  const brain = timedBrain(utilityController());
  const base = beings.defaultLife();
  const life = options.sleeping ? { ...base, species: [ACTIVE, SLEEPING] } : base;
  const controllers: { [species: string]: beings.Controller } = { s1: brain.controller };
  if (options.sleeping) controllers.s2 = sleeper();
  const world = createWorld(
    {
      seed: SEEDS.world,
      simSecondsPerTick: SPS,
      global: beings.beingsGlobal(worldgen.genesisOf(PREPARED), life),
      chunks: options.chunks ?? {},
      ruleset: beings.createBeingsRuleset({ controllers }),
    },
    { audit: false },
  );
  return { world, brain: brain.record };
}

/**
 * The wake of every being, by chunk, kept up to date from the chunks each tick changed, so that
 * the beings due at a tick are counted outside the timed step.
 */
export class Wakes {
  readonly #byChunk = new Map<string, number[]>();
  readonly #world: BenchWorld["world"];

  constructor(world: BenchWorld["world"]) {
    this.#world = world;
    this.update(readView(world).readGlobal().occupancy);
  }

  /** Reads again the chunks `keys`, which a tick changed. */
  update(keys: readonly string[]): void {
    const view = readView(this.#world);
    for (const key of keys) {
      const wakes = (view.readChunk(key)?.beings ?? []).map((being) => being.wake);
      if (wakes.length > 0) this.#byChunk.set(key, wakes);
      else this.#byChunk.delete(key);
    }
  }

  /** The beings due at `tick`. */
  due(tick: number): number {
    let count = 0;
    for (const wakes of this.#byChunk.values())
      for (const wake of wakes) if (wake <= tick) count += 1;
    return count;
  }
}

/** What one timed tick did. */
export type Sample = {
  readonly ns: number;
  readonly wakes: number;
  readonly decisions: number;
  /** The time the brain took to decide during the tick, in nanoseconds. */
  readonly decideNs: number;
  readonly events: number;
  readonly hashed: number;
};

/** A measured run: its timed ticks, the ticks before them, and what its beings cost at the end. */
export type Run = {
  readonly beings: number;
  readonly samples: readonly Sample[];
  readonly spawnMs: number;
  readonly firstMs: number;
  readonly decideNs: readonly number[];
  readonly memoryPerBeing: number;
  readonly snapshotPerBeing: number;
  readonly beingBytes: readonly number[];
};

const encoder = new TextEncoder();

/**
 * Runs `spawns` in `bench` at tick 1, `warmUp` ticks more, then times `measured` ticks; the
 * memory per being is read after the first decisions, at tick 2, before anything else is kept.
 */
export function measureRun(
  bench: BenchWorld,
  spawns: readonly Command[],
  ticks: { readonly warmUp: number; readonly measured: number },
): Run {
  const { world, brain } = bench;
  const emptySnapshot = snapshotBytes(world).length;
  const heap = liveHeap();
  const spawned = timedStep(world, spawns);
  const born = spawned.result.events.filter((event) => event.type === "being.spawned").length;
  if (born !== spawns.length) throw new Error(`${spawns.length - born} spawns were refused`);
  const first = timedStep(world, []);
  const memoryPerBeing = (liveHeap() - heap) / born;
  const wakes = new Wakes(world);
  for (let tick = 3; tick <= 2 + ticks.warmUp; tick += 1)
    wakes.update(step(world, []).changedChunks);
  const decideFrom = brain.times.length;
  const samples: Sample[] = [];
  for (let n = 0; n < ticks.measured; n += 1) {
    const due = wakes.due(readView(world).tick + 1);
    const decided = brain.decisions;
    const timedBefore = brain.times.length;
    const start = Bun.nanoseconds();
    const result = step(world, []);
    const ns = Bun.nanoseconds() - start;
    wakes.update(result.changedChunks);
    samples.push({
      ns,
      wakes: due,
      decisions: brain.decisions - decided,
      decideNs: brain.times.slice(timedBefore).reduce((total, ns) => total + ns, 0),
      events: result.events.length,
      hashed: result.stats.hashedBytes,
    });
  }
  return {
    beings: spawns.length,
    samples,
    spawnMs: spawned.ms,
    firstMs: first.ms,
    decideNs: brain.times.slice(decideFrom),
    memoryPerBeing,
    snapshotPerBeing: (snapshotBytes(world).length - emptySnapshot) / born,
    beingBytes: beingSizes(world),
  };
}

/** Steps `world` with `commands`: what the step returned and how long it took, in milliseconds. */
export function timedStep(
  world: BenchWorld["world"],
  commands: readonly Command[],
): { readonly result: StepResult; readonly ms: number } {
  const start = Bun.nanoseconds();
  const result = step(world, commands);
  return { result, ms: (Bun.nanoseconds() - start) / 1e6 };
}

/** The UTF-8 bytes of the canonical text of each being of `world`. */
function beingSizes(world: BenchWorld["world"]): number[] {
  const view = readView(world);
  return view
    .readGlobal()
    .occupancy.flatMap((key) => view.readChunk(key)?.beings ?? [])
    .map((being) => encoder.encode(canonicalize(being)).length);
}
