/**
 * The admin contracts (ADR 0026, ADR 0009): what the private admin plane of T8 serves and accepts.
 * Every field here is C3 and never reaches a public client: the public entry never imports this
 * module (tests/repo/protocol-boundary.test.ts). Admin imports public, never the reverse.
 */
import { z } from "zod";
import { DURABILITIES, Identifier, PlainText, Tick, WORLD_STATES } from "../public/index.ts";

/** A count from 0. */
const Count = z.int().min(0);

/** A duration in whole microseconds. */
const Micros = z.int().min(0);

/** The 50th, 95th, and 99th percentiles of a duration, in microseconds, in rising order. */
export const Percentiles = z
  .strictObject({ p50: Micros, p95: Micros, p99: Micros })
  .refine(({ p50, p95, p99 }) => p50 <= p95 && p95 <= p99, {
    message: "percentiles rise: p50 ≤ p95 ≤ p99",
  });

/**
 * The server's status (C3, ADR 0025, ADR 0026): the executed, committed, and published ticks, with
 * E ≥ C ≥ P; the configured rate and the simulated seconds per tick, which no public message
 * carries; durability and state; the scheduler's lateness and the durations of a step, a
 * projection, and a fan-out, as percentiles in microseconds; the ticks lost to lateness, the
 * rebases of the schedule, and the open public connections. Then what the presentation plane
 * reports of its clients now: those the last fan-out found with a full buffer, the bytes of
 * replaced chunk versions still pinned, and the chunks of terrain clients wait for; and its counts
 * since start: clients the memory guard aborted, transactions the view limit trimmed, strikes,
 * clients closed for strikes (1008) and for slowness (1013), and clients dropped on a fault. Last,
 * the items of speech the projection left out because their text was not plain text.
 */
export const ServerStatus = z
  .strictObject({
    executedTick: Tick,
    committedTick: Tick,
    publishedTick: Tick,
    tickRateHz: z.int().min(1).max(1000),
    simSecondsPerTick: z.int().min(1),
    durability: z.enum(DURABILITIES),
    state: z.enum(WORLD_STATES),
    latenessMicros: Percentiles,
    stepMicros: Percentiles,
    projectionMicros: Percentiles,
    fanOutMicros: Percentiles,
    shortfallTicks: Count,
    rebases: Count,
    connections: Count,
    laggingClients: Count,
    retainedBytes: Count,
    terrainQueue: Count,
    aborts: Count,
    trims: Count,
    strikes: Count,
    strikeCloses: Count,
    slowCloses: Count,
    faults: Count,
    omittedSpeech: Count,
  })
  .refine(
    ({ executedTick, committedTick, publishedTick }) =>
      executedTick >= committedTick && committedTick >= publishedTick,
    { message: "the counters keep E ≥ C ≥ P" },
  );
export type ServerStatus = z.output<typeof ServerStatus>;

/** An operator's command: pause the world, with a reason every client sees, or resume it. */
export const OperatorCommand = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("pause"), reason: PlainText }),
  z.strictObject({ type: z.literal("resume") }),
]);
export type OperatorCommand = z.output<typeof OperatorCommand>;

/**
 * An entry of the append-only audit log: its sequence number, the wall-clock time it was recorded
 * at (milliseconds since the Unix epoch), the operator, the command, the published tick it met,
 * and whether it was applied or rejected.
 */
export const AuditEntry = z.strictObject({
  seq: Count,
  atMs: z.int().min(0),
  actor: Identifier,
  command: OperatorCommand,
  tick: Tick,
  outcome: z.enum(["applied", "rejected"]),
});
export type AuditEntry = z.output<typeof AuditEntry>;
