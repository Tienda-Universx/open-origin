/**
 * Locomotion (ADR 0023): how long a step takes, from the terrain it crosses and the species' law.
 * The search of a brain and the engine's validation use this one function, so the cost a brain
 * optimizes is the time the engine charges.
 */
import type { Species } from "./laws.ts";
import { ceilDiv, scaledFloor } from "./rates.ts";

/** What a step crosses: the elevation difference, the liquid depth it enters, and its kind. */
export type StepGeometry = {
  readonly rise: number;
  readonly depth: number;
  readonly diagonal: boolean;
};

/** Each penalty adds at most 2^30 ms, so a step lasts at most about 3 × 10^9 ms, below 2^32. */
const PENALTY_CAP = 0x4000_0000;

/** Thousandths of a flat step that an orthogonal and a diagonal step take: 1 and ⌊1000·√2⌋. */
const ORTHOGONAL = 1000;
const DIAGONAL = 1414;

/**
 * The milliseconds of a step of `geometry` under `law`, or −1 when it rises more than `maxRise` or
 * enters liquid deeper than `maxWade`: ⌈f·(stepMs + ⌊rise·Δ⌋ + ⌊wade·depth⌋)/1000⌉, with f = 1000
 * for an orthogonal step and 1414 for a diagonal one. The caller guarantees a valid law, and a
 * non-negative rise and depth.
 */
export function stepDuration(law: Species["locomotion"], geometry: StepGeometry): number {
  if (geometry.rise > law.maxRise || geometry.depth > law.maxWade) return -1;
  const extra =
    scaledFloor(law.rise, geometry.rise, PENALTY_CAP) +
    scaledFloor(law.wade, geometry.depth, PENALTY_CAP);
  const factor = geometry.diagonal ? DIAGONAL : ORTHOGONAL;
  return ceilDiv(factor * (law.stepMs + extra), 1000);
}

/**
 * The cheapest orthogonal and diagonal steps `law` allows: on flat, dry ground. Every step costs at
 * least these, so an octile heuristic built on them is admissible and consistent; and
 * straight ≤ diagonal ≤ 2·straight.
 */
export function minimumSteps(law: Species["locomotion"]): {
  readonly straight: number;
  readonly diagonal: number;
} {
  return {
    straight: stepDuration(law, { rise: 0, depth: 0, diagonal: false }),
    diagonal: stepDuration(law, { rise: 0, depth: 0, diagonal: true }),
  };
}
