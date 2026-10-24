/**
 * Draws from one stream for one key (ADR 0020): u32 values, unbiased bounded integers, and
 * permutations, each draw consuming the next counter n of ctr-mix32@1 from 0. The counter lives
 * in the sequence; keeping it per stream and entity across a tick is the step context's job.
 */
import { describeValue, EngineError } from "../errors.ts";
import { MAX_U32, U32_COUNT } from "../int.ts";
import { type DrawSource, mixDraw, readDraw, type Seed } from "./mix32.ts";

const EXHAUSTED = "the draw counter is exhausted: a sequence has 2^32 draws, n 0 to 4294967295";

/**
 * The most items a permutation may have, 2^16. Conflicts order the inhabitants that want one
 * resource in one tick (plan §I.1.3), far fewer than this; the bound caps what one call allocates
 * and draws (65,535 bounded integers), so a mistaken count fails at once instead of exhausting
 * memory.
 */
const MAX_PERMUTATION = 0x1_0000;

const isBound = (value: number): boolean =>
  Number.isInteger(value) && value >= 1 && value <= U32_COUNT;

const isPermutationCount = (value: number): boolean =>
  Number.isInteger(value) && value >= 0 && value <= MAX_PERMUTATION;

/** The draws of one stream for one key under one seed, in counter order. */
export class DrawSequence {
  readonly #source: DrawSource;
  #next: number;

  /**
   * The draws of `stream` for `key` under `seed`, starting at the counter `next`. It reads each
   * input once, into copies of its own. Throws EngineError("invalid_value") with every input that
   * is not what its type says.
   */
  constructor(seed: Seed, stream: number, key: readonly number[], next = 0) {
    const draw = readDraw(seed, stream, key, next);
    this.#source = { seed: draw.seed, stream: draw.stream, key: draw.key };
    this.#next = draw.n;
  }

  /** The counter n that the next draw uses. */
  get next(): number {
    return this.#next;
  }

  /**
   * The next u32. Throws EngineError("invalid_value") once the counter passes 2^32 - 1: a
   * sequence has 2^32 draws.
   */
  u32(): number {
    const n = this.#next;
    if (n > MAX_U32) throw new EngineError("invalid_value", [{ path: "/n", message: EXHAUSTED }]);
    this.#next = n + 1;
    return mixDraw(this.#source, n);
  }

  /**
   * An integer in [0, bound), for an integer `bound` in [1, 2^32], without modulo bias: a draw at
   * or above the largest multiple of `bound` that fits in 2^32 is rejected, and each retry uses
   * the next counter.
   */
  int(bound: number): number {
    if (!isBound(bound)) {
      throw new EngineError("invalid_value", [
        { path: "/bound", message: `${describeValue(bound)} is not an integer in [1, 4294967296]` },
      ]);
    }
    const limit = U32_COUNT - (U32_COUNT % bound);
    let value = this.u32();
    while (value >= limit) value = this.u32();
    return value % bound;
  }

  /**
   * The integers 0 to count - 1 in a uniformly random order: a Fisher-Yates shuffle over int.
   * Throws EngineError("invalid_value"), before any draw, when `count` is not an integer in
   * [0, MAX_PERMUTATION].
   */
  permutation(count: number): number[] {
    if (!isPermutationCount(count)) {
      const message = `${describeValue(count)} is not an integer in [0, ${MAX_PERMUTATION}]`;
      throw new EngineError("invalid_value", [{ path: "/count", message }]);
    }
    const items = Array.from({ length: count }, (_, index) => index);
    for (let last = count - 1; last > 0; last -= 1) {
      const pick = this.int(last + 1);
      // pick <= last < count, so both elements exist.
      const picked = items[pick] as number;
      items[pick] = items[last] as number;
      items[last] = picked;
    }
    return items;
  }
}
