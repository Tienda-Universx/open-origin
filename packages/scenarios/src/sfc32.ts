/**
 * The spawn generator of the preregistered scenarios: sfc32, the Small Fast Counting generator by
 * Chris Doty-Humphrey from the PractRand suite (https://pracrand.sourceforge.net/), in the 32-bit
 * JavaScript form collected at https://github.com/bryc/code/blob/master/jshash/PRNGs.md. The
 * scenarios of T4 and T5 were preregistered with the engine's test copy
 * (packages/engine/test/support/sfc32.ts). This copies its constructor and `next`, the parts the
 * recipes use, so this package's sources never import engine test code; the engine keeps its own
 * copy, so its tests never depend on this package (ADR 0025). test/sfc32.test.ts checks that both
 * give the same outputs.
 * Seeding: a = 0, b = seed, c = 0, counter = 1, then 12 outputs discarded.
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
}
