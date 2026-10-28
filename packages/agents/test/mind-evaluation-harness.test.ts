/**
 * The harness of T5's evaluation (support/mind-evaluation.ts, mind-evaluation-run.ts, and
 * mind-ledger.ts), on calibration labels only, which burns nothing: the child process refuses the
 * reserve and every label outside the preregistration; its run is the run of the same input in this
 * process; the ledger's items agree with the operations each applied decision proposed, where both
 * count the same thing; and the acceptance names each item a run misses, by where it belongs.
 */
import { describe, expect, test } from "bun:test";
import { startJsonChild } from "./support/child.ts";
import {
  acceptance,
  type EvaluationInput,
  type EvaluationOutput,
  evaluationResult,
  startEvaluation,
} from "./support/mind-evaluation.ts";
import { evaluate, evaluationProblems } from "./support/mind-evaluation-run.ts";
import { LABELS2 } from "./support/mind-scenario.ts";

const FAKE = Bun.fileURLToPath(new URL("./support/fake-child.ts", import.meta.url));
const CALIBRATION_1 = LABELS2.calibration[0] as string;
const CHILD_MS = 60_000;
/** The first ticks of calibration/1, a fifth of a day: the beings meet, see food, and believe it. */
const TICKS = 1_500;

describe("an evaluation run", () => {
  test.each([
    "open-origin/t5/heldout/7",
    "open-origin/t5/heldout/12",
    "open-origin/t4/default",
    "open-origin/t5/default/2",
    "heldout/1",
  ])("refuses %s, which no evaluation may run", (label) => {
    expect(evaluationProblems({ label, ticks: 1 })).toEqual([
      `${label} is not a label an evaluation may run: ${[LABELS2.default, ...LABELS2.calibration, ...LABELS2.heldout].join(", ")}`,
    ]);
  });

  test.each([
    [
      { variant: "omniscient@1" },
      ["omniscient@1 is not a brain an evaluation may run: mind@1, amnesic"],
    ],
    [{ ticks: 0 }, ["0 is not a positive number of ticks"]],
    [{ ticks: 1.5 }, ["1.5 is not a positive number of ticks"]],
    [{ variant: "amnesic", falseClaim: true }, ["the false claim runs under mind@1 only"]],
  ])("refuses %j", (change, problems) => {
    const input = { label: CALIBRATION_1, ticks: 1, ...change } as unknown as EvaluationInput;
    expect(evaluationProblems(input)).toEqual(problems);
  });

  test("in a child process refuses the reserve before it runs anything", async () => {
    const label = "open-origin/t5/heldout/7";
    await expect(evaluationResult(startEvaluation({ label, ticks: 1 }), CHILD_MS)).rejects.toThrow(
      `${label} is not a label an evaluation may run`,
    );
  });

  test("that returns JSON of another shape is reported with what it wrote", async () => {
    const echo = { record: { beings: [] }, minds: 3 };
    await expect(evaluationResult(startJsonChild(FAKE, { echo }, "odd"), CHILD_MS)).rejects.toThrow(
      `the child process fake-child.ts (odd) returned no evaluation: ${JSON.stringify(echo)}`,
    );
  });
});

/** The run of the first ticks of calibration/1 in this process, made once. */
let short: EvaluationOutput | undefined;
const shortRun = () => {
  short ??= evaluate({ label: CALIBRATION_1, ticks: TICKS });
  return short;
};

describe("an evaluation of the first ticks of calibration/1", () => {
  test("in a child process is the run of the same input in this process", async () => {
    const child = await evaluationResult(
      startEvaluation({ label: CALIBRATION_1, ticks: TICKS }),
      CHILD_MS,
    );
    const { record, ...rest } = shortRun();
    const { record: childRecord, ...childRest } = child;
    expect(childRest).toEqual(rest);
    expect({ ...childRecord, wallMs: 0 }).toEqual({ ...record, wallMs: 0 });
  }, 30_000);

  test("keeps every invariant, rule, and link of the ledger, at every tick that changed the world", () => {
    const { integrity, seen } = shortRun();
    expect(integrity).toMatchObject({
      priorSuspect: 0,
      rules: { count: 0 },
      oracle: { count: 0 },
      invariants: { count: 0 },
    });
    expect(integrity.checkedTicks).toBeGreaterThan(100);
    expect(seen.beliefs).toBeGreaterThan(0);
  });

  test("counts from the ledger what the applied decisions proposed, where both count the same", () => {
    const { minds } = shortRun();
    for (const { ledger, proposed } of minds) {
      // Every episode a decision remembered is one the ledger encoded.
      expect([ledger.food, ledger.being]).toEqual([proposed[0], proposed[1]]);
      // A belief seen forms one, unless it adopts a belief already held; none is evicted here.
      expect(ledger.formedOwn).toBeLessThanOrEqual(proposed[2]);
      expect(ledger.evictedAtOnce).toBe(0);
    }
    // Not vacuous: the beings remembered food and one another, and believed what they saw.
    const total = (pick: (mind: (typeof minds)[number]) => number) =>
      minds.reduce((sum, mind) => sum + pick(mind), 0);
    expect(total((mind) => mind.ledger.food)).toBeGreaterThan(3);
    expect(total((mind) => mind.ledger.being)).toBeGreaterThan(1);
    expect(total((mind) => mind.ledger.formedOwn)).toBeGreaterThan(3);
  });

  test("misses, after so few ticks, T4's items of a run and the mind's items of a long one, by name", () => {
    const result = acceptance(shortRun());
    expect(result.integrity).toEqual([]);
    expect(result.beings).toHaveLength(8);
    for (const misses of result.beings) {
      expect(misses).toContain("meal cells");
      expect(misses).toContain("sleeps");
    }
    expect(result.population).toContain("10 conversations");
  });
});

describe("the acceptance of an evaluation", () => {
  /** A run that meets every item: the short run with every count raised to what the items ask. */
  function passing(): EvaluationOutput {
    const run = shortRun();
    const beings = run.record.beings.map((being) => ({
      ...being,
      mealCells: ["0,0", "0,1", "0,2", "0,3", "0,4"],
      ateOutsideBirthWindow: true,
      bigMeals: 5,
      sleeps: 9,
      restedWakes: 9,
      walked: 320,
    }));
    const ledger = {
      food: 1,
      being: 1,
      formedOwn: 3,
      fromTestimony: 1,
      revisedDown: 1,
      trustChecked: 1,
    };
    const minds = run.minds.map((mind) => ({
      ...mind,
      ledger: { ...mind.ledger, ...ledger },
      greeted: 1,
      wasGreeted: 1,
      relationsAtEnd: 1,
    }));
    const record = { ...run.record, beings, regrewAndEaten: true };
    return { ...run, record, minds, conversations: 10, diverse: true };
  }

  test("of a run that meets every item names none", () => {
    expect(acceptance(passing())).toEqual({
      beings: Array(8).fill([]),
      population: [],
      integrity: [],
      diverse: true,
    });
  });

  test.each([
    ["food episode", (run: EvaluationOutput) => withLedger(run, { food: 0 })],
    ["being episode", (run: EvaluationOutput) => withLedger(run, { being: 0 })],
    ["3 beliefs seen", (run: EvaluationOutput) => withLedger(run, { formedOwn: 2 })],
    ["relationship at end", (run: EvaluationOutput) => withMind(run, { relationsAtEnd: 0 })],
    ["greeted", (run: EvaluationOutput) => withMind(run, { greeted: 0 })],
    ["was greeted", (run: EvaluationOutput) => withMind(run, { wasGreeted: 0 })],
  ])("names %s for the one being that misses it", (item, change) => {
    const result = acceptance(change(passing()));
    expect(result.beings).toEqual([[], [], [item], [], [], [], [], []]);
    expect(result.population).toEqual([]);
  });

  test.each([
    ["revised down", { revisedDown: 0 }],
    ["from testimony", { fromTestimony: 0 }],
    ["trust checked", { trustChecked: 0 }],
  ])("names %s when no being of the population meets it", (item, zero) => {
    const run = passing();
    const minds = run.minds.map((mind) => ({ ...mind, ledger: { ...mind.ledger, ...zero } }));
    expect(acceptance({ ...run, minds }).population).toEqual([item]);
  });

  test("names regrown and eaten when no cell regrew and was eaten again (T4)", () => {
    const run = passing();
    const record = { ...run.record, regrewAndEaten: false };
    expect(acceptance({ ...run, record }).population).toEqual(["regrown and eaten"]);
  });

  test("names 10 conversations below ten, and none at ten", () => {
    expect(acceptance({ ...passing(), conversations: 9 }).population).toEqual(["10 conversations"]);
  });

  test.each([
    ["prior-suspect", { priorSuspect: 1 }],
    ["rules", { rules: { count: 1, first: ["x"] } }],
    ["oracle", { oracle: { count: 1, first: ["x"] } }],
    ["invariants", { invariants: { count: 1, first: ["x"] } }],
  ])("names %s in integrity", (item, change) => {
    const run = passing();
    expect(acceptance({ ...run, integrity: { ...run.integrity, ...change } }).integrity).toEqual([
      item,
    ]);
  });

  test("reports minds that are not diverse", () => {
    expect(acceptance({ ...passing(), diverse: false }).diverse).toBe(false);
  });
});

/** `run` with the ledger of being 3 changed by `change`. */
function withLedger(run: EvaluationOutput, change: object): EvaluationOutput {
  const minds = run.minds.map((mind, index) =>
    index === 2 ? { ...mind, ledger: { ...mind.ledger, ...change } } : mind,
  );
  return { ...run, minds };
}

/** `run` with the mind record of being 3 changed by `change`. */
function withMind(run: EvaluationOutput, change: object): EvaluationOutput {
  const minds = run.minds.map((mind, index) => (index === 2 ? { ...mind, ...change } : mind));
  return { ...run, minds };
}
