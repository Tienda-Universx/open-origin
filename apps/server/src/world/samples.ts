/**
 * Bounded windows of integer samples, for the scheduler's C3 metrics (ADR 0025): the last
 * `capacity` values, in the order they were added.
 */

/** The 50th, 95th, and 99th percentiles of a window, by nearest rank; 0 when it is empty. */
export type Percentiles = { readonly p50: number; readonly p95: number; readonly p99: number };

/** The last `capacity` integers added, oldest first. */
export class SampleWindow {
  readonly #values: number[] = [];
  readonly #capacity: number;
  /** Where the next value goes once the window is full. */
  #start = 0;

  constructor(capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError(`a sample window holds at least one value, not ${capacity}`);
    }
    this.#capacity = capacity;
  }

  get size(): number {
    return this.#values.length;
  }

  add(value: number): void {
    if (this.#values.length < this.#capacity) {
      this.#values.push(value);
      return;
    }
    this.#values[this.#start] = value;
    this.#start = (this.#start + 1) % this.#capacity;
  }

  /** The values, oldest first, in a fresh array. */
  values(): number[] {
    return [...this.#values.slice(this.#start), ...this.#values.slice(0, this.#start)];
  }

  /** The nearest-rank percentiles of the values. */
  percentiles(): Percentiles {
    const sorted = this.#values.toSorted((a, b) => a - b);
    const rank = (percent: number) => sorted[Math.ceil((percent * sorted.length) / 100) - 1] ?? 0;
    return { p50: rank(50), p95: rank(95), p99: rank(99) };
  }
}
