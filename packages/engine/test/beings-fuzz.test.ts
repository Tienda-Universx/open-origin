/**
 * Seeded fuzzing of the beings ruleset (plan §9.2, test 12) and the count of its reads (test 14's
 * harness): random spawns, valid and invalid, and a random brain, valid and invalid, whose choices
 * come from its own draws; after every tick, the invariants of docs/architecture/beings.md hold.
 * A quiet tick reads each listed chunk once and never lists every chunk; beings-cost.test.ts bounds
 * the reads of every tick.
 */
import { describe, expect, test } from "bun:test";
import {
  beings,
  type Command,
  createWorld,
  type EngineEvent,
  readView,
  step,
  worldgen,
  worldStatus,
} from "../src/index.ts";
import { type Calls, counting, DISPERSED_CELLS } from "./support/beings-cost.ts";
import {
  type BeingsWorld,
  baseFood,
  behavior,
  beingsWorld,
  brain,
  chunkOf,
  idler,
  lifeWith,
  PREPARED,
  SPECIES,
  spawn,
  testGenesis,
} from "./support/beings-world.ts";
import { Sfc32 } from "./support/sfc32.ts";

/** The steps a random brain may propose, the last ones invalid on purpose. */
function randomSteps(pick: (bound: number) => number): unknown {
  switch (pick(7)) {
    case 0:
      return [{ kind: "idle", ms: 1 + pick(400_000) }];
    case 1:
      return [{ kind: "walk", dirs: Array.from({ length: 1 + pick(8) }, () => pick(8)).join("") }];
    case 2:
      return [
        { kind: "eat", untilNutrition: pick(1_000_001) },
        { kind: "idle", ms: 30_000 },
      ];
    case 3:
      return [{ kind: "sleep", untilRest: pick(1_000_001) }];
    case 4:
      return [
        { kind: "walk", dirs: `${pick(8)}` },
        { kind: "eat", untilNutrition: 950_000 },
      ];
    case 5:
      return [
        { kind: "idle", ms: 1 },
        { kind: "walk", dirs: "0" },
      ];
    default:
      return [{ kind: "fly" }];
  }
}

/** A random brain: a pure function of its senses, whose choices come from its two draws. */
const chaotic = brain((senses) => {
  const [a = 0, b = 0] = senses.draws;
  const generator = new Sfc32((a ^ (b << 1)) >>> 0);
  const pick = (bound: number) => generator.below(bound);
  const wakeWhen: { [name: string]: number } = {};
  if (pick(3) === 0) wakeWhen.nutritionBelow = pick(1_000_001);
  if (pick(4) === 0) wakeWhen.lightBelow = pick(2000);
  if (pick(4) === 0) wakeWhen.lightAbove = pick(2000);
  return {
    steps: randomSteps(pick),
    wakeWhen,
    behavior: behavior(`b${pick(3)}`, pick(8)),
  } as never;
});

/** Where the fuzz spawns beings: a patch of the test terrain with food, east of the origin. */
const AREA = Object.freeze({ x: 60, y: -70, width: 81, height: 81 });

/** The cells of AREA with at least one bite of food, where half of the spawns land. */
const FOOD_CELLS: readonly (readonly [number, number])[] = (() => {
  const { deposit } = worldgen.sampleSurface(PREPARED, AREA, SPECIES.diet.deposit);
  const cells: [number, number][] = [];
  deposit.forEach((food, index) => {
    const cell: [number, number] = [
      AREA.x + (index % AREA.width),
      AREA.y + Math.floor(index / AREA.width),
    ];
    if (food >= SPECIES.diet.biteUnits) cells.push(cell);
  });
  return cells;
})();

/** A random spawn, valid most of the time, in AREA and often on food. */
function randomSpawn(random: Sfc32, applyTick: number, seq: number): Command {
  const fed = FOOD_CELLS[random.below(2 * FOOD_CELLS.length)];
  const anywhere = [AREA.x + random.below(AREA.width), AREA.y + random.below(AREA.height)];
  const cell = fed === undefined ? anywhere : [...fed];
  const needs = { nutrition: random.below(1_000_001), rest: random.below(1_000_001) };
  if (random.below(8) === 0) return spawn(applyTick, { species: "nobody", cell }, seq);
  if (random.below(8) === 0)
    return spawn(applyTick, { species: SPECIES.id, cell: [2 ** 31, 0] }, seq);
  return spawn(applyTick, { species: SPECIES.id, cell, needs }, seq);
}

/** Every materialized chunk of a world at its tick, each read once. */
type Chunks = ReadonlyMap<string, beings.BeingsChunk>;

/** The chunks of `world`, read once each through its view. */
function chunksOf(world: BeingsWorld): Chunks {
  const view = readView(world);
  return new Map(view.chunkKeys().map((key) => [key, view.readChunk(key) as beings.BeingsChunk]));
}

/** The food of each cell of the test terrain before any being ate, sampled once per cell. */
const BASE_FOOD = new Map<string, number>();

/** The food of `cell` before any being ate, from BASE_FOOD. */
function baseAt(cell: readonly [number, number]): number {
  const key = `${cell[0]},${cell[1]}`;
  const known = BASE_FOOD.get(key);
  if (known !== undefined) return known;
  const food = baseFood(cell);
  BASE_FOOD.set(key, food);
  return food;
}

/** The effective food of `cell` at `tick`, from the depletion of its chunk in `chunks`. */
function foodAt(chunks: Chunks, cell: readonly [number, number], tick: number): number {
  const index = worldgen.cellOffset(cell[1]) * 32 + worldgen.cellOffset(cell[0]);
  const entry = chunks.get(chunkOf(cell))?.depletion.find((candidate) => candidate.cell === index);
  if (entry === undefined) return baseAt(cell);
  return baseAt(cell) - beings.takenAt(entry, SPECIES.regrowth, (tick - entry.since) * 12);
}

/** Every being in `chunks`. */
function beingsIn(chunks: Chunks): beings.Being[] {
  return [...chunks.values()].flatMap((chunk) => chunk.beings);
}

/** Every invariant of the beings of `world` at its tick, over its chunks read once. */
function checkInvariants(world: BeingsWorld, chunks: Chunks): void {
  const view = readView(world);
  const { occupancy } = view.readGlobal();
  expect([...occupancy].sort()).toEqual([...new Set(occupancy)].sort());
  for (const key of occupancy) expect(chunks.has(key)).toBe(true);
  const ids: number[] = [];
  for (const [key, chunk] of chunks) {
    if (chunk.beings.length > 0) expect(occupancy).toContain(key);
    expect(chunk.due).toBe(beings.dueOf(chunk.beings));
    for (const being of chunk.beings) {
      ids.push(being.id);
      expect(chunkOf(being.cell)).toBe(key);
      expect(being.wake).toBeGreaterThan(view.tick);
    }
    const [cx = 0, cy = 0] = key.split(",").map(Number);
    for (const entry of chunk.depletion) {
      const cell = [cx * 32 + (entry.cell % 32), cy * 32 + Math.floor(entry.cell / 32)] as const;
      const food = foodAt(chunks, cell, view.tick);
      expect(food).toBeGreaterThanOrEqual(0);
      expect(food).toBeLessThanOrEqual(baseAt(cell));
    }
  }
  expect(new Set(ids).size).toBe(ids.length);
}

/** The units each cell lost to the beings that ate on it at this tick, from `events`. */
function eatenCells(chunks: Chunks, events: readonly EngineEvent[]): Map<string, number> {
  const eaten = new Map<string, number>();
  const all = beingsIn(chunks);
  for (const event of events) {
    if (event.type !== "being.ate") continue;
    const { id, units } = event.payload as { id: number; units: number };
    const being = all.find((candidate) => candidate.id === id);
    if (being === undefined) throw new Error(`the being ${id} that ate is in no chunk`);
    const key = `${being.cell[0]},${being.cell[1]}`;
    eaten.set(key, (eaten.get(key) ?? 0) + units);
  }
  return eaten;
}

/** The cell of the text `x,y`. */
function toCell(key: string): [number, number] {
  const [x = 0, y = 0] = key.split(",").map(Number);
  return [x, y];
}

describe("fuzzing", () => {
  test.each([1, 2, 3])("keeps every invariant after each tick (seed %i)", (seed) => {
    const random = new Sfc32(seed);
    // A small radius keeps each of the many decisions cheap: the fuzz is after the tick's
    // invariants, and beings-senses.test.ts covers the window itself.
    const life = lifeWith((species) => ({ ...species, senses: { radius: 4 } }));
    const world = beingsWorld({ controllers: { [SPECIES.id]: chaotic }, seed: [seed, 99], life });
    let spawned = 0;
    let bites = 0;
    for (let tick = 1; tick <= 250; tick += 1) {
      let count = random.below(30) === 0 ? 1 : 0;
      if (tick < 20) count = random.below(3);
      const commands = Array.from({ length: count }, (_, seq) => randomSpawn(random, tick, seq));
      // The food each being's cell will have at this tick if nobody eats it, regrowth included.
      const earlier = chunksOf(world);
      const before = new Map(
        beingsIn(earlier).map(({ cell }) => [`${cell[0]},${cell[1]}`, foodAt(earlier, cell, tick)]),
      );
      const { events } = step(world, commands);
      spawned += events.filter((event) => event.type === "being.spawned").length;
      const chunks = chunksOf(world);
      checkInvariants(world, chunks);
      // Conservation: each cell lost exactly what the beings on it ate this tick, and no more.
      const eaten = eatenCells(chunks, events);
      bites += eaten.size;
      for (const [key, food] of before) {
        expect(food - foodAt(chunks, toCell(key), tick)).toBe(eaten.get(key) ?? 0);
      }
      for (const key of eaten.keys()) expect(before.has(key)).toBe(true);
    }
    // Neither check is vacuous: beings were spawned on food, and some of them ate.
    expect(FOOD_CELLS.length).toBeGreaterThan(20);
    expect(spawned).toBeGreaterThan(5);
    expect(bites).toBeGreaterThan(0);
    expect(worldStatus(world)).toEqual({ kind: "ok", tick: 250 });
  });
});

/** A beings world whose system records its calls into `sink`, one record per tick. */
function countedWorld(sink: Calls[]): BeingsWorld {
  const ruleset = beings.createBeingsRuleset({ controllers: { [SPECIES.id]: idler(6_000_000) } });
  return createWorld({
    seed: [5, 6],
    simSecondsPerTick: 12,
    global: beings.beingsGlobal(testGenesis(), beings.defaultLife()),
    chunks: {},
    ruleset: counting(ruleset, sink),
  });
}

describe("the cost of a tick", () => {
  test("reads each listed chunk once on a quiet tick, never lists the chunks, and writes the global at most once", () => {
    const counts: Calls[] = [];
    const world = countedWorld(counts);
    step(
      world,
      DISPERSED_CELLS.map((cell, seq) => spawn(1, { species: SPECIES.id, cell: [...cell] }, seq)),
    );
    for (let tick = 2; tick <= 150; tick += 1) step(world, []);
    const listed = readView(world).readGlobal().occupancy.length;
    expect(listed).toBe(10);
    expect(counts.every((reads) => reads.chunkKeys === 0 && reads.writeGlobal <= 1)).toBe(true);
    // Tick 2 decides for every being. Their idles last 500 ticks, but a being is processed at least
    // once a simulated day: at tick 102 each is read and written again, without a decision. The
    // day turns at tick 100, where the prune reads each listed chunk again.
    const busy = new Set([2, 100, 102]);
    const quiet = counts.filter((_, index) => !busy.has(index + 1));
    expect(quiet.every((reads) => reads.readChunk === listed)).toBe(true);
    expect(counts[101]?.readChunk).toBe(2 * listed);
    expect(counts[99]?.readChunk).toBe(2 * listed);
  });
});
