/**
 * The composition root of the world plane (ADR 0025): it wires the source, the C0 projection of
 * its world, the host, the publication gate, the journal, and the scheduler, and hands the rest of
 * the server only what the presentation plane may hold: a subscription to frozen published ticks.
 * The entry point (T6-7) passes the real clock and timer; tests
 * pass fake ones, and may replace the journal, the source, its projection, and K. The planes
 * receive their settings as parameters: only this module and the entry point read the
 * configuration.
 */
import { readView, type World } from "@open-origin/engine";
import type { ServerStatus } from "@open-origin/protocol/admin";
import type { Config } from "./config/config.ts";
import { BeingsProjection, type WorldProjection } from "./projection/projection.ts";
import { type Halt, type Projector, WorldHost } from "./world/host.ts";
import { EphemeralJournal, type TickJournal } from "./world/journal.ts";
import { PublicationGate } from "./world/publication.ts";
import type { PublishedListener } from "./world/published.ts";
import { rejectionPolicy } from "./world/rejection.ts";
import { SampleWindow, TICK_SAMPLES } from "./world/samples.ts";
import { FixedRateScheduler, type Hold, type SchedulerState } from "./world/scheduler.ts";
import { ScenarioSource, type WorldSource } from "./world/source.ts";
import type { Clock, Timer } from "./world/time.ts";

/** What the world plane needs from outside: real time, and replacements for tests. */
export type WorldPlaneDeps = {
  readonly clock: Clock;
  readonly timer: Timer;
  /** The ephemeral journal unless given. */
  readonly journal?: TickJournal;
  /** The default world of T5 unless given. */
  readonly source?: WorldSource;
  /** The projection of the source's world: the C0 projection of a world of beings unless given. */
  readonly projectionOf?: (world: World) => WorldProjection;
  /** K, the ticks between checkpoints: 300 unless given. */
  readonly checkpointTicks?: number;
};

/** The world plane, as the rest of the server sees it. */
export type WorldPlane = {
  /** Starts the world's clock, or resumes it after `stop`. */
  start(): void;
  /** Stops the clock and resolves once every executed tick is committed and published (RPO 0). */
  stop(): Promise<void>;
  /** Adds a listener of published ticks; returns the function that removes it. */
  subscribeToPublished(listener: PublishedListener): () => void;
  /** The server's status (C3), shaped for the admin contract; this plane has no connections. */
  status(): ServerStatus;
  /** What the process's `unhandledRejection` handler calls: the world halts under AI_MODE=off. */
  unhandledRejection(): void;
  /**
   * Why the world halted, for the entry point's log (C3), or undefined while it runs: the code, the
   * first tick it did not execute, and, for a fault that is not an engine error, what it threw.
   */
  halted(): Halt | undefined;
};

/** Durations the world plane does not measure: the fan-out arrives in T6-6a. */
const UNMEASURED = Object.freeze({ p50: 0, p95: 0, p99: 0 });

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
  readonly scheduler: FixedRateScheduler;
  readonly hold: () => Hold | undefined;
  /** How long the projection of each of the last ticks took, in microseconds (C3). */
  readonly projections: SampleWindow;
};

/** The C0 projection of a world of beings. */
const beingsProjection = (world: World): WorldProjection => new BeingsProjection(world);

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
    onChange: () => afterJournal(),
  });
  const host = new WorldHost({ source, projector, gate, ...optionalK(deps.checkpointTicks) });
  const hold = (): Hold | undefined => {
    if (host.halted !== undefined || gate.failed) return "halted";
    return gate.stalled() ? "journalStall" : undefined;
  };
  const scheduler = new FixedRateScheduler({
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
  return { gate, host, scheduler, hold, projections };
}

/** The status of the wired world plane of `config`. */
function statusOf(config: Config, parts: Parts): ServerStatus {
  const { gate, host, scheduler, hold, projections } = parts;
  const metrics = scheduler.metrics();
  return {
    executedTick: gate.executed,
    committedTick: gate.committed,
    publishedTick: gate.published,
    tickRateHz: config.tickRateHz,
    simSecondsPerTick: host.simSecondsPerTick,
    durability: config.durability,
    state: hold() === "halted" ? "halted" : STATES[metrics.state],
    latenessMicros: metrics.latenessMicros,
    stepMicros: metrics.stepMicros,
    projectionMicros: projections.percentiles(),
    fanOutMicros: UNMEASURED,
    shortfallTicks: metrics.shortfallTicks,
    rebases: metrics.rebases,
    connections: 0,
  };
}

/** Wires the world plane of `config`. Nothing runs until `start`. */
export function compose(config: Config, deps: WorldPlaneDeps): WorldPlane {
  const parts = wire(config, deps);
  const { gate, host, scheduler } = parts;
  return Object.freeze({
    start: () => scheduler.start(),
    stop: () => {
      scheduler.pause();
      return gate.flush();
    },
    subscribeToPublished: (listener: PublishedListener) => gate.subscribe(listener),
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
