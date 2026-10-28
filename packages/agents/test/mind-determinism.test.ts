/**
 * Determinism and observer independence of a world of `mind@1` (docs/architecture/mind.md,
 * "Verification plan"; plan §6 and §11.2, tests 11, 12, and 13).
 *
 * The subject (support/mind-subject.ts): three beings of `mind@1` around a chunk corner of the
 * engine's test genesis, whose day lasts 100 ticks, where they greet, tell, hear, believe, forage,
 * lose the contest for room, walk into a new chunk, forget, revise, and see dusk fall and the day
 * turn, while research injects a false claim. The determinism suite runs it with audit and cuts at
 * the first act, delivery, contest for room, new chunk, injection, forgetting, revision, dusk, and
 * day, two seeded random ticks, and the middle of the run; child processes resume from 0, the
 * middle, and T − 1; and the interleaving shares one ruleset object, and so one brain, among three
 * worlds. A fresh `mind@1` for every decision gives the records of the shared brain, while a brain
 * that passes the senses of one being's decision to the next being diverges from its own fresh
 * differential.
 *
 * Observers read, before every tick, every being, its mind, and the view of that mind its brain
 * would get; after every tick, every invariant of the minds, the ledger oracle, and the check that
 * every belief operation `mind@1` made is its rule applied to what it cites read what the tick did.
 * The records and the final snapshot equal the suite's reference run, which had none of them. A
 * coupled host, which compacts the minds its observer read by forgetting what has faded, changes
 * the records at once.
 */
import { describe, expect, test } from "bun:test";
import {
  type beings,
  type CanonicalValue,
  type ChunkKey,
  type Command,
  type CommandHandler,
  canonicalize,
  digest,
  EngineError,
  encodeSnapshot,
  mind,
  type RulesetSystem,
  readView,
  type Seed,
  step,
} from "@open-origin/engine";
import { STALE_GLOBAL } from "../../engine/test/support/barrier-rulesets.ts";
import type { BeingsWorld } from "../../engine/test/support/beings-world.ts";
import {
  beingsById,
  chunksById,
  LedgerOracle,
  MindInvariants,
} from "../../engine/test/support/beings2-fuzz.ts";
import {
  firstDivergence,
  type SuiteRuleset,
  type TickRecord,
  tickRecord,
} from "../../engine/test/support/determinism-records.ts";
import {
  type DeterminismReport,
  runDeterminismSuite,
} from "../../engine/test/support/determinism-suite.ts";
import { Sfc32 } from "../../engine/test/support/sfc32.ts";
import { MindObserver, type MindRun } from "./support/mind-metrics.ts";
import {
  freshEach,
  freshMindRuleset,
  MIND_RULESET,
  mindRuleset,
  rulesetOf,
  SUBJECT_LIFE,
  SUBJECT_SPECIES,
  subjectBrain,
} from "./support/mind-ruleset.ts";
import type { Senses2 } from "./support/mind-senses.ts";
import {
  type Landmarks,
  landmarkTracker,
  mindWorld,
  SUBJECT_SEEDS,
  SUBJECT_TICKS,
  subjectScript,
} from "./support/mind-subject.ts";

const BUDGET_MS = 60_000;
const IDS = [1, 2, 3];

/**
 * The digest of every checksum of the reference run, pinned when T5-8 added the subject: a change
 * of `mind@1`, of beings@2, or of the subject shows here first.
 */
const REFERENCE_TRAIL = "edb4c5271fcb44bc544959c8c6ee62d7";

/** The subject's script, computed once. */
const SCRIPT = subjectScript();

/**
 * An observer: it looks at the world before `tick`, and returns the chunks holding a mind it found
 * something faded in, which a decision at `tick` would forget.
 */
type Observer = (world: BeingsWorld, tick: number) => readonly ChunkKey[];

/** The talk window of the subject's species: `max(speech.gap + 1, speech.cooldown)`. */
const TALK_WINDOW = Math.max(SUBJECT_SPECIES.speech.gap + 1, SUBJECT_SPECIES.speech.cooldown);

/** The context the mind layer works in for `being` at `tick` of the subject's world. */
function contextOf(being: beings.Being2, tick: number): mind.MindContext {
  return {
    moment: { tick, secondsPerTick: 12 },
    laws: { mind: SUBJECT_SPECIES.mind, relations: SUBJECT_SPECIES.relations },
    retention: being.traits.retention,
    talkWindow: TALK_WINDOW,
  };
}

/** A member or kind of a mind that is C3, which no view may hold (mind.md, "Classification"). */
const TAINTED = /"(tn|ex|exposure)":|"external"/;

/**
 * An observer that reads every being and its mind, and the view of that mind a decision at `tick`
 * would give its brain, checking that the view holds no taint; it returns the chunks of the minds
 * that hold an episode faded by then.
 */
const readingMinds: Observer = (world, tick) => {
  const view = readView(world);
  const faded: ChunkKey[] = [];
  for (const key of view.readGlobal().occupancy) {
    for (const being of (view.readChunk(key)?.beings ?? []) as beings.Being2[]) {
      const context = contextOf(being, tick);
      const seen = mind.viewOf(being.mind, context);
      expect(TAINTED.test(JSON.stringify(seen))).toBe(false);
      expect(seen.next).toBe(being.mind.next);
      if (mind.forget(being.mind, context).forgot.length > 0 && !faded.includes(key))
        faded.push(key);
    }
  }
  return faded;
};

/** The command of a coupled host: the chunks of the minds its observer found something faded in. */
const COMPACT = "host.compact";

/**
 * `ruleset` plus the command of a coupled host: for each chunk it names, it compacts the mind of
 * every being there by forgetting what has faded by the tick, as a decision would. A defect
 * on purpose, of the kind observer independence forbids (AGENTS.md, rule 4): the engine forgets
 * only when a being decides, so that how often a mind is looked at changes nothing.
 */
function compacting(ruleset: ReturnType<typeof mindRuleset>): SuiteRuleset {
  const compact: CommandHandler<beings.BeingsGlobal, beings.BeingsChunk> = {
    check: (_view, command) =>
      command.origin.kind === "admin" ? undefined : { reason: "admin_only" },
    apply: (ctx, command) => {
      for (const key of (command.payload as { keys: string[] }).keys) {
        const held = (ctx.readChunk(key)?.beings ?? []) as beings.Being2[];
        const compacted = held.map((being) => ({
          ...being,
          mind: mind.forget(being.mind, contextOf(being, ctx.tick)).mind,
        }));
        if (canonicalize(compacted as never) !== canonicalize(held as never))
          ctx.writeChunk(key).beings = compacted;
      }
      return undefined;
    },
  };
  const coupled = { ...ruleset, commands: { ...ruleset.commands, [COMPACT]: compact } };
  return coupled as unknown as SuiteRuleset;
}

/** The command of the coupled host at `tick`, after `after` scripted ones: the chunks to compact. */
function compactCommand(tick: number, after: number, keys: readonly ChunkKey[]): Command {
  const payload = { keys: [...keys] };
  return { applyTick: tick, seq: after, type: COMPACT, origin: { kind: "admin" }, payload };
}

/** What an observed run gave. */
type Observed = {
  readonly records: readonly TickRecord[];
  readonly finalText: string;
  readonly landmarks: Landmarks;
  /** The problems the invariants and the ledger oracle found, after every tick. */
  readonly problems: readonly string[];
  /** What the minds did, the belief operations that are not their rule among it. */
  readonly run: MindRun;
  /** Counts of what the invariants checked, so that a pass is not vacuous. */
  readonly seen: MindInvariants["seen"];
};

/**
 * Runs the subject for `ticks` ticks with `mind@1`: before each tick, the observer reading minds
 * reads the world, and with a coupled host what it read becomes a command of that tick; after each
 * tick the invariants, the ledger oracle, and the rule check of MindObserver read what it did.
 */
function runObserved(ticks: number, coupled = false): Observed {
  const observer = new MindObserver();
  const base = rulesetOf(observer.controller(subjectBrain()));
  const ruleset = coupled ? compacting(base) : (base as unknown as SuiteRuleset);
  const world = mindWorld(SUBJECT_SEEDS[0], ruleset, false) as BeingsWorld;
  observer.start(world, IDS);
  const records: TickRecord[] = [];
  const landmarks = landmarkTracker();
  const invariants = new MindInvariants(SUBJECT_LIFE);
  const oracle = new LedgerOracle();
  const problems: string[] = [];
  let before = beingsById(world);
  let chunks = chunksById(world);
  for (let tick = 1; tick <= ticks; tick += 1) {
    const faded = readingMinds(world, tick);
    const scripted = SCRIPT[tick - 1] ?? [];
    const commands =
      coupled && faded.length > 0
        ? [...scripted, compactCommand(tick, scripted.length, faded)]
        : scripted;
    const result = step(world, commands);
    records.push(tickRecord(result));
    landmarks.track(result, world);
    observer.observe(result);
    const after = beingsById(world);
    problems.push(
      ...invariants.check({ tick, before, after, chunks, commands, events: result.events }),
      ...oracle.read(result.events),
      ...oracle.compare(after, tick),
    );
    before = after;
    chunks = chunksById(world);
  }
  return {
    records,
    finalText: encodeSnapshot(world),
    landmarks: landmarks.found,
    problems,
    run: observer.finish(ticks),
    seen: invariants.seen,
  };
}

let observedRun: Observed | undefined;
/** The subject's run under its observers, computed once: its landmarks are the suite's cuts. */
const observed = () => {
  observedRun ??= runObserved(SUBJECT_TICKS);
  return observedRun;
};

/** The two seeded random ticks the suite also cuts at, drawn once from a fixed seed. */
const RANDOM_CUTS = (() => {
  const random = new Sfc32(0x7a5e_0008);
  return [2 + random.below(SUBJECT_TICKS - 3), 2 + random.below(SUBJECT_TICKS - 3)];
})();

/** The middle of the run, where a resume in process and one in a child continue from. */
const MIDDLE = Math.floor(SUBJECT_TICKS / 2);

/** The in-process cuts: every landmark, the middle, and the random ticks, once each, in order. */
function cutsOf(landmarks: Landmarks): number[] {
  return [...new Set([...Object.values(landmarks), MIDDLE, ...RANDOM_CUTS])].sort((a, b) => a - b);
}

const CHILD_CUTS = [0, MIDDLE, SUBJECT_TICKS - 1];

let suiteRun: Promise<DeterminismReport> | undefined;
/** The suite's report on the subject, with cuts at the landmarks, computed once. */
function suiteReport(): Promise<DeterminismReport> {
  suiteRun ??= runDeterminismSuite({
    ruleset: MIND_RULESET,
    world: mindWorld,
    seeds: SUBJECT_SEEDS,
    ticks: SUBJECT_TICKS,
    commands: (tick) => SCRIPT[tick - 1] ?? [],
    cuts: cutsOf(observed().landmarks),
    childCuts: CHILD_CUTS,
  });
  return suiteRun;
}

/** The records of the subject's world, without observers, for `ticks` ticks under `ruleset`. */
function recordsOf(ruleset: SuiteRuleset, ticks: number): TickRecord[] {
  const world = mindWorld(SUBJECT_SEEDS[0], ruleset, false);
  return Array.from({ length: ticks }, (_, index) => tickRecord(step(world, SCRIPT[index] ?? [])));
}

/**
 * `mind@1` with the defect of a brain that passes the senses of one decision to the next: it keeps
 * the last senses it decided on, and when the next decision is another being's, that being takes
 * the heading the other had. One instance serving every decision leaks; a fresh one cannot.
 */
function leakyBrain(): beings.Controller2 {
  const inner = subjectBrain();
  let last: Senses2 | undefined;
  return {
    brain: inner.brain,
    behaviors: inner.behaviors,
    concepts: inner.concepts,
    decide: (senses) => {
      const previous = last;
      last = senses;
      const intention = inner.decide(senses);
      if (previous === undefined || previous.self.id === senses.self.id) return intention;
      const heading = previous.self.behavior.heading;
      return { ...intention, behavior: { ...intention.behavior, heading } };
    },
  };
}

/** The tick at which tampering changes the global value behind the barrier. */
const TAMPER_TICK = 2;

/** The subject's ruleset with a system that changes the global value through a read. */
function tampering(): SuiteRuleset {
  const ruleset = mindRuleset() as unknown as SuiteRuleset;
  const sneaky: RulesetSystem<CanonicalValue, CanonicalValue> = {
    name: "tamper",
    streams: [],
    run: (ctx) => {
      // The defect: a write through the value readGlobal returns, behind the barrier.
      if (ctx.tick === TAMPER_TICK)
        (ctx.readGlobal() as unknown as { prunedDay: number }).prunedDay += 1;
      return undefined;
    },
  };
  return { ...ruleset, systems: [...ruleset.systems, sneaky] };
}

describe("the subject's world factory", () => {
  test("builds its world with the seed it is given, over the test genesis, with its three beings", () => {
    const world = mindWorld([5, 6], mindRuleset() as unknown as SuiteRuleset, false);
    const snapshot = JSON.parse(encodeSnapshot(world)) as {
      world: { rng: { seed: Seed }; config: { simSecondsPerTick: number } };
    };
    expect([snapshot.world.rng.seed, snapshot.world.config]).toEqual([
      [5, 6],
      { simSecondsPerTick: 12 },
    ]);
    expect([...beingsById(world as BeingsWorld).keys()].sort()).toEqual(IDS);
  });

  test("runs the ruleset it is given under audit when asked, which finds a write behind the barrier", () => {
    const audited = mindWorld(SUBJECT_SEEDS[0], tampering(), true);
    step(audited, []);
    let fault: unknown;
    try {
      step(audited, []);
    } catch (error) {
      fault = error;
    }
    expect(fault).toBeInstanceOf(EngineError);
    const { code, issues } = fault as EngineError;
    expect([code, issues]).toEqual([
      "integrity_violation",
      [{ path: "/global", message: STALE_GLOBAL }],
    ]);
    // Without audit, the same world steps past that write.
    const unaudited = mindWorld(SUBJECT_SEEDS[0], tampering(), false);
    step(unaudited, []);
    expect(step(unaudited, []).tick).toBe(TAMPER_TICK);
  });
});

describe("the determinism suite on a world of mind@1 (plan §11.2, test 11)", () => {
  test(
    "passes every check, with cuts at every landmark, the middle, and seeded ticks",
    async () => {
      const { landmarks } = observed();
      // The landmarks the cuts need all happen before the last tick.
      expect(landmarks).toEqual({
        act: 1,
        delivery: 2,
        room: 16,
        chunk: 33,
        injection: 30,
        forgetting: 47,
        revision: 47,
        dusk: 50,
        day: 100,
      });
      const report = await suiteReport();
      expect(report.failures).toEqual([]);
      expect(report.resumed).toEqual(cutsOf(landmarks));
      expect(report.childResumed).toEqual(CHILD_CUTS);
      const checksums = report.reference.map((record) =>
        "checksum" in record ? record.checksum : record.fault,
      );
      expect(digest(checksums)).toBe(REFERENCE_TRAIL);
    },
    BUDGET_MS,
  );

  test(
    "a fresh mind@1 for every decision gives every record of one brain that serves them all",
    async () => {
      const report = await suiteReport();
      const fresh = recordsOf(freshMindRuleset() as unknown as SuiteRuleset, SUBJECT_TICKS);
      expect(firstDivergence(report.reference, fresh)).toBeUndefined();
    },
    BUDGET_MS,
  );

  test("a brain that passes one being's senses to the next diverges from its fresh differential", () => {
    const ticks = 5;
    const fresh = recordsOf(rulesetOf(freshEach(leakyBrain)) as unknown as SuiteRuleset, ticks);
    const shared = recordsOf(rulesetOf(leakyBrain()) as unknown as SuiteRuleset, ticks);
    // A fresh instance has no senses to pass on: it decides as mind@1 does.
    const honest = recordsOf(mindRuleset() as unknown as SuiteRuleset, ticks);
    expect(firstDivergence(honest, fresh)).toBeUndefined();
    expect(firstDivergence(fresh, shared)).toEqual({ tick: 1, detail: "checksum differs" });
  });
});

describe("observers of the minds (plan §11.2, test 12)", () => {
  test(
    "reading every mind and its view, and checking every invariant and rule, leaves every record unchanged",
    async () => {
      const report = await suiteReport();
      const run = observed();
      expect(firstDivergence(report.reference, run.records)).toBeUndefined();
      expect(report.finalText).toBeDefined();
      expect(run.finalText).toBe(report.finalText ?? "");
    },
    BUDGET_MS,
  );

  test("a host that compacts the minds its observer read changes the records at once", async () => {
    const report = await suiteReport();
    const ticks = 30;
    const coupled = runObserved(ticks, true);
    expect(firstDivergence(report.reference.slice(0, ticks), coupled.records)).toEqual({
      tick: 27,
      detail: "checksum, changedChunks, stats differ",
    });
  });
});

describe("the minds of the subject at every tick (plan §11.2, test 13)", () => {
  test("hold every invariant, match the ledger oracle, and make only operations their rules give", () => {
    const { problems, run, seen } = observed();
    expect(problems.slice(0, 5)).toEqual([]);
    expect(run.ruleProblems).toEqual([]);
    expect(run.priorSuspect).toBe(0);
    // Not vacuous: the beings formed, revised, spoke, crowded, and heard what research injected.
    const tallies = [...run.tallies.values()];
    const total = (pick: (tally: (typeof tallies)[number]) => number) =>
      tallies.reduce((sum, tally) => sum + pick(tally), 0);
    expect({
      seen: total((tally) => tally.seenBeliefs) > 0,
      told: total((tally) => tally.toldBeliefs) > 0,
      revisedDown: total((tally) => tally.revisedDown) > 0,
      external: seen.external > 0,
      delivered: seen.delivered > 0,
      crowded: seen.crowded > 0,
      injected: seen.injected > 0,
    }).toEqual({
      seen: true,
      told: true,
      revisedDown: true,
      external: true,
      delivered: true,
      crowded: true,
      injected: true,
    });
  });
});
