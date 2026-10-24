import { describe, expect, test } from "bun:test";
import { DrawSequence, mix32, type Seed, streamId, tickKey } from "../src/index.ts";
import { engineErrorOf } from "./support/engine-error.ts";
import { Sfc32 } from "./support/sfc32.ts";

/**
 * Draw sequences over ctr-mix32@1 (ADR 0020): draw n of a sequence is mix32(seed, stream, key, n),
 * from n = 0. Bounded integers use rejection sampling, each retry consuming the next n, and
 * permutations are Fisher-Yates shuffles over them. The statistical tests use fixed inputs, so
 * they are deterministic; their critical values come from the NIST/SEMATECH e-Handbook of
 * Statistical Methods, table 1.3.6.7.4 (https://www.itl.nist.gov/div898/handbook/eda/section3/eda3674.htm),
 * column "0.999": 20.515 for 5, 37.697 for 15, and 49.728 for 23 degrees of freedom.
 */

const SEED: Seed = [1, 2];
const CONFLICTS = streamId("conflicts");
const KEY = tickKey(37, 5);
const U32_COUNT = 0x1_0000_0000;

const sequence = (key: readonly number[] = KEY, stream = CONFLICTS) =>
  new DrawSequence(SEED, stream, key);

/** Pearson's chi-square statistic of `counts` against a uniform expectation. */
function chiSquare(counts: readonly number[]): number {
  const total = counts.reduce((sum, count) => sum + count, 0);
  const expected = total / counts.length;
  return counts.reduce(
    (sum, count) => sum + ((count - expected) * (count - expected)) / expected,
    0,
  );
}

function popcount(value: number): number {
  let bits = 0;
  for (let rest = value >>> 0; rest !== 0; rest >>>= 1) bits += rest & 1;
  return bits;
}

describe("DrawSequence.u32", () => {
  test("gives mix32 at n = 0, 1, 2, ..., as these pinned values", () => {
    const draws = sequence();
    const values = [draws.u32(), draws.u32(), draws.u32(), draws.u32()];
    // Also computed by SMHasher's C reference over [2, stream, 4, 37, 0, 5, 0, n] with seed 1.
    expect(values).toEqual([0x3dee2cac, 0x952b2926, 0x9b225a87, 0x9414b9e4]);
    expect(values).toEqual([0, 1, 2, 3].map((n) => mix32(SEED, CONFLICTS, KEY, n)));
    expect(draws.next).toBe(4);
  });

  test("never depends on draws from another stream or for another key", () => {
    /** Entity 2's draws in a tick where entity 1 draws `first` values first. */
    const tick = (first: number, otherStream: number) => {
      const one = sequence(tickKey(37, 1));
      for (let draw = 0; draw < first; draw += 1) one.u32();
      sequence(tickKey(37, 3), otherStream).u32();
      const two = sequence(tickKey(37, 2));
      return [two.u32(), two.u32(), two.u32()];
    };
    const control = tick(1, streamId("weather.rain"));
    expect(tick(1_000, streamId("weather.rain"))).toEqual(control);
    expect(tick(0, streamId("growth"))).toEqual(control);
  });

  test("copies its key, so changing the caller's array changes nothing", () => {
    const key = [37, 0, 5, 0];
    const draws = new DrawSequence(SEED, CONFLICTS, key);
    key[2] = 6;
    expect(draws.u32()).toBe(0x3dee2cac);
  });

  test("reads each key word once, so a getter cannot pass validation and then change", () => {
    let reads = 0;
    const key = Object.defineProperty([37, 0, 0, 0], 2, {
      get: () => (reads++ === 0 ? 5 : "five"),
      enumerable: true,
    });
    expect(new DrawSequence(SEED, CONFLICTS, key).u32()).toBe(0x3dee2cac);
    expect(reads).toBe(1);
  });

  test("starts at a given n, and has no draw after n = 2^32 - 1", () => {
    const draws = new DrawSequence(SEED, CONFLICTS, KEY, 0xffffffff);
    expect(draws.u32()).toBe(mix32(SEED, CONFLICTS, KEY, 0xffffffff));
    const error = engineErrorOf(() => draws.u32());
    expect(error.code).toBe("invalid_value");
    expect(error.issues).toEqual([
      {
        path: "/n",
        message: "the draw counter is exhausted: a sequence has 2^32 draws, n 0 to 4294967295",
      },
    ]);
  });

  test("validates its inputs once, with every issue", () => {
    const error = engineErrorOf(() => new DrawSequence([0, 1.5], -1, [2 ** 32], -1));
    expect(error.issues.map(({ path }) => path)).toEqual(["/seed/1", "/stream", "/key/0", "/n"]);
  });
});

describe("DrawSequence.int", () => {
  test("is unbiased by rejection, each retry consuming the next n (bound 2^31 + 1)", () => {
    const bound = 2 ** 31 + 1;
    // limit = 2^32 - (2^32 mod bound) = 2^31 + 1: about half of all draws are rejected.
    const draws = sequence();
    let n = 0;
    let rejected = 0;
    for (let sample = 0; sample < 2_000; sample += 1) {
      let expected = mix32(SEED, CONFLICTS, KEY, n);
      n += 1;
      while (expected >= bound) {
        rejected += 1;
        expected = mix32(SEED, CONFLICTS, KEY, n);
        n += 1;
      }
      expect(draws.int(bound)).toBe(expected);
    }
    expect(draws.next).toBe(n);
    expect(rejected).toBeGreaterThan(1_800);
    expect(rejected).toBeLessThan(2_200);
  });

  test("at the bound 1 gives 0, and at 2^32 gives the u32 itself, one n each", () => {
    const ones = sequence();
    const wide = sequence();
    for (let n = 0; n < 100; n += 1) {
      expect(ones.int(1)).toBe(0);
      expect(wide.int(U32_COUNT)).toBe(mix32(SEED, CONFLICTS, KEY, n));
    }
    expect([ones.next, wide.next]).toEqual([100, 100]);
  });

  test.each([0, -1, 1.5, U32_COUNT + 1, Number.NaN])("rejects the bound %d", (bound) => {
    const draws = sequence();
    expect(engineErrorOf(() => draws.int(bound)).issues).toEqual([
      { path: "/bound", message: `${bound} is not an integer in [1, 4294967296]` },
    ]);
    expect(draws.next).toBe(0);
  });

  test.each([
    ["a symbol", Symbol("bound"), "symbol"],
    ["a bigint", 2n, "bigint"],
    ["a string", "2", "string"],
  ])("rejects %s as a bound by its type", (_name, bound, type) => {
    // Deliberately ill-typed, as a JavaScript caller can be.
    const error = engineErrorOf(() => sequence().int(bound as unknown as number));
    expect(error.issues).toEqual([
      { path: "/bound", message: `a value of type ${type} is not an integer in [1, 4294967296]` },
    ]);
  });

  test("fills 16 buckets evenly over 100,000 fixed draws (chi-square below 37.697)", () => {
    const draws = sequence();
    const low = Array.from({ length: 16 }, () => 0);
    const high = Array.from({ length: 16 }, () => 0);
    for (let draw = 0; draw < 100_000; draw += 1) {
      const bucket = draws.int(16);
      low[bucket] = (low[bucket] ?? 0) + 1;
      const top = draws.u32() >>> 28;
      high[top] = (high[top] ?? 0) + 1;
    }
    expect(chiSquare(low)).toBeLessThan(37.697);
    expect(chiSquare(high)).toBeLessThan(37.697);
  });
});

describe("DrawSequence.int at the exact rejection limit, 2^32 - (2^32 mod bound)", () => {
  // The first draw (n = 0) for seed [0, 0] and the empty key, on streams found by search; each
  // value was also computed by SMHasher's C reference over the words [0, stream, 0, 0], seed 0.
  const ALL_ONES = 1_316_206_573; // draws 0xffffffff
  const TOP_PLUS_ONE = 1_017_681_598; // draws 0x80000001
  const TOP = 302_028_550; // draws 0x80000000
  const first = (stream: number) => new DrawSequence([0, 0], stream, []);

  test("the three streams draw the values the limits need", () => {
    expect([ALL_ONES, TOP_PLUS_ONE, TOP].map((stream) => mix32([0, 0], stream, [], 0))).toEqual([
      0xffffffff, 0x80000001, 0x80000000,
    ]);
  });

  test("at the bound 2^31 + 1, the limit itself, 0x80000001, is rejected and 0x80000000 is not", () => {
    const bound = 2 ** 31 + 1;
    const accepted = first(TOP);
    expect(accepted.int(bound)).toBe(0x80000000);
    expect(accepted.next).toBe(1);
    const rejected = first(TOP_PLUS_ONE);
    const value = rejected.int(bound);
    // The retry starts at n = 1, and the first draw below the limit decides.
    let n = 1;
    while (mix32([0, 0], TOP_PLUS_ONE, [], n) >= bound) n += 1;
    expect(value).toBe(mix32([0, 0], TOP_PLUS_ONE, [], n));
    expect(rejected.next).toBe(n + 1);
  });

  test.each([1, 2, 2 ** 31, U32_COUNT])("0xffffffff is accepted at the bound %d", (bound) => {
    const draws = first(ALL_ONES);
    expect(draws.int(bound)).toBe(0xffffffff % bound);
    expect(draws.next).toBe(1);
  });

  test.each([3, 2 ** 31 + 1, U32_COUNT - 1])("0xffffffff is rejected at the bound %d", (bound) => {
    const draws = first(ALL_ONES);
    draws.int(bound);
    expect(draws.next).toBeGreaterThan(1);
  });
});

describe("mix32 avalanche", () => {
  test("flipping any one input bit flips 16 +- 1 output bits on average", () => {
    const random = new Sfc32(51);
    const samples = Array.from({ length: 256 }, () =>
      Array.from({ length: 6 }, () => random.next()),
    );
    /** The draw for the words [s0, s1, stream, key0, key1, n]. */
    const draw = ([s0 = 0, s1 = 0, stream = 0, key0 = 0, key1 = 0, n = 0]: number[]) =>
      mix32([s0, s1], stream, [key0, key1], n);
    const averages: number[] = [];
    for (let word = 0; word < 6; word += 1) {
      for (let bit = 0; bit < 32; bit += 1) {
        let flipped = 0;
        for (const sample of samples) {
          const changed = sample.map((value, index) =>
            index === word ? (value ^ (1 << bit)) >>> 0 : value,
          );
          flipped += popcount(draw(sample) ^ draw(changed));
        }
        averages.push(flipped / samples.length);
      }
    }
    expect(averages).toHaveLength(192);
    expect(averages.filter((average) => average < 15 || average > 17)).toEqual([]);
  });
});

describe("DrawSequence.permutation", () => {
  test("is a permutation of 0..count - 1, drawing count - 1 bounded integers", () => {
    expect(sequence().permutation(0)).toEqual([]);
    const one = sequence();
    expect(one.permutation(1)).toEqual([0]);
    expect(one.next).toBe(0);
    for (const count of [2, 7, 50, 1_000]) {
      const items = sequence(tickKey(1, count)).permutation(count);
      expect([...items].sort((a, b) => a - b)).toEqual(Array.from({ length: count }, (_, i) => i));
    }
  });

  test("is a Fisher-Yates shuffle over int", () => {
    const shuffled = sequence().permutation(5);
    const draws = sequence();
    const items = [0, 1, 2, 3, 4];
    for (let last = 4; last > 0; last -= 1) {
      const pick = draws.int(last + 1);
      [items[pick], items[last]] = [items[last] ?? -1, items[pick] ?? -1];
    }
    expect(shuffled).toEqual(items);
  });

  test.each([
    [3, 6_000, 20.515],
    [4, 24_000, 49.728],
  ])("of %d items is uniform over %d fixed keys (chi-square below %d)", (count, keys, critical) => {
    const counts = new Map<string, number>();
    for (let key = 0; key < keys; key += 1) {
      const order = sequence([key]).permutation(count).join(",");
      counts.set(order, (counts.get(order) ?? 0) + 1);
    }
    expect(counts.size).toBe(count === 3 ? 6 : 24);
    expect(chiSquare([...counts.values()])).toBeLessThan(critical);
  });

  test.each([-1, 1.5, U32_COUNT])("rejects the count %d", (count) => {
    expect(engineErrorOf(() => sequence().permutation(count)).issues).toEqual([
      { path: "/count", message: `${count} is not an integer in [0, 4294967295]` },
    ]);
  });
});
