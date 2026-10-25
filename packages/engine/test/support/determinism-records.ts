import {
  type CanonicalValue,
  type Command,
  canonicalize,
  EngineError,
  encodeSnapshot,
  type Ruleset,
  type StepResult,
  step,
  type World,
} from "../../src/index.ts";

/**
 * Records of runs, for the determinism suite (determinism-suite.ts) and its child process
 * (resume-child.ts): what each tick did, as canonical text, and where two runs first differ.
 */

type Value = CanonicalValue;
export type SuiteRuleset = Ruleset<Value, Value>;

/** What one tick did, each part as canonical text, or the fault that stopped the run at it. */
export type TickRecord =
  | {
      readonly tick: number;
      readonly checksum: string;
      readonly events: string;
      readonly changedChunks: string;
      readonly stats: string;
    }
  | { readonly tick: number; readonly fault: string };

/** The commands of each tick, from tick 1: the commands of tick t are at index t - 1. */
export type Script = readonly (readonly Command[])[];

/** A module, as a path or file URL, and the name of the ruleset factory it exports. */
export type RulesetSource = { readonly module: string; readonly name: string };

/** What a child process returns: the records from its first tick, and its final snapshot. */
export type ChildOutput = {
  readonly records: readonly TickRecord[];
  readonly final: string | undefined;
  readonly finalError: string | undefined;
};

/** What a child process receives on stdin, as JSON. */
export type ChildInput = {
  readonly ruleset: RulesetSource;
  readonly snapshot: string;
  readonly from: number;
  readonly script: Script;
};

/** The record of the tick that `result` describes. */
export function tickRecord({
  tick,
  checksum,
  events,
  changedChunks,
  stats,
}: StepResult): TickRecord {
  return {
    tick,
    checksum,
    // Events, keys, and statistics are canonical values the engine returns.
    events: canonicalize(events as unknown as Value),
    changedChunks: canonicalize(changedChunks as unknown as Value),
    stats: canonicalize(stats as unknown as Value),
  };
}

/** An error as one line: an EngineError's code and issues, or what else was thrown. */
export function describeError(error: unknown): string {
  if (error instanceof EngineError) return `${error.code} ${JSON.stringify(error.issues)}`;
  return error instanceof Error ? `${error.name}: ${error.message}` : `a thrown ${typeof error}`;
}

/** Steps `world` through `tick` of `script`, and records what the step did or threw. */
export function recordTick(world: World, script: Script, tick: number): TickRecord {
  try {
    return tickRecord(step(world, script[tick - 1] ?? []));
  } catch (error) {
    return { tick, fault: describeError(error) };
  }
}

/** Steps `world` from tick `from` to the end of `script`, recording each tick; stops at a fault. */
export function recordRun(world: World, script: Script, from = 1): TickRecord[] {
  const records: TickRecord[] = [];
  for (let tick = from; tick <= script.length; tick += 1) {
    const record = recordTick(world, script, tick);
    records.push(record);
    if ("fault" in record) break;
  }
  return records;
}

const PARTS = ["checksum", "events", "changedChunks", "stats"] as const;

/** A record's fault, or "no fault". */
const faultOf = (record: TickRecord) => ("fault" in record ? record.fault : "no fault");

/** How `got` differs from `want`, or undefined when they are equal. */
function recordDifference(want: TickRecord | undefined, got: TickRecord | undefined) {
  if (want === undefined || got === undefined) {
    return want === got ? undefined : `the run has ${want === undefined ? "an extra" : "no"} tick`;
  }
  if ("fault" in want || "fault" in got) {
    const [wanted, found] = [faultOf(want), faultOf(got)];
    return wanted === found ? undefined : `expected ${wanted}, got ${found}`;
  }
  const parts = PARTS.filter((part) => want[part] !== got[part]);
  if (parts.length === 0) return undefined;
  return `${parts.join(", ")} ${parts.length === 1 ? "differs" : "differ"}`;
}

/** The first tick at which `actual` differs from `expected`, record by record, and how. */
export function firstDivergence(
  expected: readonly TickRecord[],
  actual: readonly TickRecord[],
): { readonly tick: number; readonly detail: string } | undefined {
  for (let index = 0; index < Math.max(expected.length, actual.length); index += 1) {
    const want = expected[index];
    const got = actual[index];
    const detail = recordDifference(want, got);
    if (detail !== undefined) return { tick: got?.tick ?? want?.tick ?? 0, detail };
  }
  return undefined;
}

/** The ruleset factory that `source` names. */
export async function rulesetFactory(source: RulesetSource): Promise<() => SuiteRuleset> {
  const module = (await import(source.module)) as Record<string, unknown>;
  const factory = module[source.name];
  if (typeof factory !== "function") {
    throw new Error(`${source.module} exports no function ${source.name}`);
  }
  return () => factory() as SuiteRuleset;
}

/** The final snapshot of `world`, unless its run ended in a fault or the encoding throws. */
export function finalSnapshot(world: World, records: readonly TickRecord[]) {
  const last = records.at(-1);
  if (last !== undefined && "fault" in last) return { final: undefined, finalError: undefined };
  try {
    return { final: encodeSnapshot(world), finalError: undefined };
  } catch (error) {
    return { final: undefined, finalError: describeError(error) };
  }
}
