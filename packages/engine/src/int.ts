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
