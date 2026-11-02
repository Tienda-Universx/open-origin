/**
 * What the world plane publishes to the presentation plane (ADR 0025, "Planes and the boundary";
 * ADR 0026, "Projections and classification"): one deep-frozen C0 record per committed tick,
 * through one channel that runs one way. The presentation plane imports this module as a type
 * only, and this module imports only types of the public protocol, so that import reaches nothing
 * of the world.
 */
import type {
  BeingPublic,
  ChunkCoord,
  Clock,
  FeedItem,
  LocalSpeech,
} from "@open-origin/protocol/public";

/**
 * A chunk whose C0 content changed at the tick: its version `v`, the tick itself; the records of
 * the beings that entered it or whose record changed, by id; and the ids of those that left it.
 */
export type PublishedChunk = {
  readonly at: ChunkCoord;
  readonly v: number;
  readonly upsert: readonly BeingPublic[];
  readonly gone: readonly number[];
};

/**
 * One published tick: a tick the journal committed, its clock, the chunks whose C0 content it
 * changed, the local speech of the tick, each item in its speaker's chunk, and its feed.
 */
export type PublishedTick = {
  readonly tick: number;
  readonly clock: Clock;
  readonly chunks: readonly PublishedChunk[];
  readonly speech: readonly LocalSpeech[];
  readonly feed: readonly FeedItem[];
};

/** A listener of published ticks. Its return value is ignored and its exceptions are isolated. */
export type PublishedListener = (published: PublishedTick) => unknown;

/** `value`, a tree of records and arrays, frozen at every level. */
export function deepFrozen<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  for (const member of Object.values(value)) deepFrozen(member);
  return Object.freeze(value);
}
