/**
 * The preregistered scenario of T5 (docs/architecture/mind.md, "Seeds and scenario"): T4's rule
 * with the labels of T5, the default laws of life@2, and the brain `mind@1`, each being drawing its
 * cell, nutrition, rest, and six traits in this order. The spawn areas of the calibration labels
 * are recomputed from terrain alone and must match the table registered before any law of mind
 * existed. Nothing here runs the simulation, and no default or held-out label is touched.
 */
import { describe, expect, test } from "bun:test";
import { beings, readView } from "@open-origin/engine";
import { Sfc32 } from "../../engine/test/support/sfc32.ts";
import { MIND_BRAIN } from "../src/index.ts";
import { drawBeings2, LABELS2, scenario2From } from "./support/mind-scenario.ts";
import { DAY } from "./support/mind-senses.ts";
import { drawIn, terrainOf } from "./support/scenario.ts";

/** The calibration rows of the spawn table of mind.md: coverage, needs, center, land, food. */
const TABLE = [
  { n: 1, coverage: 83_737, needs: 736, center: [0, 0], land: 9216, food: 909 },
  { n: 2, coverage: 71_377, needs: 628, center: [-3, 3], land: 9216, food: 1295 },
  { n: 3, coverage: 100_314, needs: 882, center: [-5, 3], land: 9216, food: 929 },
  { n: 4, coverage: 73_110, needs: 643, center: [0, 0], land: 9216, food: 6220 },
] as const;

describe("the labels of T5", () => {
  test("are registered: the default, four for calibration, and twelve held out", () => {
    expect(LABELS2.default).toBe("open-origin/t5/default");
    expect(LABELS2.calibration).toEqual([1, 2, 3, 4].map((n) => `open-origin/t5/calibration/${n}`));
    expect(LABELS2.heldout).toEqual([1, 2, 3, 4, 5, 6].map((n) => `open-origin/t5/heldout/${n}`));
  });
});

describe.each(TABLE)("calibration/$n", ({ n, coverage, needs, center, land, food }) => {
  const terrain = terrainOf(LABELS2.calibration[n - 1] as string);

  test("has the spawn area registered before any law of mind", () => {
    expect(terrain.coverage).toBe(coverage);
    expect(terrain.area?.center).toEqual(center);
    expect(terrain.area?.land.length).toBe(land);
    expect(terrain.area?.food).toBe(food);
    expect(Math.ceil((coverage * 9216) / 2 ** 20)).toBe(needs);
  });
});

describe("the beings of a T5 scenario", () => {
  const terrain = terrainOf(LABELS2.calibration[0] as string);
  const species = beings.defaultLife2().species[0] as beings.Species2;

  test("draw their cell, nutrition, rest, and six traits, in this order, by rejection", () => {
    const area = terrain.area;
    if (area === undefined) throw new Error("calibration/1 has a spawn area");
    const drawn = drawBeings2(area, terrain.seeds.spawn, species);
    // An independent reading of the rule, draw by draw.
    const random = new Sfc32(terrain.seeds.spawn);
    const taken: number[] = [];
    const { min, max } = species.traits;
    for (const payload of drawn) {
      let entry = drawIn(random, 0, area.land.length - 1);
      while (taken.includes(entry)) entry = drawIn(random, 0, area.land.length - 1);
      taken.push(entry);
      const nutrition = drawIn(random, 600_000, 900_000);
      const rest = drawIn(random, 600_000, 900_000);
      const names = [
        "appetite",
        "sleepiness",
        "curiosity",
        "sociability",
        "credulity",
        "retention",
      ];
      const traits = Object.fromEntries(names.map((name) => [name, drawIn(random, min, max)]));
      expect(payload as unknown).toEqual({
        species: species.id,
        cell: [...(area.land[entry] as readonly [number, number])],
        needs: { nutrition, rest },
        traits,
      });
    }
    expect(drawn).toHaveLength(8);
    expect(new Set(drawn.map(({ cell }) => `${cell[0]},${cell[1]}`)).size).toBe(8);
  });

  test("live in a world of beings@2 under the default laws of life@2, without death, with mind@1", () => {
    const scenario = scenario2From(terrain, {});
    const view = readView(scenario.world);
    const global = view.readGlobal() as unknown as beings.BeingsGlobal;
    const { deathEnabled, ...laws } = global.life;
    const { deathEnabled: _default, ...defaults } = beings.defaultLife2();
    expect(deathEnabled).toBe(false);
    expect(laws).toEqual(defaults);
    expect(view.simSecondsPerTick).toBe(12);
    expect(scenario.ruleset.versions).toMatchObject({
      ruleset: "beings@2",
      brain: `s1:${MIND_BRAIN}`,
    });
    expect(scenario.dayLength).toBe(DAY);
    expect(scenario.spawns).toHaveLength(8);
    for (const spawn of scenario.spawns)
      expect(spawn).toMatchObject({ applyTick: 1, type: "beings.spawn" });
  });
});
