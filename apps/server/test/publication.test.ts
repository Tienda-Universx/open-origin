/**
 * The publication gate (ADR 0025, "Executed, committed, published"; plan test 16: publication after
 * a durable commit keeps its order): the counters keep E ≥ C ≥ P; batches of F go to the journal
 * one at a time, cut at a checkpoint; only (P, C] is published, in order, never beyond C; a journal
 * failure halts with nothing uncommitted published; E − C > W stalls; a flush appends the partial
 * batch; and listeners cannot stop publication.
 */
import { describe, expect, test } from "bun:test";
import {
  EphemeralJournal,
  type JournalBatch,
  OrderedJournal,
  type TickRecord,
} from "../src/world/journal.ts";
import { type Executed, PublicationGate } from "../src/world/publication.ts";
import { type PublishedTick, publishedTick } from "../src/world/published.ts";
import { ControlledJournal, settle } from "./support/journals.ts";

/** The record of `tick`, with a checksum that names it. */
function recordOf(tick: number): TickRecord {
  return { tick, checksum: `checksum-${tick}`, commands: [], events: [] };
}

/** What the host hands the gate for `tick`, with a checkpoint when `checkpoint` is given. */
function executed(tick: number, checkpoint?: string): Executed {
  const entry = { record: recordOf(tick), published: publishedTick(tick) };
  return checkpoint === undefined ? entry : { ...entry, checkpoint };
}

/** A gate over a controlled journal, from `boot`, with a listener that checks P ≤ C. */
function harness(batchTicks = 5, boot = 0) {
  const journal = new ControlledJournal();
  let changes = 0;
  const gate = new PublicationGate({
    journal,
    batchTicks,
    boot,
    onChange: () => {
      changes += 1;
    },
  });
  const published: number[] = [];
  /** Ticks published before the journal committed them: a listener's assertion would be isolated. */
  const uncommitted: number[] = [];
  gate.subscribe(({ tick }) => {
    if (tick > gate.committed) uncommitted.push(tick);
    published.push(tick);
  });
  const counters = () => [gate.executed, gate.committed, gate.published];
  return { journal, gate, published, uncommitted, counters, changes: () => changes };
}

/** The tick ranges of `batches`. */
const ranges = (batches: readonly JournalBatch[]) =>
  batches.map(({ fromTick, toTick }) => [fromTick, toTick]);

const ticks = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index);

describe("PublicationGate", () => {
  test("boots with P = C = E = L and takes the ticks that follow, one by one", () => {
    const { gate, counters } = harness(5, 40);
    expect(counters()).toEqual([40, 40, 40]);
    gate.accept(executed(41));
    expect(counters()).toEqual([41, 40, 40]);
    expect(() => gate.accept(executed(43))).toThrow("tick 43 does not follow tick 41");
    expect(() => gate.accept(executed(41))).toThrow("tick 41 does not follow tick 41");
  });

  test("appends batches of F, one in flight, and publishes (P, C] in order as acks arrive", async () => {
    const { journal, gate, published, uncommitted, counters, changes } = harness();
    for (const tick of ticks(1, 12)) gate.accept(executed(tick));
    // The second full batch waits for the first one's acknowledgement.
    expect(ranges(journal.batches)).toEqual([[1, 5]]);
    expect(counters()).toEqual([12, 0, 0]);
    await settle();
    expect(published).toEqual([]);
    journal.ack();
    await settle();
    expect(counters()).toEqual([12, 5, 5]);
    expect(published).toEqual(ticks(1, 5));
    expect(uncommitted).toEqual([]);
    expect(ranges(journal.batches)).toEqual([
      [1, 5],
      [6, 10],
    ]);
    journal.ack();
    await settle();
    expect(counters()).toEqual([12, 10, 10]);
    expect(published).toEqual(ticks(1, 10));
    // Ticks 11 and 12 are not a full batch: they wait.
    expect(journal.pending).toBe(0);
    expect(journal.batches[1]?.records).toEqual(ticks(6, 10).map(recordOf));
    expect(journal.maxInFlight).toBe(1);
    expect(changes()).toBe(2);
  });

  test("never publishes beyond C while acknowledgements lag behind execution", async () => {
    const { journal, gate, published, uncommitted, counters } = harness(3);
    const seen: number[][] = [];
    for (const tick of ticks(1, 30)) {
      gate.accept(executed(tick));
      if (tick % 4 === 0 && journal.pending > 0) journal.ack();
      await settle();
      seen.push(counters());
    }
    const flushed = gate.flush();
    while (journal.pending > 0) {
      journal.ack();
      await settle();
    }
    await flushed;
    expect(seen.every(([e = 0, c = 0, p = 0]) => e >= c && c >= p)).toBe(true);
    expect(seen.some(([e = 0, , p = 0]) => e - p > 3)).toBe(true);
    expect(uncommitted).toEqual([]);
    expect(published).toEqual(ticks(1, 30));
    expect(journal.maxInFlight).toBe(1);
    const appended = journal.batches.flatMap(({ records }) => records.map(({ tick }) => tick));
    expect(appended).toEqual(ticks(1, 30));
  });

  test("closes a batch at a checkpoint, which only the batch ending at it carries", async () => {
    const { journal, gate } = harness(5);
    for (const tick of ticks(1, 7)) {
      gate.accept(tick % 3 === 0 ? executed(tick, `snapshot-${tick}`) : executed(tick));
    }
    journal.ack();
    await settle();
    journal.ack();
    await settle();
    expect(journal.batches).toEqual([
      { fromTick: 1, toTick: 3, records: ticks(1, 3).map(recordOf), checkpoint: "snapshot-3" },
      { fromTick: 4, toTick: 6, records: ticks(4, 6).map(recordOf), checkpoint: "snapshot-6" },
    ]);
    await Promise.all([gate.flush(), Promise.resolve().then(() => journal.ack())]);
    expect(journal.batches[2]).toEqual({ fromTick: 7, toTick: 7, records: [recordOf(7)] });
    expect("checkpoint" in (journal.batches[2] ?? {})).toBe(false);
  });

  test("flushes the partial batch and resolves once it is committed and published", async () => {
    const { journal, gate, published, counters } = harness();
    for (const tick of ticks(1, 3)) gate.accept(executed(tick));
    expect(journal.batches).toEqual([]);
    let flushed = false;
    const flush = gate.flush().then(() => {
      flushed = true;
    });
    expect(ranges(journal.batches)).toEqual([[1, 3]]);
    await settle();
    expect(flushed).toBe(false);
    journal.ack();
    await flush;
    expect(counters()).toEqual([3, 3, 3]);
    expect(published).toEqual([1, 2, 3]);
    // After the flush, batches are full again.
    for (const tick of ticks(4, 7)) gate.accept(executed(tick));
    expect(ranges(journal.batches)).toEqual([[1, 3]]);
    gate.accept(executed(8));
    expect(ranges(journal.batches)).toEqual([
      [1, 3],
      [4, 8],
    ]);
  });

  test("a flush waits for the append in flight, then appends the rest in batches of F", async () => {
    const { journal, gate, counters } = harness(2);
    for (const tick of ticks(1, 7)) gate.accept(executed(tick));
    const flush = gate.flush();
    for (let acks = 0; acks < 4; acks += 1) {
      journal.ack();
      await settle();
    }
    await flush;
    expect(ranges(journal.batches)).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
      [7, 7],
    ]);
    expect(counters()).toEqual([7, 7, 7]);
  });

  test("halts on a journal failure and publishes nothing it did not commit", async () => {
    const { journal, gate, published, counters, changes } = harness();
    for (const tick of ticks(1, 12)) gate.accept(executed(tick));
    journal.ack();
    await settle();
    journal.fail();
    await settle();
    expect(gate.failed).toBe(true);
    expect(counters()).toEqual([12, 5, 5]);
    expect(published).toEqual(ticks(1, 5));
    expect(changes()).toBe(2);
    // Nothing more reaches the journal: not the queue, not a flush.
    await gate.flush();
    expect(ranges(journal.batches)).toEqual([
      [1, 5],
      [6, 10],
    ]);
    expect(() => gate.accept(executed(13))).toThrow("the journal failed");
  });

  test("halts when the journal throws instead of rejecting", async () => {
    const gate = new PublicationGate({
      journal: {
        level: "none",
        append: () => {
          throw new Error("disk full");
        },
      },
      batchTicks: 1,
      boot: 0,
    });
    gate.accept(executed(1));
    await settle();
    expect(gate.failed).toBe(true);
    expect([gate.executed, gate.committed, gate.published]).toEqual([1, 0, 0]);
  });

  test("stalls once E − C exceeds the window W = 4F", async () => {
    const { journal, gate } = harness(5);
    expect(gate.window).toBe(20);
    for (const tick of ticks(1, 20)) gate.accept(executed(tick));
    expect([gate.lag(), gate.stalled()]).toEqual([20, false]);
    gate.accept(executed(21));
    expect([gate.lag(), gate.stalled()]).toEqual([21, true]);
    journal.ack();
    await settle();
    expect([gate.lag(), gate.stalled()]).toEqual([16, false]);
  });

  test("ignores what listeners return and isolates their exceptions and rejections", async () => {
    const { journal, gate, published } = harness(2);
    const received: PublishedTick[] = [];
    gate.subscribe(() => {
      throw new Error("a broken listener");
    });
    gate.subscribe(() => Promise.reject(new Error("a broken async listener")));
    const unsubscribe = gate.subscribe((tick) => {
      received.push(tick);
      return "ignored";
    });
    for (const tick of ticks(1, 4)) gate.accept(executed(tick));
    journal.ack();
    await settle();
    unsubscribe();
    journal.ack();
    await settle();
    expect(published).toEqual([1, 2, 3, 4]);
    expect(received).toEqual([publishedTick(1), publishedTick(2)]);
    expect(received.every((tick) => Object.isFrozen(tick))).toBe(true);
    // Two broken listeners, four ticks each.
    expect(gate.listenerFaults).toBe(8);
  });

  test("refuses a batch size below one", () => {
    expect(
      () => new PublicationGate({ journal: new ControlledJournal(), batchTicks: 0, boot: 0 }),
    ).toThrow(RangeError);
  });
});

describe("OrderedJournal", () => {
  const batch = (fromTick: number, toTick: number): JournalBatch => ({
    fromTick,
    toTick,
    records: ticks(fromTick, toTick).map(recordOf),
  });

  /**
   * The message of what `append` throws, or undefined when it returns. Bun's toThrow would wait
   * for the promise an append returns when it does not throw, and the controlled journal never
   * settles it: a guard that let the append through would hang the test instead of failing it.
   */
  const thrownBy = (append: () => Promise<void>): string | undefined => {
    try {
      append();
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    return undefined;
  };

  test("refuses a second append while one is in flight", async () => {
    const inner = new ControlledJournal();
    const journal = new OrderedJournal(inner, 0);
    const first = journal.append(batch(1, 5));
    expect(thrownBy(() => journal.append(batch(6, 10)))).toBe(
      "journal order: an append is already in flight; one runs at a time",
    );
    expect(inner.batches).toHaveLength(1);
    inner.ack();
    await first;
    const second = journal.append(batch(6, 10));
    inner.ack();
    await second;
    expect(ranges(inner.batches)).toEqual([
      [1, 5],
      [6, 10],
    ]);
  });

  test("refuses batches out of order or whose records are not their ticks", () => {
    const inner = new ControlledJournal();
    const journal = new OrderedJournal(inner, 10);
    const records = "journal order: the records are not exactly the ticks 11 to 12, in order";
    expect(thrownBy(() => journal.append(batch(12, 13)))).toBe(
      "journal order: the batch starts at tick 12, not at 11, the tick after the last batch",
    );
    expect(thrownBy(() => journal.append({ fromTick: 11, toTick: 10, records: [] }))).toBe(
      "journal order: the batch ends at tick 10, before it starts",
    );
    const swapped = { ...batch(11, 12), records: [recordOf(12), recordOf(11)] };
    expect(thrownBy(() => journal.append(swapped))).toBe(records);
    const short = { ...batch(11, 12), records: [recordOf(11)] };
    expect(thrownBy(() => journal.append(short))).toBe(records);
    expect(inner.batches).toEqual([]);
  });

  test("frees the slot after a failure, and after a journal that throws", async () => {
    const inner = new ControlledJournal();
    const journal = new OrderedJournal(inner, 0);
    const failed = journal.append(batch(1, 1));
    inner.fail();
    await expect(failed).rejects.toThrow("the journal failed");
    // The next batch goes through: no append is left in flight.
    expect(thrownBy(() => journal.append(batch(2, 2)))).toBeUndefined();
    expect(ranges(inner.batches)).toEqual([
      [1, 1],
      [2, 2],
    ]);
    const throwing = new OrderedJournal(
      {
        level: "durable",
        append: () => {
          throw new Error("disk full");
        },
      },
      0,
    );
    expect(throwing.level).toBe("durable");
    expect(thrownBy(() => throwing.append(batch(1, 1)))).toBe("disk full");
    expect(thrownBy(() => throwing.append(batch(2, 2)))).toBe("disk full");
  });
});

describe("EphemeralJournal", () => {
  test("declares no durability and acknowledges each batch in a microtask", async () => {
    const journal = new EphemeralJournal();
    expect(journal.level).toBe("none");
    let acknowledged = false;
    const append = journal
      .append({ fromTick: 1, toTick: 1, records: [recordOf(1)], checkpoint: "snapshot-1" })
      .then(() => {
        acknowledged = true;
      });
    expect(acknowledged).toBe(false);
    await append;
    expect(acknowledged).toBe(true);
  });
});
