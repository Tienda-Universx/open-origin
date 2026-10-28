import {
  type beings,
  digest,
  encodeSnapshot,
  type StepResult,
  worldgen,
} from "@open-origin/engine";
import { type TickRecord, tickRecord } from "../../../engine/test/support/determinism-records.ts";
import { utilityController } from "../../src/index.ts";
import { randomWalker, stationary } from "./brains.ts";
import { countingBrain, runScenario } from "./metrics.ts";
import { SCENARIO_SPS, type ScenarioOptions, scenarioOf, variantLife } from "./scenario.ts";
import { STATIONARY_SPS, stationaryLife } from "./stationary.ts";
import {
  BRAINS,
  type KeptRun,
  RUNNABLE,
  type SurvivalInput,
  type SurvivalOutput,
  VARIANTS,
} from "./survival.ts";

/**
 * The child process of a survival run (survival.ts): run as `bun survival-child.ts`, it reads one
 * SurvivalInput as JSON from stdin, runs the preregistered scenario of its label with the metrics
 * runner, audit off, and writes one SurvivalOutput as JSON to stdout. An input it does not know,
 * or anything it cannot do, it throws, so the process exits with an error that the parent reports.
 */

const input = JSON.parse(await Bun.stdin.text()) as SurvivalInput;
const brainName: string = input.brain ?? "utility@1";
const variantName: string | undefined = input.variant;
const problems: string[] = [];
if (!RUNNABLE.includes(input.label))
  problems.push(`${input.label} is not a label a run may use: ${RUNNABLE.join(", ")}`);
if (!(BRAINS as readonly string[]).includes(brainName))
  problems.push(`${brainName} is not a brain a run may use: ${BRAINS.join(", ")}`);
if (variantName !== undefined && !(VARIANTS as readonly string[]).includes(variantName))
  problems.push(`${variantName} is not a variant of the laws: ${VARIANTS.join(", ")}`);
if (variantName !== undefined && brainName === "stationary@1")
  problems.push("the stationary control runs under the default laws only");
if (problems.length > 0) throw new Error(problems.join("; "));

/** The brain of the run, and what else it changes: the variant, or the stationary settings. */
function setup(): { brain: beings.Controller; options: Omit<ScenarioOptions, "controllers"> } {
  if (brainName === "stationary@1")
    return {
      brain: stationary(),
      options: { life: stationaryLife(), simSecondsPerTick: STATIONARY_SPS },
    };
  const brain = brainName === "random-walk@1" ? randomWalker() : utilityController();
  return {
    brain,
    options: input.variant === undefined ? {} : { life: variantLife(input.variant) },
  };
}

const { brain: chosen, options } = setup();
const brain = countingBrain(chosen);
const scenario = scenarioOf(input.label, { ...options, controllers: { s1: brain.controller } });

/** The first tick at which each being was incapacitated, by id. */
const incapacitated = new Map<number, number>();
/** What the run keeps of its world, when the input asks for it. */
const keep = input.keep;
let snapshot: string | undefined;
let final: string | undefined;
const records: TickRecord[] = [];
/** Every tick's checksum, in order, whose digest the output carries. */
const checksums: string[] = [];

/** Records what one step did that the output needs. */
function onStep(result: StepResult): void {
  checksums.push(result.checksum);
  for (const event of result.events) {
    const { id } = event.payload as { id: number };
    if (event.type === "being.incapacitated" && !incapacitated.has(id))
      incapacitated.set(id, result.tick);
  }
  if (keep === undefined) return;
  if (result.tick === keep.at) snapshot = encodeSnapshot(scenario.world);
  if (result.tick <= keep.at || result.tick > keep.at + keep.ticks) return;
  records.push(tickRecord(result));
  if (result.tick === keep.at + keep.ticks) final = encodeSnapshot(scenario.world);
}

const record = runScenario(scenario, input.ticks, brain, onStep);
const kept: KeptRun | undefined =
  snapshot === undefined || final === undefined ? undefined : { snapshot, records, final };
const output: SurvivalOutput = {
  record,
  dayLength: worldgen.genesisOf(scenario.prepared).laws.day.length,
  simSecondsPerTick: options.simSecondsPerTick ?? SCENARIO_SPS,
  incapacitatedAt: [...incapacitated].sort(([a], [b]) => a - b),
  trail: digest(checksums),
  ...(kept === undefined ? {} : { kept }),
};
await Bun.write(Bun.stdout, JSON.stringify(output));
