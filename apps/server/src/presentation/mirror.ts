/**
 * The mirror (ADR 0026, "Interest and transactions"): the presentation plane's copy of the public
 * world, built from the boot record and then from each published tick the playout hands it, in
 * order. It holds the current immutable version of every chunk that ever held a being, an index of
 * where each being is, and the rings of local speech and of the feed.
 *
 * Clients pin the versions they show and the versions their transaction reads. A pin is counted
 * per version; a version replaced while pinned is retained until its last pin goes, and the bytes
 * of retained versions are counted exactly (the limit that acts on them comes in T6-6b). A version
 * replaced with no pin is freed at once.
 */
import {
  type ChunkCoord,
  type Clock,
  chunkKey,
  type FeedItem,
  type LocalSpeech,
  MAX_FEED_ITEMS_PER_TICK,
} from "@open-origin/protocol/public";
import type { PublishedChunk, PublishedTick } from "../world/published.ts";
import { type RingBounds, TickRing } from "./ring.ts";
import { ChunkVersion, type EncodedBeing } from "./version.ts";

/** The one stream of the feed ring. */
export const FEED = "feed";

/** The boot tick, the tick, and the clock of a mirror that has its boot record. */
type Booted = { readonly boot: number; readonly tick: number; readonly clock: Clock };

/** The public world as the playout has released it, and the versions clients pin. */
export class Mirror {
  #at: Booted | undefined;
  /** The current version of every chunk that ever held a being since boot. */
  readonly #versions = new Map<string, ChunkVersion>();
  /** The chunk of each being, by id. */
  readonly #chunkOf = new Map<number, string>();
  /** The pins of each pinned version. */
  readonly #pins = new Map<ChunkVersion, number>();
  #pinCount = 0;
  #retainedBytes = 0;
  /** Local speech, one stream per chunk key. */
  readonly speech: TickRing;
  /** The feed, in the one stream FEED. */
  readonly feed: TickRing;

  constructor(bounds?: RingBounds) {
    this.speech = new TickRing(bounds);
    this.feed = new TickRing(bounds);
  }

  /** The tick of the last record applied. Throws before the boot record. */
  get tick(): number {
    return this.#booted().tick;
  }

  /** The clock of `tick`. */
  get clock(): Clock {
    return this.#booted().clock;
  }

  /** The tick of the boot record, the version of every chunk no tick changed. */
  get bootTick(): number {
    return this.#booted().boot;
  }

  /** How many pins all versions hold. */
  get pins(): number {
    return this.#pinCount;
  }

  /** The bytes of the versions that were replaced but are still pinned. */
  get retainedBytes(): number {
    return this.#retainedBytes;
  }

  /**
   * Applies `published`: first the boot record, then each tick right after the last, in order.
   * Its chunks become new versions, its speech goes to the speaker's chunk, and at most
   * MAX_FEED_ITEMS_PER_TICK of its feed items are kept, the rest counted.
   */
  apply(published: PublishedTick): void {
    const { tick, clock } = published;
    if (this.#at !== undefined && tick !== this.#at.tick + 1) {
      throw new Error(`the mirror is at tick ${this.#at.tick} and cannot apply tick ${tick}`);
    }
    const boot = this.#at?.boot ?? tick;
    for (const change of published.chunks) this.#change(change, boot);
    this.#at = { boot, tick, clock };
    this.#record(tick, published.speech, published.feed);
  }

  /** The current version of the chunk `at`: an empty one at the boot tick if none was made. */
  current(at: ChunkCoord): ChunkVersion {
    return this.#versions.get(chunkKey(at)) ?? ChunkVersion.empty(at, this.bootTick);
  }

  /** The chunk that holds the being `id` now, or undefined when no chunk does. */
  locate(id: number): ChunkCoord | undefined {
    const key = this.#chunkOf.get(id);
    return key === undefined ? undefined : this.#versions.get(key)?.at;
  }

  /** The record of the being `id` now, or undefined when no chunk holds it. */
  record(id: number): EncodedBeing | undefined {
    const key = this.#chunkOf.get(id);
    return key === undefined ? undefined : this.#versions.get(key)?.find(id);
  }

  /**
   * Pins `version`: it stays readable until unpinned. An empty version pins nothing. Only a current
   * version or one already pinned can be pinned: a replaced version with no pin was freed, and
   * pinning it would retain bytes the count of retained versions never added.
   */
  pin(version: ChunkVersion): void {
    if (!version.held) return;
    const pins = this.#pins.get(version);
    if (pins === undefined && this.#versions.get(version.key) !== version) {
      throw new Error(`the version ${version.v} of ${version.key} was replaced and is freed`);
    }
    this.#pins.set(version, (pins ?? 0) + 1);
    this.#pinCount += 1;
  }

  /** Removes one pin of `version`; a replaced version whose last pin goes is freed. */
  unpin(version: ChunkVersion): void {
    const pins = this.#pins.get(version);
    if (!version.held) return;
    if (pins === undefined)
      throw new Error(`the version ${version.v} of ${version.key} is not pinned`);
    this.#pinCount -= 1;
    if (pins > 1) {
      this.#pins.set(version, pins - 1);
      return;
    }
    this.#pins.delete(version);
    if (this.#versions.get(version.key) !== version) this.#retainedBytes -= version.bytes;
  }

  #booted(): Booted {
    if (this.#at === undefined) throw new Error("the mirror has not received its boot record");
    return this.#at;
  }

  /** Makes the version `change` brings, and retains the one it replaces while that is pinned. */
  #change(change: PublishedChunk, boot: number): void {
    const key = chunkKey(change.at);
    const old = this.#versions.get(key) ?? ChunkVersion.empty(change.at, boot);
    this.#versions.set(key, old.next(change));
    // A being that crossed in this tick may be upserted in its new chunk before it leaves the old.
    for (const id of change.gone) if (this.#chunkOf.get(id) === key) this.#chunkOf.delete(id);
    for (const { id } of change.upsert) this.#chunkOf.set(id, key);
    if (this.#pins.has(old)) this.#retainedBytes += old.bytes;
  }

  /** Keeps the speech and the feed of `tick` in the rings, which then drop what is too old. */
  #record(tick: number, speech: readonly LocalSpeech[], feed: readonly FeedItem[]): void {
    for (const { at, speech: said } of speech) {
      this.speech.add(chunkKey(at), tick, [JSON.stringify(said)], 1);
    }
    const kept = feed.slice(0, MAX_FEED_ITEMS_PER_TICK).map((item) => JSON.stringify(item));
    this.feed.add(FEED, tick, kept, feed.length);
    this.speech.evict(tick);
    this.feed.evict(tick);
  }
}
