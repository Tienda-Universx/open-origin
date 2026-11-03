/**
 * The rings of local speech and of the feed (ADR 0026, "Interest and transactions"): the items of
 * the last H = 300 ticks, at most 2,048 of them, each encoded once and shared by every client.
 * Items belong to a stream, a chunk for speech and one stream for the feed, and each stream counts
 * every item it ever had, kept or not. A client remembers the count of each stream at its visible
 * tick, so a transaction reads the items after it, and the items it can no longer read, evicted
 * or never kept, are counted exactly as missed.
 */
import { RING_ITEMS, RING_TICKS } from "@open-origin/protocol/public";
import { byteLength } from "./bytes.ts";

/** An item kept in a ring: its stream, its tick, its number in its stream from 1, and its JSON. */
export type RingItem = {
  readonly stream: string;
  readonly tick: number;
  readonly n: number;
  readonly json: string;
  readonly bytes: number;
};

/** What a client reads of a stream: the items after its count, and how many it missed. */
export type RingRead = { readonly items: readonly RingItem[]; readonly missed: number };

/** The bounds of a ring: the ticks it keeps, and the most items. */
export type RingBounds = { readonly ticks: number; readonly items: number };

const BOUNDS: RingBounds = Object.freeze({ ticks: RING_TICKS, items: RING_ITEMS });

/** The index of the first of `items`, numbered in increasing order, whose number exceeds `n`. */
function firstAfter(items: readonly RingItem[], n: number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((items[middle]?.n ?? Number.POSITIVE_INFINITY) > n) high = middle;
    else low = middle + 1;
  }
  return low;
}

/** Items of several streams, the newest kept, and every stream's count. */
export class TickRing {
  readonly #bounds: RingBounds;
  /** Every item each stream ever had, kept or not. */
  readonly #counts = new Map<string, number>();
  /** The kept items, oldest first. */
  readonly #items: RingItem[] = [];
  /** The kept items of each stream, oldest first. */
  readonly #streams = new Map<string, RingItem[]>();

  constructor(bounds: RingBounds = BOUNDS) {
    this.#bounds = bounds;
  }

  /** How many items the ring keeps now. */
  get size(): number {
    return this.#items.length;
  }

  /** Every item `stream` ever had. */
  count(stream: string): number {
    return this.#counts.get(stream) ?? 0;
  }

  /**
   * Adds the items `kept`, already encoded, of `stream` at `tick`, and counts `total` items in
   * all: the items beyond `kept` happened but are not kept, so every reader misses them.
   */
  add(stream: string, tick: number, kept: readonly string[], total: number): void {
    if (total < kept.length) throw new RangeError(`${total} items cannot keep ${kept.length}`);
    const before = this.count(stream);
    const items = this.#streams.get(stream) ?? [];
    kept.forEach((json, index) => {
      const item = Object.freeze({
        stream,
        tick,
        n: before + index + 1,
        json,
        bytes: byteLength(json),
      });
      items.push(item);
      this.#items.push(item);
    });
    if (items.length > 0) this.#streams.set(stream, items);
    this.#counts.set(stream, before + total);
  }

  /** Drops the items older than the last H ticks up to `tick`, then the oldest beyond the most. */
  evict(tick: number): void {
    const oldest = tick - this.#bounds.ticks;
    for (let first = this.#items[0]; first !== undefined; first = this.#items[0]) {
      if (first.tick > oldest && this.#items.length <= this.#bounds.items) return;
      this.#items.shift();
      const items = this.#streams.get(first.stream);
      items?.shift();
      if (items?.length === 0) this.#streams.delete(first.stream);
    }
  }

  /** The items of `stream` after the first `seen`, and how many of those the ring cannot give. */
  since(stream: string, seen: number): RingRead {
    const kept = this.#streams.get(stream) ?? [];
    const items = kept.slice(firstAfter(kept, seen));
    return { items, missed: this.count(stream) - seen - items.length };
  }
}
