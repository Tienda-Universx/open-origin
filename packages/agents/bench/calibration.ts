/**
 * The calibration run of T4-6 (docs/architecture/beings.md, "Calibration"): the preregistered
 * scenario of each calibration label, 63,000 ticks (10 simulated days) of the brain `utility@1`
 * under the default laws, audit off, with the acceptance metrics of every being, the wall time of
 * each run, and the decisions per being and simulated day.
 *
 *   bun packages/agents/bench/calibration.ts [1 to 4]... [adverse | favorable] [--ticks N]
 *     [--spawn K]
 *
 * `adverse` and `favorable` run a variant of the laws; `--spawn K` draws the beings from
 * `<label>/spawn/K` instead of `<label>/spawn`, a check of calibration on the same terrain that is
 * no registered scenario.
 *
 * It runs only the calibration labels: running the default or a held-out label would burn it.
 */
import { beings, worldgen } from "@open-origin/engine";
import { utilityController } from "../src/index.ts";
import { ACCEPTANCE, countingBrain, misses, runScenario } from "../test/support/metrics.ts";
import {
  LABELS,
  SCENARIO_SPS,
  scenarioOf,
  type Variant,
  variantLife,
} from "../test/support/scenario.ts";

const TEN_DAYS = 63_000;

/** What the arguments ask for: the labels, the ticks, a variant of the laws, another spawn. */
type Arguments = {
  labels: string[];
  ticks: number;
  variant: Variant | undefined;
  spawn: string | undefined;
};

/** The calibration labels the arguments name, all four by default, the ticks, and the variant. */
function readArguments(argv: readonly string[]): Arguments {
  const at = argv.indexOf("--ticks");
  const ticks = at < 0 ? TEN_DAYS : Number(argv[at + 1]);
  const spawnAt = argv.indexOf("--spawn");
  const spawn = spawnAt < 0 ? undefined : argv[spawnAt + 1];
  const values = [at, spawnAt].filter((index) => index >= 0).map((index) => index + 1);
  const numbers = argv.filter((arg, index) => /^[1-4]$/.test(arg) && !values.includes(index));
  const labels = (numbers.length === 0 ? ["1", "2", "3", "4"] : numbers).map(
    (n) => LABELS.calibration[Number(n) - 1] as string,
  );
  const variant = argv.find((arg): arg is Variant => arg === "adverse" || arg === "favorable");
  return { labels, ticks, variant, spawn };
}

/** One calibration run, printed as a table of its beings. */
function calibrate(label: string, { ticks, variant, spawn }: Arguments): void {
  if (!LABELS.calibration.includes(label)) throw new Error(`${label} is not a calibration label`);
  const brain = countingBrain(utilityController());
  const life = variant === undefined ? beings.defaultLife() : variantLife(variant);
  const respawn = spawn === undefined ? {} : { spawnSuffix: `/${spawn}` };
  const scenario = scenarioOf(label, { controllers: { s1: brain.controller }, life, ...respawn });
  const run = runScenario(scenario, ticks, brain);
  const days =
    (ticks * SCENARIO_SPS) /
    worldgen.defaultGenesis(scenario.terrain.seeds.terrain).laws.day.length;
  console.log(
    `\n${label}${variant === undefined ? "" : ` (${variant})`}${spawn === undefined ? "" : ` (spawn/${spawn})`}: area ${scenario.area.center}, ${ticks} ticks, ${(run.wallMs / 1000).toFixed(2)} s, ${(run.decisions / scenario.payloads.length / days).toFixed(1)} decisions per being and day, regrown and eaten: ${run.regrewAndEaten}`,
  );
  console.log(
    "id  incap rest0 rejct cells out  meals big  sleeps rested walked lowN     lowH     misses",
  );
  for (const record of run.beings) {
    const cells = [
      record.id,
      record.incapacitated,
      record.exhausted,
      record.rejected,
      record.mealCells.length,
      record.ateOutsideBirthWindow ? "yes" : "no",
      record.meals,
      record.bigMeals,
      record.sleeps,
      record.restedWakes,
      record.walked,
      record.lowestNutrition,
      record.lowestHealth,
      misses(record).join(", ") || "-",
    ];
    const widths = [4, 6, 6, 6, 6, 5, 6, 5, 7, 7, 7, 9, 9];
    console.log(cells.map((cell, index) => `${cell}`.padEnd(widths[index] ?? 0)).join(""));
  }
}

const options = readArguments(process.argv.slice(2));
console.log(`acceptance: ${JSON.stringify(ACCEPTANCE)}; laws ${beings.LIFE_VERSION}`);
for (const label of options.labels) calibrate(label, options);
