import type { TickRecord } from "../../../engine/test/support/determinism-records.ts";
import { type JsonChild, jsonResult, startJsonChild } from "./child.ts";
import type { RunRecord } from "./metrics.ts";
import { LABELS, type Variant } from "./scenario.ts";

/**
 * Runs of the preregistered scenario of a label in a child process (survival-child.ts), so that
 * several run in parallel beside the test process: the survival test in CI runs the default label
 * and heldout/1 at once (plan §9.3), and the soak bench runs its labels two at a time.
 */

/**
 * The brains a run may use: `utility@1`; the soak's random-walk baseline; and the stationary
 * control, which runs with the settings of support/stationary.ts.
 */
export const BRAINS = Object.freeze(["utility@1", "random-walk@1", "stationary@1"] as const);
type SurvivalBrain = (typeof BRAINS)[number];

/** The variants of the laws a run may use. */
export const VARIANTS = Object.freeze(["adverse", "favorable"] as const);

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

/**
 * What a child process returns: the run's metrics, its world's day in seconds and its seconds per
 * tick, the first tick at which each being that was incapacitated was, as [id, tick] pairs, the
 * digest of every tick's checksum, and what it kept.
 */
export type SurvivalOutput = {
  readonly record: RunRecord;
  readonly dayLength: number;
  readonly simSecondsPerTick: number;
  readonly incapacitatedAt: readonly (readonly [number, number])[];
  readonly trail: string;
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

/** Starts the run of `input` in a fresh process, whose errors name its label. */
export function startSurvival(input: SurvivalInput): JsonChild {
  return startJsonChild(SCRIPT, input, input.label);
}

/** Whether `value` has the shape of a SurvivalOutput, as far as the readers of a run rely on it. */
function isSurvivalOutput(value: unknown): value is SurvivalOutput {
  if (typeof value !== "object" || value === null) return false;
  const { record, dayLength, simSecondsPerTick, incapacitatedAt, trail } = value as {
    readonly [key: string]: unknown;
  };
  if (typeof record !== "object" || record === null) return false;
  return (
    Array.isArray((record as { beings?: unknown }).beings) &&
    typeof dayLength === "number" &&
    typeof simSecondsPerTick === "number" &&
    Array.isArray(incapacitatedAt) &&
    typeof trail === "string"
  );
}

/**
 * What the run of `child` returned. Throws when the process failed, or when it wrote JSON of
 * another shape, with the start of what it wrote.
 */
export async function survivalResult(child: JsonChild, timeoutMs: number): Promise<SurvivalOutput> {
  const output = await jsonResult(child, timeoutMs);
  if (isSurvivalOutput(output)) return output;
  const start = JSON.stringify(output)?.slice(0, 200) ?? String(output);
  throw new Error(`the child process ${child.name} returned no record of a run: ${start}`);
}
