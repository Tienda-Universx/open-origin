/**
 * The calibration run of T5-7 (docs/architecture/mind.md, "Targets of calibration"): the
 * preregistered T5 scenario of each calibration label, 63,000 ticks (10 simulated days) of the
 * brain `mind@1` under the default laws of life@2, audit off, with the acceptance items of T4 for
 * every being, the items of the mind, the share of awake time each being spent talking, the
 * targets the laws decide alone, the wall time of each run, and the decisions per being and day.
 *
 *   bun packages/agents/bench/mind-calibration.ts [1 2 3 4] [--ticks N] [--spawn K] [--mindless]
 *
 * The numbers name calibration/1 to /4 of T5, all four by default; `--spawn K` draws the beings
 * from `<label>/spawn/K`, a check of calibration on the same terrain that is no registered
 * scenario; `--mindless` runs the mindless baseline, `utility@1` on beings@2, to compare with. It
 * runs only the calibration labels: the default label and the held-out ones are
 * refused, because running them would burn them, as is a variant of the laws, which T5 does not
 * calibrate. It reads its arguments with T4's bench, so it refuses what T4's refuses.
 */
import { beings } from "@open-origin/engine";
import { mindController } from "../src/index.ts";
import { misses, runScenario } from "../test/support/metrics.ts";
import {
  actTicks,
  diverse,
  MindObserver,
  mindMisses,
  observing,
  talkingShare,
} from "../test/support/mind-metrics.ts";
import { LABELS2, scenario2Of } from "../test/support/mind-scenario.ts";
import { lawTargets } from "../test/support/mind-targets.ts";
import { mindlessUtility } from "../test/support/mindless.ts";
import { LABELS, SCENARIO_SPS } from "../test/support/scenario.ts";
import { parseArguments as parseT4 } from "./calibration.ts";
import { beingRows } from "./table.ts";

/** What the arguments ask for: the T5 calibration labels, the ticks, another spawn, the brain. */
export type Arguments = {
  readonly labels: readonly string[];
  readonly ticks: number;
  readonly spawn: number | undefined;
  /** `mind@1`, or the mindless baseline, `utility@1` on beings@2, to compare with. */
  readonly brain: "mind" | "mindless";
};

/** The option that runs the mindless baseline instead of `mind@1`. */
const MINDLESS = "--mindless";

/**
 * The arguments of the bench, read as T4's bench reads them and mapped to the labels of T5, with
 * `--mindless` at most once. Throws an Error that says what is wrong, also for a variant of the
 * laws.
 */
export function parseArguments(argv: readonly string[]): Arguments {
  const rest = argv.filter((arg) => arg !== MINDLESS);
  if (argv.length - rest.length > 1) throw new Error(`${MINDLESS} is given twice`);
  const parsed = parseT4(rest);
  if (parsed.variant !== undefined)
    throw new Error(`${parsed.variant}: the calibration of T5 runs no variant of the laws`);
  const labels = parsed.labels.map(
    (label) => LABELS2.calibration[LABELS.calibration.indexOf(label)] as string,
  );
  const brain = rest.length < argv.length ? "mindless" : "mind";
  return { labels, ticks: parsed.ticks, spawn: parsed.spawn, brain };
}

/** The targets the laws decide alone, in days of the world. */
function printLawTargets(species: beings.Species2, day: number): void {
  const targets = lawTargets(species, day, SCENARIO_SPS);
  console.log(
    `laws: forgotten after ${(targets.forgottenAfter / day).toFixed(2)} L; familiarity ${targets.familiarDay} after 1 L, ${targets.familiarAbsent} after 10 L of absence`,
  );
}

/** One calibration run, printed as tables of its beings and the items of the population. */
function calibrate(label: string, options: Arguments): void {
  if (!LABELS2.calibration.includes(label)) throw new Error(`${label} is not a calibration label`);
  const observer = new MindObserver();
  const respawn = options.spawn === undefined ? {} : { spawnSuffix: `/${options.spawn}` };
  const scenario = scenario2Of(label, {
    ...respawn,
    controller: (species, dayLength) =>
      observer.controller(
        options.brain === "mind" ? mindController({ species, dayLength }) : mindlessUtility(),
      ),
  });
  observer.start(
    scenario.world,
    scenario.payloads.map((_, index) => index + 1),
  );
  const counted = { decisions: () => observer.run.decisions };
  const run = runScenario(scenario, options.ticks, counted, observing(observer));
  const minds = observer.finish(options.ticks);
  const species = beings.defaultLife2().species[0] as beings.Species2;
  const talk = actTicks(species.speech.actMs, SCENARIO_SPS);
  const perDay = (run.decisions * scenario.dayLength) / (options.ticks * SCENARIO_SPS * 8);
  const spawnText = `${options.spawn === undefined ? "" : ` (spawn/${options.spawn})`}${options.brain === "mind" ? "" : " (mindless)"}`;
  console.log(
    `\n${label}${spawnText}: ${options.ticks} ticks, ${(run.wallMs / 1000).toFixed(2)} s, ${perDay.toFixed(1)} decisions per being and day, regrown and eaten: ${run.regrewAndEaten}`,
  );
  for (const row of beingRows(run)) console.log(row);
  console.log(
    "being | food ep | being ep | seen | told | revised down | trust | greeted | was greeted | acts | talk ‰ awake | seeks | approaches | relations | T4 misses | mind misses",
  );
  for (const tally of minds.tallies.values()) {
    const record = run.beings.find(({ id }) => id === tally.id);
    const share = talkingShare(tally, options.ticks, talk);
    console.log(
      `${tally.id} | ${tally.foodEpisodes} | ${tally.beingEpisodes} | ${tally.seenBeliefs} | ${tally.toldBeliefs} | ${tally.revisedDown} | ${tally.trustChecks} | ${tally.greeted} | ${tally.wasGreeted} | ${tally.acts} | ${share} | ${tally.seeks} | ${tally.approaches} | ${tally.relationsAtEnd} | ${record === undefined ? "?" : misses(record).join(", ")} | ${mindMisses(tally).join(", ")}`,
    );
  }
  const all = [...minds.tallies.values()];
  const sum = (pick: (tally: (typeof all)[number]) => number) =>
    all.reduce((total, tally) => total + pick(tally), 0);
  console.log(
    `population: conversations ${minds.conversations}, revised down ${sum((t) => t.revisedDown)}, from testimony ${sum((t) => t.toldBeliefs)}, trust checked ${sum((t) => t.trustChecks)}; integrity: prior-suspect ${minds.priorSuspect}, rule problems ${minds.ruleProblems.length}; diverse ${diverse(minds)}`,
  );
  for (const problem of minds.ruleProblems.slice(0, 5)) console.log(`  ${problem}`);
}

if (import.meta.main) {
  let options: Arguments | undefined;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`mind-calibration: ${(error as Error).message}`);
    process.exit(2);
  }
  const species = beings.defaultLife2().species[0] as beings.Species2;
  console.log(`laws ${beings.LIFE2_VERSION}, seal ${beings.lifeSeal2(beings.defaultLife2())}`);
  printLawTargets(species, 75_600);
  for (const label of options.labels) calibrate(label, options);
}
