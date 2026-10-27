/**
 * The soak of T4 (docs/architecture/beings.md, "Evaluation"; plan §9.3): the preregistered scenario
 * of each held-out label, 63,000 ticks (10 simulated days) of eight beings, audit off, under the
 * frozen default laws and brain `utility@1`, under the adverse and the favorable variants of the
 * laws, and, for comparison only, with the random-walk baseline instead of the brain; and the
 * stationary control, a negative control of the preregistration, at its own settings
 * (test/support/stationary.ts) for the ticks of the stationary horizon H. Then, once, the negative
 * control of the nearly barren world on calibration/1's terrain (test/support/controls.ts), which
 * T4-8 moved here from survival.test.ts to keep `bun test` in CI within its budget. It prints every
 * being's acceptance items for every run, then a summary table of the acceptance, one of the
 * stationary control, and the barren control's verdict, whatever the results are.
 *
 *   bun packages/agents/bench/soak.ts [1 2 3 4 5 6] [laws adverse favorable random-walk
 *     stationary barren] [--ticks N] [--jobs K]
 *
 * The numbers name heldout/1 to /6, all six by default; the words name the runs of each label and
 * the barren control, all of them by default; `--ticks` sets the ticks of every run but the
 * stationary control's. Each run of a label is a child process (test/support/survival-child.ts);
 * `--jobs` runs K of them at once, 2 by default. A child that fails is reported, its siblings
 * still run, and the soak exits with code 1 after its tables, as it does when the barren control
 * fails. It runs only the held-out labels: the reserve, heldout/7 to /12, replaces burned labels
 * only, and the default and calibration labels have their own runs. Any other argument is an
 * error, and exits with code 2.
 */
import { beings } from "@open-origin/engine";
import { type BarrenRun, barrenControl, barrenIssues } from "../test/support/controls.ts";
import { misses } from "../test/support/metrics.ts";
import { BEINGS, LABELS, type Variant } from "../test/support/scenario.ts";
import { stationaryTicks } from "../test/support/stationary.ts";
import {
  type SurvivalInput,
  type SurvivalOutput,
  startSurvival,
  survivalResult,
} from "../test/support/survival.ts";
import {
  beingRows,
  STATIONARY_HEADER,
  SUMMARY_HEADER,
  stationaryCells,
  summaryCells,
} from "./table.ts";

const TEN_DAYS = 63_000;

/**
 * The runs of a label: the default laws, each variant, the random-walk baseline, and the
 * stationary control.
 */
const RUNS = ["laws", "adverse", "favorable", "random-walk", "stationary"] as const;
export type Run = (typeof RUNS)[number];

/**
 * What the arguments ask for: the labels, the runs of each, whether to run the barren control, the
 * ticks, and the parallel runs.
 */
export type Arguments = {
  readonly labels: readonly string[];
  readonly runs: readonly Run[];
  readonly barren: boolean;
  readonly ticks: number;
  readonly jobs: number;
};

/** An argument that names a held-out label of the soak by its number. */
const HELDOUT = /^[1-6]$/;

/** An argument that names a reserve label, in any spelling: heldout/7 to /12. */
const RESERVE = /(^|\/)heldout\/([7-9]|1[0-2])$|^([7-9]|1[0-2])$/;

/** What the arguments read so far ask for. */
type Reading = { numbers: string[]; runs: Run[]; barren: boolean; ticks?: number; jobs?: number };

/** The value of the option at `argv[at]`, which must be a positive safe integer. */
function positive(argv: readonly string[], at: number): number {
  const option = argv[at] as string;
  const text = argv[at + 1];
  if (text === undefined) throw new Error(`${option} needs a value: a positive integer`);
  const value = Number(text);
  if (!/^[0-9]+$/.test(text) || !Number.isSafeInteger(value) || value < 1)
    throw new Error(`${option} must be a positive integer, not "${text}"`);
  return value;
}

/** Reads the option `--ticks` or `--jobs` at `argv[at]` into `reading`. */
function readOption(reading: Reading, argv: readonly string[], at: number): void {
  const option = argv[at] === "--ticks" ? "ticks" : "jobs";
  if (reading[option] !== undefined) throw new Error(`--${option} is given twice`);
  reading[option] = positive(argv, at);
}

/** Whether `arg` names one of the runs of a label. */
const isRun = (arg: string): arg is Run => (RUNS as readonly string[]).includes(arg);

/** Reads the argument `arg`, which is no option, into `reading`. */
function readWord(reading: Reading, arg: string): void {
  if (RESERVE.test(arg))
    throw new Error(
      `${arg} is a reserve label: it replaces burned labels only, and none is burned`,
    );
  if (isRun(arg) && !reading.runs.includes(arg)) {
    reading.runs.push(arg);
  } else if (arg === "barren" && !reading.barren) {
    reading.barren = true;
  } else if (HELDOUT.test(arg) && !reading.numbers.includes(arg)) {
    reading.numbers.push(arg);
  } else {
    throw new Error(
      `unknown argument "${arg}": give 1 to 6, ${RUNS.join(", ")}, barren, --ticks N, or --jobs K`,
    );
  }
}

/**
 * The arguments of the soak. Throws an Error that says what is wrong: a reserve label, any other
 * label or word, an option without a valid value, or an option, a run, or a label given twice.
 */
export function parseArguments(argv: readonly string[]): Arguments {
  const reading: Reading = { numbers: [], runs: [], barren: false };
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at] as string;
    if (arg === "--ticks" || arg === "--jobs") {
      readOption(reading, argv, at);
      at += 1;
    } else readWord(reading, arg);
  }
  const numbers = reading.numbers.length === 0 ? ["1", "2", "3", "4", "5", "6"] : reading.numbers;
  // Naming no run at all asks for every run and the barren control.
  const named = reading.runs.length > 0 || reading.barren;
  return {
    labels: numbers.map((n) => LABELS.heldout[Number(n) - 1] as string),
    runs: named ? reading.runs : [...RUNS],
    barren: named ? reading.barren : true,
    ticks: reading.ticks ?? TEN_DAYS,
    jobs: reading.jobs ?? 2,
  };
}

/** A run of the soak: its name in the tables, which run it is, and its child's input. */
export type Job = { readonly name: string; readonly run: Run; readonly input: SurvivalInput };

/** What a job gave: the output of its child, or the error that ended it. */
export type Done = { readonly job: Job; readonly output?: SurvivalOutput; readonly error?: string };

/**
 * The input of the child process of `run` on `label`: `ticks` ticks of 12 s, but the stationary
 * control runs the ticks of H at its own settings.
 */
function inputOf(label: string, run: Run, ticks: number): SurvivalInput {
  if (run === "stationary")
    return { label, ticks: stationaryTicks(label).horizon, brain: "stationary@1" };
  if (run === "random-walk") return { label, ticks, brain: "random-walk@1" };
  if (run === "laws") return { label, ticks };
  const variant: Variant = run;
  return { label, ticks, variant };
}

/** The name of `run` on `label` in the tables: the label without its prefix, and the run. */
const nameOf = (label: string, run: Run) => `${label.replace("open-origin/t4/", "")} ${run}`;

/** Prints one finished run: a heading, then a row per being. */
function printRun({ name, input }: Job, output: SurvivalOutput): void {
  const { record, dayLength, simSecondsPerTick } = output;
  const perDay = (record.decisions * dayLength) / (input.ticks * simSecondsPerTick * BEINGS);
  const failed = record.beings.filter((being) => misses(being).length > 0).length;
  console.log(
    `\n${name}: ${input.ticks} ticks of ${simSecondsPerTick} s, ${(record.wallMs / 1000).toFixed(2)} s, ${perDay.toFixed(1)} decisions per being and day, regrown and eaten: ${record.regrewAndEaten}, beings missing an item: ${failed}`,
  );
  for (const row of beingRows(record)) console.log(row);
  if (output.incapacitatedAt.length > 0)
    console.log(
      `first incapacitated (id: tick): ${output.incapacitatedAt.map(([id, tick]) => `${id}: ${tick}`).join(", ")}`,
    );
}

/** How a finished job is shown: by default, its run printed, or its error on stderr. */
export type Show = {
  readonly run: (job: Job, output: SurvivalOutput) => void;
  readonly error: (job: Job, error: string) => void;
};

const PRINT: Show = {
  run: printRun,
  error: (job, error) => console.error(`\n${job.name}: ${error}`),
};

/**
 * Runs every job, `jobs` at a time, and returns what each gave, in the order of `work`, after
 * `show` showed it. A child that fails is reported, and its siblings still run and are reported.
 */
export async function runAll(work: readonly Job[], jobs: number, show = PRINT): Promise<Done[]> {
  const done: Done[] = [];
  for (let first = 0; first < work.length; first += jobs) {
    const batch = work.slice(first, first + jobs);
    const children = batch.map(({ input }) => startSurvival(input));
    const settled = await Promise.allSettled(
      children.map((child) => survivalResult(child, 3_600_000)),
    );
    for (const [index, result] of settled.entries()) {
      const job = batch[index] as Job;
      if (result.status === "fulfilled") {
        show.run(job, result.value);
        done.push({ job, output: result.value });
      } else {
        const error = (result.reason as Error).message;
        show.error(job, error);
        done.push({ job, error });
      }
    }
  }
  return done;
}

/** Prints the summary tables of `done`: the acceptance of each run, and the stationary control. */
function printSummary(done: readonly Done[]): void {
  const acceptance = done.filter(({ job }) => job.run !== "stationary");
  if (acceptance.length > 0) console.log(`\n${SUMMARY_HEADER.join("\n")}`);
  for (const { job, output, error } of acceptance) {
    const cells = output === undefined ? [`error: ${error}`] : summaryCells(output.record);
    console.log(`| ${job.name} | ${cells.join(" | ")} |`);
  }
  const controls = done.filter(({ job }) => job.run === "stationary");
  if (controls.length > 0) console.log(`\n${STATIONARY_HEADER.join("\n")}`);
  for (const { job, output, error } of controls) {
    const cells =
      output === undefined
        ? [`error: ${error}`]
        : stationaryCells(
            {
              beings: output.record.beings.length,
              incapacitatedAt: output.incapacitatedAt,
              secondsPerTick: output.simSecondsPerTick,
              dayLength: output.dayLength,
            },
            stationaryTicks(job.input.label),
          );
    console.log(`| ${job.name} | ${cells.join(" | ")} |`);
  }
}

/**
 * The verdict of the barren control, as the cells of a Markdown row: when each being was
 * incapacitated and its bound, the bites, the cues sensed, and pass or every way it failed.
 */
export function barrenCells(run: BarrenRun): string[] {
  const issues = barrenIssues(run);
  return [
    run.incapacitated
      .map(([id, tick]) => `${id}: ${tick} (bound ${run.bounds[id - 1]})`)
      .join("; "),
    `${run.bites}`,
    `{${run.cues.join(", ")}}`,
    issues.length === 0 ? "pass" : `fail: ${issues.join("; ")}`,
  ];
}

if (import.meta.main) {
  let options: Arguments | undefined;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`soak: ${(error as Error).message}`);
    process.exit(2);
  }
  console.log(`soak: laws ${beings.LIFE_VERSION}, ${options.ticks} ticks, ${options.jobs} at once`);
  const { ticks } = options;
  const work = options.labels.flatMap((label) =>
    options.runs.map((run) => ({
      name: nameOf(label, run),
      run,
      input: inputOf(label, run, ticks),
    })),
  );
  const done = await runAll(work, options.jobs);
  printSummary(done);
  // A child that failed fails the soak, after every run was reported.
  if (done.some(({ error }) => error !== undefined)) process.exitCode = 1;
  if (options.barren) {
    const started = performance.now();
    const barren = barrenControl();
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    console.log(
      `\n| Barren control, ${seconds} s | Incapacitated at tick | Bites | Cues sensed | Verdict |`,
    );
    console.log("|---|---|---|---|---|");
    console.log(`| calibration/1, two beings | ${barrenCells(barren).join(" | ")} |`);
    if (barrenIssues(barren).length > 0) process.exitCode = 1;
  }
}
