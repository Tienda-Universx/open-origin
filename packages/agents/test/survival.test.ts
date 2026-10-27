/**
 * The survival test of the preregistration (docs/architecture/beings.md, "Evaluation"; plan §9.2,
 * test 1, and §11, criterion 1) and its negative controls (plan §9.4).
 *
 * The default label and heldout/1 each run 63,000 ticks (10 simulated days) of eight beings under
 * `utility@1` and the frozen default laws, audit off, each in a child process. Both start before
 * the first test, so they run beside the negative controls, which run in this process (plan §9.3).
 * The run of the default label also keeps its snapshot at tick 31,500, which a fresh process
 * resumes, under audit, for the next 1,500 ticks (plan §9.2, test 8).
 *
 * The negative controls show that the test fails when it should: a brain that never eats is
 * incapacitated at the tick the laws give; a stationary brain is incapacitated within ten days,
 * so by the stationary horizon H, on every calibration label; a brain that never sleeps reaches
 * rest 0; and a nearly barren world, its spawn area chosen by the same rule, collapses within the
 * bound its laws give, every food cue its beings sensed 0 or 1.
 *
 * Time (Bun 1.4.4, 2026-10-27; indicative): each ten-day run takes about 6.4 s alone on the
 * Codespace, whose two CPUs are two threads of one core. The controls take about 6.8 s alone (0.6,
 * 1.6, 1.5, and 3.2 s) and the resume 1.4 s, and the whole file about 21 s there, where the three
 * processes share the core; a CI runner with more cores runs them side by side.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { beings, type Command, type StepResult, step, worldgen } from "@open-origin/engine";
import {
  beingsWorld,
  lifeWith,
  PREPARED,
  SPECIES,
  stationaryHorizon,
} from "../../engine/test/support/beings-world.ts";
import {
  type ChildInput,
  type ChildOutput,
  firstDivergence,
} from "../../engine/test/support/determinism-records.ts";
import { utilityController } from "../src/index.ts";
import { neverEats, neverSleeps, stationary } from "./support/brains.ts";
import { type JsonChild, jsonResult, startJsonChild, stopChild } from "./support/child.ts";
import { misses, type RunInput, runScenario } from "./support/metrics.ts";
import {
  LABELS,
  labelSeeds,
  SCENARIO_SPS,
  type ScenarioWorld,
  scenarioFrom,
  scenarioOf,
  spawnCommand,
  terrainWith,
} from "./support/scenario.ts";
import { type SurvivalOutput, startSurvival, survivalResult } from "./support/survival.ts";
import { UTILITY_RULESET } from "./support/utility-ruleset.ts";

/** Ten simulated days of 75,600 s at 12 s per tick. */
const TEN_DAYS = 63_000;
/** The tick whose snapshot the default run keeps, and how many ticks after it a resume compares. */
const MIDWAY = 31_500;
const RESUMED = 1_500;
/** How long a child process may run once a test waits for it. */
const CHILD_MS = 180_000;

const HELDOUT_1 = LABELS.heldout[0] as string;

/** The two runs of the survival test, started before the first test. */
let runs: { readonly default: JsonChild; readonly heldout: JsonChild } | undefined;
const outputs = new Map<string, Promise<SurvivalOutput>>();

/** What the run of `which` returned, waited for once. */
function outputOf(which: "default" | "heldout"): Promise<SurvivalOutput> {
  const known = outputs.get(which);
  if (known !== undefined) return known;
  if (runs === undefined) throw new Error("the survival runs did not start");
  const output = survivalResult(runs[which], CHILD_MS);
  outputs.set(which, output);
  return output;
}

beforeAll(() => {
  runs = {
    default: startSurvival({
      label: LABELS.default,
      ticks: TEN_DAYS,
      keep: { at: MIDWAY, ticks: RESUMED },
    }),
    heldout: startSurvival({ label: HELDOUT_1, ticks: TEN_DAYS }),
  };
});

afterAll(async () => {
  if (runs !== undefined) await Promise.all([stopChild(runs.default), stopChild(runs.heldout)]);
});

/** The ticks at which the events of `type` happened, by being id, from the steps of a run. */
function ticksOf(type: string) {
  const ticks = new Map<number, number[]>();
  const onStep = (result: StepResult) => {
    for (const event of result.events) {
      if (event.type !== type) continue;
      const { id } = event.payload as { id: number };
      ticks.set(id, [...(ticks.get(id) ?? []), result.tick]);
    }
  };
  return { ticks, onStep };
}

/** The seconds `ratio` takes to move a quantity across `amount` units, rounded up. */
const reach = ({ num, den }: beings.Ratio, amount: number) => Math.ceil((amount * den) / num);

/** How long a negative control may take. */
const CONTROL_MS = 60_000;

/**
 * Steps `world` from tick 1, with `spawns` at tick 1, until every being spawned is incapacitated
 * or the tick `limit` has run: the tick at which each was first incapacitated, by id, and the
 * bites they took.
 */
function untilIncapacitated(world: ScenarioWorld, spawns: readonly Command[], limit: number) {
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

describe("negative controls: the survival test fails each broken brain and world (plan §9.4)", () => {
  test(
    "a brain that never eats is incapacitated at the tick the laws give",
    () => {
      // Spawned at tick 1, idle and fully rested. Nutrition 0 starves at once; 40,000 reaches 0
      // after ⌈40,000·189/1,250⌉ = 6,048 s, at tick 1 + 504. Health then falls from full to 0 in
      // ⌈10^6·567/5,000⌉ = 113,400 s, 9,450 ticks; rest stays above 0 meanwhile.
      const { awake } = SPECIES.needs.nutrition;
      const toZero = (nutrition: number) => Math.ceil(reach(awake, nutrition) / SCENARIO_SPS);
      const starving = Math.ceil(reach(SPECIES.health.starve, beings.NEED_MAX) / SCENARIO_SPS);
      const expected = [0, 40_000].map((nutrition) => 1 + toZero(nutrition) + starving);
      expect(expected).toEqual([9_451, 9_955]);

      const world = beingsWorld({ controllers: { [SPECIES.id]: neverEats() }, audit: false });
      const payloads = [0, 40_000].map((nutrition, index) => ({
        species: SPECIES.id,
        cell: [5 + index, 5] as const,
        needs: { nutrition, rest: beings.NEED_MAX },
        traits: { appetite: 1000, sleepiness: 1000, curiosity: 1000 },
      }));
      const run: RunInput = {
        world,
        spawns: payloads.map(spawnCommand),
        payloads,
        prepared: PREPARED,
      };
      const incapacitated = ticksOf("being.incapacitated");
      const records = runScenario(run, 9_955, { decisions: () => 0 }, incapacitated.onStep).beings;
      expect([...incapacitated.ticks]).toEqual([
        [1, [9_451]],
        [2, [9_955]],
      ]);
      expect(records.map((record) => [record.meals, record.exhausted, misses(record)[0]])).toEqual([
        [0, 0, "incapacitated"],
        [0, 0, "incapacitated"],
      ]);
    },
    CONTROL_MS,
  );

  test(
    "a stationary brain is incapacitated within ten days, so by H, on every calibration label",
    () => {
      // At 600 s per tick, so that H, 47.7 days, takes 6,007 ticks and ten days 1,260: the laws
      // do not depend on the tick (ADR 0023). A brain that looks only at its own cell needs no
      // wider window, and the radius of the senses changes no law of the body or of food.
      const sps = 600;
      const life = lifeWith((species) => ({ ...species, senses: { radius: 1 } }));
      const tenDays = (TEN_DAYS * SCENARIO_SPS) / sps;
      let bites = 0;
      for (const label of LABELS.calibration) {
        const scenario = scenarioOf(label, {
          controllers: { s1: stationary() },
          life,
          simSecondsPerTick: sps,
        });
        const genesis = worldgen.genesisOf(scenario.prepared);
        const { days } = stationaryHorizon(SPECIES, genesis);
        const horizon = Math.ceil((days * genesis.laws.day.length) / sps);
        expect([horizon, tenDays]).toEqual([6_007, 1_260]);
        const run = untilIncapacitated(scenario.world, scenario.spawns, horizon);
        expect(run.incapacitated.size).toBe(8);
        expect(Math.max(...run.incapacitated.values())).toBeLessThanOrEqual(tenDays);
        bites += run.bites;
      }
      // Not vacuous: some stationary beings stood on food, and ate what it regrew.
      expect(bites).toBeGreaterThan(0);
    },
    CONTROL_MS,
  );

  test(
    "a brain that never sleeps reaches rest 0, which the survival test refuses",
    () => {
      // Awake, rest falls at least at the idle rate: from at most 900,000 to 0 within
      // ⌈900,000·378/3,125⌉ = 108,864 s, by tick 1 + 9,072.
      const ticks = 1 + Math.ceil(reach(SPECIES.needs.rest.awake, 900_000) / SCENARIO_SPS);
      expect(ticks).toBe(9_073);
      const brain = neverSleeps(utilityController());
      const scenario = scenarioOf(LABELS.calibration[0] as string, { controllers: { s1: brain } });
      const records = runScenario(scenario, ticks, { decisions: () => 0 }).beings;
      expect(records.map((record) => record.exhausted > 0)).toEqual(Array(8).fill(true));
      for (const record of records) expect(misses(record)).toContain("rest 0");
    },
    CONTROL_MS,
  );

  test(
    "a nearly barren world collapses within the bound its laws give, every food cue 0 or 1",
    () => {
      // calibration/1's terrain with deposit 0 at peak 1 and threshold 999: the spawn rule still
      // finds an area, by the genesis' own average, which adds no food. Two of its eight beings
      // keep the control cheap: every decision searches.
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
      const run = untilIncapacitated(
        scenario.world,
        scenario.spawns.slice(0, 2),
        Math.max(...bounds),
      );
      expect([...run.incapacitated.keys()].sort()).toEqual([1, 2]);
      for (const [id, tick] of run.incapacitated)
        expect(tick).toBeLessThanOrEqual(bounds[id - 1] ?? 0);
      expect(run.bites).toBe(0);
      expect([...cues].every((cue) => cue <= 1)).toBe(true);
    },
    CONTROL_MS,
  );
});

/** The resume child of the determinism suite, which continues a snapshot in a fresh process. */
const RESUME_CHILD = Bun.fileURLToPath(
  new URL("../../engine/test/support/resume-child.ts", import.meta.url),
);

describe("survival over ten days on the preregistered labels (plan §9.2, test 1)", () => {
  test(
    "default: every being meets every acceptance item, and its health never falls",
    async () => {
      const { record } = await outputOf("default");
      expect(record.beings).toHaveLength(8);
      expect(record.beings.map(misses)).toEqual(Array(8).fill([]));
      expect(record.regrewAndEaten).toBe(true);
      // Health falls only while nutrition is 0, and a being that starved keeps its loss until it
      // eats again, so it shows at an event or at the end of the run.
      for (const being of record.beings) {
        expect(being.lowestHealth).toBe(beings.NEED_MAX);
        expect(being.final?.health).toBe(beings.NEED_MAX);
      }
      // Not vacuous: each being got hungry and tired, ate, slept, and walked, and its brain decided.
      expect(record.decisions).toBeGreaterThan(8 * 10 * 10);
    },
    CHILD_MS,
  );

  test(
    "heldout/1: a preregistered failure, pinned as it was evaluated: being 3 never ate outside its birth window; every other item holds (changing laws or brain would burn this seed)",
    async () => {
      const { record } = await outputOf("heldout");
      expect(record.beings).toHaveLength(8);
      // The one item that failed, for one being: every being but 3 ate outside its birth window.
      expect(
        record.beings.filter((being) => being.ateOutsideBirthWindow).map(({ id }) => id),
      ).toEqual([1, 2, 4, 5, 6, 7, 8]);
      expect(record.beings.map(misses)).toEqual([
        [],
        [],
        ["outside birth window"],
        [],
        [],
        [],
        [],
        [],
      ]);
      expect(record.regrewAndEaten).toBe(true);
      expect(record.decisions).toBeGreaterThan(8 * 10 * 10);
    },
    CHILD_MS,
  );

  test(
    "the default run resumed after tick 31,500 in a fresh process gives the next 1,500 ticks and the final snapshot (plan §9.2, test 8)",
    async () => {
      const { kept } = await outputOf("default");
      if (kept === undefined) throw new Error("the default run kept no snapshot");
      const input: ChildInput = {
        ruleset: UTILITY_RULESET,
        snapshot: kept.snapshot,
        from: MIDWAY + 1,
        script: Array.from({ length: MIDWAY + RESUMED }, () => []),
        audit: true,
      };
      const resumed = (await jsonResult(
        startJsonChild(RESUME_CHILD, input),
        CHILD_MS,
      )) as ChildOutput;
      expect(resumed.records).toHaveLength(RESUMED);
      expect(firstDivergence(kept.records, resumed.records)).toBeUndefined();
      expect(resumed.finalError).toBeUndefined();
      expect(resumed.final).toBe(kept.final);
      // Not vacuous: the beings acted in those ticks.
      const events = kept.records.flatMap((tick) => ("events" in tick ? [tick.events] : []));
      expect(events.filter((text) => text.includes("being.started")).length).toBeGreaterThan(10);
    },
    CHILD_MS,
  );
});
