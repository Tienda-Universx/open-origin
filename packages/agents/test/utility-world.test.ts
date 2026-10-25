/**
 * The brain `utility@1` in a world: the ruleset's brain version, and the bound on its reaction to
 * darkness (ADR 0023, "Decision points"). Over the first day of the calibration scenario
 * calibration/1, a being that rests or wanders by day is woken at the exact tick the light falls
 * to dusk, and every other being that is awake decides within the longest plan the brain makes
 * without a light condition: a walk of 64 of the slowest steps, then a meal to full. A ninth
 * being, spawned hungry just before dusk away from food, is one such: it forages across dusk.
 */
import { describe, expect, test } from "bun:test";
import { beings, type EngineEvent, readView, step, worldgen } from "@open-origin/engine";
import { DUSK_LIGHT, EXHAUSTION_GUARD } from "../src/brain/parameters.ts";
import { utilityController } from "../src/index.ts";
import { LABELS, SCENARIO_SPS, scenarioOf } from "./support/scenario.ts";
import { sensesOf } from "./support/senses.ts";

/** The senses of a being of the first decision at `cell`, with `needs`, at noon. */
function sensesAt(
  cell: readonly [number, number],
  window: beings.SensedWindow,
  needs: { nutrition: number; rest: number },
) {
  return sensesOf(window, { cell, ...needs, behavior: { kind: "none", heading: 0 } });
}

describe("utility@1 in a world", () => {
  test("composes the ruleset's brain version", () => {
    const ruleset = beings.createBeingsRuleset({ controllers: { s1: utilityController() } });
    expect(ruleset.versions.brain).toBe("s1:utility@1");
  });

  test("reacts to dusk at once when it waits for it, and within its longest plan otherwise", () => {
    const decisions: { tick: number; id: number; kind: string }[] = [];
    let now = 0;
    const inner = utilityController();
    const recorder: beings.Controller = {
      brain: inner.brain,
      decide: (senses) => {
        const intention = inner.decide(senses);
        decisions.push({ tick: now, id: senses.self.id, kind: intention.behavior.kind });
        return intention;
      },
    };
    const scenario = scenarioOf(LABELS.calibration[0] as string, { controllers: { s1: recorder } });
    const { prepared } = scenario.terrain;
    const light = (tick: number) =>
      worldgen.radiance(prepared, { tick, simSecondsPerTick: SCENARIO_SPS });
    // Dusk of the first day: the first tick past mid-light whose light is at or below DUSK_LIGHT.
    let dusk = 2000;
    while (light(dusk) > DUSK_LIGHT) dusk += 1;
    expect(light(dusk - 1)).toBeGreaterThan(DUSK_LIGHT);

    // A hungry being where the brain forages a cell some steps away, spawned four ticks before dusk.
    const species = beings.defaultLife().species[0] as beings.Species;
    const hungry = { nutrition: 450_000, rest: 900_000 };
    const forager = scenario.area.land.find((cell) => {
      const window = beings.senseWindow({
        prepared,
        species,
        center: [cell[0], cell[1]],
        view: { readChunk: () => undefined },
        nowSeconds: 0,
        simSecondsPerTick: SCENARIO_SPS,
      });
      const intention = inner.decide(sensesAt(cell, window, hungry));
      const walk = intention.steps[0];
      return intention.behavior.kind === "forage" && walk?.kind === "walk" && walk.dirs.length >= 8;
    });
    if (forager === undefined) throw new Error("calibration/1 has a cell to forage from");
    const late = {
      applyTick: dusk - 4,
      seq: 0,
      type: "beings.spawn",
      origin: { kind: "admin" as const },
      payload: { species: species.id, cell: [forager[0], forager[1]], needs: hungry },
    };

    const commandsAt = (tick: number) => {
      if (tick === 1) return scenario.spawns;
      return tick === late.applyTick ? [late] : [];
    };
    const events: EngineEvent[] = [];
    const run = (to: number) => {
      for (now = readView(scenario.world).tick + 1; now <= to; now += 1) {
        events.push(...step(scenario.world, commandsAt(now)).events);
      }
    };
    run(dusk - 1);
    const view = readView(scenario.world);
    const before = view
      .readGlobal()
      .occupancy.flatMap((key) => (view.readChunk(key)?.beings ?? []) as beings.Being[]);
    const waiting = before.filter(
      (being) => being.wakeWhen.lightBelow === DUSK_LIGHT && being.activity.kind !== "sleep",
    );
    const awake = before.filter((being) => being.activity.kind !== "sleep");
    expect(waiting.length).toBeGreaterThan(0);
    const ninth = awake.find((being) => being.id === 9);
    expect(ninth?.behavior.kind).toBe("forage");
    expect(ninth?.wakeWhen).toEqual({ restBelow: EXHAUSTION_GUARD });
    expect(waiting.some((being) => being.id === 9)).toBe(false);

    // The longest plan without a light condition, from the laws.
    const { stepMs, rise, maxRise, wade, maxWade } = species.locomotion;
    const slowest = Math.ceil(
      (1414 *
        (stepMs +
          Math.floor((rise.num * maxRise) / rise.den) +
          Math.floor((wade.num * maxWade) / wade.den))) /
        1000,
    );
    const bites = Math.ceil(1_000_000 / (species.diet.nutritionPerUnit * species.diet.biteUnits));
    const bound =
      Math.ceil((64 * slowest + bites * species.diet.biteMs) / (SCENARIO_SPS * 1000)) + 1;
    run(dusk + bound);

    for (const being of waiting)
      expect(decisions.filter(({ id, tick }) => id === being.id && tick === dusk)).toHaveLength(1);
    for (const being of awake) {
      const reacted = decisions.find(({ id, tick }) => id === being.id && tick >= dusk);
      expect(reacted?.tick ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(dusk + bound);
    }
    expect(events.filter(({ type }) => type === "being.intention_rejected")).toEqual([]);
  });
});
