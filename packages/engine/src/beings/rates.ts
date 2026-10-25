/**
 * The exact arithmetic of the beings layer (ADR 0023). Laws are rates per simulated second, written
 * as ratios num/den; a quantity that changes at a rate is computed in closed form from the second it
 * was anchored, so its value never depends on how often a being was processed. Every intermediate
 * value is a safe integer, whatever the elapsed time, because products that could leave the safe
 * integers are split or saturated first.
 */
import { floorDiv } from "../int.ts";

/** A rate of `num` units per `den` simulated seconds. */
export type Ratio = { readonly num: number; readonly den: number };

/**
 * The bounds of a ratio's terms. They keep num·den below 2^53, which is what makes scaledFloor
 * exact: the largest numerator is 2^20 units per second and the slowest rate one unit per 2^32
 * seconds, about 136 years.
 */
export const RATIO_BOUNDS = Object.freeze({
  num: Object.freeze({ min: 0, max: 0x10_0000 }),
  den: Object.freeze({ min: 1, max: 0x1_0000_0000 }),
});

/** The largest value of a need or of health: the fixed-point 0 to 1,000,000 of plan §I.1.4. */
export const NEED_MAX = 1_000_000;

/** ⌈a / b⌉ for a safe integer a ≥ 0 and a positive safe integer b, without computing a + b − 1. */
export function ceilDiv(a: number, b: number): number {
  const quotient = floorDiv(a, b);
  return quotient * b === a ? quotient : quotient + 1;
}

/**
 * ⌊num·seconds/den⌋ for `seconds` ≥ 0, or `cap` when that is larger. It is computed as
 * num·⌊seconds/den⌋ + ⌊num·(seconds mod den)/den⌋, which is the same integer; the second product
 * is below num·den, and the first is taken only once it cannot exceed `cap`. The caller guarantees
 * a ratio within RATIO_BOUNDS, safe integers, and `cap` ≥ 0.
 */
export function scaledFloor(rate: Ratio, seconds: number, cap: number): number {
  if (rate.num === 0 || seconds === 0) return 0;
  const whole = floorDiv(seconds, rate.den);
  // num·whole > cap once whole exceeds ⌊cap/num⌋, and then so does the result.
  if (whole > floorDiv(cap, rate.num)) return cap;
  const part = floorDiv(rate.num * (seconds - whole * rate.den), rate.den);
  const value = rate.num * whole + part;
  if (value > cap) return cap;
  return value;
}

/** A level that falls (`sign` −1) or rises (`sign` 1) at `rate`. */
export type Trend = { readonly rate: Ratio; readonly sign: -1 | 1 };

/** The level `seconds` after it was `from`, clamped to [0, NEED_MAX]. */
export function levelAt(from: number, trend: Trend, seconds: number): number {
  if (trend.sign < 0) return from - scaledFloor(trend.rate, seconds, from);
  return from + scaledFloor(trend.rate, seconds, NEED_MAX - from);
}

/**
 * The fewest seconds after which a level that was `from` reaches `target`: at or below it when it
 * falls, at or above it when it rises. 0 when it already has; undefined when it never will, because
 * its rate is 0. `target` lies in [0, NEED_MAX]. Exact: ⌊num·E/den⌋ ≥ d holds exactly when
 * num·E ≥ d·den, that is when E ≥ ⌈d·den/num⌉, and d·den stays below 2^53.
 */
export function secondsToReach(from: number, trend: Trend, target: number): number | undefined {
  const distance = trend.sign < 0 ? from - target : target - from;
  if (distance <= 0) return 0;
  if (trend.rate.num === 0) return undefined;
  return ceilDiv(distance * trend.rate.den, trend.rate.num);
}
