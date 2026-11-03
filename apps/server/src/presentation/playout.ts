/**
 * The playout (ADR 0025, "Playout"): the gate releases up to F ticks at a time, and the playout
 * hands the mirror at most one of them per period, so clients see one step per period with no
 * bursts. When more than F ticks wait, the mirror applies every one of them in order and the
 * period releases the newest: the rings of speech and feed still receive every tick.
 */
import type { PublishedTick } from "../world/published.ts";

/** The queue of published ticks between the gate and the mirror. */
export class Playout {
  readonly #batchTicks: number;
  readonly #queue: PublishedTick[] = [];

  /** A playout for batches of `batchTicks` ticks, F. */
  constructor(batchTicks: number) {
    if (!Number.isSafeInteger(batchTicks) || batchTicks < 1) {
      throw new RangeError(`a batch holds at least one tick, not ${batchTicks}`);
    }
    this.#batchTicks = batchTicks;
  }

  /** How many published ticks wait. */
  get waiting(): number {
    return this.#queue.length;
  }

  /** Queues a published tick; it reaches the mirror in a later period. */
  push(published: PublishedTick): void {
    this.#queue.push(published);
  }

  /**
   * One period's release: the oldest waiting tick, or, when more than F wait, all of them in
   * order. `apply` receives each; returns how many it received.
   */
  release(apply: (published: PublishedTick) => void): number {
    const count = this.#queue.length > this.#batchTicks ? this.#queue.length : 1;
    const released = this.#queue.splice(0, count);
    for (const published of released) apply(published);
    return released.length;
  }
}
