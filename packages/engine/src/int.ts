/**
 * Integer helpers over 32-bit words. This is the one engine module that may use `Math` (ADR
 * 0020): biome.json exempts it, and only it, from global-math.grit. It uses only functions that
 * ECMA-262 defines exactly, `Math.imul` and `Math.floor`, never the approximated ones (ADR 0003).
 *
 * The word operations return int32 values, as JavaScript's bitwise operators do: engines keep
 * those in integer registers, while a u32 above 2^31 - 1 becomes a double, which made MurmurHash3
 * several times slower on Bun 1.4.4 (measured 7 to 14 times). `x >>> 0` turns a word into its
 * u32.
 */
import { describeValue, EngineError } from "./errors.ts";

/** The largest u32, 2^32 - 1. */
export const MAX_U32 = 0xffffffff;

/** 2^32, how many u32 values there are. */
export const U32_COUNT = 0x1_0000_0000;

/** Whether `value` is an integer from 0 to 2^32 - 1. */
export function isU32(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_U32;
}

/** The low 32 bits of `a * b`, as an int32; `a` and `b` are taken modulo 2^32. */
export const imul: (a: number, b: number) => number = Math.imul;

/** The 32-bit word `value` rotated left by `bits`, from 1 to 31, as an int32. */
export function rotl32(value: number, bits: number): number {
  return (value << bits) | (value >>> (32 - bits));
}

/**
 * The 64-bit two's complement of the safe integer `value`, as two u32 words, low first. Dividing
 * by 2^32 only changes the exponent, so the quotient is exact and so is its floor. Throws
 * EngineError("invalid_value") when `value` is not a safe integer.
 */
export function int64Words(value: number): readonly [number, number] {
  if (!Number.isSafeInteger(value)) {
    throw new EngineError("invalid_value", [
      { path: "", message: `${describeValue(value)} is not a safe integer` },
    ]);
  }
  return [value >>> 0, Math.floor(value / U32_COUNT) >>> 0];
}

/**
 * ⌊a / b⌋, rounded toward negative infinity, for a safe integer `a` and a positive safe integer
 * `b`; the caller guarantees both, as hot paths validate their inputs once. It is exact: when the
 * quotient is not an integer, it lies at least 1/b from the nearest one, while its rounding error is
 * below half an ulp, which for a quotient below 2^53/b is below 1/b, so the rounding never reaches
 * an integer. `+ 0` turns -0 into 0, which canonical values require.
 */
export function floorDiv(a: number, b: number): number {
  return Math.floor(a / b) + 0;
}

/**
 * a − b·⌊a / b⌋, in [0, b), for a safe integer `a` and a positive safe integer `b`; the caller
 * guarantees both. The remainder `%` is exact for doubles, and adding `b` to a negative remainder
 * gives an integer below b, which is exact too. `+ 0` turns the -0 of `-5 % 5` into 0.
 */
export function floorMod(a: number, b: number): number {
  const remainder = a % b;
  return remainder < 0 ? remainder + b : remainder + 0;
}

/** The smaller of `a` and `b`, without `Math.min`, which this module does not use. */
export function least(a: number, b: number): number {
  if (a < b) return a;
  return b;
}

/** The larger of `a` and `b`. */
export function greatest(a: number, b: number): number {
  if (a > b) return a;
  return b;
}

/** ⌈a / b⌉ for a safe integer a ≥ 0 and a positive safe integer b, without computing a + b − 1. */
export function ceilDiv(a: number, b: number): number {
  const quotient = floorDiv(a, b);
  return quotient * b === a ? quotient : quotient + 1;
}
