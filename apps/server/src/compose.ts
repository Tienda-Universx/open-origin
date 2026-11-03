/**
 * The composition root (ADR 0025): `compose` wires the world plane, the source, the C0 projection
 * of its world, the host, the publication gate, the journal, and the scheduler, and hands the rest
 * of the server only what the presentation plane may hold: a subscription to frozen published
 * ticks, the public terrain of a chunk, and the world's state. `composeServer` wires the
 * presentation plane to those three functions, and joins both planes' telemetry in the server's
 * status. The entry point (T6-7) passes the real clock and timer; tests pass fake ones, and may
 * replace the journal, the source, its projection, the scheduler, and K. The planes receive their
 * settings as parameters: only this module and the entry point read the configuration.
 */
import { readView, type World } from "@open-origin/engine";
import type { ServerStatus } from "@open-origin/protocol/admin";
import type { ChunkCoord, TerrainPublic } from "@open-origin/protocol/public";
import type { Config } from "./config/config.ts";
import { Presentation } from "./presentation/presentation.ts";
import { BeingsProjection, type WorldProjection } from "./projection/projection.ts";
import { type Halt, type Projector, WorldHost } from "./world/host.ts";
import { EphemeralJournal, type TickJournal } from "./world/journal.ts";
import { PublicationGate } from "./world/publication.ts";
import type { PublishedListener } from "./world/published.ts";
import { rejectionPolicy } from "./world/rejection.ts";
import { SampleWindow, TICK_SAMPLES } from "./world/samples.ts";
import {
  FixedRateScheduler,
  type Hold,
  type SchedulerOptions,
  type SchedulerState,
  type TickScheduler,
} from "./world/scheduler.ts";
import { ScenarioSource, type WorldSource } from "./world/source.ts";
import type { Clock, Timer } from "./world/time.ts";

/**
 * A projection of the source's world, and, when it keeps one, the count of items of speech it left
 * out because their text was not plain text (C3), which BeingsProjection keeps.
 */
export type CountingProjection = WorldProjection & { readonly omittedSpeech?: number };

/** What the world plane needs from outside: real time, and replacements for tests. */
export type WorldPlaneDeps = {
  readonly clock: Clock;
  readonly timer: Timer;
  /** The ephemeral journal unless given. */
  readonly journal?: TickJournal;
  /** The default world of T5 unless given. */
  readonly source?: WorldSource;
  /** The projection of the source's world: the C0 projection of a world of beings unless given. */
  readonly projectionOf?: (world: World) => CountingProjection;
  /** K, the ticks between checkpoints: 300 unless given. */
  readonly checkpointTicks?: number;
  /** The scheduler of the world's ticks: a FixedRateScheduler over `options` unless given. */
  readonly schedulerOf?: (options: SchedulerOptions) => TickScheduler;
};

/** The world plane, as the rest of the server sees it. */
export type WorldPlane = {
  /** Starts the world's clock, or resumes it after `stop`. */
  start(): void;
  /** Stops the clock and resolves once every executed tick is committed and published (RPO 0). */
  stop(): Promise<void>;
  /**
   * Adds a listener of published ticks and returns the function that removes it. The listener
   * receives the boot record first, the full projection of the world's tick at boot, then every
   * published tick in order. It must subscribe before the first publication, or this throws.
   */
  subscribeToPublished(listener: PublishedListener): () => void;
  /** The public terrain of `chunk`, from the world's genesis; it never materializes a chunk. */
  readTerrain(chunk: ChunkCoord): TerrainPublic;
  /**
   * The world's state now, the same for every client: halted once it halted, else the scheduler's.
   */
  state(): ServerStatus["state"];
  /**
   * The server's status (C3), shaped for the admin contract. This plane has no clients: the
   * presentation's members are zero, and `composeServer`'s status fills them.
   */
  status(): ServerStatus;
  /** What the process's `unhandledRejection` handler calls: the world halts under AI_MODE=off. */
  unhandledRejection(): void;
  /**
   * Why the world halted, for the entry point's log (C3), or undefined while it runs: the code, the
   * first tick it did not execute, and, for a fault that is not an engine error, what it threw.
   */
  halted(): Halt | undefined;
};

/** Durations the world plane does not measure: the fan-out is the presentation's. */
const UNMEASURED = Object.freeze({ p50: 0, p95: 0, p99: 0 });

/** The presentation's members of the status, for a world plane that has no clients. */
const NO_CLIENTS = Object.freeze({
  fanOutMicros: UNMEASURED,
  connections: 0,
  laggingClients: 0,
  retainedBytes: 0,
  terrainQueue: 0,
  aborts: 0,
  trims: 0,
  strikes: 0,
  strikeCloses: 0,
  slowCloses: 0,
  faults: 0,
});

/** The public state of a scheduler's state. */
const STATES: Readonly<Record<SchedulerState, ServerStatus["state"]>> = Object.freeze({
  running: "running",
  paused: "paused",
  journalStall: "stalled",
  halted: "halted",
});

/** The parts of the world plane, wired, and the hold the scheduler asks before each tick. */
type Parts = {
  readonly gate: PublicationGate;
  readonly host: WorldHost;
  readonly scheduler: TickScheduler;
  readonly hold: () => Hold | undefined;
  readonly projection: CountingProjection;
  /** How long the projection of each of the last ticks took, in microseconds (C3). */
  readonly projections: SampleWindow;
};

/** The C0 projection of a world of beings. */
const beingsProjection = (world: World): WorldProjection => new BeingsProjection(world);

/** The scheduler of the public universe: one tick per period, at a fixed rate. */
const fixedRate = (options: SchedulerOptions): TickScheduler => new FixedRateScheduler(options);

/** `projection`, whose every call is timed on `clock` into `samples`. */
function timed(projection: Projector, clock: Clock, samples: SampleWindow): Projector {
  return {
    project: (result) => {
      const start = clock.now();
      try {
        return projection.project(result);
      } finally {
        samples.add(clock.now() - start);
      }
    },
  };
}

/** The source, projection, gate, host, and scheduler of `config`, wired to one another. */
function wire(config: Config, deps: WorldPlaneDeps): Parts {
  const source = deps.source ?? new ScenarioSource();
  const projection = (deps.projectionOf ?? beingsProjection)(source.world);
  const projections = new SampleWindow(TICK_SAMPLES);
  const projector = timed(projection, deps.clock, projections);
  const gate = new PublicationGate({
    journal: deps.journal ?? new EphemeralJournal(),
    batchTicks: config.publicationBatchTicks,
    boot: readView(source.world).tick,
    bootRecord: projection.boot(),
    onChange: () => afterJournal(),
  });
  const host = new WorldHost({ source, projector, gate, ...optionalK(deps.checkpointTicks) });
  const hold = (): Hold | undefined => {
    if (host.halted !== undefined || gate.failed) return "halted";
    return gate.stalled() ? "journalStall" : undefined;
  };
  const scheduler = (deps.schedulerOf ?? fixedRate)({
    clock: deps.clock,
    timer: deps.timer,
    tickRateHz: config.tickRateHz,
    runTick: () => host.stepOnce(),
    hold,
  });
  /** A journal acknowledgement or failure: a failure halts the world; either may end a stall. */
  function afterJournal(): void {
    if (gate.failed) host.halt("journal_failed", gate.failure);
    scheduler.wake();
  }
  return { gate, host, scheduler, hold, projection, projections };
}

/** The state of a world plane whose scheduler is in `state`: halted once its hold says so. */
function stateOf(hold: Parts["hold"], state: SchedulerState): ServerStatus["state"] {
  return hold() === "halted" ? "halted" : STATES[state];
}

/** The status of the wired world plane of `config`, with no clients. */
function statusOf(config: Config, parts: Parts): ServerStatus {
  const { gate, host, scheduler, hold, projection, projections } = parts;
  const metrics = scheduler.metrics();
  return {
    ...NO_CLIENTS,
    executedTick: gate.executed,
    committedTick: gate.committed,
    publishedTick: gate.published,
    tickRateHz: config.tickRateHz,
    simSecondsPerTick: host.simSecondsPerTick,
    durability: config.durability,
    state: stateOf(hold, metrics.state),
    latenessMicros: metrics.latenessMicros,
    stepMicros: metrics.stepMicros,
    projectionMicros: projections.percentiles(),
    shortfallTicks: metrics.shortfallTicks,
    rebases: metrics.rebases,
    omittedSpeech: projection.omittedSpeech ?? 0,
  };
}

/** Wires the world plane of `config`. Nothing runs until `start`. */
export function compose(config: Config, deps: WorldPlaneDeps): WorldPlane {
  const parts = wire(config, deps);
  const { gate, host, scheduler, projection } = parts;
  return Object.freeze({
    start: () => scheduler.start(),
    stop: () => {
      scheduler.pause();
      return gate.flush();
    },
    subscribeToPublished: (listener: PublishedListener) => gate.subscribe(listener),
    readTerrain: (chunk: ChunkCoord) => projection.readTerrain(chunk),
    state: () => stateOf(parts.hold, parts.scheduler.metrics().state),
    status: () => statusOf(config, parts),
    unhandledRejection: () => {
      host.halt(rejectionPolicy(config.aiMode).code);
      scheduler.wake();
    },
    halted: () => host.halted,
  });
}

/** The host's K option, present only when a test sets it. */
function optionalK(checkpointTicks: number | undefined): { checkpointTicks?: number } {
  return checkpointTicks === undefined ? {} : { checkpointTicks };
}

/** What the server needs from outside: the world plane's needs and, for tests, the world's id. */
export type ServerDeps = WorldPlaneDeps & {
  /** The random id hello announces, 32 lowercase hexadecimal digits: fresh at every boot unless given. */
  readonly worldId?: string;
};

/** The two planes, wired: the world plane, and the presentation plane it feeds. */
export type Server = {
  readonly world: WorldPlane;
  readonly presentation: Presentation;
  /** Starts the world's clock and the presentation's periods. */
  start(): void;
  /** Stops the presentation's periods and the world's clock; resolves once every tick is published. */
  stop(): Promise<void>;
  /** The server's status (C3): the world plane's, with the presentation's telemetry. */
  status(): ServerStatus;
};

/**
 * A world id from 16 random bytes: in ephemeral mode every boot creates a world, whose id is never
 * derived from the seed, a label, or the genesis (ADR 0026).
 */
function randomWorldId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Wires the world plane of `config` and the presentation plane, which receives from it only the
 * subscription to published ticks, `readTerrain`, and the world's state, and the same clock and
 * timer. Nothing runs until `start`.
 */
export function composeServer(config: Config, deps: ServerDeps): Server {
  const world = compose(config, deps);
  const fanOuts = new SampleWindow(TICK_SAMPLES);
  const presentation = new Presentation({
    subscribeToPublished: (listener) => world.subscribeToPublished(listener),
    readTerrain: (chunk) => world.readTerrain(chunk),
    worldState: () => world.state(),
    clock: deps.clock,
    timer: deps.timer,
    tickRateHz: config.tickRateHz,
    batchTicks: config.publicationBatchTicks,
    world: { id: deps.worldId ?? randomWorldId(), durability: config.durability },
    retainedBytes: config.retainedBytes,
    recordFanOut: (micros) => fanOuts.add(micros),
  });
  return Object.freeze({
    world,
    presentation,
    status: () => ({
      ...world.status(),
      ...presentation.telemetry(),
      fanOutMicros: fanOuts.percentiles(),
    }),
    // The presentation starts first: one that cannot start leaves no world clock running.
    start: () => {
      presentation.start();
      world.start();
    },
    stop: () => {
      presentation.stop();
      return world.stop();
    },
  });
}
