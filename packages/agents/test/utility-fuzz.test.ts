/**
 * The brain `utility@1` against the engine's judge: on windows the engine senses over real
 * terrain, with random needs, light, traits, behaviors, outcomes, cooldowns, and draws, every
 * intention it proposes is one the engine accepts, with a walk of at most 64 steps, at most four
 * cooldowns, and a behavior the brain knows; and by day, every plan either ends by itself, a walk
 * and a meal, or wakes the being at dusk, which bounds its reaction to darkness.
 */
import { describe, expect, test } from "bun:test";
import { beings, worldgen } from "@open-origin/engine";
import { Sfc32 } from "../../engine/test/support/sfc32.ts";
import { BEHAVIORS, DUSK_LIGHT } from "../src/brain/parameters.ts";
import { utilityController } from "../src/index.ts";
import { LABELS, labelSeeds } from "./support/scenario.ts";
import type { Senses } from "./support/senses.ts";

const species = beings.defaultLife().species[0] as beings.Species;
const prepared = worldgen.prepareGenesis(
  worldgen.defaultGenesis(labelSeeds(LABELS.calibration[2] as string).terrain),
);
const brain = utilityController();

/** Random senses at a random cell around the calibration area of calibration/3. */
function randomSenses(random: Sfc32): { senses: Senses; window: beings.SensedWindow } {
  const center: [number, number] = [
    -176 + random.between(-150, 150),
    -16 + random.between(-150, 150),
  ];
  const window = beings.senseWindow({
    prepared,
    species,
    center,
    view: { readChunk: () => undefined },
    nowSeconds: 0,
    simSecondsPerTick: 12,
  });
  const kinds = ["none", ...BEHAVIORS];
  const outcomes = [
    ["done", ""],
    ["failed", "no_food"],
    ["lost", "food_gone"],
    ["interrupted", "wake_condition"],
    ["rejected", "malformed"],
  ];
  const [result, reason] = random.pick(outcomes) as [string, string];
  const cooldowns = Array.from({ length: random.below(5) }, () => ({
    cell: [center[0] + random.between(-40, 40), center[1] + random.between(-40, 40)] as const,
    until: random.between(1, 10_000),
  }));
  const senses: Senses = {
    self: {
      id: 1,
      species: species.id,
      cell: center,
      needs: { nutrition: random.between(0, 1_000_000), rest: random.between(0, 1_000_000) },
      health: random.between(0, 1_000_000),
      condition: random.below(8) === 0 ? "incapacitated" : "ok",
      traits: {
        appetite: random.between(800, 1200),
        sleepiness: random.between(800, 1200),
        curiosity: random.between(800, 1200),
      },
      activity: { kind: "idle", start: 5, ms: 1 },
      behavior: { kind: random.pick(kinds), since: 3, heading: random.below(8) },
      outcome: { result, tick: 5, reason },
      cooldowns,
    },
    light: random.pick([40, 100, 101, 150, 199, 200, 1000, random.between(40, 1000)]),
    window: { ...window, edgeMs: window.edgeMs.slice(), foodCue: window.foodCue.slice() },
    draws: [random.next(), random.next()],
  };
  return { senses, window };
}

describe("utility@1 against the engine's judge", () => {
  test("proposes only intentions the engine accepts, on 300 random senses", () => {
    const random = new Sfc32(0x7406_0001);
    const kinds = new Set<string>();
    for (let round = 0; round < 300; round += 1) {
      const { senses, window } = randomSenses(random);
      const intention = brain.decide(senses);
      const judged = beings.acceptIntention(intention, { tick: 9, window });
      expect(judged.kind).toBe("accepted");
      expect(intention.cooldowns?.length ?? 0).toBeLessThanOrEqual(4);
      expect(BEHAVIORS).toContain(intention.behavior.kind);
      const walk = intention.steps.find((step) => step.kind === "walk");
      if (walk?.kind === "walk") expect(walk.dirs.length).toBeLessThanOrEqual(64);
      if (senses.self.condition === "incapacitated") expect(walk).toBeUndefined();
      // By day, a being is woken at dusk unless its plan ends by itself: a walk, then a meal.
      if (senses.light > DUSK_LIGHT && intention.behavior.kind !== "sleep") {
        const ends = intention.steps.every((step) => step.kind === "walk" || step.kind === "eat");
        expect(ends || intention.wakeWhen.lightBelow === DUSK_LIGHT).toBe(true);
      }
      kinds.add(intention.behavior.kind);
    }
    // The random senses reach every behavior, so the check covers each recipe.
    expect([...kinds].sort()).toEqual([...BEHAVIORS].sort());
  });
});
