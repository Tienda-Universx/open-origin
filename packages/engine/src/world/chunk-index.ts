/**
 * The chunks of a world by key, with the keys in canonical order on demand (ADR 0020, cost).
 *
 * - `add` is amortized O(1): the key joins a list of pending keys.
 * - `has` and `get` are O(1) lookups in a null-prototype record. The record is never enumerated,
 *   so its insertion order is never observable, and no key reaches an inherited property. This
 *   is why the index needs no `Map`, which global-map.grit denies here.
 * - `sortedKeys` sorts only the pending keys and merges them into the sorted list: O(P log P + N)
 *   for P pending keys, paid only by a caller that asks for every key.
 */
import { compareCodeUnits } from "../canonical/order.ts";
import { EngineError } from "../errors.ts";
import type { ChunkKey } from "./chunk.ts";

/** The keys of `sorted` and `fresh`, both sorted and disjoint, in one sorted array. */
function merge(sorted: readonly ChunkKey[], fresh: readonly ChunkKey[]): ChunkKey[] {
  const merged: ChunkKey[] = [];
  let a = 0;
  let b = 0;
  while (a < sorted.length && b < fresh.length) {
    // Both indexes are in bounds, and the keys are unique, so one key is less than the other.
    const left = sorted[a] as ChunkKey;
    const right = fresh[b] as ChunkKey;
    if (compareCodeUnits(left, right) < 0) {
      merged.push(left);
      a += 1;
    } else {
      merged.push(right);
      b += 1;
    }
  }
  return merged.concat(sorted.slice(a), fresh.slice(b));
}

/** Chunk values by key; `V` is what the world keeps per chunk. */
export class ChunkIndex<V> {
  readonly #entries: { [key: ChunkKey]: V } = Object.create(null);
  #sorted: ChunkKey[] = [];
  readonly #pending: ChunkKey[] = [];

  /** How many chunks the index holds. */
  get size(): number {
    return this.#sorted.length + this.#pending.length;
  }

  /** How many keys were added since the last sortedKeys call; they are not sorted yet. */
  get pendingCount(): number {
    return this.#pending.length;
  }

  has(key: ChunkKey): boolean {
    return Object.hasOwn(this.#entries, key);
  }

  /** The value of `key`, or undefined when the index has no such chunk. */
  get(key: ChunkKey): V | undefined {
    return this.has(key) ? this.#entries[key] : undefined;
  }

  /** Adds the chunk `key`. Throws EngineError("invalid_value") when it is already there. */
  add(key: ChunkKey, value: V): void {
    if (this.has(key)) {
      throw new EngineError("invalid_value", [
        { path: "", message: `the chunk ${key} already exists` },
      ]);
    }
    this.#entries[key] = value;
    this.#pending.push(key);
  }

  /** Every key, sorted by UTF-16 code units, in a fresh array. */
  sortedKeys(): ChunkKey[] {
    if (this.#pending.length > 0) {
      this.#sorted = merge(this.#sorted, this.#pending.sort(compareCodeUnits));
      this.#pending.length = 0;
    }
    return this.#sorted.slice();
  }

  /** Every chunk as a [key, value] pair, sorted by key, in a fresh array. */
  sortedEntries(): [ChunkKey, V][] {
    const entries: [ChunkKey, V][] = [];
    for (const key of this.sortedKeys()) {
      // Every sorted key was added with its value, and nothing removes one.
      entries.push([key, this.#entries[key] as V]);
    }
    return entries;
  }
}
