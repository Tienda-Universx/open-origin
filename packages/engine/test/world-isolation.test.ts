import { describe, expect, test } from "bun:test";
import { type Seed, stateRoot, step, type World } from "../src/index.ts";
import { tallyCommands, tallyRuleset, tallyWorld } from "./fixtures/tally-ruleset.ts";
import { recordRun, type Script } from "./support/determinism-records.ts";
import { interleave } from "./support/determinism-suite.ts";
import { Sfc32 } from "./support/sfc32.ts";

/**
 * Isolation between worlds (ADR 0020; plan §2.5, §8 "Aislamiento entre mundos"): a world is a
 * value, and the engine and tally keep no module state, so worlds that run in one process, in
 * any interleaving, give exactly what each gives alone. The determinism suite checks a seeded
 * random interleaving of every subject; these tests add fixed orders and separate rulesets.
 */

const TICKS = 120;
const SEEDS: readonly Seed[] = [
  [1, 2],
  [3, 4],
  [1, 2],
];
const SCRIPT: Script = Array.from({ length: TICKS }, (_, index) => tallyCommands(index + 1));

/** The records of `TICKS` ticks of a tally world with `seed`, stepped alone. */
const alone = (seed: Seed) => recordRun(tallyWorld(seed), SCRIPT);

describe("worlds in one process", () => {
  const expected = SEEDS.map(alone);

  test("stepped in turn give what each gives alone", () => {
    const worlds = SEEDS.map((seed) => tallyWorld(seed));
    expect(interleave(worlds, SCRIPT, (ready) => ready[0] as number)).toEqual(expected);
    const turns = SEEDS.map((seed) => tallyWorld(seed));
    let turn = 0;
    expect(interleave(turns, SCRIPT, (ready) => ready[turn++ % ready.length] as number)).toEqual(
      expected,
    );
  });

  test("stepped in a random interleaving give what each gives alone", () => {
    const random = new Sfc32(7);
    const worlds = SEEDS.map((seed) => tallyWorld(seed));
    expect(interleave(worlds, SCRIPT, (ready) => random.pick(ready))).toEqual(expected);
  });

  test("that share one ruleset object give what each gives alone", () => {
    const ruleset = tallyRuleset();
    const worlds = SEEDS.map((seed) => tallyWorld(seed, false, ruleset));
    const random = new Sfc32(11);
    expect(interleave(worlds, SCRIPT, (ready) => random.pick(ready))).toEqual(expected);
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
