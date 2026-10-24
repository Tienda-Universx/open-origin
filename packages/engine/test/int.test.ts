import { describe, expect, test } from "bun:test";
import { imul, int64Words, isU32, rotl32 } from "../src/int.ts";
import { engineErrorOf } from "./support/engine-error.ts";
import { Sfc32 } from "./support/sfc32.ts";

/**
 * The integer helpers (src/int.ts), the one engine module that may use `Math`. Expected values
 * come from BigInt, which tests may use and the engine may not need.
 */

const U32 = 2n ** 32n;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

describe("isU32", () => {
  test("accepts the integers from 0 to 2^32 - 1", () => {
    for (const value of [0, 1, 0x7fffffff, 0x80000000, 0xffffffff]) expect(isU32(value)).toBe(true);
  });

  test("rejects everything else", () => {
    for (const value of [-1, 0x1_0000_0000, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1", 1n]) {
      expect(isU32(value)).toBe(false);
    }
  });
});

describe("imul", () => {
  test("is the low 32 bits of the product, as an int32", () => {
    expect(imul(0xffffffff, 0xffffffff)).toBe(1);
    expect(imul(0x10000, 0x10000)).toBe(0);
    expect(imul(0x80000000, 3)).toBe(-0x80000000);
    const random = new Sfc32(7);
    for (let sample = 0; sample < 1_000; sample += 1) {
      const a = random.next();
      const b = random.next();
      expect(imul(a, b) >>> 0).toBe(Number((BigInt(a) * BigInt(b)) % U32));
    }
  });
});

describe("rotl32", () => {
  test("rotates left by 1 to 31 bits, as an int32", () => {
    expect(rotl32(0x80000001, 1)).toBe(3);
    expect(rotl32(0x12345678, 8)).toBe(0x34567812);
    expect(rotl32(0x40000000, 1)).toBe(-0x80000000);
    const random = new Sfc32(8);
    for (let bits = 1; bits < 32; bits += 1) {
      const value = random.next();
      const wide = BigInt(value) << BigInt(bits);
      expect(rotl32(value, bits) >>> 0).toBe(Number((wide % U32) | (wide / U32)));
    }
  });
});

describe("int64Words", () => {
  test.each([
    [0, 0, 0],
    [1, 1, 0],
    [-1, 0xffffffff, 0xffffffff],
    [0xffffffff, 0xffffffff, 0],
    [0x1_0000_0000, 0, 1],
    [-0x1_0000_0000, 0, 0xffffffff],
    [-0x1_0000_0001, 0xffffffff, 0xfffffffe],
    [MAX_SAFE, 0xffffffff, 0x1fffff],
    [-MAX_SAFE, 1, 0xffe00000],
  ])("splits %d into the two's complement words [%d, %d]", (value, lo, hi) => {
    expect(int64Words(value)).toEqual([lo, hi]);
  });

  test("agrees with BigInt.asUintN(64) for random safe integers of every size", () => {
    const random = new Sfc32(9);
    for (let sample = 0; sample < 1_000; sample += 1) {
      // Up to 53 bits of magnitude, with either sign.
      const magnitude = (random.next() % 0x200000) * 0x1_0000_0000 + random.next();
      const value = random.next() % 2 === 0 ? magnitude : -magnitude;
      const words = BigInt.asUintN(64, BigInt(value));
      expect(int64Words(value)).toEqual([Number(words % U32), Number(words / U32)]);
    }
  });

  test.each([
    ["a fraction", 1.5],
    ["2^53", MAX_SAFE + 1],
    ["-(2^53)", -(MAX_SAFE + 1)],
    ["NaN", Number.NaN],
  ])("rejects %s with invalid_value", (_name, value) => {
    const error = engineErrorOf(() => int64Words(value));
    expect(error.code).toBe("invalid_value");
    expect(error.issues).toEqual([{ path: "", message: `${String(value)} is not a safe integer` }]);
  });
});
