import { describe, expect, test } from "bun:test";
import { murmur3x86_32, murmur3x86_32Words, murmur3x86_128 } from "../src/digest/murmur3.ts";
import { Sfc32 } from "./support/sfc32.ts";

/**
 * MurmurHash3 x86_32 and x86_128, ported from the public-domain reference in SMHasher
 * (https://github.com/aappleby/smhasher/blob/07bb4de10a63e8cc2e1724865454eba635742383/src/MurmurHash3.cpp).
 * Every expected value below is copied from the source cited next to it.
 */

const encoder = new TextEncoder();

/** `words` as little-endian bytes, the layout the reference writes its hashes in. */
function leBytes(words: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(words.length * 4);
  const view = new DataView(bytes.buffer);
  for (const [index, word] of words.entries()) view.setUint32(index * 4, word, true);
  return bytes;
}

function hex(words: readonly number[]): string {
  return words.map((word) => word.toString(16).padStart(8, "0")).join("");
}

/**
 * SMHasher's VerificationTest (src/KeysetTest.cpp, lines 13-42 at the commit above): hash the
 * keys {}, {0}, {0, 1}, ..., {0, ..., 254} with the seed 256 - length, hash the concatenated
 * results with seed 0, and read the first four bytes of that hash as a little-endian integer.
 */
function verificationValue(hash: (key: Uint8Array, seed: number) => readonly number[]): number {
  const key = Uint8Array.from({ length: 256 }, (_, index) => index);
  const results = Array.from({ length: 256 }, (_, length) =>
    hash(key.subarray(0, length), 256 - length),
  );
  const [first = Number.NaN] = hash(leBytes(results.flat()), 0);
  return first;
}

describe("SMHasher verification values", () => {
  // src/main.cpp, lines 78-79 at the commit above:
  // { MurmurHash3_x86_32,   32, 0xB0F57EE3, "Murmur3A", "MurmurHash3 for x86, 32-bit" },
  // { MurmurHash3_x86_128, 128, 0xB3ECE62A, "Murmur3C", "MurmurHash3 for x86, 128-bit" },
  test("MurmurHash3_x86_32 gives 0xB0F57EE3", () => {
    expect(verificationValue((key, seed) => [murmur3x86_32(key, seed)])).toBe(0xb0f57ee3);
  });

  test("MurmurHash3_x86_128 gives 0xB3ECE62A", () => {
    expect(verificationValue(murmur3x86_128)).toBe(0xb3ece62a);
  });
});

describe("published vectors", () => {
  // Ian Boyd's vectors, from an implementation that passes the SMHasher verification:
  // https://stackoverflow.com/a/31929528
  test.each([
    [[], 0, 0],
    [[], 1, 0x514e28b7],
    [[], 0xffffffff, 0x81f16f39],
    [[0xff, 0xff, 0xff, 0xff], 0, 0x76293b50],
    [[0x21, 0x43, 0x65, 0x87], 0, 0xf55b516b],
    [[0x21, 0x43, 0x65, 0x87], 0x5082edee, 0x2362f9de],
    [[0x21, 0x43, 0x65], 0, 0x7e4a8634],
    [[0x21, 0x43], 0, 0xa0f7b07a],
    [[0x21], 0, 0x72661cf4],
    [[0, 0, 0, 0], 0, 0x2362f9de],
    [[0, 0, 0], 0, 0x85f0b427],
    [[0, 0], 0, 0x30f4c306],
    [[0], 0, 0x514e28b7],
  ])("x86_32 of the bytes %j with seed %d is %d", (bytes, seed, expected) => {
    expect(murmur3x86_32(Uint8Array.from(bytes), seed)).toBe(expected);
  });

  test.each([
    ["Hello, world!", 0x9747b28c, 0x24884cba],
    ["\u03c0".repeat(8), 0x9747b28c, 0xd58063c1],
    ["a".repeat(256), 0x9747b28c, 0x37405bdc],
    ["The quick brown fox jumps over the lazy dog", 0x9747b28c, 0x2fa826cd],
  ])("x86_32 of the UTF-8 of %j with seed %d is %d (Stack Overflow)", (text, seed, expected) => {
    expect(murmur3x86_32(encoder.encode(text), seed)).toBe(expected);
  });

  // Peter Scott's port and its tests:
  // https://github.com/PeterScott/murmur3/blob/dae94be0c0f54a399d23ea6cbe54bca5a4e93ce4/test.c
  test.each([
    [1234, "Hello, world!", "faf6cdb3"],
    [4321, "Hello, world!", "bf505788"],
    [1234, "x".repeat(28), "8905ac28"],
    [1234, "", "0f2cc00b"],
  ])("x86_32 with seed %d of %j is %s (Peter Scott)", (seed, text, expected) => {
    expect(hex([murmur3x86_32(encoder.encode(text), seed)])).toBe(expected);
  });

  test.each([
    [123, "Hello, world!", "61c9129e5a1aacd7a41621629e37c886"],
    [321, "Hello, world!", "d5fbdcb3c26c4193045880c5a7170f0f"],
    [123, "x".repeat(28), "5e40bab278825a164cf929d31fec6047"],
    [123, "", "fedc524526f3e79926f3e79926f3e799"],
  ])("x86_128 with seed %d of %j is %s (Peter Scott)", (seed, text, expected) => {
    expect(hex(murmur3x86_128(encoder.encode(text), seed))).toBe(expected);
  });
});

describe("inputs", () => {
  test("a view into a larger buffer hashes as a copy of its bytes", () => {
    const random = new Sfc32(21);
    const buffer = Uint8Array.from({ length: 300 }, () => random.below(256));
    for (const [start, end] of [
      [3, 3],
      [1, 18],
      [7, 300],
      [5, 37],
    ] as const) {
      const view = buffer.subarray(start, end);
      const copy = Uint8Array.from(view);
      expect(murmur3x86_32(view, 9)).toBe(murmur3x86_32(copy, 9));
      expect(murmur3x86_128(view, 9)).toEqual(murmur3x86_128(copy, 9));
    }
  });

  test("the word variant equals the byte variant over the words' little-endian bytes", () => {
    const random = new Sfc32(22);
    for (let sample = 0; sample < 1_000; sample += 1) {
      const words = Array.from({ length: random.below(24) }, () => random.next());
      const seed = random.next();
      expect(murmur3x86_32Words(words, seed)).toBe(murmur3x86_32(leBytes(words), seed));
    }
  });
});
