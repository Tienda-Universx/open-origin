import { describe, expect, test } from "bun:test";
import { floorDiv, floorMod, imul, int64Words, isU32, rotl32 } from "../src/int.ts";
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
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("rejects %s with invalid_value", (_name, value) => {
    const error = engineErrorOf(() => int64Words(value));
    expect(error.code).toBe("invalid_value");
    expect(error.issues).toEqual([{ path: "", message: `${String(value)} is not a safe integer` }]);
  });

  test.each([
    ["a symbol", Symbol("n"), "symbol"],
    ["a bigint", 2n, "bigint"],
    ["a string", "2", "string"],
  ])("rejects %s by its type", (_name, value, type) => {
    // Deliberately ill-typed, as a JavaScript caller can be.
    expect(engineErrorOf(() => int64Words(value as unknown as number)).issues).toEqual([
      { path: "", message: `a value of type ${type} is not a safe integer` },
    ]);
  });
});

/** A random safe integer of up to 53 bits of magnitude, with either sign. */
function randomSafe(random: Sfc32): number {
  const magnitude = (random.next() % 0x200000) * 0x1_0000_0000 + random.next();
  return random.next() % 2 === 0 ? magnitude : -magnitude;
}

/** ⌊a / b⌋ and a mod b with the sign of b, computed with BigInt. */
function floorReference(a: number, b: number): [number, number] {
  const [big, divisor] = [BigInt(a), BigInt(b)];
  const truncated = big / divisor;
  const quotient = big % divisor < 0n ? truncated - 1n : truncated;
  return [Number(quotient), Number(big - quotient * divisor)];
}

describe("floorDiv and floorMod", () => {
  test("agree with BigInt floor division on every pair in [-200, 200] x [1, 70]", () => {
    for (let a = -200; a <= 200; a += 1) {
      for (let b = 1; b <= 70; b += 1) {
        expect([floorDiv(a, b), floorMod(a, b)]).toEqual(floorReference(a, b));
      }
    }
  });

  test("agree with BigInt for random safe integers and divisors of every size", () => {
    const random = new Sfc32(21);
    let largeDivisors = 0;
    for (let sample = 0; sample < 5_000; sample += 1) {
      const a = randomSafe(random);
      // Dividing, not shifting: `>>>` would truncate the divisor to 32 bits.
      const b = Math.max(1, Math.floor(Math.abs(randomSafe(random)) / 2 ** (random.next() % 53)));
      if (b > 0xffffffff) largeDivisors += 1;
      expect([floorDiv(a, b), floorMod(a, b)]).toEqual(floorReference(a, b));
    }
    // The divisors span every size, beyond 32 bits too.
    expect(largeDivisors).toBeGreaterThan(500);
  });

  test.each([
    [MAX_SAFE, 1],
    [-MAX_SAFE, 1],
    [MAX_SAFE, 2],
    [-MAX_SAFE, 2],
    [MAX_SAFE, 3],
    [-MAX_SAFE, 3],
    [MAX_SAFE - 1, MAX_SAFE],
    [-MAX_SAFE, MAX_SAFE],
    [-1, MAX_SAFE],
    [-(2 ** 52) - 1, 2 ** 52],
    [2 ** 31, 32],
    [-(2 ** 31), 32],
    [-(2 ** 31) - 1, 32],
  ])("are exact at the edge (%d, %d)", (a, b) => {
    expect([floorDiv(a, b), floorMod(a, b)]).toEqual(floorReference(a, b));
  });

  test("round toward negative infinity: the cells -1, -32, and -33 of chunks of 32", () => {
    expect([floorDiv(-1, 32), floorMod(-1, 32)]).toEqual([-1, 31]);
    expect([floorDiv(-32, 32), floorMod(-32, 32)]).toEqual([-1, 0]);
    expect([floorDiv(-33, 32), floorMod(-33, 32)]).toEqual([-2, 31]);
  });

  test("never return -0, which is not canonical, even for the safe integer -0", () => {
    for (const [a, b] of [
      [-0, 5],
      [0, 5],
      [-5, 5],
      [-10, 5],
      [-MAX_SAFE, MAX_SAFE],
    ] as const) {
      expect(Object.is(floorDiv(a, b), -0)).toBe(false);
      expect(Object.is(floorMod(a, b), -0)).toBe(false);
    }
  });
});
