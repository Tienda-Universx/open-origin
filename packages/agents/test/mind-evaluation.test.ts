/**
 * The preregistered evaluation of T5 (docs/architecture/mind.md, "Evaluation"; plan §11.1 and §15,
 * criterion 2): the default label and heldout/1 of T5, each 63,000 ticks (10 simulated days) of
 * eight beings under `mind@1` and the frozen laws of life@2, audit off, each in a child process
 * (support/mind-evaluation.ts) started before the first test, so that both run beside the other
 * tests, as T4's survival runs do. Every acceptance item is computed from the ledger and the state:
 * per being (T4's items and the mind's), of the population, of integrity (the invariants of the
 * minds and the ledger oracle at every tick that changed the world, every rule, no model-prior-
 * suspect), and of diversity. The results are pinned exactly as they were evaluated (EVALUATED_AT):
 * changing them burns both labels, and the evaluation moves to the reserve (mind.md, "Evaluation").
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
 * What each run gave when it was evaluated, at the commit EVALUATED_AT, pinned exactly: the
 * acceptance, each being's counts (counts), and the digest of every tick's checksum.
 */
const EVALUATED_AT = "";
const PINNED: { readonly [which: string]: unknown } = { default: undefined, heldout: undefined };
const TRAILS = { default: "", heldout: "" };

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
  expect(output.integrity.checkedTicks).toBeGreaterThan(TEN_DAYS / 10);
  for (const name of ["beliefs", "relations", "heard", "delivered", "told"])
    expect(output.seen[name]).toBeGreaterThan(0);
}

describe("the evaluation of mind@1 over ten days on the preregistered labels (mind.md, Evaluation)", () => {
  test(
    "default: PINNED AFTER THE BURN",
    async () => {
      const output = await outputOf("default");
      expectNotVacuous(output);
      expect({ acceptance: acceptance(output), counts: counts(output) }).toEqual(
        PINNED.default as never,
      );
    },
    TEST_MS,
  );

  test(
    "heldout/1: PINNED AFTER THE BURN",
    async () => {
      const output = await outputOf("heldout");
      expectNotVacuous(output);
      expect({ acceptance: acceptance(output), counts: counts(output) }).toEqual(
        PINNED.heldout as never,
      );
    },
    TEST_MS,
  );

  test(
    "both runs keep, tick by tick, the checksums they had when they were evaluated",
    async () => {
      const [ran, held] = await Promise.all([outputOf("default"), outputOf("heldout")]);
      expect({ at: EVALUATED_AT, default: ran.trail, heldout: held.trail }).toEqual({
        at: EVALUATED_AT,
        ...TRAILS,
      });
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
