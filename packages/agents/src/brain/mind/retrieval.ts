/**
 * Retrieval in `mind@1` (ADR 0024, docs/architecture/mind.md "The brain mind@1", plan §K.3): which
 * record a being acts on, a food to walk to, a belief to tell, a belief to check, chosen in one
 * pass by age × importance × relevance. Recency halves over the half-life of a belief scaled by
 * retention, the trait of memory, so a being of high retention keeps to older records. The engine
 * already scales forgetting by retention; this is how the brain weighs what it still holds.
 */
import { floorDiv, mind } from "@open-origin/engine";

/** A record as retrieval ranks it: its local id, its age in seconds, and two factors in permille. */
export type Ranked = {
  readonly id: number;
  readonly age: number;
  readonly importance: number;
  readonly relevance: number;
};

/** The recency of a record of `age` seconds, in permille: 1000 now, 500 at one half-life. */
export function recency(age: number, halfLife: number): number {
  return floorDiv(1000 * halfLife, halfLife + age);
}

/** The score of `ranked`: recency × importance × relevance, at most 10^9. */
export function retrievalScore(ranked: Ranked, halfLife: number): number {
  return recency(ranked.age, halfLife) * ranked.importance * ranked.relevance;
}

/**
 * The record of `records` with the highest score, in one pass that ranks each record once; ties
 * go to the lower id. A record `rank` leaves out, or whose score is 0, is never retrieved.
 */
export function retrieve<T>(
  records: readonly T[],
  rank: (record: T) => Ranked | undefined,
  halfLife: number,
): T | undefined {
  let best: { record: T; id: number; score: number } | undefined;
  for (const record of records) {
    const ranked = rank(record);
    if (ranked === undefined) continue;
    const score = retrievalScore(ranked, halfLife);
    if (score === 0) continue;
    if (best === undefined || score > best.score || (score === best.score && ranked.id < best.id))
      best = { record, id: ranked.id, score };
  }
  return best?.record;
}

/** The half-life of recency for a being of `retention`: a belief's, scaled as the engine scales it. */
export function memoryHalfLife(
  laws: { readonly mind: { readonly halfLife: { readonly belief: number } } },
  retention: number,
): number {
  return mind.scaledHalfLife(laws.mind.halfLife.belief, retention);
}
