/**
 * The terrain of chunks that enter a view (ADR 0026, "Limits and backpressure": at most 16 chunks
 * generated per period across all clients, from a fair queue, with an LRU of 2,048 entries).
 * Terrain is generated from the world's genesis by `readTerrain`, a closure of the world plane,
 * and encoded once; the most recently used entries are kept, and a cache hit generates nothing.
 *
 * A transaction fixes its content when it starts, terrain included, so it starts only once the
 * terrain of every chunk it brings is at hand; until then the client waits, its view at L. While
 * the period's budget lasts, missing terrain is generated at once. What the budget cannot cover
 * waits in a queue served first come, first served: at the start of each period, before any new
 * request, the budget goes to the clients that wait in the order they arrived, each until it needs
 * nothing more, then to the next. A client that waits asks again at each of its turns in the
 * fan-out; one whose needs changed meanwhile goes to the back, with nothing held for it, so no
 * client keeps its place by asking for other chunks.
 *
 * Terrain is held outside the cache for the head of the queue alone, so the cache cannot evict it
 * before the head's transaction starts. The bound: what is held is some of the head's needs, which
 * `take` caps at MAX_VIEW_CHUNKS, so at most 73 chunks of at most WIDEST_TERRAIN_BYTES, 905,273
 * bytes, whatever the number of clients. The clients behind the head hold nothing: what the queue
 * serves them goes to the cache, and a chunk it evicts before their transaction starts waits for
 * them again, served in their turn. No client whose needs stay the same starves: the head's hold
 * only grows, so it needs nothing more within ⌈73 / 16⌉ = 5 periods, and keeps its place until its
 * transaction starts at its next turn in the fan-out; then the next client in arrival order is the
 * head, and holds what the cache has of its needs.
 */
import {
  type ChunkCoord,
  chunkKey,
  encodeTerrain,
  MAX_VIEW_CHUNKS,
  SUBSTRATE_CODES,
  type TerrainPublic,
} from "@open-origin/protocol/public";
import { byteLength } from "./bytes.ts";
import type { ClientId } from "./interest.ts";
import type { EncodedText } from "./parts.ts";

/** The entries the cache keeps. */
export const TERRAIN_ENTRIES = 2048;

/** The most chunks of terrain generated per period, across all clients. */
export const TERRAIN_PER_PERIOD = 16;

/**
 * The bytes of the widest terrain a chunk may have: every field at its widest width, a substrate
 * always one byte. The size of a terrain's JSON depends only on its widths, which are the world's
 * and never the chunk's.
 */
export const WIDEST_TERRAIN_BYTES = byteLength(
  JSON.stringify(
    encodeTerrain(
      {
        elevation: Array(1024).fill(0),
        liquidDepth: Array(1024).fill(0),
        substrate: Array(1024).fill(0),
      },
      {
        elevation: { min: -0x8000_0000, max: 0x7fff_ffff },
        liquidDepth: { min: 0, max: 0xffff_ffff },
        substrate: { min: 0, max: SUBSTRATE_CODES.length - 1 },
      },
    ),
  ),
);

/** The encoded terrain of the chunks used last. */
export class TerrainCache {
  readonly #read: (chunk: ChunkCoord) => TerrainPublic;
  readonly #entries: number;
  /** By chunk key, the least recently used first. */
  readonly #cache = new Map<string, EncodedText>();
  #reads = 0;

  constructor(read: (chunk: ChunkCoord) => TerrainPublic, entries = TERRAIN_ENTRIES) {
    this.#read = read;
    this.#entries = entries;
  }

  /** How many times the terrain was generated: a cache hit generates nothing. */
  get reads(): number {
    return this.#reads;
  }

  /** The encoded terrain of `at` when the cache holds it, which then counts as used last. */
  cached(at: ChunkCoord): EncodedText | undefined {
    const key = chunkKey(at);
    const cached = this.#cache.get(key);
    if (cached === undefined) return undefined;
    this.#cache.delete(key);
    this.#cache.set(key, cached);
    return cached;
  }

  /** The encoded terrain of `at`, generated when the cache does not hold it. */
  of(at: ChunkCoord): EncodedText {
    const cached = this.cached(at);
    if (cached !== undefined) return cached;
    this.#reads += 1;
    const json = JSON.stringify(this.#read(at));
    const encoded = Object.freeze({ json, bytes: byteLength(json) });
    this.#cache.set(chunkKey(at), encoded);
    for (const oldest of this.#cache.keys()) {
      if (this.#cache.size <= this.#entries) break;
      this.#cache.delete(oldest);
    }
    return encoded;
  }
}

/** A client that waits: the chunks it needs, by key, and those the queue has yet to serve it. */
type Waiting = {
  readonly needs: ReadonlyMap<string, ChunkCoord>;
  /** In the order the queue serves them. */
  pending: ChunkCoord[];
};

const NOTHING_HELD: ReadonlyMap<string, EncodedText> = new Map();

/** `chunks` by chunk key, each once. */
function keyed(chunks: readonly ChunkCoord[]): Map<string, ChunkCoord> {
  return new Map(chunks.map((at) => [chunkKey(at), at]));
}

/** Whether `a` and `b` hold the same chunk keys. */
function sameKeys(a: ReadonlyMap<string, ChunkCoord>, b: ReadonlyMap<string, ChunkCoord>): boolean {
  if (a.size !== b.size) return false;
  for (const key of a.keys()) if (!b.has(key)) return false;
  return true;
}

/** The terrain of `chunks`, from `held` when there, else the cache's, and the chunks missing. */
function fromCache(
  chunks: Iterable<ChunkCoord>,
  held: ReadonlyMap<string, EncodedText>,
  cache: TerrainCache,
): { readonly found: Map<string, EncodedText>; readonly missing: ChunkCoord[] } {
  const found = new Map<string, EncodedText>();
  const missing: ChunkCoord[] = [];
  for (const at of chunks) {
    const key = chunkKey(at);
    const terrain = held.get(key) ?? cache.cached(at);
    if (terrain === undefined) missing.push(at);
    else found.set(key, terrain);
  }
  return { found, missing };
}

/**
 * The budget of terrain generations per period, and the queue of the clients that wait, served
 * first come, first served, with terrain held for its head alone.
 */
export class TerrainQueue {
  readonly #cache: TerrainCache;
  readonly #perPeriod: number;
  /** The clients that wait, in the order they arrived: the first is the head. */
  readonly #waiting = new Map<ClientId, Waiting>();
  /** The terrain held for the head, by chunk key: some of its needs, so at most MAX_VIEW_CHUNKS. */
  #held = new Map<string, EncodedText>();
  #left: number;

  constructor(cache: TerrainCache, perPeriod = TERRAIN_PER_PERIOD) {
    if (!Number.isSafeInteger(perPeriod) || perPeriod < 1) {
      throw new RangeError(`a period generates at least one chunk of terrain, not ${perPeriod}`);
    }
    this.#cache = cache;
    this.#perPeriod = perPeriod;
    this.#left = perPeriod;
  }

  /** How many chunks of terrain the queue has yet to serve the clients that wait. */
  get queued(): number {
    let queued = 0;
    for (const { pending } of this.#waiting.values()) queued += pending.length;
    return queued;
  }

  /** How many chunks of terrain are held for the head of the queue: at most MAX_VIEW_CHUNKS. */
  get held(): number {
    return this.#held.size;
  }

  /**
   * Starts a period: the budget is whole again, and the clients that wait are served first, in the
   * order they arrived, each until it needs nothing more, while the budget lasts. A generation that
   * throws removes its client from the queue and reports it through `fault`; the queue goes on
   * with the next client.
   */
  period(fault: (client: ClientId, cause: unknown) => void): void {
    this.#left = this.#perPeriod;
    // A Map's iteration skips the entries deleted during it, so a client a fault removed is skipped.
    for (const [client, waiting] of this.#waiting) {
      if (this.#left === 0) return;
      try {
        this.#serve(client, waiting);
      } catch (cause) {
        this.remove(client);
        fault(client, cause);
      }
    }
  }

  /**
   * The terrain of every chunk of `chunks` for `client`, generated now while the period's budget
   * lasts; or undefined while some chunk still waits, and the client then waits in the queue: in
   * its place when it waited already for the same chunks, in any order, else at the back, with
   * nothing held for it. Once it returns the terrain, the client leaves the queue.
   */
  take(
    client: ClientId,
    chunks: readonly ChunkCoord[],
  ): ReadonlyMap<string, EncodedText> | undefined {
    if (chunks.length > MAX_VIEW_CHUNKS) {
      throw new RangeError(
        `a client needs at most ${MAX_VIEW_CHUNKS} chunks of terrain, not ${chunks.length}`,
      );
    }
    const needs = keyed(chunks);
    const waiting = this.#waiting.get(client);
    if (waiting !== undefined && !sameKeys(waiting.needs, needs)) this.remove(client);
    const held = this.#isHead(client) ? this.#held : NOTHING_HELD;
    const { found, missing } = fromCache(needs.values(), held, this.#cache);
    const pending: ChunkCoord[] = [];
    for (const at of missing) {
      if (this.#left > 0) found.set(chunkKey(at), this.#generate(at));
      else pending.push(at);
    }
    if (pending.length === 0) {
      this.remove(client);
      return found;
    }
    this.#wait(client, needs, pending, found);
    return undefined;
  }

  /** Forgets `client`: what it waited for, and what was held for it; the next client is the head. */
  remove(client: ClientId): void {
    const head = this.#isHead(client);
    if (this.#waiting.delete(client) && head) this.#promote();
  }

  /** Records what `client` waits for, at the back unless it waits already; the head holds `found`. */
  #wait(
    client: ClientId,
    needs: ReadonlyMap<string, ChunkCoord>,
    pending: ChunkCoord[],
    found: Map<string, EncodedText>,
  ): void {
    const waiting = this.#waiting.get(client);
    if (waiting === undefined) this.#waiting.set(client, { needs, pending });
    else waiting.pending = pending;
    if (this.#isHead(client)) this.#held = found;
  }

  /** The next client is the head: it holds what the cache has of its needs, and waits for the rest. */
  #promote(): void {
    this.#held = new Map();
    for (const waiting of this.#waiting.values()) {
      const { found, missing } = fromCache(waiting.needs.values(), NOTHING_HELD, this.#cache);
      this.#held = found;
      waiting.pending = missing;
      return;
    }
  }

  /**
   * Serves `client` its pending chunks, from the cache or generated while the budget lasts; the
   * head holds them, and a client behind it finds them in the cache when it asks again.
   */
  #serve(client: ClientId, waiting: Waiting): void {
    const held = this.#isHead(client) ? this.#held : undefined;
    for (let at = waiting.pending[0]; at !== undefined; at = waiting.pending[0]) {
      const terrain = this.#cache.cached(at) ?? (this.#left > 0 ? this.#generate(at) : undefined);
      if (terrain === undefined) return;
      held?.set(chunkKey(at), terrain);
      waiting.pending.shift();
    }
  }

  #isHead(client: ClientId): boolean {
    for (const head of this.#waiting.keys()) return head === client;
    return false;
  }

  #generate(at: ChunkCoord): EncodedText {
    this.#left -= 1;
    return this.#cache.of(at);
  }
}
