/**
 * The bounds of the values a mind holds (ADR 0024, docs/architecture/mind.md "The mind of a
 * being"), and the integer helpers of the mind layer. The layer may not import the beings layer or
 * worldgen, so the few helpers and bounds it shares with them are written here again; tests pin
 * that they agree.
 */
import { floorDiv } from "../int.ts";

/** The integers from `min` to `max`, both included. */
export type IntRange = { readonly min: number; readonly max: number };

/** A frozen range. */
export function range(min: number, max: number): IntRange {
  return Object.freeze({ min, max });
}

/** 2^31 − 1: the last value of `next`, of `lost`, and of an age in a view. */
export const INT31_MAX = 0x7fff_ffff;

/**
 * The bounds of every value of a mind. The chunk validator cannot see the laws, so the stores are
 * bounded by the largest capacity a law allows, `depth` by the deepest `mind.depth`, and `turns`
 * and the daily counts by the largest `speech.turns` and `speech.perDay`.
 */
export const MIND_BOUNDS = Object.freeze({
  /** `next`; a record's id lies below it, so ids run out at 2^31 − 2. */
  next: range(1, INT31_MAX),
  tick: range(0, Number.MAX_SAFE_INTEGER),
  entity: range(1, Number.MAX_SAFE_INTEGER),
  /** A cell's coordinates, as worldgen bounds them. */
  cell: range(-0x8000_0000, 0x7fff_ffff),
  /** A proposition's value and its integer terms: any safe integer. */
  integer: range(Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
  /** Importance, confidence, and trust. */
  permille: range(0, 1000),
  affinity: range(-1000, 1000),
  taints: range(0, 7),
  /** A belief's `src`: any union of 1 seen, 2 told, 4 inferred, and 8 external. */
  evidence: range(0, 15),
  citations: range(0, 3),
  lost: range(0, INT31_MAX),
  depth: range(1, 8),
  /** A speaker's confidence band, and a food band. */
  band: range(0, 2),
  /** An episode's value: the largest is the units of a bite, which life@1 bounds by 2^20. */
  value: range(0, 0x10_0000),
  /** The reason a `failed` episode indexes (records.ts, FAILURES). */
  failure: range(0, 3),
  /** Familiarity in seconds: it saturates at ⌈1000 / rate⌉, which the laws keep at most 2^22. */
  familiarity: range(0, 0x40_0000),
  turns: range(0, 8),
  daily: range(0, 64),
  episodes: range(0, 16),
  beliefs: range(0, 16),
  relations: range(0, 12),
  inbox: range(0, 4),
});

/** Whether `value` lies within `bounds`. */
export function within(value: number, bounds: IntRange): boolean {
  return value >= bounds.min && value <= bounds.max;
}

/** The smaller of `a` and `b`; `Math` is denied outside int.ts (ADR 0003). */
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
