/**
 * The journal port (ADR 0025, "Executed, committed, published"; ADR 0007): where the world plane
 * makes its ticks durable before it publishes them. T6 has only the ephemeral journal; T7 adds a
 * durable one behind the same port, so the loop does not change.
 */
import type { Command, Digest, EngineEvent, Tick } from "@open-origin/engine";

/** What one tick did: every command it was given, rejected ones included, and every event. */
export type TickRecord = {
  readonly tick: Tick;
  readonly checksum: Digest;
  readonly commands: readonly Command[];
  readonly events: readonly EngineEvent[];
};

/**
 * The records of ticks `fromTick` to `toTick`, in order, and, when the batch ends at a checkpoint
 * tick, the snapshot of that tick, encoded (ADR 0007: written with the batch that ends at it).
 */
export type JournalBatch = {
  readonly fromTick: Tick;
  readonly toTick: Tick;
  readonly records: readonly TickRecord[];
  readonly checkpoint?: string;
};

/** Whether an acknowledged batch survives a restart: `none` for the ephemeral journal. */
export type DurabilityLevel = "none" | "durable";

/**
 * A journal of tick batches. `append` resolves once the batch is committed and rejects when it
 * cannot be. Its caller keeps one append in flight at a time, in increasing tick order.
 */
export interface TickJournal {
  readonly level: DurabilityLevel;
  append(batch: JournalBatch): Promise<void>;
}

/**
 * The journal of ephemeral mode: it acknowledges every batch in a microtask and keeps nothing, the
 * checkpoint included. A restart starts a new world, so nothing it acknowledged can be lost.
 */
export class EphemeralJournal implements TickJournal {
  readonly level = "none";

  append(_batch: JournalBatch): Promise<void> {
    return Promise.resolve();
  }
}

/** Why `batch` breaks the journal's order after the batch that ended at `last`; undefined if not. */
function orderProblem(batch: JournalBatch, last: Tick): string | undefined {
  const { fromTick, toTick, records } = batch;
  if (fromTick !== last + 1) {
    return `the batch starts at tick ${fromTick}, not at ${last + 1}, the tick after the last batch`;
  }
  if (toTick < fromTick) return `the batch ends at tick ${toTick}, before it starts`;
  const contiguous = records.every((record, index) => record.tick === fromTick + index);
  if (records.length !== toTick - fromTick + 1 || !contiguous) {
    return `the records are not exactly the ticks ${fromTick} to ${toTick}, in order`;
  }
  return undefined;
}

/**
 * The order ADR 0025 holds the journal's caller to, asserted: one append in flight at a time, and
 * batches whose ticks follow on from `after`, the tick the world booted at. A violation throws
 * before the journal sees the batch; the publication gate takes it as a journal failure and halts.
 */
export class OrderedJournal implements TickJournal {
  readonly #journal: TickJournal;
  #last: Tick;
  #inFlight = false;

  constructor(journal: TickJournal, after: Tick) {
    this.#journal = journal;
    this.#last = after;
  }

  get level(): DurabilityLevel {
    return this.#journal.level;
  }

  append(batch: JournalBatch): Promise<void> {
    if (this.#inFlight) {
      throw new Error("journal order: an append is already in flight; one runs at a time");
    }
    const problem = orderProblem(batch, this.#last);
    if (problem !== undefined) throw new Error(`journal order: ${problem}`);
    this.#inFlight = true;
    this.#last = batch.toTick;
    const settled = () => {
      this.#inFlight = false;
    };
    try {
      return this.#journal.append(batch).finally(settled);
    } catch (error) {
      settled();
      throw error;
    }
  }
}
