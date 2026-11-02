/**
 * The world host (ADR 0025): it owns the world a source gives it and steps it, one tick per call.
 * The engine is the reality: the host only stamps the source's commands with their tick and order,
 * steps, and hands what the tick did and its C0 projection to the publication gate, so nothing
 * here can change a step's result. Every K-th tick it encodes the snapshot for the journal's
 * checkpoint. When the source, a step, the snapshot, or the projection throws, the host first has
 * the gate append the valid ticks it has not appended yet, never the faulted one, then halts. It
 * keeps an engine error's code alone, since its issues may name C3 data, and anything else as
 * `unexpected_error` with what it threw.
 */
import {
  type Command,
  EngineError,
  type EngineErrorCode,
  encodeSnapshot,
  readView,
  type StepResult,
  step,
  type Tick,
  type World,
} from "@open-origin/engine";
import { causeOf, type FaultCause } from "./fault.ts";
import type { PublicationGate } from "./publication.ts";
import type { PublishedTick } from "./published.ts";
import type { CommandIntent, WorldSource } from "./source.ts";

/** Why the world halted: an engine error's code, an error that is not one, or another fault. */
export type HaltCode =
  | EngineErrorCode
  | "unexpected_error"
  | "journal_failed"
  | "unhandled_rejection";

/**
 * A halt: its code, the first tick the world did not execute, and, for a fault that is not an
 * engine error, what it threw.
 */
export type Halt = { readonly code: HaltCode; readonly tick: Tick; readonly cause?: FaultCause };

/** K: the ticks between two checkpoints (ADR 0007). */
const CHECKPOINT_TICKS = 300;

/**
 * The C0 projection of each executed tick (ADR 0026): what the gate publishes once the tick is
 * committed. The host asks it once per tick, right after the step, while nothing else steps the
 * world.
 */
export interface Projector {
  /** The deep-frozen C0 record of the tick `result` reports, read from the world after its step. */
  project(result: StepResult): PublishedTick;
}

export type HostOptions = {
  readonly source: WorldSource;
  /** The projection of the source's world, booted at its tick. */
  readonly projector: Projector;
  /** The gate, booted at the world's tick. */
  readonly gate: PublicationGate;
  /** K; CHECKPOINT_TICKS unless a test sets another. */
  readonly checkpointTicks?: number;
};

/** The commands of `tick`, stamped: `applyTick` is the tick, and `seq` counts from 0. */
function stamp(intents: readonly CommandIntent[], tick: Tick): Command[] {
  return intents.map(({ type, origin, payload }, seq) => ({
    applyTick: tick,
    seq,
    type,
    origin,
    payload,
  }));
}

/** Steps the world of one source and hands each tick to the publication gate. */
export class WorldHost {
  readonly #world: World;
  readonly #source: WorldSource;
  readonly #projector: Projector;
  readonly #gate: PublicationGate;
  readonly #checkpointTicks: number;
  /** The world's simulated seconds per tick, read at boot: it never changes. */
  readonly simSecondsPerTick: number;
  #executed: Tick;
  #halt: Halt | undefined;

  constructor({ source, projector, gate, checkpointTicks = CHECKPOINT_TICKS }: HostOptions) {
    if (!Number.isSafeInteger(checkpointTicks) || checkpointTicks < 1) {
      throw new RangeError(`checkpoints are at least one tick apart, not ${checkpointTicks}`);
    }
    const view = readView(source.world);
    if (gate.executed !== view.tick) {
      throw new Error(`the gate booted at tick ${gate.executed}, not at the world's ${view.tick}`);
    }
    this.#world = source.world;
    this.#source = source;
    this.#projector = projector;
    this.#gate = gate;
    this.#checkpointTicks = checkpointTicks;
    this.simSecondsPerTick = view.simSecondsPerTick;
    this.#executed = view.tick;
  }

  /** E: the last tick the host executed and handed to the gate. */
  get executedTick(): Tick {
    return this.#executed;
  }

  /** Why the world halted, or undefined while it runs. */
  get halted(): Halt | undefined {
    return this.#halt;
  }

  /** Runs the next tick. Throws when the world halted: the scheduler holds a halted world. */
  stepOnce(): void {
    if (this.#halt !== undefined) {
      throw new Error(`the world halted at tick ${this.#halt.tick} with ${this.#halt.code}`);
    }
    const tick = this.#executed + 1;
    let commands: Command[];
    let result: StepResult;
    let checkpoint: string | undefined;
    let published: PublishedTick;
    try {
      commands = stamp(this.#source.commandsAt(tick), tick);
      result = step(this.#world, commands);
      checkpoint = tick % this.#checkpointTicks === 0 ? encodeSnapshot(this.#world) : undefined;
      published = this.#projector.project(result);
    } catch (error) {
      if (EngineError.isEngineError(error)) this.halt(error.code);
      else this.halt("unexpected_error", causeOf(error));
      return;
    }
    this.#executed = tick;
    const record = { tick, checksum: result.checksum, commands, events: result.events };
    const executed = { record, published };
    this.#gate.accept(checkpoint === undefined ? executed : { ...executed, checkpoint });
  }

  /**
   * Halts the world with `code` and, for a fault that is not an engine error, its `cause`: the gate
   * first appends the ticks it holds, then nothing more runs. A second halt keeps the first one's
   * reason, even one the flush causes: a journal that fails at once halts the host again from
   * within it, so the reason is recorded before the flush.
   */
  halt(code: HaltCode, cause?: FaultCause): void {
    if (this.#halt !== undefined) return;
    const tick = this.#executed + 1;
    this.#halt = cause === undefined ? { code, tick } : { code, tick, cause };
    void this.#gate.flush();
  }
}
