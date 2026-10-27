import { encodeSnapshot, type StepResult, worldgen } from "@open-origin/engine";
import { type TickRecord, tickRecord } from "../../../engine/test/support/determinism-records.ts";
import { utilityController } from "../../src/index.ts";
import { randomWalker } from "./brains.ts";
import { countingBrain, runScenario } from "./metrics.ts";
import { scenarioOf, variantLife } from "./scenario.ts";
import { type KeptRun, RUNNABLE, type SurvivalInput, type SurvivalOutput } from "./survival.ts";

/**
 * The child process of a survival run (survival.ts): run as `bun survival-child.ts`, it reads one
 * SurvivalInput as JSON from stdin, runs the preregistered scenario of its label with the metrics
 * runner, audit off, and writes one SurvivalOutput as JSON to stdout. Anything it cannot do, it
 * throws, so the process exits with an error that the parent reports.
 */

const input = JSON.parse(await Bun.stdin.text()) as SurvivalInput;
if (!RUNNABLE.includes(input.label))
  throw new Error(`${input.label} is not a label a run may use: ${RUNNABLE.join(", ")}`);
const brain = countingBrain(input.brain === "random-walk@1" ? randomWalker() : utilityController());
const variant = input.variant === undefined ? {} : { life: variantLife(input.variant) };
const scenario = scenarioOf(input.label, { controllers: { s1: brain.controller }, ...variant });

/** What the run keeps of its world, when the input asks for it. */
const keep = input.keep;
let snapshot: string | undefined;
let final: string | undefined;
const records: TickRecord[] = [];
const onStep =
  keep === undefined
    ? undefined
    : (result: StepResult) => {
        if (result.tick === keep.at) snapshot = encodeSnapshot(scenario.world);
        if (result.tick <= keep.at || result.tick > keep.at + keep.ticks) return;
        records.push(tickRecord(result));
        if (result.tick === keep.at + keep.ticks) final = encodeSnapshot(scenario.world);
      };

const record = runScenario(scenario, input.ticks, brain, onStep);
const kept: KeptRun | undefined =
  snapshot === undefined || final === undefined ? undefined : { snapshot, records, final };
const dayLength = worldgen.genesisOf(scenario.prepared).laws.day.length;
const output: SurvivalOutput = { record, dayLength, ...(kept === undefined ? {} : { kept }) };
await Bun.write(Bun.stdout, JSON.stringify(output));
