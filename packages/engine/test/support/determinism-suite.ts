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
  isChildOutput,
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
 * - at each cut, the snapshot of that tick, decoded with a fresh ruleset under audit and stepped
 *   on, gives the same record at every later tick and the same final snapshot text ("resume");
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
  /**
   * A world at tick 0 with `seed`, running `ruleset`, under audit when `audit` is true. It must use
   * the ruleset and the audit flag it is given: a world that ignores them makes the audit run, the
   * repeat with a fresh ruleset, and the interleaving's shared ruleset check nothing.
   */
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

export type DeterminismOptions = {
  /**
   * How long each child process may run once the suite waits for it, in milliseconds, before it is
   * killed: CHILD_TIMEOUT_MS when undefined.
   */
  readonly childTimeoutMs?: number | undefined;
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

/**
 * Throws, with every problem, when `subject` cannot be run: a misuse of the harness. A subject
 * with no cut would pass the resume checks without running them, so it is refused too.
 */
function checkSubject({ ticks, cuts, childCuts }: DeterminismSubject): void {
  const problems: string[] = [];
  if (!Number.isSafeInteger(ticks) || ticks < 1) problems.push(`ticks ${ticks} is not positive`);
  if (cuts.length + childCuts.length === 0) {
    problems.push("the subject has no cut: list a tick in cuts or childCuts");
  }
  for (const cut of [...cuts, ...childCuts]) {
    if (!Number.isSafeInteger(cut) || cut < 0 || cut >= ticks) {
      problems.push(`the cut ${cut} is not a tick in [0, ${ticks})`);
    }
  }
  if (problems.length > 0) throw new Error(`invalid determinism subject: ${problems.join("; ")}`);
}

/** The child time limit of `options`. Throws when it is not a positive safe integer. */
function childTimeout({ childTimeoutMs = CHILD_TIMEOUT_MS }: DeterminismOptions): number {
  if (Number.isSafeInteger(childTimeoutMs) && childTimeoutMs > 0) return childTimeoutMs;
  const problem = `childTimeoutMs ${childTimeoutMs} is not a positive integer`;
  throw new Error(`invalid determinism options: ${problem}`);
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

/** Resumes from each cut in this process, with a fresh ruleset, under audit. */
function resumeInProcess(run: Run, failures: Failure[]): number[] {
  const resumed: number[] = [];
  for (const cut of run.subject.cuts) {
    const text = run.texts.get(cut);
    if (text === undefined) continue;
    let world: World;
    try {
      world = decodeSnapshot(text, run.fresh(), { audit: true });
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

/** How long one child process may run, once the suite waits for it, before it is killed. */
export const CHILD_TIMEOUT_MS = 30_000;

/** A child process that continues from `cut`, and what it writes and how it exits. */
type Child = {
  readonly cut: number;
  readonly process: Bun.Subprocess;
  readonly ended: Promise<readonly [stdout: string, stderr: string, code: number]>;
};

/** Where a child process starts: the snapshot of a world at `cut`, decoded under `audit` or not. */
type ChildStart = { readonly cut: number; readonly snapshot: string; readonly audit: boolean };

/**
 * Starts a child process that continues from `start` to the end of the script. Its pipes are read
 * from the start, so they drain whenever this process's event loop runs, but no time limit runs
 * yet (childResult).
 */
function startChild(run: Run, { cut, snapshot, audit }: ChildStart): Child {
  const input: ChildInput = {
    ruleset: run.subject.ruleset,
    snapshot,
    from: cut + 1,
    script: run.script,
    audit,
  };
  const child = Bun.spawn([process.execPath, CHILD], {
    cwd: REPO_ROOT,
    stdin: new Blob([JSON.stringify(input)]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const ended = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ] as const);
  return { cut, process: child, ended };
}

/** The ChildOutput that a child process wrote to `stdout`, or what is wrong with it. */
function childOutputOf(stdout: string): ChildOutput | string {
  if (stdout === "") return "the child process exited with 0 and wrote nothing";
  const start = stdout.slice(0, 200);
  let output: unknown;
  try {
    output = JSON.parse(stdout);
  } catch {
    return `the child process wrote output that is not JSON: ${start}`;
  }
  if (isChildOutput(output)) return output;
  return `the child process wrote JSON that is not a ChildOutput: ${start}`;
}

/**
 * The output of `child`, or why there is none. Its time limit starts now, when this process waits
 * for it and can feed its stdin and drain its stdout, not when it started: the synchronous work
 * in between serves no child. Past the limit, it is killed with SIGKILL and reaped.
 */
async function childResult(child: Child, timeoutMs: number): Promise<ChildOutput | string> {
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.process.kill("SIGKILL");
  }, timeoutMs);
  const [stdout, stderr, code] = await child.ended.finally(() => clearTimeout(timer));
  if (code === 0) return childOutputOf(stdout);
  const tail = stderr.trim().slice(-500);
  if (timedOut) {
    return `the child process ran past ${timeoutMs} ms and was killed with SIGKILL: ${tail}`;
  }
  const { signalCode } = child.process;
  const signal = signalCode === null ? "" : `, killed by ${signalCode}`;
  return `the child process exited with ${code}${signal}: ${tail}`;
}

/** Waits for each child in `children`, each with `timeoutMs` from now, and reports its resume. */
async function childFailures(run: Run, children: readonly Child[], timeoutMs: number) {
  const outputs = await Promise.all(children.map((child) => childResult(child, timeoutMs)));
  return outputs.flatMap((output, index): Failure[] => {
    const cut = children[index]?.cut ?? 0;
    if (typeof output !== "string") return resumeFailures(run, cut, "child-resume", output);
    return [{ property: "child-resume", tick: cut, at: cut, detail: output }];
  });
}

/**
 * The result of `work`, which runs while `children` do. When it throws, each child is killed and
 * reaped before the error is rethrown, so that none outlives the suite.
 */
async function besideChildren<T>(children: readonly Child[], work: () => T): Promise<T> {
  try {
    return work();
  } catch (error) {
    for (const child of children) child.process.kill("SIGKILL");
    await Promise.all(children.map((child) => child.ended));
    throw error;
  }
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
 * Where the run of the second seed alone starts: that world's snapshot at tick 0, decoded without
 * audit, as the interleaving's worlds run. It runs in a child process, whose modules start fresh:
 * in this process, state that a ruleset keeps in a module, which every run shares, would already
 * hold what the first seed's runs left (a cache keyed without the seed), and the world would agree
 * with its interleaved copy for the wrong reason. A world decoded at tick 0 runs as the world the
 * factory created, as every resume from cut 0 shows.
 */
function secondSeedStart({ subject, fresh }: Run): ChildStart {
  const world = subject.world(subject.seeds[1], fresh(), false);
  return { cut: 0, snapshot: encodeSnapshot(world), audit: false };
}

/**
 * The records of the subject's world, a world with the second seed, and a replica of the first,
 * sharing one ruleset object, in a seeded random interleaving.
 */
function interleaving({ subject, fresh, script }: Run): TickRecord[][] {
  const shared = fresh();
  const [first, second] = subject.seeds;
  const worlds = [first, second, first].map((seed) => subject.world(seed, shared, false));
  const random = new Sfc32(INTERLEAVING_SEED);
  return interleave(worlds, script, (ready) => random.pick(ready));
}

/**
 * The interleaving's failures: each world must give what it gives alone, the first seed's worlds
 * the reference run and the second seed's world its run in a child process, `second`. A child
 * that gives no output is a failure of the second world.
 */
function interleavingFailures(
  run: Run,
  records: readonly (readonly TickRecord[])[],
  second: ChildOutput | string,
): Failure[] {
  if (typeof second === "string")
    return [{ property: "interleave", tick: 0, at: 1, detail: second }];
  const alone = [run.reference, second.records, run.reference];
  return records.flatMap((actual, index) =>
    compared("interleave", alone[index] ?? [], actual, index),
  );
}

/**
 * Runs every check on `subject` and reports each property that failed, with the first tick at
 * which it did; an empty list of failures means the subject passed. Throws only when the subject
 * or `options` cannot be run: ticks or cuts out of range, no cut, a child time limit that is not
 * a positive integer, a ruleset module without its factory, or a world factory that throws.
 *
 * The child processes start before the in-process resumes and the interleaving, and run beside
 * them; each child's time limit starts once those are done and the suite waits for it.
 */
export async function runDeterminismSuite(
  subject: DeterminismSubject,
  options: DeterminismOptions = {},
): Promise<DeterminismReport> {
  checkSubject(subject);
  const timeoutMs = childTimeout(options);
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
  const childCuts = subject.childCuts.filter((cut) => run.texts.has(cut));
  // Before any child starts: a world factory that throws leaves no child behind.
  const secondStart = secondSeedStart(run);
  const children = childCuts.map((cut) =>
    startChild(run, { cut, snapshot: run.texts.get(cut) ?? "", audit: true }),
  );
  const second = startChild(run, secondStart);
  const { resumed, interleaved } = await besideChildren([...children, second], () => ({
    resumed: resumeInProcess(run, failures),
    interleaved: interleaving(run),
  }));
  const [resumes, alone] = await Promise.all([
    childFailures(run, children, timeoutMs),
    childResult(second, timeoutMs),
  ]);
  failures.push(...resumes, ...interleavingFailures(run, interleaved, alone));
  const finalText = snapshots.texts.get(script.length);
  return { failures, resumed, childResumed: childCuts, reference, finalText };
}
