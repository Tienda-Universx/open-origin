import {
  type Command,
  decodeSnapshot,
  encodeSnapshot,
  type Seed,
  type World,
} from "../../src/index.ts";
import {
  type ChildInput,
  type ChildOutput,
  describeError,
  finalSnapshot,
  firstDivergence,
  type RulesetSource,
  recordRun,
  recordTick,
  rulesetFactory,
  type Script,
  type SuiteRuleset,
  type TickRecord,
} from "./determinism-records.ts";
import { Sfc32 } from "./sfc32.ts";

/**
 * The determinism suite (ADR 0020; plan §1 item 8, §2.5, §8): one harness that T3 to T5 run on
 * their own rulesets. Given a subject (a ruleset factory, a world, a seed, a command source, and
 * a tick count), runDeterminismSuite checks that:
 *
 * - the uninterrupted run, the reference, does not fault ("fault");
 * - a second independent run gives the same record at every tick: checksum, events, changed
 *   chunks, and statistics ("repeat");
 * - a run under audit gives the same records, so the incremental root equals the full one at
 *   every tick ("audit");
 * - at each cut, the snapshot of that tick, decoded with a fresh ruleset and stepped on, gives the
 *   same record at every later tick and the same final snapshot text ("resume");
 * - at each child cut, the same holds in a fresh child process (resume-child.ts), which catches
 *   module-level state that an in-process resume shares ("child-resume");
 * - the world, a replica, and a world with the second seed, stepped in a seeded random
 *   interleaving and sharing one ruleset object, each give what it gives alone ("interleave").
 *
 * It returns a report instead of asserting, so that its negative controls (broken-rulesets.ts)
 * can prove that it fails: each failure names its property and the first tick it diverged at.
 * Within a property, only the first divergence is reported, since later ticks follow from it.
 */

export type DeterminismSubject = {
  /**
   * The function that returns a fresh ruleset on every call. The child process imports it by this
   * path, so the module must be importable on its own and keep its state, if any, in the module.
   */
  readonly ruleset: RulesetSource;
  /** A world at tick 0 with `seed`, running `ruleset`, under audit when `audit` is true. */
  readonly world: (seed: Seed, ruleset: SuiteRuleset, audit: boolean) => World;
  /** The seed of the subject's world, and that of a second world for the interleaving. */
  readonly seeds: readonly [Seed, Seed];
  readonly ticks: number;
  /** The commands of `tick`: called once per tick, in order from 1, so a generator may keep state. */
  readonly commands: (tick: number) => readonly Command[];
  /** Ticks in [0, ticks) whose snapshot an in-process resume continues from. */
  readonly cuts: readonly number[];
  /** Ticks in [0, ticks) whose snapshot a child process continues from. */
  readonly childCuts: readonly number[];
};

export type Property = "fault" | "repeat" | "audit" | "resume" | "child-resume" | "interleave";

export type Failure = {
  readonly property: Property;
  /** The first tick at which the property failed. */
  readonly tick: number;
  /** The cut of a resume, or the index of a world in the interleaving (0, 1, or 2). */
  readonly at?: number;
  readonly detail: string;
};

export type DeterminismReport = {
  readonly failures: readonly Failure[];
  /** The cuts whose resume ran, in process and in a child, so a check that ran nothing shows. */
  readonly resumed: readonly number[];
  readonly childResumed: readonly number[];
  /** The reference run's records, from tick 1. */
  readonly reference: readonly TickRecord[];
  /** The uninterrupted run's final snapshot text, unless it could not be encoded. */
  readonly finalText: string | undefined;
};

/** The failure of `property` where `actual` first differs from `expected`, if anywhere. */
function compared(
  property: Property,
  expected: readonly TickRecord[],
  actual: readonly TickRecord[],
  at?: number,
): Failure[] {
  const divergence = firstDivergence(expected, actual);
  if (divergence === undefined) return [];
  return [at === undefined ? { property, ...divergence } : { property, at, ...divergence }];
}

/** Throws, with every problem, when `subject` cannot be run: a misuse of the harness. */
function checkSubject({ ticks, cuts, childCuts }: DeterminismSubject): void {
  const problems: string[] = [];
  if (!Number.isSafeInteger(ticks) || ticks < 1) problems.push(`ticks ${ticks} is not positive`);
  for (const cut of [...cuts, ...childCuts]) {
    if (!Number.isSafeInteger(cut) || cut < 0 || cut >= ticks) {
      problems.push(`the cut ${cut} is not a tick in [0, ${ticks})`);
    }
  }
  if (problems.length > 0) throw new Error(`invalid determinism subject: ${problems.join("; ")}`);
}

/** Everything the checks after the reference run share. */
type Run = {
  readonly subject: DeterminismSubject;
  readonly fresh: () => SuiteRuleset;
  readonly script: Script;
  readonly reference: readonly TickRecord[];
  /** The snapshot text at each cut that could be encoded, and at the last tick. */
  readonly texts: ReadonlyMap<number, string>;
};

/**
 * A run that encodes a snapshot at every cut and at its last tick: a run of its own, so that an
 * encoding that poisons its world (a write behind the barrier) cannot change the reference. An
 * encoding that throws is a resume failure at its tick, and ends the run.
 */
function takeSnapshots(subject: DeterminismSubject, fresh: () => SuiteRuleset, script: Script) {
  const world = subject.world(subject.seeds[0], fresh(), false);
  const cuts = new Set([...subject.cuts, ...subject.childCuts, script.length]);
  const texts = new Map<number, string>();
  for (let tick = 0; tick <= script.length; tick += 1) {
    try {
      if (cuts.has(tick)) texts.set(tick, encodeSnapshot(world));
    } catch (error) {
      const detail = `encodeSnapshot at tick ${tick} threw ${describeError(error)}`;
      const failure: Failure = { property: "resume", tick, at: tick, detail };
      return { texts, failures: [failure] };
    }
    // A fault ends the run; the reference run reports it.
    if (tick === script.length || "fault" in recordTick(world, script, tick + 1)) break;
  }
  return { texts, failures: [] as Failure[] };
}

/**
 * The failures of a resume from `cut`, whose run gave `output`, against the uninterrupted run:
 * the first record after the cut that differs; otherwise a final snapshot that throws, or whose
 * text differs from the uninterrupted run's, when that run has one.
 */
function resumeFailures(run: Run, cut: number, property: Property, output: ChildOutput): Failure[] {
  const failures = compared(property, run.reference.slice(cut), output.records, cut);
  if (failures.length > 0) return failures;
  const tick = run.script.length;
  if (output.finalError !== undefined) {
    return [{ property, tick, at: cut, detail: `the final snapshot threw ${output.finalError}` }];
  }
  const expected = run.texts.get(tick);
  if (expected === undefined || output.final === expected) return [];
  return [{ property, tick, at: cut, detail: "the final snapshot text differs" }];
}

/** Resumes from each cut in this process, with a fresh ruleset. */
function resumeInProcess(run: Run, failures: Failure[]): number[] {
  const resumed: number[] = [];
  for (const cut of run.subject.cuts) {
    const text = run.texts.get(cut);
    if (text === undefined) continue;
    let world: World;
    try {
      world = decodeSnapshot(text, run.fresh());
    } catch (error) {
      const detail = `decodeSnapshot threw ${describeError(error)}`;
      failures.push({ property: "resume", tick: cut, at: cut, detail });
      continue;
    }
    const records = recordRun(world, run.script, cut + 1);
    failures.push(
      ...resumeFailures(run, cut, "resume", { records, ...finalSnapshot(world, records) }),
    );
    resumed.push(cut);
  }
  return resumed;
}

const CHILD = Bun.fileURLToPath(new URL("./resume-child.ts", import.meta.url));
const REPO_ROOT = Bun.fileURLToPath(new URL("../../../../", import.meta.url));

/** How long one child process may run before it is killed. */
export const CHILD_TIMEOUT_MS = 30_000;

/** The output of a child process, or why there is none. */
async function inChild(input: ChildInput): Promise<ChildOutput | string> {
  const child = Bun.spawn([process.execPath, CHILD], {
    cwd: REPO_ROOT,
    stdin: new Blob([JSON.stringify(input)]),
    stdout: "pipe",
    stderr: "pipe",
    timeout: CHILD_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code === 0) return JSON.parse(stdout) as ChildOutput;
  const signal = child.signalCode === null ? "" : `, killed by ${child.signalCode}`;
  return `the child process exited with ${code}${signal}: ${stderr.trim().slice(-500)}`;
}

/**
 * Resumes from each child cut in a child process of its own. The processes start at once and run
 * while this process goes on with the other checks; the result lists the cuts that ran.
 */
async function resumeInChildren(run: Run): Promise<{ cuts: number[]; failures: Failure[] }> {
  const cuts = run.subject.childCuts.filter((cut) => run.texts.has(cut));
  const outputs = await Promise.all(
    cuts.map((cut) => {
      const snapshot = run.texts.get(cut) ?? "";
      return inChild({ ruleset: run.subject.ruleset, snapshot, from: cut + 1, script: run.script });
    }),
  );
  const failures = outputs.flatMap((output, index): Failure[] => {
    const cut = cuts[index] ?? 0;
    if (typeof output !== "string") return resumeFailures(run, cut, "child-resume", output);
    return [{ property: "child-resume", tick: cut, at: cut, detail: output }];
  });
  return { cuts, failures };
}

/**
 * Steps `worlds` through `script` in the order `pick` chooses among those with ticks left, and
 * records each world's ticks; a world stops at its first fault.
 */
export function interleave(
  worlds: readonly World[],
  script: Script,
  pick: (ready: readonly number[]) => number,
): TickRecord[][] {
  const records: TickRecord[][] = worlds.map(() => []);
  for (;;) {
    const ready = records.flatMap((own, index) => {
      const last = own.at(-1);
      const stopped = last !== undefined && "fault" in last;
      return own.length < script.length && !stopped ? [index] : [];
    });
    if (ready.length === 0) return records;
    const index = pick(ready);
    const world = worlds[index];
    const own = records[index];
    if (world === undefined || own === undefined) throw new Error(`no world ${index} is ready`);
    own.push(recordTick(world, script, own.length + 1));
  }
}

/** The seed of the interleaving's order: fixed, so that a failure reproduces. */
const INTERLEAVING_SEED = 2020;

/**
 * The subject's world, a world with the second seed, and a replica of the first, sharing one
 * ruleset object, in a seeded random interleaving: each must give what it gives alone.
 */
function interleaving(run: Run): Failure[] {
  const { subject, fresh, script, reference } = run;
  const shared = fresh();
  const [first, second] = subject.seeds;
  const worlds = [first, second, first].map((seed) => subject.world(seed, shared, false));
  const random = new Sfc32(INTERLEAVING_SEED);
  const records = interleave(worlds, script, (ready) => random.pick(ready));
  const other = recordRun(subject.world(second, fresh(), false), script);
  const alone = [reference, other, reference];
  return records.flatMap((actual, index) =>
    compared("interleave", alone[index] ?? [], actual, index),
  );
}

/**
 * Runs every check on `subject` and reports each property that failed, with the first tick at
 * which it did; an empty list of failures means the subject passed. Throws only when the subject
 * itself cannot be run: ticks or cuts out of range, or a ruleset module without its factory.
 */
export async function runDeterminismSuite(subject: DeterminismSubject): Promise<DeterminismReport> {
  checkSubject(subject);
  const fresh = await rulesetFactory(subject.ruleset);
  const script = Array.from({ length: subject.ticks }, (_, index) => subject.commands(index + 1));
  const runOf = (audit: boolean) =>
    recordRun(subject.world(subject.seeds[0], fresh(), audit), script);
  const reference = runOf(false);
  const last = reference.at(-1);
  const failures: Failure[] =
    last !== undefined && "fault" in last
      ? [{ property: "fault", tick: last.tick, detail: last.fault }]
      : [];
  failures.push(...compared("repeat", reference, runOf(false)));
  failures.push(...compared("audit", reference, runOf(true)));
  const snapshots = takeSnapshots(subject, fresh, script);
  failures.push(...snapshots.failures);
  const run: Run = { subject, fresh, script, reference, texts: snapshots.texts };
  const children = resumeInChildren(run);
  const resumed = resumeInProcess(run, failures);
  const interleaved = interleaving(run);
  const child = await children;
  failures.push(...child.failures, ...interleaved);
  const finalText = snapshots.texts.get(script.length);
  return { failures, resumed, childResumed: child.cuts, reference, finalText };
}
