import { describe, expect, test } from "bun:test";
import { Sfc32 as EngineSfc32 } from "../../engine/test/support/sfc32.ts";
import { LABELS, LABELS2, labelSeeds } from "../src/index.ts";
import { Sfc32 } from "../src/sfc32.ts";

/** How many outputs of each seed the two copies must agree on. */
const OUTPUTS = 4096;

/**
 * The seeds compared: the edges of the u32 range, both sides of the sign bit that `seed | 0` folds,
 * an arbitrary word, and the spawn seeds of the default labels of T4 and T5.
 */
const SEEDS = [
  0,
  1,
  2,
  0x7fff_ffff,
  0x8000_0000,
  0xdead_beef,
  0xffff_ffff,
  labelSeeds(LABELS.default).spawn,
  labelSeeds(LABELS2.default).spawn,
];

/** The first `count` outputs of `random`. */
function outputs(random: { next(): number }, count: number): number[] {
  return Array.from({ length: count }, () => random.next());
}

describe("the copy of Sfc32 in scenarios", () => {
  test.each(SEEDS)("gives the engine copy's first outputs for seed %p", (seed) => {
    expect(outputs(new Sfc32(seed), OUTPUTS)).toEqual(outputs(new EngineSfc32(seed), OUTPUTS));
  });

  test("gives the pinned first outputs of seeds 0 and 1, so a change made to both copies fails too", () => {
    expect(outputs(new Sfc32(0), 4)).toEqual([1363572419, 145230303, 808754475, 4216505632]);
    expect(outputs(new Sfc32(1), 4)).toEqual([2012149540, 1872316204, 1707632675, 1779833415]);
  });
});
