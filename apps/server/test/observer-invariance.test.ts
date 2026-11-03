/**
 * Observer invariance, P9 (plan tests 3, 4, and 5 in process; ADR 0005 control 1 as ADR 0025
 * refines it), through the same composeServer() and compose() that production runs, on a fake
 * clock, with a constant readTerrain, over the mind@1 subject world of T5: three beings that greet,
 * tell, forage, and cross chunks, and a research injection, an admin command, at tick 30. (The
 * default world sleeps from its second tick until its night, past 260 ticks: too still to show a
 * brain's leak within a run.) A reference run with no observer
 * is compared with runs with 1 and 32 simulated observers, which connect, change camera and
 * followed being at random, all follow the same being, churn their subscriptions, drain slowly by
 * skipping periods, resync, and disconnect midway. For every tick the fake-clock time it ran at,
 * its full command list, rejected commands included, its checksum, and the bytes of its
 * PublishedTick must be equal, and so must the final snapshot.
 *
 * The run with 32 observers also holds four clients of the protocol's reducer that watch the
 * subject's first chunk crossing (plan test 9): one of the chunk the being leaves, one of the chunk
 * it enters, one of both, and one that follows it. After every commit each view must equal the
 * published world at the commit's tick, and the crossing must fall between two of each client's
 * commits: the being leaves the first chunk and enters the second in one transaction, and the
 * follower's window moves with it.
 *
 * Three permanent negative controls, test doubles injected through compose()'s dependencies and
 * never production code, must make the comparison fail at the exact tick they leak at: NC1, a
 * source that adds an admin command, one the engine rejects, once a being is followed; NC2, a brain
 * wrapper that acts on the "observed" flag the presentation's telemetry sets; NC3, a scheduler that
 * runs one extra tick per subscribe, which only the timeline shows.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { type beings, type Command, encodeSnapshot, type World } from "@open-origin/engine";
import {
  type BeingPublic,
  type ChunkCoord,
  type ClientState,
  type Clock,
  chunkKey,
  encodeTerrain,
  type TerrainPublic,
} from "@open-origin/protocol/public";
import { rulesetOf, subjectBrain } from "../../../packages/agents/test/support/mind-ruleset.ts";
import {
  mindWorld,
  SUBJECT_SEEDS,
  subjectScript,
} from "../../../packages/agents/test/support/mind-subject.ts";
import type { SuiteRuleset } from "../../../packages/engine/test/support/determinism-records.ts";
import { Random } from "../../../packages/protocol/test/support/random.ts";
import { composeServer, type Server, type WorldPlaneDeps } from "../src/compose.ts";
import { parseConfig } from "../src/config/config.ts";
import { BUFFER_BYTES } from "../src/presentation/client.ts";
import type { Presentation } from "../src/presentation/presentation.ts";
import { BeingsProjection, type WorldProjection } from "../src/projection/projection.ts";
import { EphemeralJournal, type JournalBatch, type TickJournal } from "../src/world/journal.ts";
import type { PublishedTick } from "../src/world/published.ts";
import { FixedRateScheduler, type TickScheduler } from "../src/world/scheduler.ts";
import type { CommandIntent, WorldSource } from "../src/world/source.ts";
import { FakeClock, FakeTimer } from "./support/fake-time.ts";
import { type ChunkState, shown, ViewClient, windowKeys } from "./support/presentation.ts";

/** One period at 5 Hz, in microseconds. */
const P = 200_000;
/** The ticks of the compared runs, and of the runs of the negative controls. */
const TICKS = 100;
const LEAK_TICKS = 30;
/** The period at which the negative controls' observers join: clean ticks precede each leak. */
const LATE_JOIN = 10;
const WORLD_ID = "0123456789abcdef0123456789abcdef";

/** The configuration production starts with, in ephemeral mode. */
function config() {
  const parsed = parseConfig({ OPEN_ORIGIN_DURABILITY: "ephemeral" });
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.config;
}

/** One flat terrain for every chunk: what the world does never depends on terrain sent out. */
const TERRAIN: TerrainPublic = encodeTerrain(
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
function constantTerrain(world: World): WorldProjection {
  const projection = new BeingsProjection(world);
  return {
    boot: () => projection.boot(),
    project: (result) => projection.project(result),
    readTerrain: () => TERRAIN,
  };
}

/** What the observers and the leaks share: the presentation, the tick being run, and the leak. */
type Probe = {
  presentation: Presentation | undefined;
  /** The tick the host is running, from its source's call. */
  tick: number;
  /** The being every observer follows, once the feed named it. */
  common: number | undefined;
  /** How many subscriptions the observers made. */
  subscribes: number;
  /** Every tick at which a leak changed what the world receives, in order. */
  readonly leaks: number[];
};

/** A leak: a negative control's double, injected through compose()'s dependencies. */
type Leak = {
  readonly extra?: (tick: number, probe: Probe) => readonly CommandIntent[];
  readonly brain?: (probe: Probe) => beings.Controller2;
  readonly schedulerOf?: (probe: Probe) => NonNullable<WorldPlaneDeps["schedulerOf"]>;
};

/** What a run recorded of each tick, and its final snapshot. */
type Timeline = {
  readonly ticks: number;
  readonly times: ReadonlyMap<number, number>;
  readonly commands: ReadonlyMap<number, string>;
  readonly checksums: ReadonlyMap<number, string>;
  readonly published: ReadonlyMap<number, string>;
  readonly snapshot: string;
};

/** The first tick at which `run` differs from `reference`, and in what; undefined when none. */
function divergence(reference: Timeline, run: Timeline) {
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
let script: readonly (readonly Command[])[];

/**
 * The mind@1 subject world, with its brain replaced when a leak asks, as a source that gives the
 * script's commands and records the fake-clock time at which the host asks for each tick's.
 */
function recordingSource(clock: FakeClock, probe: Probe, leak: Leak) {
  const brain = leak.brain?.(probe) ?? subjectBrain();
  const world = mindWorld(SUBJECT_SEEDS[0], rulesetOf(brain) as unknown as SuiteRuleset, false);
  const times = new Map<number, number>();
  const source: WorldSource = {
    world,
    commandsAt: (tick) => {
      probe.tick = tick;
      times.set(tick, clock.now());
      const commands = (script[tick - 1] ?? []).map(({ type, origin, payload }) => ({
        type,
        origin,
        payload,
      }));
      return leak.extra === undefined ? commands : [...commands, ...leak.extra(tick, probe)];
    },
  };
  return { source, times, world };
}

/** One simulated observer. */
type Observer = {
  id: number | undefined;
  lag: boolean;
  bytes: number;
  readonly joinAt: number;
  readonly leaveAt: number;
};

/** What the observers did, so that a run with observers is never vacuous. */
type Activity = {
  connects: number;
  closes: number;
  follows: number;
  lagged: number;
  received: number;
  watched: number;
};

/** Observers that act between periods, at random from a seed, on what the feed and chunks showed. */
class Audience {
  readonly #random: Random;
  readonly #probe: Probe;
  readonly #observers: Observer[];
  readonly #chunks = new Map<string, ChunkCoord>();
  readonly #beings: number[] = [];
  readonly activity: Activity = {
    connects: 0,
    closes: 0,
    follows: 0,
    lagged: 0,
    received: 0,
    watched: 0,
  };

  constructor(count: number, ticks: number, probe: Probe, firstJoin = 0) {
    this.#random = new Random(0x0b5e + count);
    this.#probe = probe;
    this.#observers = Array.from({ length: count }, (_, index) => ({
      id: undefined,
      lag: false,
      bytes: 0,
      joinAt: firstJoin + (index % 4),
      leaveAt: Math.floor(ticks / 3) + this.#random.below(Math.floor(ticks / 3)),
    }));
  }

  /** Learns the chunks and beings a published tick shows, as a spectator would. */
  learn(
    chunks: readonly {
      readonly at: ChunkCoord;
      readonly upsert: readonly { readonly id: number }[];
    }[],
  ): void {
    for (const { at, upsert } of chunks) {
      this.#chunks.set(chunkKey(at), at);
      for (const { id } of upsert) if (!this.#beings.includes(id)) this.#beings.push(id);
    }
    this.#probe.common ??= this.#beings[0];
  }

  /** Every observer's move before period `step`. */
  act(step: number): void {
    const presentation = this.#probe.presentation;
    if (presentation === undefined) return;
    for (const observer of this.#observers) this.#move(presentation, observer, step);
  }

  #move(presentation: Presentation, observer: Observer, step: number): void {
    if (observer.id === undefined) {
      if (step === observer.joinAt || step === observer.leaveAt + 20)
        this.#join(presentation, observer);
      return;
    }
    if (step === observer.leaveAt) {
      presentation.close(observer.id);
      observer.id = undefined;
      this.activity.closes += 1;
      return;
    }
    this.#churn(presentation, observer, observer.id);
  }

  #join(presentation: Presentation, observer: Observer): void {
    observer.id = presentation.connect({
      send: (frame) => {
        observer.bytes += frame.length;
        this.activity.received += 1;
      },
      // A lagging observer's socket holds as much as the presentation lets it.
      buffered: () => (observer.lag ? BUFFER_BYTES : 0),
      end: (ending) => {
        throw ending.reason === "fault" ? ending.cause : new Error(`ended: ${ending.reason}`);
      },
    });
    this.activity.connects += 1;
    this.#subscribe(presentation, observer.id);
    this.#follow(presentation, observer.id, this.#probe.common ?? null);
  }

  #churn(presentation: Presentation, observer: Observer, id: number): void {
    const roll = this.#random.below(100);
    if (roll < 12) this.#subscribe(presentation, id);
    else if (roll < 20) this.#follow(presentation, id, this.#target());
    else if (roll < 30) observer.lag = !observer.lag;
    else if (roll < 32) presentation.resync(id);
    if (observer.lag) this.activity.lagged += 1;
    if (this.#probe.common !== undefined && presentation.followers(this.#probe.common) > 0) {
      this.activity.watched += 1;
    }
  }

  /** The common being most of the time, else another being, or nothing. */
  #target(): number | null {
    const roll = this.#random.below(10);
    if (roll < 6 || this.#beings.length === 0) return this.#probe.common ?? null;
    return roll < 9 ? this.#random.pick(this.#beings) : null;
  }

  #subscribe(presentation: Presentation, id: number): void {
    const known = [...this.#chunks.values()];
    const camera = new Map<string, ChunkCoord>();
    const size = 1 + this.#random.below(6);
    for (let n = 0; n < size; n += 1) {
      const [x, y] = known.length > 0 ? this.#random.pick(known) : [0, 0];
      const at: ChunkCoord = [x + this.#random.below(3) - 1, y + this.#random.below(3) - 1];
      camera.set(chunkKey(at), at);
    }
    presentation.subscribe(id, [...camera.values()]);
    this.#probe.subscribes += 1;
  }

  #follow(presentation: Presentation, id: number, being: number | null): void {
    presentation.follow(id, being);
    if (being !== null) this.activity.follows += 1;
  }
}

beforeAll(() => {
  script = subjectScript();
});

/** What a run varies. */
type RunOptions = {
  readonly observers: number;
  readonly ticks: number;
  readonly leak?: Leak;
  /** The step at which the first observers join. */
  readonly firstJoin?: number;
  /** Called once the server is composed, before it starts: clients of the test's own join there. */
  readonly watch?: (server: Server) => void;
};

/**
 * Runs the subject world for `ticks` ticks through composeServer, with `observers` acting half a
 * period after each tick and `leak` injected; returns the run's timeline and what observers did.
 */
async function runWorld({ observers, ticks, leak = {}, firstJoin = 0, watch }: RunOptions) {
  const clock = new FakeClock();
  const timer = new FakeTimer(clock);
  const probe: Probe = {
    presentation: undefined,
    tick: 0,
    common: undefined,
    subscribes: 0,
    leaks: [],
  };
  const { source, times, world } = recordingSource(clock, probe, leak);
  const journal = new RecordingJournal();
  const schedulerOf = leak.schedulerOf?.(probe);
  const server = composeServer(config(), {
    clock,
    timer,
    source,
    journal,
    projectionOf: constantTerrain,
    worldId: WORLD_ID,
    ...(schedulerOf === undefined ? {} : { schedulerOf }),
  });
  probe.presentation = server.presentation;
  watch?.(server);
  const audience = new Audience(observers, ticks, probe, firstJoin);
  const published = new Map<number, string>();
  server.world.subscribeToPublished((tick) => {
    published.set(tick.tick, JSON.stringify(tick));
    audience.learn(tick.chunks);
  });
  const act = (step: number) => {
    if (step >= ticks) return;
    audience.act(step);
    timer.schedule(P, () => act(step + 1));
  };
  timer.schedule(P / 2, () => act(0));
  server.start();
  await timer.runUntilSettled((ticks - 1) * P);
  await server.stop();
  const executed = server.world.status().executedTick;
  const timeline: Timeline = {
    ticks: executed,
    times,
    commands: journal.commands,
    checksums: journal.checksums,
    published,
    snapshot: encodeSnapshot(world),
  };
  return { timeline, activity: audience.activity, probe };
}

/** NC1: a source that adds an admin command, which the engine rejects, once a being is followed. */
const NC1: Leak = {
  extra: (tick, probe) => {
    const followed =
      probe.common !== undefined && (probe.presentation?.followers(probe.common) ?? 0) > 0;
    if (!followed || probe.leaks.length > 0) return [];
    probe.leaks.push(tick);
    return [
      {
        type: "observer.followed",
        origin: { kind: "admin" },
        payload: { being: probe.common ?? 0 },
      },
    ];
  },
};

/** NC2: a brain wrapper that idles a being while the presentation counts a follower of it. */
const NC2: Leak = {
  brain: (probe) => {
    const brain = subjectBrain();
    return {
      ...brain,
      decide: (senses) => {
        const intention = brain.decide(senses);
        if ((probe.presentation?.followers(senses.self.id) ?? 0) === 0) return intention;
        const observed: beings.Intention2 = {
          ...intention,
          steps: [{ kind: "idle", ms: 1000 }],
          wakeWhen: {},
        };
        if (JSON.stringify(observed) === JSON.stringify(intention)) return intention;
        if (probe.leaks.at(-1) !== probe.tick) probe.leaks.push(probe.tick);
        return observed;
      },
    };
  },
};

/** NC3: a scheduler that runs one extra tick, out of its schedule, per subscribe it has not seen. */
const NC3: Leak = {
  schedulerOf: (probe) => (options) => {
    let seen = 0;
    const runTick = () => {
      options.runTick();
      for (; seen < probe.subscribes; seen += 1) {
        probe.leaks.push(probe.tick + 1);
        options.runTick();
      }
    };
    const scheduler: TickScheduler = new FixedRateScheduler({ ...options, runTick });
    return scheduler;
  },
};

/** A being that left one chunk for another in one tick. */
type Crossing = {
  readonly tick: number;
  readonly being: number;
  readonly from: ChunkCoord;
  readonly to: ChunkCoord;
};

/** The first crossing in `published`: a being gone from one chunk and upserted in another. */
function firstCrossing(published: ReadonlyMap<number, string>): Crossing {
  for (const [tick, text] of published) {
    const { chunks }: PublishedTick = JSON.parse(text);
    for (const to of chunks) {
      for (const { id } of to.upsert) {
        const from = chunks.find(({ gone }) => gone.includes(id));
        if (from !== undefined) return { tick, being: id, from: from.at, to: to.at };
      }
    }
  }
  throw new Error("no being of the subject world crossed a chunk");
}

/** The public world at each published tick, as the C0 projection published it. */
class PublicHistory {
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

/** What a client's view showed after a commit. */
type Shown = {
  readonly tick: number;
  readonly clock: Clock;
  readonly chunks: Map<string, ChunkState>;
  readonly followed: BeingPublic | null;
  /** Whether every chunk shown had the constant terrain. */
  readonly terrain: boolean;
};

/** What the view of `state` shows. */
function snapshot(state: ClientState): Shown {
  const { view } = state;
  if (view === undefined) throw new Error("a commit left no view");
  const chunks = [...view.chunks.values()];
  return {
    tick: view.tick,
    clock: view.clock,
    chunks: shown(state),
    followed: view.followed,
    terrain: chunks.every(({ terrain }) => Bun.deepEquals(terrain, TERRAIN)),
  };
}

/** A client that watches a crossing: its camera, whether it follows the being, and its commits. */
type Viewer = {
  readonly client: ViewClient;
  readonly camera: readonly ChunkCoord[];
  readonly follows: boolean;
  readonly shown: Shown[];
};

/** Clients of the chunk a crossing leaves, of the one it enters, of both, and its being's follower. */
class CrossingWatch {
  readonly history = new PublicHistory();
  readonly crossing: Crossing;
  readonly viewers: Readonly<Record<"source" | "destination" | "both" | "follower", Viewer>>;

  constructor(crossing: Crossing) {
    this.crossing = crossing;
    const { from, to } = crossing;
    const viewer = (camera: readonly ChunkCoord[], follows = false): Viewer => ({
      client: new ViewClient(),
      camera,
      follows,
      shown: [],
    });
    this.viewers = {
      source: viewer([from]),
      destination: viewer([to]),
      both: viewer([from, to]),
      follower: viewer([], true),
    };
  }

  /** Records the published world and connects the clients, before `server` starts. */
  readonly attach = (server: Server): void => {
    server.world.subscribeToPublished(this.history.apply);
    for (const { client, camera, follows, shown: commits } of Object.values(this.viewers)) {
      const id = server.presentation.connect(client);
      server.presentation.subscribe(id, camera);
      if (follows) server.presentation.follow(id, this.crossing.being);
      client.onCommit = () => commits.push(snapshot(client.state));
    }
  };
}

/** Each commit of each client of `watch` showed the world the gate published at its tick. */
function expectPublishedViews({ crossing, history, viewers }: CrossingWatch): void {
  for (const { client, camera, follows, shown: commits } of Object.values(viewers)) {
    expect(client.anomalies).toEqual([]);
    for (const commit of commits) {
      const record = history.record(commit.tick, crossing.being);
      const window = follows && record !== undefined ? windowKeys(record.cell) : [];
      const keys = [...window, ...camera.map(chunkKey)];
      expect(commit.chunks).toEqual(history.chunks(commit.tick, keys));
      expect(commit.clock).toEqual(history.clock(commit.tick));
      expect(commit.followed).toEqual(follows ? (record ?? null) : null);
      expect(commit.terrain).toBe(true);
    }
  }
}

/**
 * Whether the crossing's being is in the chunk it left and in the one it entered, as each client
 * of `watch` showed them in its last commit before the crossing's tick and in its first commit
 * from it on: true, false, or null when the view does not show the chunk.
 */
function placesAround({ crossing, viewers }: CrossingWatch) {
  const { being, from, to } = crossing;
  const places = (commit: Shown | undefined) =>
    [from, to].map((at) => commit?.chunks.get(chunkKey(at))?.beings.has(being) ?? null);
  return Object.fromEntries(
    Object.entries(viewers).map(([name, { shown: commits }]) => {
      const after = commits.findIndex(({ tick }) => tick >= crossing.tick);
      return [name, [places(commits[after - 1]), places(commits[after])]];
    }),
  );
}

describe("observer invariance", () => {
  let reference: Timeline;
  /** The run of 32 observers, which also holds the clients that watch the subject's first crossing. */
  let crowd: Awaited<ReturnType<typeof runWorld>>;
  let watched: CrossingWatch;
  beforeAll(async () => {
    reference = (await runWorld({ observers: 0, ticks: TICKS })).timeline;
    watched = new CrossingWatch(firstCrossing(reference.published));
    crowd = await runWorld({ observers: 32, ticks: TICKS, watch: watched.attach });
  });

  test("the reference run executed every tick and published the subject world", () => {
    expect(reference.ticks).toBe(TICKS);
    expect(JSON.parse(reference.commands.get(30) ?? "[]")).toMatchObject([{ type: "mind.inject" }]);
    expect(JSON.parse(reference.published.get(0) ?? "{}").chunks.length).toBeGreaterThan(0);
    expect(reference.published.size).toBe(TICKS + 1);
    expect(reference.times.get(TICKS)).toBe((TICKS - 1) * P);
  });

  test.each([1, 32])(
    "%p observers leave every tick and the final snapshot as they were",
    async (count) => {
      const run = count === 32 ? crowd : await runWorld({ observers: count, ticks: TICKS });
      const { timeline, activity } = run;
      expect(divergence(reference, timeline)).toBeUndefined();
      // The observers watched: they connected, followed, lagged, left, and received messages.
      expect(activity.connects).toBeGreaterThan(count);
      expect(activity.closes).toBeGreaterThanOrEqual(count);
      expect(activity.follows).toBeGreaterThan(count);
      expect(activity.lagged).toBeGreaterThan(0);
      expect(activity.watched).toBeGreaterThan(0);
      expect(activity.received).toBeGreaterThan(TICKS / 4);
    },
  );

  test.each([
    ["NC1, an admin command once a being is followed", NC1, "commands"],
    ["NC3, an extra tick per subscribe", NC3, "times"],
  ] as const)("%s fails the comparison at the exact tick it leaks", async (_name, leak, what) => {
    const { timeline, probe } = await runWorld({
      observers: 4,
      ticks: LEAK_TICKS,
      leak,
      firstJoin: LATE_JOIN,
    });
    const [first] = probe.leaks;
    expect(first).toBeGreaterThan(LATE_JOIN);
    expect(divergence(reference, timeline)).toEqual({ tick: first ?? -1, what });
  });

  test("NC2, a brain that reads the observed flag, fails the comparison at a tick it leaks", async () => {
    const { timeline, probe } = await runWorld({
      observers: 4,
      ticks: LEAK_TICKS,
      leak: NC2,
      firstJoin: LATE_JOIN,
    });
    const found = divergence(reference, timeline);
    // The engine may discard a decision in the tick it makes it: a being whose step loses the
    // contest for room at that tick fails it, whatever it decided. The comparison then fails at the
    // next tick at which the brain's changed decision applied: never before the leak, and always at
    // a tick at which the brain changed its decision.
    expect(probe.leaks[0]).toBeGreaterThan(LATE_JOIN);
    expect(found?.what).toBe("checksums");
    expect(probe.leaks).toContain(found?.tick ?? -1);
  });

  test("a being that crosses chunks leaves and enters the views of clients of one chunk, the other, both, and its follower (plan test 9)", () => {
    const { crossing, viewers } = watched;
    const { being, from, to } = crossing;
    expectPublishedViews(watched);
    // The crossing fell between two commits of each client: the being was in the chunk it left,
    // and is in the one it entered.
    expect(placesAround(watched)).toEqual({
      source: [
        [true, null],
        [false, null],
      ],
      destination: [
        [null, false],
        [null, true],
      ],
      both: [
        [true, false],
        [false, true],
      ],
      follower: [
        [true, false],
        [false, true],
      ],
    });
    // The client of both chunks got the crossing in one transaction: gone from one, upserted in
    // the other.
    const commits = viewers.both.shown;
    const tick = commits[commits.findIndex((commit) => commit.tick >= crossing.tick)]?.tick;
    const delta = viewers.both.client.messages.find(
      (message) => message.type === "delta" && message.tick === tick,
    );
    const entries = delta?.type === "delta" ? delta.chunks : [];
    const entry = (at: ChunkCoord) => entries.find((chunk) => chunkKey(chunk.at) === chunkKey(at));
    expect(entry(from)?.gone).toContain(being);
    expect(entry(to)?.upsert.map(({ id }) => id)).toContain(being);
  });
});
