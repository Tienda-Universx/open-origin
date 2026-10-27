/**
 * Scarcity and simultaneous needs (plan §9.2, test 2): six beings in the dark around the small
 * patch of food of the patch world, which holds 353 units, about four meals. Four are hungry and
 * rested, one is hungry and tired, and one is sated and rested. The brain `utility@1` puts first
 * what docs/architecture/beings.md says it does: the hungry and rested forage the patch, the tired
 * one sleeps although it is hungry, since sleep in the dark outweighs food that only cues some,
 * and the sated one rests until dawn. The patch runs out, and a being still hungry explores. At
 * every tick, read from the state, each cell of the patch lost exactly what the beings on it ate:
 * nobody gets food twice.
 */
import { describe, expect, test } from "bun:test";
import { beings, type EngineEvent, step, worldgen } from "@open-origin/engine";
import { utilityController } from "../src/index.ts";
import {
  beingsIn,
  chunkIn,
  chunkOf,
  lightAt,
  PATCH,
  PATCH_PREPARED,
  PATCH_SPS,
  patchWorld,
  spawnsAt,
} from "./support/patch-world.ts";

const SPECIES = beings.defaultLife().species[0] as beings.Species;
const TICKS = 120;

/** The six beings, spawned at tick 1, in the dark before the first dawn. */
const BEINGS = [
  { cell: [-58, -60], nutrition: 300_000, rest: 960_000 },
  { cell: [-45, -62], nutrition: 320_000, rest: 960_000 },
  { cell: [-50, -75], nutrition: 340_000, rest: 960_000 },
  { cell: [-60, -72], nutrition: 360_000, rest: 960_000 },
  { cell: [-52, -58], nutrition: 350_000, rest: 400_000 },
  { cell: [-47, -70], nutrition: 950_000, rest: 960_000 },
] as const;

/** The cells of the patch, as "x,y", with their food before anything ate. */
const BASE: ReadonlyMap<string, number> = (() => {
  const { deposit } = worldgen.sampleSurface(PATCH_PREPARED, PATCH, SPECIES.diet.deposit);
  const base = new Map<string, number>();
  deposit.forEach((food, index) => {
    const x = PATCH.x + (index % PATCH.width);
    const y = PATCH.y + Math.floor(index / PATCH.width);
    if (food > 0) base.set(`${x},${y}`, food);
  });
  return base;
})();

/** The food of each cell of the patch in `world` after the tick `tick`, from its chunk's depletion. */
function patchFood(world: ReturnType<typeof patchWorld>, tick: number): Map<string, number> {
  const food = new Map<string, number>();
  for (const [key, base] of BASE) {
    const [x = 0, y = 0] = key.split(",").map(Number);
    const index = worldgen.cellOffset(y) * worldgen.CHUNK_CELLS + worldgen.cellOffset(x);
    const entry = chunkIn(world, chunkOf([x, y]))?.depletion.find((taken) => taken.cell === index);
    const seconds = entry === undefined ? 0 : (tick - entry.since) * PATCH_SPS;
    const taken = entry === undefined ? 0 : beings.takenAt(entry, SPECIES.regrowth, seconds);
    food.set(key, Math.max(0, base - taken));
  }
  return food;
}

/** A decision of the brain: when, by whom, what it chose, and the being's nutrition then. */
type Decision = { tick: number; id: number; kind: string; nutrition: number };

/** `utility@1`, recording each decision into `decisions` at the tick `clock` gives. */
function recording(decisions: Decision[], clock: () => number): beings.Controller {
  const inner = utilityController();
  return {
    brain: inner.brain,
    decide: (senses) => {
      const intention = inner.decide(senses);
      const { id, needs } = senses.self;
      const { kind } = intention.behavior;
      decisions.push({ tick: clock(), id, kind, nutrition: needs.nutrition });
      return intention;
    },
  };
}

/** The units the beings of `world` ate at this tick, by the cell they ate in, from `events`. */
function eatenByCell(world: ReturnType<typeof patchWorld>, events: readonly EngineEvent[]) {
  const cells = new Map(beingsIn(world).map(({ id, cell }) => [id, `${cell[0]},${cell[1]}`]));
  const ate = new Map<string, number>();
  for (const event of events) {
    if (event.type !== "being.ate") continue;
    const { id, units } = event.payload as { id: number; units: number };
    const key = cells.get(id) ?? "";
    ate.set(key, (ate.get(key) ?? 0) + units);
  }
  return ate;
}

/**
 * Steps `world` through TICKS, the beings spawned at tick 1, calling `at` with each tick before it
 * runs. At every tick, each cell of the patch must lose exactly what the beings on it ate, read from
 * the state. Returns the units eaten, and the first tick after which no cell of the patch held a
 * bite.
 */
function runConserving(world: ReturnType<typeof patchWorld>, at: (tick: number) => void) {
  let eaten = 0;
  let gone = 0;
  for (let tick = 1; tick <= TICKS; tick += 1) {
    at(tick);
    // The food each cell will have at this tick if nobody eats it, regrowth included.
    const before = patchFood(world, tick);
    const ate = eatenByCell(world, step(world, tick === 1 ? spawnsAt(1, BEINGS) : []).events);
    const after = patchFood(world, tick);
    for (const [key, left] of after) expect((before.get(key) ?? 0) - left).toBe(ate.get(key) ?? 0);
    expect([...ate.keys()].every((key) => BASE.has(key))).toBe(true);
    for (const units of ate.values()) eaten += units;
    const bites = [...after.values()].filter((left) => left >= SPECIES.diet.cue.some);
    if (gone === 0 && bites.length === 0) gone = tick;
  }
  return { eaten, gone };
}

describe("scarcity and simultaneous needs on a small patch, in the dark (plan §9.2, test 2)", () => {
  test("puts the expected needs first, shares the food without duplicating it, and explores once it runs out", () => {
    const decisions: Decision[] = [];
    let now = 0;
    const brain = recording(decisions, () => now);
    const world = patchWorld(
      [3, 5],
      beings.createBeingsRuleset({ controllers: { s1: brain } }),
      false,
    );
    expect(lightAt(2)).toBeLessThanOrEqual(100);
    // The patch: 17 cells and 353 units, 6 of its cells with a bite or more.
    expect([BASE.size, [...BASE.values()].reduce((a, b) => a + b, 0)]).toEqual([17, 353]);
    const { eaten, gone } = runConserving(world, (tick) => {
      now = tick;
    });

    // Each being's first decision, at tick 2, in the dark.
    const first = [1, 2, 3, 4, 5, 6].map(
      (id) => decisions.find((decision) => decision.id === id)?.kind,
    );
    expect(first).toEqual(["forage", "forage", "forage", "forage", "sleep", "rest"]);
    // The food ran out: no cell of the patch holds a bite any more, and the beings ate most of it.
    expect(gone).toBeGreaterThan(0);
    expect(eaten).toBeGreaterThan(353 / 2);
    // A being still hungry explores once the patch holds no bite.
    const searching = decisions.filter(
      ({ tick, kind, nutrition }) => tick >= gone && kind === "explore" && nutrition < 600_000,
    );
    expect(searching.length).toBeGreaterThan(0);
    // The tired being sleeps through: it decided once.
    expect(decisions.filter(({ id }) => id === 5)).toHaveLength(1);
  });
});
