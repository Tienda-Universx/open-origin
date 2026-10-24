import { describe, expect, test } from "bun:test";
import { murmur3x86_32, murmur3x86_32Words } from "../src/digest/murmur3.ts";
import { DrawSequence, mix32, type Seed, streamId, tickKey } from "../src/index.ts";
import { engineErrorOf } from "./support/engine-error.ts";
import { Sfc32 } from "./support/sfc32.ts";

/**
 * ctr-mix32@1 (ADR 0020): draw n of a stream for a key is MurmurHash3 x86_32 over the words
 * [s1, stream, key.length, ...key, n] with seed s0. The pinned values were also computed by
 * SMHasher's C reference (src/MurmurHash3.cpp) over the little-endian bytes of those words.
 */

const MAX = 0xffffffff;
const NOT_U32 = (value: number) => `${value} is not an integer in [0, 4294967295]`;

describe("mix32", () => {
  test("gives these pinned values", () => {
    expect(mix32([1, 2], 3, [4, 5], 6)).toBe(0x4ec93050);
    expect(mix32([0, 0], 0, [], 0)).toBe(0x8134cdf8);
    expect(mix32([MAX, MAX], MAX, [MAX], MAX)).toBe(0x80d13b96);
  });

  test("is MurmurHash3 x86_32 over [s1, stream, key.length, ...key, n] with seed s0", () => {
    const random = new Sfc32(41);
    for (let sample = 0; sample < 1_000; sample += 1) {
      const seed: Seed = [random.next(), random.next()];
      const stream = random.next();
      const key = Array.from({ length: random.below(6) }, () => random.next());
      const n = random.next();
      expect(mix32(seed, stream, key, n)).toBe(
        murmur3x86_32Words([seed[1], stream, key.length, ...key, n], seed[0]),
      );
    }
  });

  test("reports every input that is not a u32, with its path, as invalid_value", () => {
    const error = engineErrorOf(() => mix32([1, -1], 0x1_0000_0000, [0, 1.5, 3], -2));
    expect(error.code).toBe("invalid_value");
    expect(error.issues).toEqual([
      { path: "/seed/1", message: NOT_U32(-1) },
      { path: "/stream", message: NOT_U32(0x1_0000_0000) },
      { path: "/key/1", message: NOT_U32(1.5) },
      { path: "/n", message: NOT_U32(-2) },
    ]);
  });

  test("rejects a seed that is not a pair and a key that is not an array", () => {
    // Deliberately ill-typed, as a JavaScript caller can be.
    const pair = [1, 2, 3] as unknown as Seed;
    const notKey = "1" as unknown as readonly number[];
    expect(engineErrorOf(() => mix32(pair, 0, notKey, 0)).issues).toEqual([
      { path: "/seed", message: "the seed must be an array of two words" },
      { path: "/key", message: "the key must be an array of words" },
    ]);
  });
});

describe("mix32 reads each input once", () => {
  test("a key word behind a getter is read once, so validation and the hash see the same word", () => {
    let reads = 0;
    const key = Object.defineProperty([4, 0], 1, {
      get: () => (reads++ === 0 ? 5 : 6),
      enumerable: true,
    });
    expect(mix32([1, 2], 3, key, 6)).toBe(0x4ec93050);
    expect(reads).toBe(1);
  });

  test("a key with its own iterator is hashed by index, as it was validated", () => {
    const key = Object.assign([4, 5], {
      *[Symbol.iterator]() {
        yield 7;
        yield 8;
        yield 9;
      },
    });
    expect(mix32([1, 2], 3, key, 6)).toBe(0x4ec93050);
    expect(new DrawSequence([1, 2], 3, key, 6).u32()).toBe(0x4ec93050);
  });

  test("a seed with its own iterator is hashed by index too", () => {
    const seed = Object.assign([1, 2], {
      *[Symbol.iterator]() {
        yield 9;
        yield 9;
      },
    }) as unknown as Seed;
    expect(mix32(seed, 3, [4, 5], 6)).toBe(0x4ec93050);
  });
});

describe("streamId", () => {
  test.each([
    ["", 0],
    ["conflicts", 0xef5bfc3e],
    ["weather.rain", 0x0438eefa],
  ])("of %j is %d, MurmurHash3 x86_32 of its UTF-8 with seed 0", (name, expected) => {
    expect(streamId(name)).toBe(expected);
    expect(murmur3x86_32(new TextEncoder().encode(name), 0)).toBe(expected);
  });

  test("rejects a name with a lone surrogate, or one that is not a string", () => {
    expect(engineErrorOf(() => streamId("a\ud800")).code).toBe("invalid_value");
    expect(engineErrorOf(() => streamId(7 as unknown as string)).issues).toEqual([
      { path: "", message: "the stream name must be a string, not number" },
    ]);
  });
});

describe("tickKey", () => {
  test("is [tickLo, tickHi, entityLo, entityHi]", () => {
    expect(tickKey(37, 5)).toEqual([37, 0, 5, 0]);
    expect(tickKey(0x1_0000_0001, Number.MAX_SAFE_INTEGER)).toEqual([1, 1, MAX, 0x1fffff]);
    expect(tickKey(0, -1)).toEqual([0, 0, MAX, MAX]);
  });

  test("rejects a tick that is not a tick and an entity that is not a safe integer", () => {
    const tick = engineErrorOf(() => tickKey(-1, 0));
    expect(tick.code).toBe("invalid_value");
    expect(tick.issues).toEqual([
      { path: "/tick", message: "-1 is not a tick: ticks are safe integers from 0" },
    ]);
    expect(engineErrorOf(() => tickKey(1.5, 2 ** 53)).issues).toEqual([
      { path: "/tick", message: "1.5 is not a tick: ticks are safe integers from 0" },
      { path: "/entity", message: "9007199254740992 is not a safe integer" },
    ]);
  });
});
