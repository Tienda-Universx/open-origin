import { beings, type Command, step, worldgen } from "@open-origin/engine";
import { SPECIES } from "../../../engine/test/support/beings-world.ts";
import { utilityController } from "../../src/index.ts";
import {
  LABELS,
  labelSeeds,
  SCENARIO_SPS,
  type ScenarioWorld,
  scenarioFrom,
  terrainWith,
} from "./scenario.ts";

/**
 * Negative controls of the survival test (docs/architecture/beings.md, "Negative controls"; plan
 * §9.4): the runner the controls share, and the nearly barren world, which the soak runs
 * (bench/soak.ts) since T4-8 moved it out of `bun test` to keep CI within its budget.
 */

/**
 * Steps `world` from tick 1, with `spawns` at tick 1, until every being spawned is incapacitated
 * or the tick `limit` has run: the tick at which each was first incapacitated, by id, and the
 * bites they took.
 */
export function untilIncapacitated(
  world: ScenarioWorld,
  spawns: readonly Command[],
  limit: number,
) {
  const incapacitated = new Map<number, number>();
  let bites = 0;
  for (let tick = 1; tick <= limit && incapacitated.size < spawns.length; tick += 1) {
    for (const event of step(world, tick === 1 ? spawns : []).events) {
      const { id } = event.payload as { id: number };
      if (event.type === "being.incapacitated" && !incapacitated.has(id))
        incapacitated.set(id, tick);
      if (event.type === "being.ate") bites += 1;
    }
  }
  return { incapacitated, bites };
}

/** What a run of the barren control gave. */
export type BarrenRun = {
  /** The tick at which each being was first incapacitated, by id, in order of id. */
  readonly incapacitated: readonly (readonly [number, number])[];
  /** The latest tick the laws allow each being's incapacity, by id from 1. */
  readonly bounds: readonly number[];
  readonly bites: number;
  /** Every food cue the beings' brain sensed, ascending. */
  readonly cues: readonly number[];
};

/**
 * The nearly barren world: calibration/1's terrain with deposit 0 at peak 1 and threshold 999.
 * The spawn rule still finds an area, by the genesis' own average, which adds no food. Two of its
 * eight beings run under `utility@1`, which records every food cue it senses; with nothing in
 * sight, every decision searches, so eight would cost about 10 s.
 */
export function barrenControl(): BarrenRun {
  const label = LABELS.calibration[0] as string;
  const base = worldgen.defaultGenesis(labelSeeds(label).terrain);
  const deposits = base.terrain.deposits.map((deposit, index) =>
    index === 0 ? { ...deposit, peak: 1, threshold: 999 } : deposit,
  );
  const barren = terrainWith(label, { ...base, terrain: { ...base.terrain, deposits } });
  const inner = utilityController();
  const cues = new Set<number>();
  const brain: beings.Controller = {
    brain: inner.brain,
    decide: (senses) => {
      for (const cue of senses.window.foodCue) cues.add(cue);
      return inner.decide(senses);
    },
  };
  const scenario = scenarioFrom(barren, { controllers: { s1: brain } });
  // A tick lowers nutrition by at least ⌊12·625/189⌋ = 39, asleep, and health at nutrition 0
  // by ⌊12·5,000/567⌋ = 105, whichever activities split it: a bound for each being.
  const perTick = (ratio: beings.Ratio) => Math.floor((SCENARIO_SPS * ratio.num) / ratio.den);
  const bounds = scenario.payloads
    .slice(0, 2)
    .map(
      ({ needs }) =>
        1 +
        Math.ceil(needs.nutrition / perTick(SPECIES.needs.nutrition.asleep)) +
        Math.ceil(beings.NEED_MAX / perTick(SPECIES.health.starve)),
    );
  const run = untilIncapacitated(scenario.world, scenario.spawns.slice(0, 2), Math.max(...bounds));
  return {
    incapacitated: [...run.incapacitated].sort(([a], [b]) => a - b),
    bounds,
    bites: run.bites,
    cues: [...cues].sort((a, b) => a - b),
  };
}

/**
 * Every way `run` fails the barren control: a being of the two not incapacitated, or incapacitated
 * after its bound; a bite taken; and a set of sensed cues other than exactly {0}, which is also
 * what an empty set, a brain that recorded nothing, gives.
 */
export function barrenIssues(run: BarrenRun): string[] {
  const issues: string[] = [];
  const ids = run.incapacitated.map(([id]) => id);
  if (`${ids}` !== "1,2")
    issues.push(`incapacitated beings ${ids.join(", ") || "none"}, not 1 and 2`);
  for (const [id, tick] of run.incapacitated) {
    const bound = run.bounds[id - 1] ?? 0;
    if (tick > bound)
      issues.push(`being ${id} incapacitated at tick ${tick}, after its bound ${bound}`);
  }
  if (run.bites > 0) issues.push(`${run.bites} bites taken in a world without food`);
  if (`${run.cues}` !== "0")
    issues.push(`food cues sensed {${run.cues.join(", ")}}, not exactly {0}`);
  return issues;
}
