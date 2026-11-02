/**
 * The world host (ADR 0025): it owns the world a source gives it and steps it, one tick per call.
 * The engine is the reality: the host only stamps the source's commands with their tick and order,
 * steps, and hands what the tick did to the publication gate, so nothing here can change a step's
 * result. Every K-th tick it encodes the snapshot for the journal's checkpoint. When a step
 * throws, the host first has the gate append the valid ticks it has not appended yet, never the
 * faulted one, then halts, keeping only the error's code: its issues may name C3 data.
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
import type { PublicationGate } from "./publication.ts";
import { publishedTick } from "./published.ts";
import type { CommandIntent, WorldSource } from "./source.ts";

/** Why the world halted: an engine error's code, an error that is not one, or another fault. */
export type HaltCode =
  | EngineErrorCode
  | "unexpected_error"
  | "journal_failed"
  | "unhandled_rejection";

/** A halt: its code, and the first tick the world did not execute. */
export type Halt = { readonly code: HaltCode; readonly tick: Tick };

/** K: the ticks between two checkpoints (ADR 0007). */
export const CHECKPOINT_TICKS = 300;

export type HostOptions = {
  readonly source: WorldSource;
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

/** The code of what a step threw. */
function codeOf(error: unknown): HaltCode {
  return EngineError.isEngineError(error) ? error.code : "unexpected_error";
}

/** Steps the world of one source and hands each tick to the publication gate. */
export class WorldHost {
  readonly #world: World;
  readonly #source: WorldSource;
  readonly #gate: PublicationGate;
  readonly #checkpointTicks: number;
  /** The world's simulated seconds per tick, read at boot: it never changes. */
  readonly simSecondsPerTick: number;
  #executed: Tick;
  #halt: Halt | undefined;

  constructor({ source, gate, checkpointTicks = CHECKPOINT_TICKS }: HostOptions) {
    if (!Number.isSafeInteger(checkpointTicks) || checkpointTicks < 1) {
      throw new RangeError(`checkpoints are at least one tick apart, not ${checkpointTicks}`);
    }
    const view = readView(source.world);
    if (gate.executed !== view.tick) {
      throw new Error(`the gate booted at tick ${gate.executed}, not at the world's ${view.tick}`);
    }
    this.#world = source.world;
    this.#source = source;
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
    const commands = stamp(this.#source.commandsAt(tick), tick);
    let result: StepResult;
    let checkpoint: string | undefined;
    try {
      result = step(this.#world, commands);
      checkpoint = tick % this.#checkpointTicks === 0 ? encodeSnapshot(this.#world) : undefined;
    } catch (error) {
      this.halt(codeOf(error));
      return;
    }
    this.#executed = tick;
    const record = { tick, checksum: result.checksum, commands, events: result.events };
    const executed = { record, published: publishedTick(tick) };
    this.#gate.accept(checkpoint === undefined ? executed : { ...executed, checkpoint });
  }

  /**
   * Halts the world with `code`: the gate first appends the ticks it holds, then nothing more
   * runs. A second halt keeps the first one's code.
   */
  halt(code: HaltCode): void {
    if (this.#halt !== undefined) return;
    void this.#gate.flush();
    this.#halt = { code, tick: this.#executed + 1 };
  }
}
