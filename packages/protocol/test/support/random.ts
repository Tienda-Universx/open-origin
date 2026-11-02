/**
 * A small seeded generator for the protocol's fuzz tests: mulberry32, which is enough to spread
 * cases and keeps every run the same. Tests never use Math.random.
 */
export class Random {
  #state: number;

  constructor(seed: number) {
    this.#state = seed >>> 0;
  }

  /** The next 32-bit unsigned integer. */
  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** An integer in [0, bound). */
  below(bound: number): number {
    return Math.floor((this.next() / 0x1_0000_0000) * bound);
  }

  /** One of `choices`. */
  pick<T>(choices: readonly T[]): T {
    const choice = choices[this.below(choices.length)];
    if (choice === undefined) throw new Error("pick needs at least one choice");
    return choice;
  }

  /** `length` random bytes. */
  bytes(length: number): Uint8Array {
    return Uint8Array.from({ length }, () => this.below(256));
  }
}
