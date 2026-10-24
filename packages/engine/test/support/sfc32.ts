/**
 * A seeded pseudo-random generator for fuzz tests: sfc32, the Small Fast Counting generator by
 * Chris Doty-Humphrey from the PractRand suite (https://pracrand.sourceforge.net/), in the 32-bit
 * JavaScript form collected at https://github.com/bryc/code/blob/master/jshash/PRNGs.md. It is
 * independent of the engine's own randomness, so a defect there cannot also shape the inputs
 * that test it. Seeding is ours: a = 0, b = seed, c = 0, counter = 1, then 12 outputs discarded.
 */
export class Sfc32 {
  #a = 0;
  #b: number;
  #c = 0;
  #counter = 1;

  constructor(seed: number) {
    this.#b = seed | 0;
    for (let round = 0; round < 12; round += 1) this.next();
  }

  /** The next unsigned 32-bit integer. */
  next(): number {
    const output = (((this.#a + this.#b) | 0) + this.#counter) | 0;
    this.#counter = (this.#counter + 1) | 0;
    this.#a = this.#b ^ (this.#b >>> 9);
    this.#b = (this.#c + (this.#c << 3)) | 0;
    this.#c = (((this.#c << 21) | (this.#c >>> 11)) + output) | 0;
    return output >>> 0;
  }

  /** An integer in [0, bound), for 1 <= bound <= 2^32; the modulo bias does not matter here. */
  below(bound: number): number {
    return this.next() % bound;
  }

  /** An integer in [min, max], for ranges of at most 2^32 values. */
  between(min: number, max: number): number {
    return min + this.below(max - min + 1);
  }

  /** One element of `items`, which must not be empty. */
  pick<T>(items: readonly T[]): T {
    const item = items[this.below(items.length)];
    if (item === undefined) throw new RangeError("pick needs a non-empty list");
    return item;
  }
}
