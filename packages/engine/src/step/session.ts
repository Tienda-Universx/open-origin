/**
 * One tick in progress (ADR 0020, ownership and failures): what step, the tick context, and the
 * commit share while a tick runs. Only the engine's modules see it.
 *
 * Faults are recorded here, not only thrown, so that ruleset code that catches one cannot hide
 * it: the first fault of a tick is the one step reports, and every later use of the context
 * throws it again.
 */
import type { CanonicalValue } from "../canonical/value.ts";
import { EngineError, type EngineErrorCode } from "../errors.ts";
import type { Tick } from "../time/tick.ts";
import type { ChunkKey } from "../world/chunk.ts";
import type { EngineEvent, EventCause, Rejected } from "../world/contracts.ts";
import type { StreamIds } from "../world/ruleset.ts";
import { type ActiveStep, busyError, type WorldState } from "../world/world.ts";

/** The ruleset code that is running: a command's handler, or a system. */
export type Owner = {
  /**
   * Where it is, as a JSON Pointer: `/commands/<index>` into the commands given to step, or
   * `/systems/<index>` into the ruleset's systems.
   */
  readonly path: string;
  /** How messages name it, such as `system "growth"` or `command 7 ("move")`. */
  readonly label: string;
  /** The cause of the events it emits. */
  readonly cause: EventCause;
  /** The streams it declared, the only ones it may draw from. */
  readonly streams: StreamIds;
};

const EXPIRED = "the tick context was used after its step returned: keep no reference to it";
const OUTSIDE =
  "the tick context was used outside every system and command handler: only they may use it";

export class TickSession implements ActiveStep {
  readonly state: WorldState;
  /** The tick being computed. */
  readonly tick: Tick;
  /** The ruleset code that is running; undefined between them and during the commit. */
  owner: Owner | undefined = undefined;
  /** The chunks that existed before the tick and were written through writeChunk, by key. */
  readonly dirty: { [key: ChunkKey]: true } = Object.create(null);
  /** The keys of `dirty`, in the order they were first written. */
  readonly dirtyKeys: ChunkKey[] = [];
  globalDirty = false;
  /** The chunks created during the tick, by key: they join the world at the commit. */
  readonly created: { [key: ChunkKey]: CanonicalValue } = Object.create(null);
  /** The keys of `created`, in the order they were created. */
  readonly createdKeys: ChunkKey[] = [];
  readonly events: EngineEvent[] = [];
  readonly rejected: Rejected[] = [];
  #fault: EngineError | undefined;
  #expired = false;

  /** A tick of `state`, whose kernel is already at the tick being computed. */
  constructor(state: WorldState) {
    this.state = state;
    this.tick = state.kernel.tick;
  }

  /** The first fault of the tick, once there is one. */
  get fault(): EngineError | undefined {
    return this.#fault;
  }

  /**
   * The running owner. Throws what makes the context unusable: context_expired once its step
   * returned, the tick's fault once there is one, and a fault when no system or handler is
   * running, as when a validator uses a context it kept.
   */
  ensureLive(): Owner {
    if (this.#expired) throw new EngineError("context_expired", [{ path: "", message: EXPIRED }]);
    this.throwIfFaulted();
    if (this.owner === undefined) throw this.fail(OUTSIDE);
    return this.owner;
  }

  /**
   * Throws the tick's fault, once there is one. Ruleset code that runs outside invoke (the
   * validators at the commit, and the traps of a Proxy in the state) may catch the fault it
   * caused, so the step checks after it runs: a recorded fault always poisons the world.
   */
  throwIfFaulted(): void {
    if (this.#fault !== undefined) throw this.#fault;
  }

  /** Revokes the context: every later use throws context_expired. */
  expire(): void {
    this.#expired = true;
  }

  /** Records `fault` unless the tick already has one, and returns the tick's fault. */
  record(fault: EngineError): EngineError {
    this.#fault ??= fault;
    return this.#fault;
  }

  /**
   * Records a fault with `code` and one issue per message, at the running owner and prefixed with
   * its label, and returns the tick's fault.
   */
  failWith(code: EngineErrorCode, messages: readonly string[], cause?: unknown): EngineError {
    const { owner } = this;
    const issues = messages.map((message) =>
      owner === undefined
        ? { path: "", message }
        : { path: owner.path, message: `${owner.label}: ${message}` },
    );
    return this.record(new EngineError(code, issues, cause === undefined ? {} : { cause }));
  }

  /** failWith("system_fault", [message], cause). */
  fail(message: string, cause?: unknown): EngineError {
    return this.failWith("system_fault", [message], cause);
  }

  /**
   * The world_busy error for a call of `api` on this world by ruleset code during the tick, which
   * is also recorded as the tick's fault: the code may catch the error, but not hide the misuse.
   */
  refuse(api: string): EngineError {
    this.fail(
      `${api} was called during a tick of this world: ruleset code cannot use the world it runs in`,
    );
    return busyError(api);
  }

  /** Marks the committed chunk `key` as written, once. */
  markDirty(key: ChunkKey): void {
    if (this.dirty[key] === true) return;
    this.dirty[key] = true;
    this.dirtyKeys.push(key);
  }
}
