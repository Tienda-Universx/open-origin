/**
 * The arithmetic of utility (plan §5.3): response curves that map an input to a consideration in
 * permille, and the score of a behavior from its considerations. Everything is integer: the brain
 * shares the engine's rule against inexact math (ADR 0003), and floorDiv rounds every quotient the
 * same way on every engine.
 */
import { floorDiv } from "@open-origin/engine";

/** The unit of every consideration and score: 1000 is "fully". */
export const PERMILLE = 1000;

/**
 * A piecewise-linear response curve: its points `[x0, y0, x1, y1, …]`, with x strictly rising.
 * Below x0 it gives y0, above the last x the last y, and between two points the line through them,
 * rounded down.
 */
export type Curve = readonly number[];

/** The value of `curve` at `x`, for integer points and an integer `x`. */
export function respond(curve: Curve, x: number): number {
  const last = curve.length - 2;
  if (x <= (curve[0] as number)) return curve[1] as number;
  for (let at = 2; at <= last; at += 2) {
    const x1 = curve[at] as number;
    if (x > x1) continue;
    const x0 = curve[at - 2] as number;
    const y0 = curve[at - 1] as number;
    const y1 = curve[at + 1] as number;
    return y0 + floorDiv((x - x0) * (y1 - y0), x1 - x0);
  }
  return curve[last + 1] as number;
}

/**
 * The score of a behavior from its considerations, each in permille: their product, with the
 * compensation of Mark and Dill's Infinite Axis Utility System, which lifts each factor by
 * (1 − c)·(1 − 1/n)·c so that a behavior with more considerations is not penalized for having
 * them. A consideration of 0 still vetoes the behavior, and one of 1000 leaves the others whole.
 */
export function compensated(considerations: readonly number[]): number {
  const count = considerations.length;
  if (count === 0) return 0;
  const modification = PERMILLE - floorDiv(PERMILLE, count);
  let score = PERMILLE;
  for (const value of considerations) {
    const lift = floorDiv((PERMILLE - value) * modification * value, PERMILLE * PERMILLE);
    score = floorDiv(score * (value + lift), PERMILLE);
  }
  return score;
}

/** The smaller of `a` and `b`. Math is denied in the brain, as in the engine (ADR 0003). */
export function least(a: number, b: number): number {
  if (a < b) return a;
  return b;
}

/** The larger of `a` and `b`. */
export function greatest(a: number, b: number): number {
  if (a > b) return a;
  return b;
}

/** `value` scaled by a trait in permille, at most 1000: a trait of 1200 makes a need 20% stronger. */
export function felt(value: number, trait: number): number {
  return least(floorDiv(value * trait, PERMILLE), PERMILLE);
}
