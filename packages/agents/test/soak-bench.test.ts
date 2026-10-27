/**
 * The arguments of the soak (packages/agents/bench/soak.ts): it runs only the held-out labels,
 * refuses the reserve in any spelling, and refuses every argument it does not know instead of
 * ignoring it. Its tables (bench/table.ts) summarize a run by its acceptance items.
 */
import { describe, expect, test } from "bun:test";
import { type Job, parseArguments, runAll } from "../bench/soak.ts";
import { stationaryCells, summaryCells } from "../bench/table.ts";
import type { BeingRecord } from "./support/metrics.ts";
import { LABELS } from "./support/scenario.ts";

describe("the arguments of the soak", () => {
  test("run the six held-out labels, each with the laws, both variants, and the random walk", () => {
    expect(parseArguments([])).toEqual({
      labels: [...LABELS.heldout],
      runs: ["laws", "adverse", "favorable", "random-walk", "stationary"],
      ticks: 63_000,
      jobs: 2,
    });
  });

  test("name labels by number, the runs by word, the ticks, and the parallel runs", () => {
    expect(parseArguments(["6", "2", "adverse", "laws", "--ticks", "300", "--jobs", "3"])).toEqual({
      labels: [LABELS.heldout[5] as string, LABELS.heldout[1] as string],
      runs: ["adverse", "laws"],
      ticks: 300,
      jobs: 3,
    });
  });

  test.each([
    { argv: ["7"] },
    { argv: ["12"] },
    { argv: ["heldout/7"] },
    { argv: ["open-origin/t4/heldout/10"] },
    { argv: ["1", "heldout/12"] },
  ])("refuse the reserve label in $argv", ({ argv }) => {
    expect(() => parseArguments(argv)).toThrow("is a reserve label");
  });

  test.each([
    { argv: ["0"], message: 'unknown argument "0"' },
    { argv: ["13"], message: 'unknown argument "13"' },
    { argv: ["default"], message: 'unknown argument "default"' },
    { argv: ["calibration/1"], message: 'unknown argument "calibration/1"' },
    { argv: ["heldout/1"], message: 'unknown argument "heldout/1"' },
    { argv: ["1", "1"], message: 'unknown argument "1"' },
    { argv: ["adverse", "adverse"], message: 'unknown argument "adverse"' },
    { argv: ["random"], message: 'unknown argument "random"' },
    { argv: ["--tick", "3"], message: 'unknown argument "--tick"' },
    { argv: ["--ticks"], message: "--ticks needs a value" },
    { argv: ["--ticks", "0"], message: '--ticks must be a positive integer, not "0"' },
    { argv: ["--jobs", "1.5"], message: '--jobs must be a positive integer, not "1.5"' },
    { argv: ["--jobs", "2", "--jobs", "2"], message: "--jobs is given twice" },
  ])("refuse $argv: $message", ({ argv, message }) => {
    expect(() => parseArguments(argv)).toThrow(message);
  });
});

describe("the summary of a run", () => {
  /** A being's record that meets every item, changed by `change`. */
  const being = (id: number, change: Partial<BeingRecord> = {}): BeingRecord => ({
    id,
    born: [0, 0],
    incapacitated: 0,
    died: 0,
    exhausted: 0,
    rejected: 0,
    mealCells: ["0,0", "1,0", "2,0", "3,0", "40,0"],
    ateOutsideBirthWindow: true,
    meals: 6,
    bigMeals: 5,
    sleeps: 10,
    restedWakes: 9,
    walked: 400,
    lowestNutrition: 500_000,
    lowestHealth: 1_000_000,
    final: undefined,
    ...change,
  });

  test("gives the totals, the minimum of each item, and the beings that miss one", () => {
    const run = {
      beings: [
        being(1, { mealCells: ["0,0", "1,0", "2,0", "3,0", "4,0", "5,0", "40,0"], bigMeals: 7 }),
        being(2, { ateOutsideBirthWindow: false, walked: 320, lowestNutrition: 1_234 }),
        being(3, { exhausted: 2, sleeps: 9, restedWakes: 8 }),
      ],
      regrewAndEaten: true,
      decisions: 0,
      wallMs: 0,
    };
    expect(summaryCells(run)).toEqual([
      "0, 2, 0",
      "5",
      "2 of 3",
      "5",
      "9; 8",
      "320",
      "1,234",
      "yes",
      "fail: 2 (outside birth window); 3 (rest 0, rested wakes)",
    ]);
    expect(summaryCells({ ...run, beings: [being(1)] }).at(-1)).toBe("pass");
    // Some cell must also have regrown and been eaten again.
    const unregrown = { ...run, beings: [being(1)], regrewAndEaten: false };
    expect(summaryCells(unregrown).slice(-2)).toEqual([
      "no",
      "fail: no cell regrew and was eaten again",
    ]);
  });
});

describe("the summary of a run of the stationary control", () => {
  const ticks = { tenDays: 1_260, horizon: 6_007 };
  const run = (incapacitatedAt: [number, number][], beings = 3) => ({
    beings,
    incapacitatedAt,
    secondsPerTick: 600,
    dayLength: 75_600,
  });

  test("gives the beings incapacitated, the day of the last, and the bounds it is within", () => {
    expect(
      stationaryCells(
        run([
          [1, 400],
          [2, 896],
          [3, 12],
        ]),
        ticks,
      ),
    ).toEqual(["3 of 3", "7.1 (tick 896)", "yes", "yes"]);
    expect(
      stationaryCells(
        run([
          [1, 400],
          [2, 1_261],
          [3, 6_007],
        ]),
        ticks,
      ),
    ).toEqual(["3 of 3", "47.7 (tick 6007)", "no", "yes"]);
  });

  test("is within no bound while a being was never incapacitated", () => {
    expect(
      stationaryCells(
        run([
          [1, 400],
          [3, 12],
        ]),
        ticks,
      ),
    ).toEqual(["2 of 3", "-", "no", "no"]);
  });
});

describe("the runs of the soak", () => {
  test("report a child that fails, and still run and report its siblings", async () => {
    const work: Job[] = [
      { name: "refused", run: "laws", input: { label: "open-origin/t4/heldout/7", ticks: 1 } },
      { name: "short", run: "laws", input: { label: LABELS.calibration[0] as string, ticks: 2 } },
    ];
    const shown: string[] = [];
    const done = await runAll(work, 2, {
      run: (job) => shown.push(`run ${job.name}`),
      error: (job) => shown.push(`error ${job.name}`),
    });
    expect(shown).toEqual(["error refused", "run short"]);
    expect(done[0]?.error).toContain(
      "the child process survival-child.ts (open-origin/t4/heldout/7) exited with 1",
    );
    expect(done[1]?.output?.record.beings).toHaveLength(8);
  }, 60_000);
});
