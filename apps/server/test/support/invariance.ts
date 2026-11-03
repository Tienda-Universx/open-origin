/**
 * The run and the comparison of observer invariance, P9 (ADR 0005, control 1 as ADR 0025 refines
 * it), shared by the test in process (observer-invariance.test.ts) and its variant over real
 * sockets (ws-world.test.ts). A run is the mind@1 subject world of T5, composed by composeServer as
 * production composes it, on a fake clock, with a constant readTerrain: three beings that greet,
 * tell, forage, and cross chunks, and a research injection, an admin command, at tick 30. It
 * records, for every tick, the fake-clock time at which the host asked for its commands, its full
 * command list, rejected commands included, its checksum, and the bytes of its PublishedTick, and
 * at the end the snapshot. Two runs are compared tick by tick, and the first difference is named.
 */
import { type beings, type Command, encodeSnapshot, type World } from "@open-origin/engine";
import {
  type BeingPublic,
  type Clock,
  chunkKey,
  encodeTerrain,
  type TerrainPublic,
} from "@open-origin/protocol/public";
import { rulesetOf, subjectBrain } from "../../../../packages/agents/test/support/mind-ruleset.ts";
import {
  mindWorld,
  SUBJECT_SEEDS,
  subjectScript,
} from "../../../../packages/agents/test/support/mind-subject.ts";
import type { SuiteRuleset } from "../../../../packages/engine/test/support/determinism-records.ts";
import { composeServer, type Server, type WorldPlaneDeps } from "../../src/compose.ts";
import { type Config, parseConfig } from "../../src/config/config.ts";
import { BeingsProjection, type WorldProjection } from "../../src/projection/projection.ts";
import { EphemeralJournal, type JournalBatch, type TickJournal } from "../../src/world/journal.ts";
import type { PublishedTick } from "../../src/world/published.ts";
import type { CommandIntent, WorldSource } from "../../src/world/source.ts";
import { FakeClock, FakeTimer } from "./fake-time.ts";
import { type ChunkState, WORLD_ID } from "./presentation.ts";

/** One period at 5 Hz, in microseconds. */
export const P = 200_000;

/** The configuration production starts with, in ephemeral mode. */
export function config(): Config {
  const parsed = parseConfig({ OPEN_ORIGIN_DURABILITY: "ephemeral" });
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.config;
}

/** One flat terrain for every chunk: what the world does never depends on terrain sent out. */
export const TERRAIN: TerrainPublic = encodeTerrain(
  {
    elevation: Array(1024).fill(0),
    liquidDepth: Array(1024).fill(0),
    substrate: Array(1024).fill(0),
  },
  {
    elevation: { min: -100, max: 100 },
    liquidDepth: { min: 0, max: 100 },
    substrate: { min: 0, max: 15 },
  },
);

/** The C0 projection of a world of beings, with the constant terrain. */
export function constantTerrain(world: World): WorldProjection {
  const projection = new BeingsProjection(world);
  return {
    boot: () => projection.boot(),
    project: (result) => projection.project(result),
    readTerrain: () => TERRAIN,
    get omittedSpeech() {
      return projection.omittedSpeech;
    },
  };
}

/** What a run recorded of each tick, and its final snapshot. */
export type Timeline = {
  readonly ticks: number;
  readonly times: ReadonlyMap<number, number>;
  readonly commands: ReadonlyMap<number, string>;
  readonly checksums: ReadonlyMap<number, string>;
  readonly published: ReadonlyMap<number, string>;
  readonly snapshot: string;
};

/** The first tick at which `run` differs from `reference`, and in what; undefined when none. */
export function divergence(reference: Timeline, run: Timeline) {
  const fields = ["times", "commands", "checksums", "published"] as const;
  for (let tick = 0; tick <= Math.max(reference.ticks, run.ticks); tick += 1) {
    const what = fields.find((field) => reference[field].get(tick) !== run[field].get(tick));
    if (what !== undefined) return { tick, what };
  }
  return reference.snapshot === run.snapshot ? undefined : { tick: run.ticks, what: "snapshot" };
}

/** A journal that keeps each tick's commands and checksum, then acknowledges as production does. */
class RecordingJournal implements TickJournal {
  readonly level = "none";
  readonly commands = new Map<number, string>();
  readonly checksums = new Map<number, string>();
  readonly #inner = new EphemeralJournal();

  append(batch: JournalBatch): Promise<void> {
    for (const { tick, commands, checksum } of batch.records) {
      this.commands.set(tick, JSON.stringify(commands));
      this.checksums.set(tick, checksum);
    }
    return this.#inner.append(batch);
  }
}

/** The subject's script: the commands of tick `t` at index `t − 1`, the injection among them. */
let script: readonly (readonly Command[])[] | undefined;

/** The intents of the script's commands at `tick`. */
function scriptAt(tick: number): CommandIntent[] {
  script ??= subjectScript();
  return (script[tick - 1] ?? []).map(({ type, origin, payload }) => ({ type, origin, payload }));
}

/** What a run of the subject may change: a negative control's double, and a hook per tick. */
export type SubjectOptions = {
  /** The brain of the subject's beings: its own unless given. */
  readonly brain?: beings.Controller2 | undefined;
  /** Commands added to the script's at each tick. */
  readonly extra?: ((tick: number) => readonly CommandIntent[]) | undefined;
  /** Called with each tick as the host asks for its commands. */
  readonly onTick?: ((tick: number) => void) | undefined;
  readonly schedulerOf?: WorldPlaneDeps["schedulerOf"] | undefined;
};

/** A composed run of the subject: its clock and timer, its server and world, and its end. */
export type SubjectRun = {
  readonly clock: FakeClock;
  readonly timer: FakeTimer;
  readonly server: Server;
  readonly world: World;
  /** Stops the server, which publishes every executed tick, and returns the run's timeline. */
  finish(): Promise<Timeline>;
};

/** The subject world as a source that records the fake-clock time the host asks for each tick. */
function recordingSource(clock: FakeClock, options: SubjectOptions) {
  const brain = options.brain ?? subjectBrain();
  const world = mindWorld(SUBJECT_SEEDS[0], rulesetOf(brain) as unknown as SuiteRuleset, false);
  const times = new Map<number, number>();
  const source: WorldSource = {
    world,
    commandsAt: (tick) => {
      options.onTick?.(tick);
      times.set(tick, clock.now());
      const commands = scriptAt(tick);
      return options.extra === undefined ? commands : [...commands, ...options.extra(tick)];
    },
  };
  return { source, times, world };
}

/**
 * Composes a run of the subject through composeServer, as production composes the server, with
 * the doubles of `options`. Nothing runs until its server starts.
 */
export function subjectRun(options: SubjectOptions = {}): SubjectRun {
  const clock = new FakeClock();
  const timer = new FakeTimer(clock);
  const { source, times, world } = recordingSource(clock, options);
  const journal = new RecordingJournal();
  const { schedulerOf } = options;
  const server = composeServer(config(), {
    clock,
    timer,
    source,
    journal,
    projectionOf: constantTerrain,
    worldId: WORLD_ID,
    ...(schedulerOf === undefined ? {} : { schedulerOf }),
  });
  const published = new Map<number, string>();
  server.world.subscribeToPublished((tick) => {
    published.set(tick.tick, JSON.stringify(tick));
  });
  const finish = async (): Promise<Timeline> => {
    await server.stop();
    const { commands, checksums } = journal;
    const ticks = server.world.status().executedTick;
    return { ticks, times, commands, checksums, published, snapshot: encodeSnapshot(world) };
  };
  return { clock, timer, server, world, finish };
}

/** The public world at each published tick, as the C0 projection published it. */
export class PublicHistory {
  readonly #chunks = new Map<number, ReadonlyMap<string, ChunkState>>();
  readonly #clocks = new Map<number, Clock>();
  #boot = 0;

  /** Applies the next published tick, the boot record first. */
  readonly apply = (published: PublishedTick): void => {
    if (this.#chunks.size === 0) this.#boot = published.tick;
    const chunks = new Map(this.#chunks.get(published.tick - 1));
    for (const { at, v, upsert, gone } of published.chunks) {
      const beings = new Map(chunks.get(chunkKey(at))?.beings);
      for (const id of gone) beings.delete(id);
      for (const record of upsert) beings.set(record.id, record);
      chunks.set(chunkKey(at), { v, beings });
    }
    this.#chunks.set(published.tick, chunks);
    this.#clocks.set(published.tick, published.clock);
  };

  /** The chunks `keys` at `tick`: a chunk no tick published is empty at the boot tick. */
  chunks(tick: number, keys: Iterable<string>): Map<string, ChunkState> {
    const world = this.#chunks.get(tick);
    if (world === undefined) throw new Error(`no tick ${tick} was published`);
    const empty: ChunkState = { v: this.#boot, beings: new Map() };
    return new Map([...keys].map((key) => [key, world.get(key) ?? empty]));
  }

  /** The record of `being` at `tick`, or undefined when no chunk holds it. */
  record(tick: number, being: number): BeingPublic | undefined {
    for (const { beings } of this.#chunks.get(tick)?.values() ?? []) {
      const record = beings.get(being);
      if (record !== undefined) return record;
    }
    return undefined;
  }

  clock(tick: number): Clock {
    const clock = this.#clocks.get(tick);
    if (clock === undefined) throw new Error(`no tick ${tick} was published`);
    return clock;
  }
}
