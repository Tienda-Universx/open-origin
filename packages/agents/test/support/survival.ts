import type { TickRecord } from "../../../engine/test/support/determinism-records.ts";
import { type JsonChild, jsonResult, startJsonChild } from "./child.ts";
import type { RunRecord } from "./metrics.ts";
import { LABELS, type Variant } from "./scenario.ts";

/**
 * Runs of the preregistered scenario of a label in a child process (survival-child.ts), so that
 * several run in parallel beside the test process: the survival test in CI runs the default label
 * and heldout/1 at once (plan §9.3), and the soak bench runs its labels two at a time.
 */

/** The brains a run may use: `utility@1`, or the soak's random-walk baseline. */
export type SurvivalBrain = "utility@1" | "random-walk@1";

/** What a child process runs. */
export type SurvivalInput = {
  readonly label: string;
  readonly ticks: number;
  readonly variant?: Variant;
  readonly brain?: SurvivalBrain;
  /**
   * The tick after which the run keeps the snapshot of its world, and how many ticks after it it
   * records, for a resume in another process to compare with.
   */
  readonly keep?: { readonly at: number; readonly ticks: number };
};

/** What a run kept: the snapshot after `keep.at`, the records after it, and the final snapshot. */
export type KeptRun = {
  readonly snapshot: string;
  readonly records: readonly TickRecord[];
  readonly final: string;
};

/** What a child process returns: the run's metrics, its world's day in seconds, what it kept. */
export type SurvivalOutput = {
  readonly record: RunRecord;
  readonly dayLength: number;
  readonly kept?: KeptRun;
};

/**
 * The labels a run may use: the default, calibration, and held-out labels of the preregistration.
 * The reserve, `heldout/7` to `/12`, replaces burned labels only, so no run may use it (none burned).
 */
export const RUNNABLE: readonly string[] = Object.freeze([
  LABELS.default,
  ...LABELS.calibration,
  ...LABELS.heldout,
]);

const SCRIPT = Bun.fileURLToPath(new URL("./survival-child.ts", import.meta.url));

/** Starts the run of `input` in a fresh process. */
export function startSurvival(input: SurvivalInput): JsonChild {
  return startJsonChild(SCRIPT, input);
}

/** What the run of `child` returned; throws when the process failed or returned another shape. */
export async function survivalResult(child: JsonChild, timeoutMs: number): Promise<SurvivalOutput> {
  const output = (await jsonResult(child, timeoutMs)) as Partial<SurvivalOutput>;
  if (!Array.isArray(output.record?.beings) || typeof output.dayLength !== "number")
    throw new Error("the survival child returned no record of its run");
  return output as SurvivalOutput;
}
