/**
 * The world host (ADR 0025; plan test 15: the server changes none of the frozen results of T2–T5):
 * over the `mind@1` subject and its script it reproduces the frozen trail of the determinism
 * suite, and over the default scenario it gives every tick the checksum a direct step loop gives;
 * it stamps commands, records every one, and checkpoints every K-th tick; and on an engine fault,
 * or a projection that throws, a walk's refused record among them, the valid ticks reach the
 * journal, the faulted one does not, and the host halts.
 */
import { describe, expect, test } from "bun:test";
import {
  beings,
  createWorld,
  digest,
  encodeSnapshot,
  type Ruleset,
  step,
  type World,
  worldStatus,
} from "@open-origin/engine";
import { LABELS2, scenario2Of } from "@open-origin/scenarios";
import { mindRuleset } from "../../../packages/agents/test/support/mind-ruleset.ts";
import {
  mindWorld,
  SUBJECT_SEEDS,
  SUBJECT_TICKS,
  subjectScript,
} from "../../../packages/agents/test/support/mind-subject.ts";
import { testGenesis } from "../../../packages/engine/test/support/beings-world.ts";
import { being2, chunksOf } from "../../../packages/engine/test/support/beings2-world.ts";
import type { SuiteRuleset } from "../../../packages/engine/test/support/determinism-records.ts";
import { BeingsProjection } from "../src/projection/projection.ts";
import { type Halt, type Projector, WorldHost } from "../src/world/host.ts";
import type { JournalBatch, TickJournal, TickRecord } from "../src/world/journal.ts";
import { PublicationGate } from "../src/world/publication.ts";
import {
  type CommandIntent,
  ScenarioSource,
  ScriptedSource,
  type WorldSource,
} from "../src/world/source.ts";
import { countingWorld } from "./support/counting-world.ts";
import { ControlledJournal, RecordingJournal, settle } from "./support/journals.ts";
import { emptyProjection } from "./support/projections.ts";

/**
 * The digest of every checksum of the subject's reference run, as
 * packages/agents/test/mind-determinism.test.ts pins it (REFERENCE_TRAIL, from T5-8).
 */
const REFERENCE_TRAIL = "edb4c5271fcb44bc544959c8c6ee62d7";

type HostOverOptions = {
  readonly journal?: TickJournal;
  readonly batchTicks?: number;
  readonly checkpointTicks?: number;
  /** The projection of a world without beings unless given. */
  readonly projector?: Projector;
};

/** A host over `source` with a gate booted at tick 0 and `journal`. */
function hostOver(
  source: WorldSource,
  {
    journal = new RecordingJournal(),
    batchTicks = 5,
    checkpointTicks = 300,
    projector = emptyProjection(source.world),
  }: HostOverOptions = {},
) {
  const gate = new PublicationGate({ journal, batchTicks, boot: 0 });
  const host = new WorldHost({ source, projector, gate, checkpointTicks });
  return { gate, host };
}

/**
 * A world that holds being 1 of beings@2 on the first step of a walk, under a ruleset that validates
 * nothing and whose one system, at the tick `at`, moves the walk past its last step: a walk the
 * engine's validator never stores, planted so that it reaches the projection.
 */
function brokenWalkWorld(at: number): World {
  const walk: beings.Activity = { kind: "walk", start: 0, dirs: "02", ms: [10, 20], done: 0 };
  const ruleset: Ruleset<beings.BeingsGlobal, beings.BeingsChunk> = {
    versions: { ruleset: "server-test@1", generator: "none@1", brain: "none@1" },
    systems: [
      {
        name: "break",
        streams: [],
        run: (ctx) => {
          if (ctx.tick !== at) return undefined;
          const chunk = ctx.writeChunk("0,0");
          chunk.beings = chunk.beings.map((being) => ({
            ...being,
            activity: { ...walk, done: walk.dirs.length },
          }));
          return undefined;
        },
      },
    ],
    commands: {},
    validateGlobal: () => [],
    validateChunk: () => [],
  };
  const global = {
    ...beings.beingsGlobal(testGenesis(), beings.defaultLife2()),
    occupancy: ["0,0"],
  };
  const chunks = chunksOf([{ ...being2(1, [3, 4]), activity: walk }]);
  return createWorld({ seed: [1, 2], simSecondsPerTick: 12, global, chunks, ruleset });
}

/** The records of `batches`, in order. */
const recordsOf = (batches: readonly JournalBatch[]): TickRecord[] =>
  batches.flatMap(({ records }) => records);

const ranges = (batches: readonly JournalBatch[]) =>
  batches.map(({ fromTick, toTick }) => [fromTick, toTick]);

const ticks = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index);

describe("WorldHost", () => {
  test("reproduces the frozen trail of the mind@1 subject, stamping its script exactly", async () => {
    const script = subjectScript();
    // mindWorld takes the determinism suite's ruleset type, as mind-determinism.test.ts passes it.
    const world = mindWorld(SUBJECT_SEEDS[0], mindRuleset() as unknown as SuiteRuleset, false);
    const journal = new RecordingJournal();
    const projector = new BeingsProjection(world);
    const { gate, host } = hostOver(new ScriptedSource(world, script), { journal, projector });
    const published: number[] = [];
    gate.subscribe(({ tick }) => {
      published.push(tick);
    });
    for (let tick = 1; tick <= SUBJECT_TICKS; tick += 1) host.stepOnce();
    await gate.flush();
    const records = recordsOf(journal.batches);
    expect(records.map(({ tick }) => tick)).toEqual(ticks(1, SUBJECT_TICKS));
    expect(digest(records.map(({ checksum }) => checksum))).toBe(REFERENCE_TRAIL);
    // The script carries its own applyTick and seq: the host's stamps are the same.
    expect(records.map(({ commands }) => commands)).toEqual(
      script.map((commands) => [...commands]),
    );
    expect(published).toEqual(ticks(1, SUBJECT_TICKS));
  });

  test("steps the default scenario exactly as a direct step loop does, checkpoint included", async () => {
    const TICKS = 300;
    const direct = scenario2Of(LABELS2.default);
    const expected = ticks(1, TICKS).map(
      (tick) => step(direct.world, tick === 1 ? direct.spawns : []).checksum,
    );
    const source = new ScenarioSource();
    expect(source.label).toBe("open-origin/t5/default");
    const journal = new RecordingJournal();
    const projector = new BeingsProjection(source.world);
    const { gate, host } = hostOver(source, { journal, projector });
    for (let tick = 1; tick <= TICKS; tick += 1) host.stepOnce();
    await gate.flush();
    const records = recordsOf(journal.batches);
    expect(records.map(({ checksum }) => checksum)).toEqual(expected);
    // The admin spawns of tick 1, eight of them, with their seq; nothing after.
    expect(records[0]?.commands).toEqual(direct.spawns);
    expect(records[0]?.commands).toHaveLength(8);
    expect(records.slice(1).every(({ commands }) => commands.length === 0)).toBe(true);
    const checkpoints = journal.batches.filter(({ checkpoint }) => checkpoint !== undefined);
    expect(ranges(checkpoints)).toEqual([[296, 300]]);
    expect(checkpoints[0]?.checkpoint).toBe(encodeSnapshot(direct.world));
    expect(host.simSecondsPerTick).toBe(12);
  });

  test("records every command it was given, rejected ones included, in stamped order", async () => {
    const unknown: CommandIntent = { type: "nothing.known", origin: { kind: "admin" }, payload: 1 };
    const later: CommandIntent = { type: "nothing.else", origin: { kind: "admin" }, payload: [2] };
    const journal = new RecordingJournal();
    const source = new ScriptedSource(countingWorld(1000), [[], [unknown, later]]);
    const { gate, host } = hostOver(source, { journal, batchTicks: 2 });
    host.stepOnce();
    host.stepOnce();
    await gate.flush();
    expect(recordsOf(journal.batches).map(({ commands }) => commands)).toEqual([
      [],
      [
        { applyTick: 2, seq: 0, ...unknown },
        { applyTick: 2, seq: 1, ...later },
      ],
    ]);
  });

  test("encodes the snapshot of every K-th tick into the batch that ends at it", async () => {
    const journal = new RecordingJournal();
    const { gate, host } = hostOver(new ScriptedSource(countingWorld(1000), []), {
      journal,
      batchTicks: 3,
      checkpointTicks: 4,
    });
    for (let tick = 1; tick <= 9; tick += 1) host.stepOnce();
    await gate.flush();
    expect(ranges(journal.batches)).toEqual([
      [1, 3],
      [4, 4],
      [5, 7],
      [8, 8],
      [9, 9],
    ]);
    const twin = countingWorld(1000);
    const snapshots: string[] = [];
    for (let tick = 1; tick <= 8; tick += 1) {
      step(twin, []);
      if (tick % 4 === 0) snapshots.push(encodeSnapshot(twin));
    }
    expect(journal.batches.map(({ checkpoint }) => checkpoint)).toEqual([
      undefined,
      snapshots[0],
      undefined,
      snapshots[1],
      undefined,
    ]);
  });

  test("on an engine fault appends the valid ticks, never the faulted one, then halts", async () => {
    const world = countingWorld(7);
    const journal = new ControlledJournal();
    const { gate, host } = hostOver(new ScriptedSource(world, []), { journal });
    for (let tick = 1; tick <= 6; tick += 1) host.stepOnce();
    expect(ranges(journal.batches)).toEqual([[1, 5]]);
    host.stepOnce();
    expect(host.halted).toEqual({ code: "system_fault", tick: 7 });
    expect(host.executedTick).toBe(6);
    expect(worldStatus(world)).toMatchObject({ kind: "faulted", tick: 7, code: "system_fault" });
    journal.ack();
    await settle();
    // The halt flushed the partial batch of tick 6.
    expect(ranges(journal.batches)).toEqual([
      [1, 5],
      [6, 6],
    ]);
    journal.ack();
    await settle();
    expect([gate.executed, gate.committed, gate.published]).toEqual([6, 6, 6]);
    expect(recordsOf(journal.batches).map(({ tick }) => tick)).toEqual(ticks(1, 6));
    expect(() => host.stepOnce()).toThrow("the world halted at tick 7 with system_fault");
    expect(journal.batches).toHaveLength(2);
  });

  test("halts on a projection that throws, and never publishes the tick it could not project", async () => {
    const journal = new RecordingJournal();
    const source = new ScriptedSource(countingWorld(1000), []);
    const empty = emptyProjection(source.world);
    const projector: Projector = {
      project: (result) => {
        if (result.tick === 3) throw new Error("a planted projection fault");
        return empty.project(result);
      },
    };
    const { gate, host } = hostOver(source, { journal, projector });
    const published: number[] = [];
    gate.subscribe(({ tick }) => {
      published.push(tick);
    });
    for (let tick = 1; tick <= 3; tick += 1) host.stepOnce();
    await settle();
    expect(host.halted).toEqual({
      code: "unexpected_error",
      tick: 3,
      cause: { message: "a planted projection fault" },
    });
    expect(host.executedTick).toBe(2);
    expect(recordsOf(journal.batches).map(({ tick }) => tick)).toEqual([1, 2]);
    expect(published).toEqual([1, 2]);
  });

  test("halts on a walk past its last step, whose record the strict schema refuses: the fail-safe", async () => {
    const journal = new RecordingJournal();
    const world = brokenWalkWorld(3);
    const projector = new BeingsProjection(world);
    const { gate, host } = hostOver(new ScriptedSource(world, []), { journal, projector });
    const published: number[] = [];
    gate.subscribe(({ tick }) => {
      published.push(tick);
    });
    for (let tick = 1; tick <= 3; tick += 1) host.stepOnce();
    await settle();
    expect(host.halted).toEqual({
      code: "unexpected_error",
      tick: 3,
      cause: { message: "the being 1 has no valid public record: activity.dir (invalid_type)" },
    });
    expect(recordsOf(journal.batches).map(({ tick }) => tick)).toEqual([1, 2]);
    expect(published).toEqual([1, 2]);
  });

  test("records a halt before its flush, so a halt the flush causes keeps the first reason", () => {
    const seen: (Halt | undefined)[] = [];
    let host: WorldHost | undefined;
    const gate: PublicationGate = new PublicationGate({
      journal: {
        level: "none",
        append: () => {
          throw new Error("disk full");
        },
      },
      batchTicks: 5,
      boot: 0,
      // As compose wires it: a journal failure halts the host, from within the flush.
      onChange: () => {
        host?.halt("journal_failed", gate.failure);
        seen.push(host?.halted);
      },
    });
    const source = new ScriptedSource(countingWorld(3), []);
    host = new WorldHost({ source, projector: emptyProjection(source.world), gate });
    host.stepOnce();
    host.stepOnce();
    // Tick 3 faults: the halt flushes ticks 1 and 2, and the journal throws at once.
    host.stepOnce();
    expect(gate.failed).toBe(true);
    expect(gate.failure).toEqual({ message: "disk full" });
    expect(seen).toEqual([{ code: "system_fault", tick: 3 }]);
    expect(host.halted).toEqual({ code: "system_fault", tick: 3 });
  });

  test("halts on request, flushing first, and keeps the first halt's code", async () => {
    const journal = new RecordingJournal();
    const { gate, host } = hostOver(new ScriptedSource(countingWorld(1000), []), { journal });
    for (let tick = 1; tick <= 3; tick += 1) host.stepOnce();
    host.halt("unhandled_rejection");
    host.halt("journal_failed");
    await settle();
    expect(host.halted).toEqual({ code: "unhandled_rejection", tick: 4 });
    expect(ranges(journal.batches)).toEqual([[1, 3]]);
    expect(gate.published).toBe(3);
  });

  test("refuses a gate that did not boot at the world's tick, and K below one", () => {
    const source = new ScriptedSource(countingWorld(1000), []);
    const gate = new PublicationGate({ journal: new RecordingJournal(), batchTicks: 5, boot: 3 });
    const projector = emptyProjection(source.world);
    expect(() => new WorldHost({ source, projector, gate })).toThrow(
      "the gate booted at tick 3, not at the world's 0",
    );
    expect(() => hostOver(source, { checkpointTicks: 0 })).toThrow(RangeError);
  });
});
