import type { JournalBatch, TickJournal } from "../../src/world/journal.ts";

type Ack = { readonly resolve: () => void; readonly reject: (error: Error) => void };

/**
 * A journal whose acknowledgements a test gives by hand: it records every batch, and each append
 * waits until the test acknowledges or fails it, oldest first. It counts the appends in flight at
 * once, so a test can check that its caller never had two.
 */
export class ControlledJournal implements TickJournal {
  readonly level = "none";
  readonly batches: JournalBatch[] = [];
  #acks: Ack[] = [];
  /** The most appends that were ever in flight at once. */
  maxInFlight = 0;

  append(batch: JournalBatch): Promise<void> {
    this.batches.push(batch);
    const pending = new Promise<void>((resolve, reject) => this.#acks.push({ resolve, reject }));
    this.maxInFlight = Math.max(this.maxInFlight, this.#acks.length);
    return pending;
  }

  /** How many appends wait for their acknowledgement. */
  get pending(): number {
    return this.#acks.length;
  }

  /** Acknowledges the oldest append. */
  ack(): void {
    this.#next().resolve();
  }

  /** Fails the oldest append. */
  fail(): void {
    this.#next().reject(new Error("the journal failed"));
  }

  #next(): Ack {
    const ack = this.#acks.shift();
    if (ack === undefined) throw new Error("no append waits for an acknowledgement");
    return ack;
  }
}

/** A journal that acknowledges every batch at once and keeps them all. */
export class RecordingJournal implements TickJournal {
  readonly level = "none";
  readonly batches: JournalBatch[] = [];

  append(batch: JournalBatch): Promise<void> {
    this.batches.push(batch);
    return Promise.resolve();
  }
}

/** Resolves once every microtask queued before it, and those they queue, has run. */
export function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
