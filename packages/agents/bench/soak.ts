/**
 * The soak of T4 (docs/architecture/beings.md, "Evaluation"; plan §9.3): the preregistered scenario
 * of each held-out label, 63,000 ticks (10 simulated days) of eight beings, audit off, under the
 * frozen default laws and brain `utility@1`, under the adverse and the favorable variants of the
 * laws, and, for comparison only, with the random-walk baseline instead of the brain. It prints
 * every being's acceptance items for every run, then a summary table, whatever the results are.
 *
 *   bun packages/agents/bench/soak.ts [1 2 3 4 5 6] [laws adverse favorable random-walk]
 *     [--ticks N] [--jobs K]
 *
 * The numbers name heldout/1 to /6, all six by default; the words name the runs of each label,
 * all four by default. Each run is a child process (test/support/survival-child.ts); `--jobs`
 * runs K of them at once, 2 by default. It runs only the held-out labels: the reserve, heldout/7 to
 * /12, replaces burned labels only, and the default and calibration labels have their own runs.
 * Any other argument is an error, and exits with code 2.
 */
import { beings } from "@open-origin/engine";
import { misses } from "../test/support/metrics.ts";
import { BEINGS, LABELS, SCENARIO_SPS, type Variant } from "../test/support/scenario.ts";
import {
  type SurvivalInput,
  type SurvivalOutput,
  startSurvival,
  survivalResult,
} from "../test/support/survival.ts";
import { beingRows, SUMMARY_HEADER, summaryCells } from "./table.ts";

const TEN_DAYS = 63_000;

/** The runs of a label: the default laws, each variant, and the random-walk baseline. */
const RUNS = ["laws", "adverse", "favorable", "random-walk"] as const;
type Run = (typeof RUNS)[number];

/** What the arguments ask for: the labels, the runs of each, the ticks, and the parallel runs. */
export type Arguments = {
  readonly labels: readonly string[];
  readonly runs: readonly Run[];
  readonly ticks: number;
  readonly jobs: number;
};

/** An argument that names a held-out label of the soak by its number. */
const HELDOUT = /^[1-6]$/;

/** An argument that names a reserve label, in any spelling: heldout/7 to /12. */
const RESERVE = /(^|\/)heldout\/([7-9]|1[0-2])$|^([7-9]|1[0-2])$/;

/** What the arguments read so far ask for. */
type Reading = { numbers: string[]; runs: Run[]; ticks?: number; jobs?: number };

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
  } else if (HELDOUT.test(arg) && !reading.numbers.includes(arg)) {
    reading.numbers.push(arg);
  } else {
    throw new Error(
      `unknown argument "${arg}": give 1 to 6, ${RUNS.join(", ")}, --ticks N, or --jobs K`,
    );
  }
}

/**
 * The arguments of the soak. Throws an Error that says what is wrong: a reserve label, any other
 * label or word, an option without a valid value, or an option, a run, or a label given twice.
 */
export function parseArguments(argv: readonly string[]): Arguments {
  const reading: Reading = { numbers: [], runs: [] };
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at] as string;
    if (arg === "--ticks" || arg === "--jobs") {
      readOption(reading, argv, at);
      at += 1;
    } else readWord(reading, arg);
  }
  const numbers = reading.numbers.length === 0 ? ["1", "2", "3", "4", "5", "6"] : reading.numbers;
  return {
    labels: numbers.map((n) => LABELS.heldout[Number(n) - 1] as string),
    runs: reading.runs.length === 0 ? [...RUNS] : reading.runs,
    ticks: reading.ticks ?? TEN_DAYS,
    jobs: reading.jobs ?? 2,
  };
}

/** The input of the child process of `run` on `label`. */
function inputOf(label: string, run: Run, ticks: number): SurvivalInput {
  if (run === "random-walk") return { label, ticks, brain: "random-walk@1" };
  if (run === "laws") return { label, ticks };
  const variant: Variant = run;
  return { label, ticks, variant };
}

/** The name of `run` on `label` in the tables: the label without its prefix, and the run. */
const nameOf = (label: string, run: Run) => `${label.replace("open-origin/t4/", "")} ${run}`;

/** Prints one finished run: a heading, then a row per being. */
function printRun(name: string, output: SurvivalOutput, ticks: number): void {
  const { record, dayLength } = output;
  const perDay = (record.decisions * dayLength) / (ticks * SCENARIO_SPS * BEINGS);
  const failed = record.beings.filter((being) => misses(being).length > 0).length;
  console.log(
    `\n${name}: ${ticks} ticks, ${(record.wallMs / 1000).toFixed(2)} s, ${perDay.toFixed(1)} decisions per being and day, regrown and eaten: ${record.regrewAndEaten}, beings missing an item: ${failed}`,
  );
  for (const row of beingRows(record)) console.log(row);
}

/** Runs every job, `jobs` at a time, and returns their outputs in the order of `work`. */
async function runAll(
  work: readonly { readonly name: string; readonly input: SurvivalInput }[],
  options: Arguments,
): Promise<SurvivalOutput[]> {
  const outputs: SurvivalOutput[] = [];
  for (let first = 0; first < work.length; first += options.jobs) {
    const batch = work.slice(first, first + options.jobs);
    const children = batch.map(({ input }) => startSurvival(input));
    const finished = await Promise.all(children.map((child) => survivalResult(child, 3_600_000)));
    for (const [index, output] of finished.entries())
      printRun(batch[index]?.name ?? "", output, options.ticks);
    outputs.push(...finished);
  }
  return outputs;
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
  const work = options.labels.flatMap((label) =>
    options.runs.map((run) => ({
      name: nameOf(label, run),
      input: inputOf(label, run, options.ticks),
    })),
  );
  const outputs = await runAll(work, options);
  console.log(`\n${SUMMARY_HEADER.join("\n")}`);
  for (const [index, output] of outputs.entries())
    console.log(`| ${work[index]?.name} | ${summaryCells(output.record).join(" | ")} |`);
}
