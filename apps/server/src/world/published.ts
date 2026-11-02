/**
 * What the world plane publishes to the presentation plane (ADR 0025, "Planes and the boundary"):
 * deep-frozen records, through one channel that runs one way. The presentation plane imports this
 * module as a type only, so it imports nothing itself. In T6-4 a published tick carries only its
 * tick; T6-5 adds its C0 projection.
 */

/** One published tick: a tick the journal committed. */
export type PublishedTick = { readonly tick: number };

/** A listener of published ticks. Its return value is ignored and its exceptions are isolated. */
export type PublishedListener = (published: PublishedTick) => unknown;

/** The published record of `tick`, frozen. */
export function publishedTick(tick: number): PublishedTick {
  return Object.freeze({ tick });
}
