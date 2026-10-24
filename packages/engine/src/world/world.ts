/**
 * The world (ADR 0020, ownership; plan §2.2). A World keeps its whole state in one ES2022 private
 * field: the host can hold a world and pass it back, but no reflection reaches its state, and the
 * brand check rejects a forged object without running a Proxy trap. Only the engine's modules
 * reach the state, through worldState, which index.ts does not export. Everything the host reads
 * is a detached copy or a primitive.
 */
import { copyCanonical } from "../canonical/copy.ts";
import type { CanonicalValue } from "../canonical/value.ts";
import type { Digest } from "../digest/digest.ts";
import type { Lanes } from "../digest/lanes.ts";
import { EngineError, type EngineErrorCode, type Issue } from "../errors.ts";
import type { Seed } from "../rng/mix32.ts";
import type { Tick } from "../time/tick.ts";
import { parseChunkKey } from "./chunk.ts";
import type { ChunkIndex } from "./chunk-index.ts";
import type { DeepReadonly, EntityId, ReadView } from "./contracts.ts";
import type { CapturedRuleset } from "./ruleset.ts";

/** The versions that a snapshot header records, so that replay can require equal ones. */
type WorldHeader = {
  readonly engineVersion: string;
  readonly rulesetVersion: string;
  readonly generatorVersion: string;
  readonly brainVersion: string;
};

/** The kernel's own state, hashed as the kernel digest. `step` advances tick and nextEntityId. */
export type Kernel = {
  epoch: number;
  tick: Tick;
  nextEntityId: EntityId;
  readonly rng: { readonly algorithm: "ctr-mix32@1"; readonly seed: Seed };
  readonly config: { readonly simSecondsPerTick: number };
};

/** A chunk's value and its cached term of the chunk sum, digest(["chunk", key, value]). */
export type ChunkEntry<C extends CanonicalValue = CanonicalValue> = { value: C; term: Lanes };

/**
 * The digests a world keeps, so that a tick can update them for what it changed instead of
 * hashing the whole world (ADR 0020, cost). The chunk terms live in the chunk entries.
 */
export type DigestCache = { globalDigest: Digest; chunkSum: Lanes; stateRoot: Digest };

/**
 * A world whose tick failed (ADR 0020, failures): the tick that failed, which is the tick step
 * was computing (or, for tick_overflow, the last tick), and the error step threw.
 */
export type FaultedStatus = {
  readonly kind: "faulted";
  readonly tick: Tick;
  readonly code: EngineErrorCode;
  readonly issues: readonly Issue[];
};

/** What worldStatus reports: a healthy world and its tick, or a faulted one and its diagnosis. */
export type WorldStatus = { readonly kind: "ok"; readonly tick: Tick } | FaultedStatus;

/**
 * The tick that step is running on a world. A step called from inside it, by ruleset code that
 * holds the world, records a fault through it instead of changing the world a second time.
 */
export interface ActiveTick {
  /** Records a system_fault with `message` at the code that is running, and returns it. */
  fail(message: string): EngineError;
}

/**
 * Everything a world holds, with its global value a G and its chunks Cs, as the ruleset's
 * validators accepted them. Only the engine's modules see it.
 */
export type WorldState<
  G extends CanonicalValue = CanonicalValue,
  C extends CanonicalValue = CanonicalValue,
> = {
  readonly header: WorldHeader;
  readonly kernel: Kernel;
  global: G;
  readonly chunks: ChunkIndex<ChunkEntry<C>>;
  readonly ruleset: CapturedRuleset;
  readonly digests: DigestCache;
  /** Whether every tick recomputes every digest, to detect writes that bypass the barrier. */
  readonly audit: boolean;
  /** Faulted from the moment a tick fails, and for good (poison). */
  status: { readonly kind: "ok" } | FaultedStatus;
  /** The tick in progress, while step runs. */
  active: ActiveTick | undefined;
};

/** Lets the constructor tell createWorld from a host that reached it through `.constructor`. */
const MADE_BY_ENGINE: unique symbol = Symbol("World");

/** Reads the state of a branded world. Set once, by the static block of World, and never again. */
let stateOf: (world: World) => WorldState;

/** A world: a value the host holds and passes to the engine's functions. */
export class World<
  G extends CanonicalValue = CanonicalValue,
  C extends CanonicalValue = CanonicalValue,
> {
  readonly #state: WorldState<G, C>;

  /** Not for hosts: createWorld makes worlds. A call from anywhere else throws invalid_input. */
  constructor(key: symbol, state: WorldState<G, C>) {
    if (key !== MADE_BY_ENGINE) {
      throw new EngineError("invalid_input", [
        { path: "", message: "worlds are made by createWorld, not by the World constructor" },
      ]);
    }
    this.#state = state;
  }

  /** Whether `value` is a world the engine made. The private brand check runs no Proxy trap. */
  static isWorld(value: unknown): value is World {
    return typeof value === "object" && value !== null && #state in value;
  }

  static {
    stateOf = (world) => world.#state;
  }
}

/**
 * A new world holding `state`, which the caller owns alone and whose values the ruleset's
 * validators accepted as a G and as Cs.
 */
export function newWorld<G extends CanonicalValue, C extends CanonicalValue>(
  state: WorldState<G, C>,
): World<G, C> {
  return new World<G, C>(MADE_BY_ENGINE, state);
}

/**
 * The state of `value`. Throws EngineError("invalid_input") when `value` is not a world the
 * engine made.
 */
export function worldState(value: unknown): WorldState {
  if (!World.isWorld(value)) {
    throw new EngineError("invalid_input", [
      { path: "", message: "the value is not a world: worlds are made by createWorld" },
    ]);
  }
  return stateOf(value);
}

/**
 * The state of `value`, if its last tick did not fail. Throws EngineError("invalid_input") when
 * `value` is not a world, and EngineError("world_faulted") when it is poisoned: a world whose tick
 * failed can no longer be read, hashed, or stepped (ADR 0020, failures).
 */
export function healthyState(value: unknown): WorldState {
  const state = worldState(value);
  const { status } = state;
  if (status.kind === "ok") return state;
  const { tick, code } = status;
  const message = `the world faulted at tick ${tick} with ${code}: only worldStatus reads it; recover from the last snapshot`;
  throw new EngineError("world_faulted", [{ path: "", message }]);
}

/** Poisons `state` with `fault`, at the tick its kernel is at. */
export function poison(state: WorldState, fault: EngineError): void {
  state.status = {
    kind: "faulted",
    tick: state.kernel.tick,
    code: fault.code,
    issues: fault.issues,
  };
}

/**
 * What `world` is doing, in a fresh record: `{ kind: "ok", tick }`, or, once a tick failed,
 * `{ kind: "faulted", tick, code, issues }`. It is the one function a faulted world answers.
 */
export function worldStatus(world: World): WorldStatus {
  const { kernel, status } = worldState(world);
  if (status.kind === "ok") return { kind: "ok", tick: kernel.tick };
  const issues = status.issues.map(({ path, message }) => ({ path, message }));
  return { kind: "faulted", tick: status.tick, code: status.code, issues };
}

/**
 * Reads of `world` for the host. Each call reads the world as it is then and returns a detached
 * copy: changing what it returns never changes the world. readChunk throws
 * EngineError("invalid_value") for a key that is not a chunk key, and returns undefined for a key
 * that has no chunk. readView and every method of the view throw EngineError("world_faulted")
 * once the world is poisoned.
 */
export function readView<G extends CanonicalValue, C extends CanonicalValue>(
  world: World<G, C>,
): ReadView<G, C> {
  healthyState(world);
  // The ruleset's validators accepted these values as a G and as Cs when they entered the world.
  return {
    get tick() {
      return healthyState(world).kernel.tick;
    },
    chunkKeys: () => healthyState(world).chunks.sortedKeys(),
    readChunk(key) {
      const { chunks } = healthyState(world);
      parseChunkKey(key);
      const entry = chunks.get(key);
      return entry === undefined ? undefined : (copyCanonical(entry.value) as DeepReadonly<C>);
    },
    readGlobal: () => copyCanonical(healthyState(world).global) as DeepReadonly<G>,
  };
}
