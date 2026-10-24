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

  test("describes a word that is not a number by its type alone, without running its code", () => {
    const hostile = {
      valueOf: () => {
        throw new Error("valueOf ran");
      },
      toString: () => {
        throw new Error("toString ran");
      },
    };
    // Deliberately ill-typed, as a JavaScript caller can be.
    const key = ["1", hostile, true, 1n] as unknown as readonly number[];
    const notU32 = (type: string) => `a value of type ${type} is not an integer in [0, 4294967295]`;
    expect(engineErrorOf(() => mix32([1, 2], 0, key, 0)).issues).toEqual([
      { path: "/key/0", message: notU32("string") },
      { path: "/key/1", message: notU32("object") },
      { path: "/key/2", message: notU32("boolean") },
      { path: "/key/3", message: notU32("bigint") },
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

describe("mix32 key length", () => {
  const NOT_SHORT = (length: number) => `the key must have at most 64 words, not ${length}`;
  const words = (length: number) => Array.from({ length }, (_, index) => index);

  test("accepts a key of 64 words, the maximum", () => {
    const key = words(64);
    expect(mix32([1, 2], 3, key, 6)).toBe(murmur3x86_32Words([2, 3, 64, ...key, 6], 1));
    expect(new DrawSequence([1, 2], 3, key, 6).u32()).toBe(mix32([1, 2], 3, key, 6));
  });

  test("rejects a key of 65 words, in mix32 and in DrawSequence, without reading its words", () => {
    let reads = 0;
    const key = Object.defineProperty(words(65), 0, {
      get: () => {
        reads += 1;
        return 0;
      },
      enumerable: true,
    });
    const expected = [{ path: "/key", message: NOT_SHORT(65) }];
    expect(engineErrorOf(() => mix32([1, 2], 3, key, 6)).issues).toEqual(expected);
    expect(engineErrorOf(() => new DrawSequence([1, 2], 3, key)).issues).toEqual(expected);
    expect(reads).toBe(0);
  });

  test("rejects the longest array, of 2^32 - 1 holes, at once instead of scanning it", () => {
    const key: number[] = [];
    key.length = 0xffffffff;
    expect(engineErrorOf(() => mix32([1, 2], 3, key, 6)).issues).toEqual([
      { path: "/key", message: NOT_SHORT(0xffffffff) },
    ]);
  });

  test("rejects a length that is not a u32, which only a Proxy can report", () => {
    const key = new Proxy([4, 5], {
      get: (target, property) => (property === "length" ? Number.POSITIVE_INFINITY : target[0]),
    });
    expect(engineErrorOf(() => mix32([1, 2], 3, key, 6)).issues).toEqual([
      { path: "/key", message: "the key must have at most 64 words, not Infinity" },
    ]);
  });

  test("reports the other inputs' issues along with the key's length", () => {
    const error = engineErrorOf(() => mix32([1, -1], 3, words(65), -2));
    expect(error.issues).toEqual([
      { path: "/seed/1", message: NOT_U32(-1) },
      { path: "/key", message: NOT_SHORT(65) },
      { path: "/n", message: NOT_U32(-2) },
    ]);
  });
});

describe("mix32 rejects holes", () => {
  const HOLE = "the element is a hole: the array must be dense";

  /** [4, hole, 5], whose prototype may supply index 1. */
  function holed(inherited?: number): number[] {
    const key: number[] = [];
    key[0] = 4;
    key[2] = 5;
    if (inherited !== undefined) {
      Object.setPrototypeOf(key, Object.create(Array.prototype, { 1: { value: inherited } }));
    }
    return key;
  }

  test("a key with a hole is rejected at the hole's path", () => {
    expect(engineErrorOf(() => mix32([1, 2], 3, holed(), 6)).issues).toEqual([
      { path: "/key/1", message: HOLE },
    ]);
  });

  test("a hole is rejected even when the key's prototype has a word at its index", () => {
    const key = holed(7);
    expect(Array.isArray(key) && key[1] === 7).toBe(true);
    expect(engineErrorOf(() => mix32([1, 2], 3, key, 6)).issues).toEqual([
      { path: "/key/1", message: HOLE },
    ]);
    expect(engineErrorOf(() => new DrawSequence([1, 2], 3, key)).issues).toEqual([
      { path: "/key/1", message: HOLE },
    ]);
  });

  test("a seed with a hole is rejected, whatever its prototype holds", () => {
    const seed: number[] = [];
    seed[1] = 2;
    Object.setPrototypeOf(seed, Object.create(Array.prototype, { 0: { value: 1 } }));
    // Deliberately ill-typed, as a JavaScript caller can be.
    const pair = seed as unknown as Seed;
    expect(engineErrorOf(() => mix32(pair, 3, [4, 5], 6)).issues).toEqual([
      { path: "/seed/0", message: HOLE },
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
