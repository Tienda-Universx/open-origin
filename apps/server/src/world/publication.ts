/**
 * The publication gate (ADR 0025, "Executed, committed, published"): ticks reach the presentation
 * plane only after the journal committed them. It holds three monotonic counters, `E ≥ C ≥ P`:
 *
 * - `E`, executed: the last tick the host handed it;
 * - `C`, committed: the last tick the journal acknowledged;
 * - `P`, published: the last tick it delivered to the listeners.
 *
 * It appends batches of F ticks, one append in flight at a time and in increasing tick order (an
 * OrderedJournal asserts both), and closes a batch early at a tick that carries a checkpoint, so
 * the snapshot of tick K travels with the batch that ends at K (ADR 0007). A flush appends what is
 * left as partial batches, for shutdown and before a halt. On each acknowledgement it publishes
 * exactly `(P, C]`, in order. When the journal fails it halts: it appends and publishes nothing
 * more, so nothing uncommitted is ever published. At boot `P = C = E = L`, the world's tick.
 */
import type { Tick } from "@open-origin/engine";
import { type JournalBatch, OrderedJournal, type TickJournal, type TickRecord } from "./journal.ts";
import type { PublishedListener, PublishedTick } from "./published.ts";

/** What the host hands the gate for one executed tick. */
export type Executed = {
  readonly record: TickRecord;
  /** What the listeners receive once the tick is committed. */
  readonly published: PublishedTick;
  /** The snapshot of the tick, encoded, when it is a checkpoint tick. */
  readonly checkpoint?: string;
};

export type GateOptions = {
  readonly journal: TickJournal;
  /** F: the ticks of a full batch. */
  readonly batchTicks: number;
  /** L: the world's tick at boot. */
  readonly boot: Tick;
  /**
   * Called after each acknowledgement and after a failure, so the scheduler can ask again. A throw
   * is counted as a change fault: it reaches neither `accept` nor the append's promise.
   */
  readonly onChange?: () => void;
};

/** Whether `value` is a promise or another thenable, whose rejection would go unhandled. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  const holder = typeof value === "object" || typeof value === "function";
  return holder && value !== null && "then" in value;
}

/** The ticks between execution and publication: the executed ticks the journal has not committed. */
export class PublicationGate {
  readonly #journal: TickJournal;
  readonly #batchTicks: number;
  readonly #onChange: () => void;
  #executed: Tick;
  #committed: Tick;
  #published: Tick;
  /** Executed ticks not yet appended, oldest first. */
  readonly #queue: Executed[] = [];
  /** The ticks of the append in flight. */
  #inFlight: readonly Executed[] | undefined;
  /** Whether partial batches are appended: from a flush until the queue is empty. */
  #draining = false;
  #failed = false;
  #flushes: (() => void)[] = [];
  readonly #listeners = new Set<PublishedListener>();
  #listenerFaults = 0;
  #changeFaults = 0;

  constructor({ journal, batchTicks, boot, onChange = () => undefined }: GateOptions) {
    if (!Number.isSafeInteger(batchTicks) || batchTicks < 1) {
      throw new RangeError(`a batch holds at least one tick, not ${batchTicks}`);
    }
    this.#journal = new OrderedJournal(journal, boot);
    this.#batchTicks = batchTicks;
    this.#onChange = onChange;
    this.#executed = boot;
    this.#committed = boot;
    this.#published = boot;
  }

  get executed(): Tick {
    return this.#executed;
  }

  get committed(): Tick {
    return this.#committed;
  }

  get published(): Tick {
    return this.#published;
  }

  /** Whether the journal failed: the world halts, and the gate publishes nothing more. */
  get failed(): boolean {
    return this.#failed;
  }

  /** W = 4F: how far the journal may lag behind execution before the scheduler holds. */
  get window(): number {
    return 4 * this.#batchTicks;
  }

  /** How many listener calls threw or returned a promise that rejected. */
  get listenerFaults(): number {
    return this.#listenerFaults;
  }

  /** How many calls of `onChange` threw. */
  get changeFaults(): number {
    return this.#changeFaults;
  }

  /** E − C: the executed ticks the journal has not committed. */
  lag(): number {
    return this.#executed - this.#committed;
  }

  /** Whether E − C exceeds the window: the scheduler holds until the journal catches up. */
  stalled(): boolean {
    return this.lag() > this.window;
  }

  /** Takes the next executed tick. Throws when it does not follow E, or after a journal failure. */
  accept(entry: Executed): void {
    if (this.#failed) throw new Error("the journal failed: the gate takes no more ticks");
    const { tick } = entry.record;
    if (tick !== this.#executed + 1) {
      throw new Error(`tick ${tick} does not follow tick ${this.#executed}, the last executed`);
    }
    this.#executed = tick;
    this.#queue.push(entry);
    this.#pump();
  }

  /**
   * Appends every executed tick, partial batches included, and resolves once all are committed
   * and published, or once the journal failed. It never rejects.
   */
  flush(): Promise<void> {
    const done = new Promise<void>((resolve) => this.#flushes.push(resolve));
    this.#draining = true;
    this.#pump();
    return done;
  }

  /** Adds a listener of published ticks; returns the function that removes it. */
  subscribe(listener: PublishedListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Appends the next batch when none is in flight, or settles the flushes when nothing is left. */
  #pump(): void {
    if (this.#failed) {
      this.#settleFlushes();
      return;
    }
    if (this.#inFlight !== undefined) return;
    const entries = this.#nextBatch();
    if (entries === undefined) {
      if (this.#queue.length === 0) this.#settleFlushes();
      return;
    }
    this.#append(entries);
  }

  /** The next batch: F ticks, fewer when a checkpoint closes it, or what is left while draining. */
  #nextBatch(): Executed[] | undefined {
    const checkpoint = this.#queue
      .slice(0, this.#batchTicks)
      .findIndex((entry) => entry.checkpoint !== undefined);
    const size = checkpoint === -1 ? this.#batchTicks : checkpoint + 1;
    if (this.#queue.length >= size) return this.#queue.splice(0, size);
    if (this.#draining && this.#queue.length > 0) return this.#queue.splice(0);
    return undefined;
  }

  #append(entries: readonly Executed[]): void {
    const first = entries[0];
    const last = entries.at(-1);
    if (first === undefined || last === undefined) return;
    const batch: JournalBatch = {
      fromTick: first.record.tick,
      toTick: last.record.tick,
      records: entries.map(({ record }) => record),
      ...(last.checkpoint === undefined ? {} : { checkpoint: last.checkpoint }),
    };
    this.#inFlight = entries;
    let acknowledged: Promise<void>;
    try {
      acknowledged = this.#journal.append(batch);
    } catch {
      this.#fail();
      return;
    }
    acknowledged.then(
      () => this.#commit(entries, last.record.tick),
      () => this.#fail(),
    );
  }

  /** The journal committed `entries`: C moves to `tick`, and (P, C] is published in order. */
  #commit(entries: readonly Executed[], tick: Tick): void {
    this.#inFlight = undefined;
    this.#committed = tick;
    for (const entry of entries) this.#publish(entry.record.tick, entry.published);
    this.#pump();
    this.#changed();
  }

  #publish(tick: Tick, published: PublishedTick): void {
    this.#published = tick;
    for (const listener of [...this.#listeners]) {
      try {
        const result = listener(published);
        if (isThenable(result)) Promise.resolve(result).catch(() => this.#countFault());
      } catch {
        this.#countFault();
      }
    }
  }

  #countFault(): void {
    this.#listenerFaults += 1;
  }

  /** The journal failed: nothing it did not commit is published, and nothing more is appended. */
  #fail(): void {
    this.#failed = true;
    this.#inFlight = undefined;
    this.#queue.length = 0;
    this.#settleFlushes();
    this.#changed();
  }

  /**
   * Calls `onChange`, counting a throw: from an append's promise handler it would be an unhandled
   * rejection, and from a journal that throws it would reach the caller of `accept`.
   */
  #changed(): void {
    try {
      this.#onChange();
    } catch {
      this.#changeFaults += 1;
    }
  }

  #settleFlushes(): void {
    this.#draining = false;
    const flushes = this.#flushes;
    this.#flushes = [];
    for (const resolve of flushes) resolve();
  }
}
