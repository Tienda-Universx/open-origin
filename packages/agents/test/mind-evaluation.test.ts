/**
 * The preregistered evaluation of T5 (docs/architecture/mind.md, "Evaluation"; plan §11.1 and §15,
 * criterion 2): the default label and heldout/1 of T5, each 63,000 ticks (10 simulated days) of
 * eight beings under `mind@1` and the frozen laws of life@2, audit off, each in a child process
 * (support/mind-evaluation.ts) started before the first test, so that both run beside the other
 * tests, as T4's survival runs do. Every acceptance item is computed from the ledger and the state:
 * per being (T4's items and the mind's), of the population, of integrity (the invariants of the
 * minds and the ledger oracle at every tick that changed the world, every rule, no model-prior-
 * suspect), and of diversity. The results are pinned exactly as they were evaluated, once, at
 * EVALUATED_AT: changing them burns both labels, and the evaluation moves to the reserve (mind.md,
 * "Evaluation results"). heldout/1 fails one preregistered item for one being, pinned as it is.
 *
 * The default run also keeps its snapshot at tick 31,500, which a fresh process resumes, under
 * audit, for the next 1,500 ticks (plan §15, criterion 6).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type ChildInput,
  type ChildOutput,
  firstDivergence,
} from "../../engine/test/support/determinism-records.ts";
import { type JsonChild, jsonResult, startJsonChild, stopChild } from "./support/child.ts";
import {
  acceptance,
  EVALUATED,
  type EvaluationOutput,
  evaluationResult,
  startEvaluation,
} from "./support/mind-evaluation.ts";
import { SCENARIO2_RULESET } from "./support/mind-scenario.ts";

/** Ten simulated days of 75,600 s at 12 s per tick. */
const TEN_DAYS = 63_000;
/** The tick whose snapshot the default run keeps, and how many ticks after it a resume compares. */
const MIDWAY = 31_500;
const RESUMED = 1_500;
/** How long a child may run once a test waits for it, shorter than the test's own limit. */
const CHILD_MS = 150_000;
const TEST_MS = 180_000;

/**
 * The commit at which the evaluation ran once, 2026-10-28; every result below is what it gave
 * then. Changing any of them burns both labels (mind.md, "Evaluation results").
 */
const EVALUATED_AT = "5c59a0e";

/**
 * Each being's counts, by id: food and being episodes encoded; beliefs formed from its own
 * observations and from testimony; believes or revises from testimony; revisions down after a
 * contradiction; trust changed by a checked testimony; greeted, was greeted; relationships at the end.
 */
const COUNTS = {
  default: [
    [17, 16, 16, 2, 2, 1, 0, 10, 8, 6],
    [19, 20, 13, 7, 7, 2, 5, 12, 13, 6],
    [31, 51, 25, 10, 10, 6, 0, 30, 32, 6],
    [37, 38, 24, 10, 10, 4, 9, 22, 23, 6],
    [36, 37, 23, 9, 9, 6, 7, 23, 22, 6],
    [30, 52, 21, 15, 15, 3, 7, 28, 28, 6],
    [24, 33, 15, 9, 9, 2, 8, 20, 19, 6],
    [27, 33, 25, 9, 9, 2, 0, 20, 20, 6],
  ],
  heldout: [
    [38, 2, 35, 1, 1, 3, 0, 2, 2, 3],
    [35, 12, 29, 4, 4, 2, 4, 6, 7, 5],
    [39, 14, 33, 7, 7, 3, 3, 7, 7, 4],
    [34, 4, 31, 1, 1, 3, 0, 2, 2, 2],
    [36, 0, 33, 0, 0, 3, 0, 0, 0, 1],
    [41, 8, 35, 3, 3, 3, 3, 5, 4, 5],
    [39, 5, 36, 3, 3, 3, 0, 3, 4, 5],
    [43, 13, 40, 6, 6, 3, 0, 7, 6, 5],
  ],
};

/** The digest of every tick's checksum of each run. */
const TRAILS = {
  default: "cc98bd81954d97cdfc98dfc72c2ac821",
  heldout: "26aa8e46e8c627d1f2c7ea068f0b60fe",
};

/** The two runs of the evaluation, started before the first test. */
let runs: { readonly default: JsonChild; readonly heldout: JsonChild } | undefined;
const outputs = new Map<string, Promise<EvaluationOutput>>();

/** What the run of `which` returned, waited for once. */
function outputOf(which: "default" | "heldout"): Promise<EvaluationOutput> {
  const known = outputs.get(which);
  if (known !== undefined) return known;
  if (runs === undefined) throw new Error("the evaluation runs did not start");
  const output = evaluationResult(runs[which], CHILD_MS);
  outputs.set(which, output);
  return output;
}

beforeAll(() => {
  runs = {
    default: startEvaluation({
      label: EVALUATED.default,
      ticks: TEN_DAYS,
      keep: { at: MIDWAY, ticks: RESUMED },
    }),
    heldout: startEvaluation({ label: EVALUATED.heldout, ticks: TEN_DAYS }),
  };
});

afterAll(async () => {
  if (runs !== undefined) await Promise.all([stopChild(runs.default), stopChild(runs.heldout)]);
});

/** Each being's counts of the items, in the order of the columns of mind.md's tables. */
function counts(output: EvaluationOutput) {
  return output.minds.map((mind) => [
    mind.ledger.food,
    mind.ledger.being,
    mind.ledger.formedOwn,
    mind.ledger.formedTold,
    mind.ledger.fromTestimony,
    mind.ledger.revisedDown,
    mind.ledger.trustChecked,
    mind.greeted,
    mind.wasGreeted,
    mind.relationsAtEnd,
  ]);
}

/** What makes a pass not vacuous: the beings decided, and the checks ran on what they did. */
function expectNotVacuous(output: EvaluationOutput): void {
  expect(output.record.decisions).toBeGreaterThan(8 * 10 * 10);
  for (const name of ["beliefs", "relations", "heard", "delivered", "told"])
    expect(output.seen[name]).toBeGreaterThan(0);
}

describe("the evaluation of mind@1 over ten days on the preregistered labels (mind.md, Evaluation)", () => {
  test(
    "default: every being meets every item, and so do the population, integrity, and diversity",
    async () => {
      const output = await outputOf("default");
      expectNotVacuous(output);
      expect(acceptance(output)).toEqual({
        beings: Array(8).fill([]),
        population: [],
        integrity: [],
        diverse: true,
      });
      expect(counts(output)).toEqual(COUNTS.default);
      expect(output.conversations).toBe(66);
      // The decisions, and the ticks the invariants and the oracle checked, a ninth of the run.
      expect([output.record.decisions, output.integrity.checkedTicks]).toEqual([1_644, 6_899]);
      // T4's items: health never fell, and some cell regrew and was eaten again.
      for (const being of output.record.beings) expect(being.lowestHealth).toBe(1_000_000);
      expect(output.record.regrewAndEaten).toBe(true);
    },
    TEST_MS,
  );

  test(
    "heldout/1: a preregistered failure, pinned as it was evaluated: being 5 never came within reach of speech of another being awake, so it encoded no being episode and neither greeted nor was greeted; every other item holds (changing laws or brain would burn this label)",
    async () => {
      const output = await outputOf("heldout");
      expectNotVacuous(output);
      expect(acceptance(output)).toEqual({
        beings: [[], [], [], [], ["being episode", "greeted", "was greeted"], [], [], []],
        population: [],
        integrity: [],
        diverse: true,
      });
      expect(counts(output)).toEqual(COUNTS.heldout);
      expect(output.conversations).toBe(15);
      expect([output.record.decisions, output.integrity.checkedTicks]).toEqual([1_058, 5_170]);
      for (const being of output.record.beings) expect(being.lowestHealth).toBe(1_000_000);
      expect(output.record.regrewAndEaten).toBe(true);
    },
    TEST_MS,
  );

  test(
    `both runs keep, tick by tick, the checksums they had when they were evaluated at ${EVALUATED_AT}`,
    async () => {
      const [ran, held] = await Promise.all([outputOf("default"), outputOf("heldout")]);
      expect({ default: ran.trail, heldout: held.trail }).toEqual(TRAILS);
    },
    TEST_MS,
  );

  test(
    "the default run resumed after tick 31,500 in a fresh process gives the next 1,500 ticks and the final snapshot",
    async () => {
      const { kept } = await outputOf("default");
      if (kept === undefined) throw new Error("the default run kept no snapshot");
      const input: ChildInput = {
        ruleset: SCENARIO2_RULESET,
        snapshot: kept.snapshot,
        from: MIDWAY + 1,
        script: Array.from({ length: MIDWAY + RESUMED }, () => []),
        audit: true,
      };
      const resume = Bun.fileURLToPath(
        new URL("../../engine/test/support/resume-child.ts", import.meta.url),
      );
      const resumed = (await jsonResult(startJsonChild(resume, input), CHILD_MS)) as ChildOutput;
      expect(resumed.records).toHaveLength(RESUMED);
      expect(firstDivergence(kept.records, resumed.records)).toBeUndefined();
      expect(resumed.finalError).toBeUndefined();
      expect(resumed.final).toBe(kept.final);
      // Not vacuous: the beings decided and their minds changed in those ticks.
      const events = kept.records.flatMap((tick) => ("events" in tick ? [tick.events] : []));
      expect(events.filter((text) => text.includes("mind.changed")).length).toBeGreaterThan(10);
    },
    TEST_MS,
  );
});
