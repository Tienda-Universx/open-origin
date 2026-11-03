/**
 * The terrain of chunks that enter a view (ADR 0026, "Limits and backpressure": at most 16 chunks
 * generated per period across all clients, from a fair queue, with an LRU of 2,048 entries).
 * Terrain is generated from the world's genesis by `readTerrain`, a closure of the world plane,
 * and encoded once; the most recently used entries are kept, and a cache hit generates nothing.
 *
 * A transaction fixes its content when it starts, terrain included, so it starts only once the
 * terrain of every chunk it brings is at hand; until then the client waits, its view at L. While
 * the period's budget lasts, missing terrain is generated at once. What the budget cannot cover
 * waits in a fair queue: at the start of each period, the clients that wait are served one chunk
 * each in turn, the first served moving to the back, before any new request. Terrain generated
 * for a waiting client is kept for it until its transaction starts, so a cache that evicts it in
 * the meantime cannot make it wait again: every waiting client is served, within the periods the
 * chunks waiting before its own take at 16 a period.
 */
import {
  type ChunkCoord,
  chunkKey,
  encodeTerrain,
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

/** The terrain of `chunks`, from `ready` when there, else the cache's, and the chunks missing. */
function fromCache(
  chunks: readonly ChunkCoord[],
  ready: ReadonlyMap<string, EncodedText>,
  cache: TerrainCache,
): { readonly found: Map<string, EncodedText>; readonly missing: ChunkCoord[] } {
  const found = new Map<string, EncodedText>();
  const missing: ChunkCoord[] = [];
  for (const at of chunks) {
    const key = chunkKey(at);
    const terrain = ready.get(key) ?? cache.cached(at);
    if (terrain === undefined) missing.push(at);
    else found.set(key, terrain);
  }
  return { found, missing };
}

/** The budget of terrain generations per period, and the fair queue of the clients that wait. */
export class TerrainQueue {
  readonly #cache: TerrainCache;
  readonly #perPeriod: number;
  /** The chunks each waiting client waits for, the clients in the order they are served next. */
  readonly #wanted = new Map<ClientId, ChunkCoord[]>();
  /** The terrain kept for each waiting client, by chunk key, until its transaction starts. */
  readonly #ready = new Map<ClientId, Map<string, EncodedText>>();
  #left: number;

  constructor(cache: TerrainCache, perPeriod = TERRAIN_PER_PERIOD) {
    if (!Number.isSafeInteger(perPeriod) || perPeriod < 1) {
      throw new RangeError(`a period generates at least one chunk of terrain, not ${perPeriod}`);
    }
    this.#cache = cache;
    this.#perPeriod = perPeriod;
    this.#left = perPeriod;
  }

  /** How many chunks of terrain the waiting clients still wait for. */
  get queued(): number {
    let queued = 0;
    for (const wanted of this.#wanted.values()) queued += wanted.length;
    return queued;
  }

  /** How many chunks of terrain are kept for waiting clients. */
  get held(): number {
    let held = 0;
    for (const ready of this.#ready.values()) held += ready.size;
    return held;
  }

  /**
   * Starts a period: the budget is whole again, and the waiting clients are served first, one
   * chunk each in turn. A generation that throws drops its client through `fault`, and the queue
   * goes on with the next.
   */
  period(fault: (client: ClientId, cause: unknown) => void): void {
    this.#left = this.#perPeriod;
    for (let next = this.#next(); next !== undefined && this.#left > 0; next = this.#next()) {
      const [client, wanted] = next;
      const at = wanted.shift();
      // The client goes to the back, or out of the queue when it waits for nothing more.
      this.#wanted.delete(client);
      if (wanted.length > 0) this.#wanted.set(client, wanted);
      if (at === undefined) continue;
      try {
        const terrain = this.#cache.cached(at) ?? this.#generate(at);
        this.#readyOf(client).set(chunkKey(at), terrain);
      } catch (cause) {
        fault(client, cause);
      }
    }
  }

  /**
   * The terrain of every chunk of `chunks` for `client`, generated now while the period's budget
   * lasts; or undefined while some chunk still waits, and the client then waits in the queue for
   * the chunks missing. Once it returns the terrain, nothing is kept for the client.
   */
  take(
    client: ClientId,
    chunks: readonly ChunkCoord[],
  ): ReadonlyMap<string, EncodedText> | undefined {
    const { found, missing } = fromCache(chunks, this.#ready.get(client) ?? new Map(), this.#cache);
    const wanted: ChunkCoord[] = [];
    for (const at of missing) {
      if (this.#left > 0) found.set(chunkKey(at), this.#generate(at));
      else wanted.push(at);
    }
    if (wanted.length === 0) {
      this.remove(client);
      return found;
    }
    // A client that already waits keeps its place; the terrain it no longer needs is let go.
    this.#wanted.set(client, wanted);
    this.#ready.set(client, found);
    return undefined;
  }

  /** Forgets `client`: what it waited for, and what was kept for it. */
  remove(client: ClientId): void {
    this.#wanted.delete(client);
    this.#ready.delete(client);
  }

  #next(): [ClientId, ChunkCoord[]] | undefined {
    for (const entry of this.#wanted) return entry;
    return undefined;
  }

  #readyOf(client: ClientId): Map<string, EncodedText> {
    const ready = this.#ready.get(client) ?? new Map<string, EncodedText>();
    this.#ready.set(client, ready);
    return ready;
  }

  #generate(at: ChunkCoord): EncodedText {
    this.#left -= 1;
    return this.#cache.of(at);
  }
}
