import {
  beings,
  type Command,
  type EngineEvent,
  readView,
  step,
  worldgen,
} from "@open-origin/engine";
import type { ScenarioWorld, SpawnPayload } from "./scenario.ts";

/**
 * What a run of the preregistered scenario did, read from its events and from the state at the
 * ticks they happened, against the acceptance of docs/architecture/beings.md ("Evaluation"). The
 * runner only observes: it reads the world after each step and never changes what happens. Every
 * event of every tick is counted; the state is read only at the ticks whose events need it.
 */

/** What a run needs: its world, the spawns of tick 1 and their payloads, and its terrain. */
export type RunInput = {
  readonly world: ScenarioWorld;
  readonly spawns: readonly Command[];
  readonly payloads: readonly SpawnPayload[];
  readonly prepared: worldgen.PreparedGenesis;
};

/** What one being did over a run. */
export type BeingRecord = {
  readonly id: number;
  readonly born: readonly [number, number];
  incapacitated: number;
  died: number;
  exhausted: number;
  rejected: number;
  /** The cells it ate in, as "x,y", and whether one lies outside the window it was born in. */
  readonly mealCells: string[];
  ateOutsideBirthWindow: boolean;
  meals: number;
  /** Meals whose nutrition, from their start to their end, rose by at least 300,000. */
  bigMeals: number;
  sleeps: number;
  /** Sleeps that ended with rest at least 900,000. */
  restedWakes: number;
  walked: number;
  /** The lowest nutrition and health seen at any of its events. */
  lowestNutrition: number;
  lowestHealth: number;
};

/** What a whole run did. */
export type RunRecord = {
  readonly beings: readonly BeingRecord[];
  /** Whether some cell was emptied, regrew to at least half its deposit, and was eaten again. */
  regrewAndEaten: boolean;
  decisions: number;
  wallMs: number;
};

/** The thresholds of the acceptance list. */
export const ACCEPTANCE = Object.freeze({
  bigMeal: 300_000,
  restedWake: 900_000,
  mealCells: 5,
  bigMeals: 5,
  sleeps: 9,
  restedWakes: 9,
  walked: 320,
});

/** A walk in progress: when it started and the cumulative milliseconds of its arrivals. */
type Walk = { readonly start: number; readonly ms: readonly number[] };

/** What the runner keeps between ticks for each being and cell. */
type Tracker = {
  readonly run: RunInput;
  readonly species: beings.Species;
  readonly sps: number;
  readonly records: Map<number, BeingRecord>;
  readonly mealStart: Map<number, number>;
  readonly walks: Map<number, Walk>;
  /** Cells emptied by a meal, by "x,y". */
  readonly emptied: Set<string>;
  readonly base: Map<string, number>;
  regrewAndEaten: boolean;
};

/** The beings of the world after its last step, by id. */
function beingsNow(tracker: Tracker): Map<number, beings.Being> {
  const view = readView(tracker.run.world);
  const found = new Map<number, beings.Being>();
  for (const key of view.readGlobal().occupancy) {
    for (const being of view.readChunk(key)?.beings ?? [])
      found.set(being.id, being as beings.Being);
  }
  return found;
}

/** The body of `being` at `tick`, in closed form. */
function bodyOf(tracker: Tracker, being: beings.Being, tick: number): beings.Body {
  return beings.bodyAt(tracker.species, being, tick, tracker.sps);
}

/** The deposit of `cell` before anything ate it. */
function baseOf(tracker: Tracker, cell: readonly [number, number]): number {
  const key = `${cell[0]},${cell[1]}`;
  const known = tracker.base.get(key);
  if (known !== undefined) return known;
  const rect = { x: cell[0], y: cell[1], width: 1, height: 1 };
  const deposit =
    worldgen.sampleSurface(tracker.run.prepared, rect, tracker.species.diet.deposit).deposit[0] ??
    0;
  tracker.base.set(key, deposit);
  return deposit;
}

/** The food left in `cell` after the tick `tick`, from its chunk's depletion. */
function foodLeft(tracker: Tracker, cell: readonly [number, number], tick: number): number {
  const view = readView(tracker.run.world);
  const key = `${worldgen.chunkOfCell(cell[0])},${worldgen.chunkOfCell(cell[1])}`;
  const index = worldgen.cellOffset(cell[1]) * worldgen.CHUNK_CELLS + worldgen.cellOffset(cell[0]);
  const entry = view.readChunk(key)?.depletion.find((candidate) => candidate.cell === index);
  const base = baseOf(tracker, cell);
  if (entry === undefined) return base;
  const seconds = (tick - entry.since) * tracker.sps;
  return Math.max(0, base - beings.takenAt(entry, tracker.species.regrowth, seconds));
}

/** Records the meals of one tick: their cells, and the cells they emptied or found regrown. */
function recordMeals(
  tracker: Tracker,
  tick: number,
  ate: readonly EngineEvent[],
  now: Map<number, beings.Being>,
): void {
  const eatenAt = new Map<string, number>();
  for (const event of ate) {
    const { id, units } = event.payload as { id: number; units: number };
    const being = now.get(id);
    const record = tracker.records.get(id);
    if (being === undefined || record === undefined) continue;
    const key = recordMealCell(tracker, record, being.cell);
    eatenAt.set(key, (eatenAt.get(key) ?? 0) + units);
  }
  for (const [key, units] of eatenAt) recordCellFood(tracker, { key, units, tick });
}

/**
 * Records what a meal left in a cell: emptied, or eaten again after it was emptied and regrew to
 * at least half its deposit before the bites of this tick.
 */
function recordCellFood(
  tracker: Tracker,
  meal: { readonly key: string; readonly units: number; readonly tick: number },
): void {
  const [x = 0, y = 0] = meal.key.split(",").map(Number);
  const left = foodLeft(tracker, [x, y], meal.tick);
  if (tracker.emptied.has(meal.key) && 2 * (left + meal.units) >= baseOf(tracker, [x, y]))
    tracker.regrewAndEaten = true;
  if (left === 0) tracker.emptied.add(meal.key);
}

/** Records that `record`'s being ate in `cell`, and whether outside its birth window; its key. */
function recordMealCell(
  tracker: Tracker,
  record: BeingRecord,
  cell: readonly [number, number],
): string {
  const key = `${cell[0]},${cell[1]}`;
  if (!record.mealCells.includes(key)) record.mealCells.push(key);
  const away = Math.max(Math.abs(cell[0] - record.born[0]), Math.abs(cell[1] - record.born[1]));
  if (away > tracker.species.senses.radius) record.ateOutsideBirthWindow = true;
  return key;
}

/** The steps of `walk` that arrived by `tick`, at `sps` seconds per tick. */
function arrivedBy(walk: Walk, tick: number, sps: number): number {
  return walk.ms.filter((ms) => walk.start + Math.ceil(ms / (sps * 1000)) <= tick).length;
}

/** Records one event of one being, read against its state after the tick. */
function recordEvent(tracker: Tracker, event: EngineEvent, being: beings.Being | undefined): void {
  const payload = event.payload as { id: number; activity?: string; result?: string };
  const record = tracker.records.get(payload.id);
  if (record === undefined) return;
  if (event.type === "being.incapacitated") record.incapacitated += 1;
  if (event.type === "being.died") record.died += 1;
  if (event.type === "being.exhausted") record.exhausted += 1;
  if (event.type === "being.intention_rejected") record.rejected += 1;
  if (being === undefined) return;
  const body = bodyOf(tracker, being, event.tick);
  record.lowestNutrition = Math.min(record.lowestNutrition, body.nutrition);
  record.lowestHealth = Math.min(record.lowestHealth, body.health);
  if (event.type === "being.started") started(tracker, record, being, event);
  if (event.type === "being.finished") finished(tracker, record, body, event);
}

/** A being started an activity: a meal's nutrition, a walk's schedule, a sleep counted. */
function started(
  tracker: Tracker,
  record: BeingRecord,
  being: beings.Being,
  event: EngineEvent,
): void {
  const { activity } = event.payload as { activity: string };
  if (activity === "eat")
    tracker.mealStart.set(record.id, bodyOf(tracker, being, event.tick).nutrition);
  if (activity === "sleep") record.sleeps += 1;
  if (activity === "walk" && being.activity.kind === "walk")
    tracker.walks.set(record.id, { start: being.activity.start, ms: [...being.activity.ms] });
}

/** A being finished an activity: a meal measured, a sleep's rest read, a walk's steps counted. */
function finished(
  tracker: Tracker,
  record: BeingRecord,
  body: beings.Body,
  event: EngineEvent,
): void {
  const { activity } = event.payload as { activity: string };
  if (activity === "eat") {
    const start = tracker.mealStart.get(record.id) ?? body.nutrition;
    record.meals += 1;
    if (body.nutrition - start >= ACCEPTANCE.bigMeal) record.bigMeals += 1;
  }
  if (activity === "sleep" && body.rest >= ACCEPTANCE.restedWake) record.restedWakes += 1;
  const walk = tracker.walks.get(record.id);
  if (activity === "walk" && walk !== undefined) {
    record.walked += arrivedBy(walk, event.tick, tracker.sps);
    tracker.walks.delete(record.id);
  }
}

/** The records of a new run, one per payload, ids from 1 in spawn order. */
function newTracker(run: RunInput): Tracker {
  const view = readView(run.world);
  const species = view.readGlobal().life.species[0] as beings.Species;
  const records = new Map<number, BeingRecord>();
  run.payloads.forEach((payload, index) => {
    records.set(index + 1, {
      id: index + 1,
      born: payload.cell,
      incapacitated: 0,
      died: 0,
      exhausted: 0,
      rejected: 0,
      mealCells: [],
      ateOutsideBirthWindow: false,
      meals: 0,
      bigMeals: 0,
      sleeps: 0,
      restedWakes: 0,
      walked: 0,
      lowestNutrition: payload.needs.nutrition,
      lowestHealth: beings.NEED_MAX,
    });
  });
  const maps = { mealStart: new Map(), walks: new Map(), base: new Map() };
  const sps = view.simSecondsPerTick;
  return { run, species, sps, records, ...maps, emptied: new Set(), regrewAndEaten: false };
}

/**
 * The events after which the runner reads the state: those whose metrics need the body, the
 * cell, or the activity of a being. Every other event is counted from its payload alone.
 */
const READ_FOR = new Set(["being.started", "being.finished", "being.ate", "being.incapacitated"]);

/**
 * Runs `run` to tick `ticks`, the spawns at tick 1, and records what its beings did. The
 * decisions are counted by `counted`, which the caller wraps around the brain.
 */
export function runScenario(
  run: RunInput,
  ticks: number,
  counted: { readonly decisions: () => number },
): RunRecord {
  const tracker = newTracker(run);
  const started = performance.now();
  for (let tick = 1; tick <= ticks; tick += 1) {
    const { events } = step(run.world, tick === 1 ? run.spawns : []);
    const now = events.some((event) => READ_FOR.has(event.type)) ? beingsNow(tracker) : undefined;
    for (const event of events) {
      const id = (event.payload as { id?: number }).id ?? 0;
      recordEvent(tracker, event, now?.get(id));
    }
    const ate = events.filter((event) => event.type === "being.ate");
    if (now !== undefined && ate.length > 0) recordMeals(tracker, tick, ate, now);
  }
  return {
    beings: [...tracker.records.values()],
    regrewAndEaten: tracker.regrewAndEaten,
    decisions: counted.decisions(),
    wallMs: performance.now() - started,
  };
}

/** A brain that counts its decisions, for a run's cost: `inner` decides, unchanged. */
export function countingBrain(inner: beings.Controller): {
  readonly controller: beings.Controller;
  readonly decisions: () => number;
} {
  let decisions = 0;
  const controller: beings.Controller = {
    brain: inner.brain,
    decide: (senses) => {
      decisions += 1;
      return inner.decide(senses);
    },
  };
  return { controller, decisions: () => decisions };
}

/** The acceptance items a being's record misses, by name; empty when it meets them all. */
export function misses(record: BeingRecord): string[] {
  const items: [string, boolean][] = [
    ["incapacitated", record.incapacitated > 0],
    ["died", record.died > 0],
    ["rest 0", record.exhausted > 0],
    ["rejected", record.rejected > 0],
    ["meal cells", record.mealCells.length < ACCEPTANCE.mealCells],
    ["outside birth window", !record.ateOutsideBirthWindow],
    ["big meals", record.bigMeals < ACCEPTANCE.bigMeals],
    ["sleeps", record.sleeps < ACCEPTANCE.sleeps],
    ["rested wakes", record.restedWakes < ACCEPTANCE.restedWakes],
    ["walked", record.walked < ACCEPTANCE.walked],
  ];
  return items.filter(([, missed]) => missed).map(([name]) => name);
}
