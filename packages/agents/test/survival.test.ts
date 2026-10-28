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
 * so by the stationary horizon H, on the calibration labels, the default label, and heldout/1 (the
 * soak runs it on the other held-out labels); and a brain that never sleeps reaches rest 0. The
 * fourth, a nearly barren world, runs in the soak (bench/soak.ts, support/controls.ts), where T4-8
 * moved it to keep `bun test` in CI within its budget; soak-bench.test.ts checks its verdict.
 *
 * Time (Bun 1.4.4, 2026-10-27; indicative): each ten-day run takes about 6.4 s alone on the
 * Codespace, whose two CPUs are two threads of one core. The three controls take about 4.5 s alone
 * (0.7, 2.5, and 1.3 s) and the resume 1.4 s, and the whole file about 18 s there, where the three
 * processes share the core; a CI runner with more cores runs them side by side.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { beings, type StepResult } from "@open-origin/engine";
import { beingsWorld, PREPARED, SPECIES } from "../../engine/test/support/beings-world.ts";
import {
  type ChildInput,
  type ChildOutput,
  firstDivergence,
} from "../../engine/test/support/determinism-records.ts";
import { utilityController } from "../src/index.ts";
import { neverEats, neverSleeps, stationary } from "./support/brains.ts";
import { type JsonChild, jsonResult, startJsonChild, stopChild } from "./support/child.ts";
import { untilIncapacitated } from "./support/controls.ts";
import { misses, type RunInput, runScenario } from "./support/metrics.ts";
import {
  LABELS,
  SCENARIO_SPS,
  scenarioFrom,
  spawnCommand,
  type Terrain,
  terrainOf,
} from "./support/scenario.ts";
import { STATIONARY_SPS, stationaryLife, stationaryTicks } from "./support/stationary.ts";
import { type SurvivalOutput, startSurvival, survivalResult } from "./support/survival.ts";
import { UTILITY_RULESET } from "./support/utility-ruleset.ts";

/** Ten simulated days of 75,600 s at 12 s per tick. */
const TEN_DAYS = 63_000;
/** The tick whose snapshot the default run keeps, and how many ticks after it a resume compares. */
const MIDWAY = 31_500;
const RESUMED = 1_500;
/**
 * How long a child process may run once a test waits for it, shorter than the test's own limit, so
 * that a child that hangs is reported with its own message.
 */
const CHILD_MS = 120_000;
const TEST_MS = 180_000;

const HELDOUT_1 = LABELS.heldout[0] as string;

/**
 * The digest of every tick's checksum of each run, pinned on `6fa7375` before T5 shared any code
 * with `beings@2`: `beings@1` and `utility@1` must keep every output byte for byte (ADR 0024).
 */
const TRAILS = {
  default: "171c9406d17a4a7b29d6586f0cc74927",
  heldout: "3f605d4904d2dd0ce6f8311407f2b038",
} as const;

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

/** The terrain of each label the controls use, measured once: two controls share calibration/1's. */
const terrains = new Map<string, Terrain>();
function terrainOfLabel(label: string): Terrain {
  const known = terrains.get(label);
  if (known !== undefined) return known;
  const terrain = terrainOf(label);
  terrains.set(label, terrain);
  return terrain;
}

/** How long a negative control may take. */
const CONTROL_MS = 60_000;

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
    "a stationary brain is incapacitated within ten days, so by H, on the calibration labels, the default label, and heldout/1",
    () => {
      // At 600 s per tick, so that H, 47.7 days, takes 6,007 ticks and ten days 1,260: the laws
      // do not depend on the tick (ADR 0023). A brain that looks only at its own cell needs no
      // wider window, and the radius of the senses changes no law of the body or of food. The
      // soak runs it on the other held-out labels.
      let bites = 0;
      for (const label of [...LABELS.calibration, LABELS.default, HELDOUT_1]) {
        const scenario = scenarioFrom(terrainOfLabel(label), {
          controllers: { s1: stationary() },
          life: stationaryLife(),
          simSecondsPerTick: STATIONARY_SPS,
        });
        const { horizon, tenDays } = stationaryTicks(label);
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
      const terrain = terrainOfLabel(LABELS.calibration[0] as string);
      const scenario = scenarioFrom(terrain, { controllers: { s1: brain } });
      const records = runScenario(scenario, ticks, { decisions: () => 0 }).beings;
      expect(records.map((record) => record.exhausted > 0)).toEqual(Array(8).fill(true));
      for (const record of records) expect(misses(record)).toContain("rest 0");
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
    TEST_MS,
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
      // Health never fell here either: it was full at every event and at the last tick.
      for (const being of record.beings) {
        expect(being.lowestHealth).toBe(beings.NEED_MAX);
        expect(being.final?.health).toBe(beings.NEED_MAX);
      }
    },
    TEST_MS,
  );

  test(
    "both runs keep, tick by tick, the checksums they had before T5 (beings@1 and utility@1 unchanged)",
    async () => {
      const [ran, held] = await Promise.all([outputOf("default"), outputOf("heldout")]);
      expect({ default: ran.trail, heldout: held.trail }).toEqual(TRAILS);
    },
    TEST_MS,
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
    TEST_MS,
  );
});
