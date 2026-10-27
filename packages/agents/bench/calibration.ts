/**
 * The calibration run of T4-6 (docs/architecture/beings.md, "Calibration"): the preregistered
 * scenario of each calibration label, 63,000 ticks (10 simulated days) of the brain `utility@1`
 * under the default laws, audit off, with the acceptance metrics of every being, the wall time of
 * each run, and the decisions per being and simulated day.
 *
 *   bun packages/agents/bench/calibration.ts [1 2 3 4] [adverse | favorable] [--ticks N]
 *     [--spawn K]
 *
 * The numbers name calibration/1 to /4, all four by default. `adverse` and `favorable` run a
 * variant of the laws; `--spawn K` draws the beings from `<label>/spawn/K` instead of
 * `<label>/spawn`, a check of calibration on the same terrain that is no registered scenario.
 *
 * It runs only the calibration labels: the default label and the held-out ones are refused,
 * because running them would burn them. Any other argument is an error, and exits with code 2.
 */
import { beings, worldgen } from "@open-origin/engine";
import { utilityController } from "../src/index.ts";
import { ACCEPTANCE, countingBrain, runScenario } from "../test/support/metrics.ts";
import {
  BEINGS,
  LABELS,
  SCENARIO_SPS,
  scenarioOf,
  type Variant,
  variantLife,
} from "../test/support/scenario.ts";
import { beingRows } from "./table.ts";

const TEN_DAYS = 63_000;

/** What the arguments ask for: the labels, the ticks, a variant of the laws, another spawn. */
export type Arguments = {
  readonly labels: readonly string[];
  readonly ticks: number;
  readonly variant: Variant | undefined;
  readonly spawn: number | undefined;
};

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

/** An argument that names a calibration label by its number. */
const CALIBRATION = /^[1-4]$/;

/** An argument that names the default label or a held-out one, in any spelling. */
const BURNED = /(^|\/)(default|heldout)(\/|$)/;

/** What the arguments read so far ask for. */
type Reading = { numbers: string[]; ticks?: number; spawn?: number; variant?: Variant };

/** Reads the option `--ticks` or `--spawn` at `argv[at]` into `reading`. */
function readOption(reading: Reading, argv: readonly string[], at: number): void {
  const option = argv[at] === "--ticks" ? "ticks" : "spawn";
  if (reading[option] !== undefined) throw new Error(`--${option} is given twice`);
  reading[option] = positive(argv, at);
}

/** Reads the argument `arg`, which is no option, into `reading`. */
function readWord(reading: Reading, arg: string): void {
  if (arg === "adverse" || arg === "favorable") {
    if (reading.variant !== undefined)
      throw new Error("give at most one variant: adverse or favorable");
    reading.variant = arg;
  } else if (BURNED.test(arg)) {
    throw new Error(`${arg} is not a calibration label: running it would burn it`);
  } else if (CALIBRATION.test(arg) && !reading.numbers.includes(arg)) {
    reading.numbers.push(arg);
  } else {
    throw new Error(
      `unknown argument "${arg}": give 1 to 4, adverse or favorable, --ticks N, or --spawn K`,
    );
  }
}

/**
 * The arguments of the bench. Throws an Error that says what is wrong: an option without a valid
 * value, the default or a held-out label, any other label or word, or an option, a variant, or a
 * label given twice.
 */
export function parseArguments(argv: readonly string[]): Arguments {
  const reading: Reading = { numbers: [] };
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at] as string;
    if (arg === "--ticks" || arg === "--spawn") {
      readOption(reading, argv, at);
      at += 1;
    } else readWord(reading, arg);
  }
  const chosen = reading.numbers.length === 0 ? ["1", "2", "3", "4"] : reading.numbers;
  return {
    labels: chosen.map((n) => LABELS.calibration[Number(n) - 1] as string),
    ticks: reading.ticks ?? TEN_DAYS,
    variant: reading.variant,
    spawn: reading.spawn,
  };
}

/** What heads the table of one run: its run, and the seconds of its world's day. */
type Measured = { readonly wallMs: number; readonly decisions: number; readonly day: number };

/** The line that heads the table of one run. */
function heading(label: string, options: Arguments, run: Measured): string {
  const { variant, spawn, ticks } = options;
  const perDay = (run.decisions * run.day) / (ticks * SCENARIO_SPS * BEINGS);
  const variantText = variant === undefined ? "" : ` (${variant})`;
  const spawnText = spawn === undefined ? "" : ` (spawn/${spawn})`;
  return `\n${label}${variantText}${spawnText}: ${ticks} ticks, ${(run.wallMs / 1000).toFixed(2)} s, ${perDay.toFixed(1)} decisions per being and day`;
}

/** One calibration run, printed as a table of its beings. */
function calibrate(label: string, options: Arguments): void {
  if (!LABELS.calibration.includes(label)) throw new Error(`${label} is not a calibration label`);
  const { ticks, variant, spawn } = options;
  const brain = countingBrain(utilityController());
  const life = variant === undefined ? beings.defaultLife() : variantLife(variant);
  const respawn = spawn === undefined ? {} : { spawnSuffix: `/${spawn}` };
  const scenario = scenarioOf(label, { controllers: { s1: brain.controller }, life, ...respawn });
  const run = runScenario(scenario, ticks, brain);
  const day = worldgen.genesisOf(scenario.prepared).laws.day.length;
  console.log(
    `${heading(label, options, { ...run, day })}, regrown and eaten: ${run.regrewAndEaten}`,
  );
  for (const row of beingRows(run)) console.log(row);
}

if (import.meta.main) {
  let options: Arguments | undefined;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`calibration: ${(error as Error).message}`);
    process.exit(2);
  }
  console.log(`acceptance: ${JSON.stringify(ACCEPTANCE)}; laws ${beings.LIFE_VERSION}`);
  for (const label of options.labels) calibrate(label, options);
}
