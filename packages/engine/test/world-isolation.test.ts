import { describe, expect, test } from "bun:test";
import { type Seed, type StepResult, stateRoot, step, type World } from "../src/index.ts";
import { tallyCommands, tallyRuleset, tallyWorld } from "./fixtures/tally-ruleset.ts";
import { Sfc32 } from "./support/sfc32.ts";

/**
 * Isolation between worlds (ADR 0020; plan §2.5, §8 "Aislamiento entre mundos"): a world is a
 * value, and the engine and tally keep no module state, so worlds that run in one process, in
 * any interleaving, give exactly what each gives alone.
 */

const TICKS = 120;
const SEEDS: readonly Seed[] = [
  [1, 2],
  [3, 4],
  [1, 2],
];

/** The results of `TICKS` ticks of a tally world with `seed`, stepped alone. */
function alone(seed: Seed): StepResult[] {
  const world = tallyWorld(seed);
  return Array.from({ length: TICKS }, (_, index) => step(world, tallyCommands(index + 1)));
}

/** Steps `worlds` in the order `pick` chooses, until each has run `TICKS` ticks. */
function interleaved(worlds: readonly World[], pick: (ready: number[]) => number): StepResult[][] {
  const results: StepResult[][] = worlds.map(() => []);
  for (;;) {
    const ready = results.flatMap((done, index) => (done.length < TICKS ? [index] : []));
    if (ready.length === 0) return results;
    const index = pick(ready);
    const done = results[index] as StepResult[];
    done.push(step(worlds[index] as World, tallyCommands(done.length + 1)));
  }
}

describe("worlds in one process", () => {
  const expected = SEEDS.map(alone);

  test("stepped in turn give what each gives alone", () => {
    const worlds = SEEDS.map((seed) => tallyWorld(seed));
    expect(interleaved(worlds, (ready) => ready[0] as number)).toEqual(expected);
    const turns = SEEDS.map((seed) => tallyWorld(seed));
    let turn = 0;
    expect(interleaved(turns, (ready) => ready[turn++ % ready.length] as number)).toEqual(expected);
  });

  test("stepped in a random interleaving give what each gives alone", () => {
    const random = new Sfc32(7);
    const worlds = SEEDS.map((seed) => tallyWorld(seed));
    expect(interleaved(worlds, (ready) => random.pick(ready))).toEqual(expected);
  });

  test("that share one ruleset object give what each gives alone", () => {
    const ruleset = tallyRuleset();
    const worlds = SEEDS.map((seed) => tallyWorld(seed, false, ruleset));
    const random = new Sfc32(11);
    expect(interleaved(worlds, (ready) => random.pick(ready))).toEqual(expected);
  });

  test("are not trivially equal: different seeds give different worlds", () => {
    const [a, b, c] = SEEDS.map((seed) => tallyWorld(seed));
    for (let tick = 1; tick <= 10; tick += 1) {
      for (const world of [a, b, c] as World[]) step(world, tallyCommands(tick));
    }
    expect(stateRoot(a as World)).not.toBe(stateRoot(b as World));
    expect(stateRoot(a as World)).toBe(stateRoot(c as World));
  });
});
