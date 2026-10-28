import type { TickRecord } from "../../../engine/test/support/determinism-records.ts";
import { type JsonChild, jsonResult, startJsonChild } from "./child.ts";
import { misses, type RunRecord } from "./metrics.ts";
import type { LedgerTally } from "./mind-ledger.ts";
import { LABELS2 } from "./mind-scenario.ts";
import type { SoakRecord } from "./mind-soak.ts";

/**
 * The evaluation of T5 (docs/architecture/mind.md, "Evaluation"): the one entry point that runs the
 * default label and the held-out labels of T5, which running burns. A run is the preregistered T5
 * scenario of its label under `mind@1` and the frozen laws of life@2, audit off, in a child process
 * (mind-evaluation-child.ts), so that the two runs of CI run beside the other tests, as T4's survival
 * runs do. It computes every acceptance item, per being, of the population, of integrity, and of
 * diversity, from the ledger and the state, with the invariants of the minds and the ledger oracle at
 * every tick that changed the world. The soak bench (bench/mind-soak.ts) runs the held-out labels
 * through it too, with the informative hypotheses. Calibration labels run through it as well, which
 * checks the harness against the calibration's own results without burning anything; the reserve,
 * `heldout/7` to `/12`, and every other label are refused.
 */

/** The labels of CI: the default label and heldout/1. */
export const EVALUATED = Object.freeze({
  default: LABELS2.default,
  heldout: LABELS2.heldout[0] as string,
});

/** The labels a run may use: the default, calibration, and held-out labels of T5, never the reserve. */
export const EVALUABLE: readonly string[] = Object.freeze([
  LABELS2.default,
  ...LABELS2.calibration,
  ...LABELS2.heldout,
]);

/** The brains a run may use: `mind@1`, and the amnesic ablation of the soak's memory hypothesis. */
export const VARIANTS = Object.freeze(["mind@1", "amnesic"] as const);
export type Variant = (typeof VARIANTS)[number];

/** What a child process runs. */
export type EvaluationInput = {
  readonly label: string;
  readonly ticks: number;
  /** `mind@1` by default; `amnesic` sets every capacity of `mind` and `speech.perDay` to 0. */
  readonly variant?: Variant;
  /** The tick after which the run keeps its snapshot, and the ticks after it it records. */
  readonly keep?: { readonly at: number; readonly ticks: number };
  /** The soak's measures: hungry spells, testimony against the truth, and the ablations. */
  readonly soak?: boolean;
  /** The soak's false claim, injected at tick 6,300 into the being of lowest id. */
  readonly falseClaim?: boolean;
};

/** What a run kept: the snapshot after `keep.at`, the records after it, and the final snapshot. */
export type KeptRun = {
  readonly snapshot: string;
  readonly records: readonly TickRecord[];
  readonly final: string;
};

/** What a run's minds did, by being: the ledger's items and the observer's speech and stores. */
export type MindRecord = {
  readonly ledger: LedgerTally;
  /**
   * The same items as the calibration counted them, from the operations each applied decision
   * proposed (mind-metrics.ts): episodes of food and of beings, beliefs by `seen-food` and by
   * `told-food`, revisions to 100, and relates that changed trust.
   */
  readonly proposed: readonly [
    food: number,
    being: number,
    seen: number,
    told: number,
    revisedDown: number,
    trustChecks: number,
  ];
  readonly greeted: number;
  readonly wasGreeted: number;
  readonly acts: number;
  readonly seeks: number;
  readonly relationsAtEnd: number;
  readonly beliefsAtEnd: number;
  readonly credulity: number;
};

/** The first problems of a kind, and how many there were. */
export type Problems = { readonly count: number; readonly first: readonly string[] };

/** What a child process returns. */
export type EvaluationOutput = {
  readonly label: string;
  readonly variant: Variant;
  readonly ticks: number;
  readonly record: RunRecord;
  readonly minds: readonly MindRecord[];
  readonly conversations: number;
  readonly diverse: boolean;
  readonly integrity: {
    /** Beliefs whose lineage holds model-prior-suspect, by the ledger. */
    readonly priorSuspect: number;
    readonly rules: Problems;
    readonly oracle: Problems;
    readonly invariants: Problems;
    /** Ticks the invariants and the oracle checked: those that changed some chunk or emitted an event. */
    readonly checkedTicks: number;
  };
  /** What the invariants saw, so that a pass is not vacuous. */
  readonly seen: { readonly [name: string]: number };
  /** The digest of every tick's checksum. */
  readonly trail: string;
  readonly kept?: KeptRun;
  readonly soak?: SoakRecord;
};

/** Every acceptance item of mind.md ("Evaluation") that a run misses, by where it belongs. */
export type Acceptance = {
  /** Each being's misses: T4's items, then the mind's. */
  readonly beings: readonly (readonly string[])[];
  readonly population: readonly string[];
  readonly integrity: readonly string[];
  readonly diverse: boolean;
};

/** The items of the mind that a being misses, by name. */
function mindMisses(mind: MindRecord): string[] {
  const items: [string, boolean][] = [
    ["food episode", mind.ledger.food < 1],
    ["being episode", mind.ledger.being < 1],
    ["3 beliefs seen", mind.ledger.formedOwn < 3],
    ["relationship at end", mind.relationsAtEnd < 1],
    ["greeted", mind.greeted < 1],
    ["was greeted", mind.wasGreeted < 1],
  ];
  return items.filter(([, missed]) => missed).map(([name]) => name);
}

/**
 * The acceptance of a run (mind.md, "Evaluation"): every being meets T4's items, a rejected mental
 * operation counted as a rejected intention, encoded a food and a being episode, formed three
 * beliefs from its own observations, holds a relationship at the end, and greeted and was greeted;
 * the population revised a belief down after seeing it contradicted, held 10 conversations, formed
 * a belief from testimony, and changed trust by checking a testimony, and some cell regrew and was
 * eaten again (T4); integrity: no belief has model-prior-suspect, and the ledger oracle, every
 * invariant (the flows of taints, the quotas), and every rule hold; and the minds are diverse.
 */
export function acceptance(output: EvaluationOutput): Acceptance {
  const beings = output.record.beings.map((being, index) => {
    const mind = output.minds[index];
    return [...misses(being), ...(mind === undefined ? ["no mind"] : mindMisses(mind))];
  });
  const total = (pick: (mind: MindRecord) => number) =>
    output.minds.reduce((sum, mind) => sum + pick(mind), 0);
  const population: [string, boolean][] = [
    ["revised down", total((mind) => mind.ledger.revisedDown) < 1],
    ["10 conversations", output.conversations < 10],
    ["from testimony", total((mind) => mind.ledger.fromTestimony) < 1],
    ["trust checked", total((mind) => mind.ledger.trustChecked) < 1],
    ["regrown and eaten", !output.record.regrewAndEaten],
  ];
  const { integrity } = output;
  const checks: [string, boolean][] = [
    ["prior-suspect", integrity.priorSuspect > 0],
    ["rules", integrity.rules.count > 0],
    ["oracle", integrity.oracle.count > 0],
    ["invariants", integrity.invariants.count > 0],
  ];
  const failed = (items: [string, boolean][]) =>
    items.filter(([, missed]) => missed).map(([name]) => name);
  return {
    beings,
    population: failed(population),
    integrity: failed(checks),
    diverse: output.diverse,
  };
}

const SCRIPT = Bun.fileURLToPath(new URL("./mind-evaluation-child.ts", import.meta.url));

/** Starts the run of `input` in a fresh process, whose errors name its label. */
export function startEvaluation(input: EvaluationInput): JsonChild {
  return startJsonChild(SCRIPT, input, input.label);
}

/**
 * What the run of `child` returned. Throws when the process failed, or when it wrote JSON of
 * another shape, with the start of what it wrote.
 */
export async function evaluationResult(
  child: JsonChild,
  timeoutMs: number,
): Promise<EvaluationOutput> {
  const output = (await jsonResult(child, timeoutMs)) as Partial<EvaluationOutput> | null;
  const shaped =
    typeof output === "object" &&
    output !== null &&
    Array.isArray(output.record?.beings) &&
    Array.isArray(output.minds) &&
    typeof output.trail === "string" &&
    typeof output.integrity === "object";
  if (shaped) return output as EvaluationOutput;
  const start = JSON.stringify(output)?.slice(0, 200) ?? String(output);
  throw new Error(`the child process ${child.name} returned no evaluation: ${start}`);
}
