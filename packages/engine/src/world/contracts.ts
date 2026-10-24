/**
 * The contracts between the kernel, the ruleset, and the host (plan §4, ADR 0020). Types only:
 * step/context.ts implements the tick context, and step/step.ts the step.
 */
import type { CanonicalValue } from "../canonical/value.ts";
import type { Digest } from "../digest/digest.ts";
import type { Issue } from "../errors.ts";
import type { Seed } from "../rng/mix32.ts";
import type { Tick } from "../time/tick.ts";
import type { ChunkKey } from "./chunk.ts";

/** An entity's id: a safe integer the kernel hands out from `nextEntityId`, starting at 1. */
export type EntityId = number;

/** Who sent a command: the admin plane, or an inhabitant acting as itself. */
export type CommandOrigin =
  | { readonly kind: "admin" }
  | { readonly kind: "inhabitant"; readonly actor: EntityId };

/** An intention submitted to the engine, applied at `applyTick` in `seq` order (ADR 0003). */
export type Command = {
  readonly applyTick: Tick;
  readonly seq: number;
  readonly type: string;
  readonly origin: CommandOrigin;
  readonly payload: CanonicalValue;
};

/** What caused an event: the command with that `seq`, or the system with that name. */
export type EventCause =
  | { readonly kind: "command"; readonly seq: number }
  | { readonly kind: "system"; readonly name: string };

/** Something that happened during a tick, in emission order (`seq`). */
export type EngineEvent = {
  readonly tick: Tick;
  readonly seq: number;
  readonly type: string;
  readonly payload: CanonicalValue;
  readonly cause: EventCause;
};

/**
 * Why a handler's `check` refused a command: a reason the ruleset defines and canonical details,
 * so that a rejection can become the actor's experience (ADR 0004).
 */
export type Rejection = { readonly reason: string; readonly details?: CanonicalValue };

/** A command that `check` refused during this tick, with its rejection. */
export type Rejected = { readonly command: Command; readonly rejection: Rejection };

/**
 * `T` with every array and record read-only, at every depth. A compiler aid for ruleset authors
 * only (plan §2.2): inside the tick, values are live and isolation is checked, not prevented.
 */
export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Element)[]
    ? readonly DeepReadonly<Element>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

/**
 * Reads of a world. The host's view, from readView, returns detached copies; the tick's view,
 * which `check` receives, returns live values.
 */
export interface ReadView<G extends CanonicalValue, C extends CanonicalValue> {
  readonly tick: Tick;
  /** Every chunk key, sorted by UTF-16 code units, in a fresh array. */
  chunkKeys(): ChunkKey[];
  /** The chunk `key`, or undefined when there is none. */
  readChunk(key: ChunkKey): DeepReadonly<C> | undefined;
  readGlobal(): DeepReadonly<G>;
}

/** Draws for one stream that the system or handler declared (ADR 0020, randomness). */
export interface TickRandom {
  u32(stream: string, entity: EntityId): number;
  /** An integer in [0, bound), for an integer `bound` in [1, 2^32]. */
  int(stream: string, entity: EntityId, bound: number): number;
  /** 0 to count - 1 in random order, keyed by the resource contended for (plan §I.1.3). */
  permutation(stream: string, resourceId: number, count: number): number[];
}

/**
 * What a system or a handler may do during a tick; revoked when `step` returns, after which every
 * method throws EngineError("context_expired"). Reads return live values, so that writing through
 * one, or keeping one past the tick, is a write that bypasses the barrier: detected by audit and
 * by snapshot encoding, not prevented (ADR 0020, ownership). Misusing a method is a fault.
 */
export interface TickContext<G extends CanonicalValue, C extends CanonicalValue>
  extends ReadView<G, C> {
  /** The live chunk `key`, marked dirty. */
  writeChunk(key: ChunkKey): C;
  /** The live global value, marked dirty. */
  writeGlobal(): G;
  createChunk(key: ChunkKey, initial: C): void;
  newEntityId(): EntityId;
  readonly random: TickRandom;
  /** The commands rejected so far this tick. */
  rejectedCommands(): readonly Rejected[];
  emit(type: string, payload: CanonicalValue): void;
}

/** A system: it runs once per tick, in the ruleset's order, and must return undefined. */
export interface RulesetSystem<G extends CanonicalValue, C extends CanonicalValue> {
  readonly name: string;
  /** The streams it draws from; each belongs to this system alone. */
  readonly streams: readonly string[];
  run(ctx: TickContext<G, C>): undefined;
}

/** The handler of one command type: `check` may reject a command, and `apply` carries it out. */
export interface CommandHandler<G extends CanonicalValue, C extends CanonicalValue> {
  /** The streams `apply` draws from; each belongs to this handler alone. */
  readonly streams?: readonly string[];
  check(view: ReadView<G, C>, command: Command): Rejection | undefined;
  apply(ctx: TickContext<G, C>, command: Command): undefined;
}

/** The versions a snapshot header records for replay (ADR 0020, snapshots). */
export type RulesetVersions = {
  readonly ruleset: string;
  readonly generator: string;
  readonly brain: string;
};

/**
 * The content the host gives the kernel (ADR 0020, kernel and ruleset): systems, command
 * handlers, and validators for the global and chunk data, which report every problem they find.
 */
export interface Ruleset<G extends CanonicalValue, C extends CanonicalValue> {
  readonly versions: RulesetVersions;
  readonly systems: readonly RulesetSystem<G, C>[];
  readonly commands: { readonly [type: string]: CommandHandler<G, C> };
  validateGlobal(value: DeepReadonly<G>): readonly Issue[];
  validateChunk(key: ChunkKey, value: DeepReadonly<C>): readonly Issue[];
}

/** The definition of a new world. createWorld validates and copies all of it. */
export type WorldInit<G extends CanonicalValue, C extends CanonicalValue> = {
  readonly seed: Seed;
  readonly simSecondsPerTick: number;
  readonly global: G;
  readonly chunks: { readonly [key: ChunkKey]: C };
  readonly ruleset: Ruleset<G, C>;
};

export type WorldOptions = {
  /** Recompute every digest after each tick to detect writes that bypass the barrier (tests). */
  readonly audit?: boolean;
};

/** What one tick did, counted (ADR 0020, cost). */
export type StepStats = {
  /** The commands given to step. */
  readonly commands: number;
  /** The commands rejected: those of an unknown type and those `check` refused. */
  readonly rejected: number;
  readonly events: number;
  /** The chunks that existed before the tick and were written through writeChunk. */
  readonly dirtyChunks: number;
  readonly createdChunks: number;
  /**
   * The UTF-8 bytes of canonical text the commit hashed: the changed chunks, the global value when
   * it changed, and digests of a fixed size. Audit's full recomputation is not counted.
   */
  readonly hashedBytes: number;
};

/** What step returns to the host: fresh values that the world keeps no reference to. */
export type StepResult = {
  /** The tick the step computed. */
  readonly tick: Tick;
  /** digest(["tick", stateRoot, digest(["events", events])]): the state and what the tick emitted. */
  readonly checksum: Digest;
  readonly events: readonly EngineEvent[];
  /** The chunks written or created during the tick, sorted by UTF-16 code units. */
  readonly changedChunks: readonly ChunkKey[];
  readonly stats: StepStats;
};
