/**
 * The terrain of chunks that enter a view (ADR 0026, "Limits and backpressure": at most 16 chunks
 * generated per period across all clients, from a fair queue, with an LRU of 2,048 entries).
 * Terrain is generated from the world's genesis by `readTerrain`, a closure of the world plane,
 * and encoded once; the most recently used entries are kept, and a cache hit generates nothing.
 *
 * A transaction fixes its content when it starts, terrain included, so it starts only once the
 * terrain of every chunk it brings is at hand; until then the client waits, its view at L. What a
 * client cannot have from the cache waits in a queue served first come, first served. Each period,
 * before any request, the period's budget goes first to the head of the queue; in the fan-out,
 * only the head generates at once, or any client while none waits; and what is left after the
 * fan-out goes to the clients that wait, in the order they arrived. A waiting client asks again at
 * each of its turns in the fan-out, and keeps its place whatever it needs then: its needs change by
 * themselves when the window of a moving being moves or a trim moves with chunk sizes.
 *
 * Terrain is held outside the cache for the head alone, so the cache cannot evict it before the
 * head's transaction starts. The head's hold keeps only what it still needs, which `take` caps at
 * MAX_VIEW_CHUNKS: at most 73 chunks of at most WIDEST_TERRAIN_BYTES, 905,273 bytes, whatever the
 * number of clients. The clients behind the head hold nothing: what the queue serves them goes to
 * the cache, and a chunk it evicts before they start waits for them again, in their turn.
 *
 * The head's turn lasts T = ⌈2 · 73 / B⌉ periods, B being the budget a period, 10 at 16: the periods
 * in which it is served first. A head that has not started by then goes to the back, with nothing
 * held; what was generated for it stays in the cache, so its next turn needs only what changed or
 * was evicted. The bounds:
 *
 * - a client with k clients ahead is the head within k · (T + 1) periods: each head keeps the head
 *   for at most T periods after the one in which it became the head, and the clients that arrive
 *   later or go to the back wait behind it, so no client, whatever its needs do, holds the others
 *   for more than a turn;
 * - a head whose needs gain at most d new chunks a period has all of them within ⌈73 / (B − d)⌉
 *   periods, 7 for a follow window that moves one chunk a period (d ≤ 5), when its turn in the
 *   fan-out comes each period: the pass and its take at once generate B a period for it, of which
 *   d go to what changed. It then starts at its next turn in the fan-out with room in its buffer.
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

/** A client that waits: the chunks it needs now, by key, and those the queue has yet to serve it. */
type Waiting = {
  needs: ReadonlyMap<string, ChunkCoord>;
  /** In the order the queue serves them. */
  pending: ChunkCoord[];
};

const NOTHING_HELD: ReadonlyMap<string, EncodedText> = new Map();

/** The generations a head's turn is worth: twice the chunks of a full view. */
export const TURN_GENERATIONS = 2 * MAX_VIEW_CHUNKS;

/** The periods a head's turn lasts at `perPeriod` generations a period: 10 at 16. */
export function turnPeriods(perPeriod: number): number {
  return Math.ceil(TURN_GENERATIONS / perPeriod);
}

/** `chunks` by chunk key, each once. */
function keyed(chunks: readonly ChunkCoord[]): Map<string, ChunkCoord> {
  return new Map(chunks.map((at) => [chunkKey(at), at]));
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
 * first come, first served, its head for a bounded turn, with terrain held for its head alone.
 */
export class TerrainQueue {
  readonly #cache: TerrainCache;
  readonly #perPeriod: number;
  readonly #turn: number;
  /** The clients that wait, in the order they arrived: the first is the head. */
  readonly #waiting = new Map<ClientId, Waiting>();
  /** The terrain held for the head, by chunk key: some of its needs, so at most MAX_VIEW_CHUNKS. */
  #held = new Map<string, EncodedText>();
  /** The periods of its turn the head has had. */
  #turnUsed = 0;
  #left: number;

  constructor(cache: TerrainCache, perPeriod = TERRAIN_PER_PERIOD) {
    if (!Number.isSafeInteger(perPeriod) || perPeriod < 1) {
      throw new RangeError(`a period generates at least one chunk of terrain, not ${perPeriod}`);
    }
    this.#cache = cache;
    this.#perPeriod = perPeriod;
    this.#turn = turnPeriods(perPeriod);
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
   * Starts a period: the budget is whole again; a head whose turn is over goes to the back; and the
   * head is served first, before any request. A generation that throws removes its client from the
   * queue and reports it through `fault`, and the next client, the head now, is served instead.
   */
  period(fault: (client: ClientId, cause: unknown) => void): void {
    this.#left = this.#perPeriod;
    if (this.#turnUsed >= this.#turn) this.#back();
    let head = this.#first();
    while (head !== undefined && this.#left > 0 && !this.#served(head, fault)) {
      head = this.#first();
    }
    if (this.#waiting.size > 0) this.#turnUsed += 1;
  }

  /**
   * Spends what is left of the period's budget, once the fan-out took its share: the clients that
   * wait are served in the order they arrived, the head holding what it is served, those behind it
   * finding theirs in the cache when they ask again. A generation that throws removes its client
   * from the queue and reports it through `fault`; the queue goes on with the next client.
   */
  prefetch(fault: (client: ClientId, cause: unknown) => void): void {
    // A Map's iteration skips the entries deleted during it, so a client a fault removed is skipped.
    for (const entry of this.#waiting) {
      if (this.#left === 0) return;
      this.#served(entry, fault);
    }
  }

  /**
   * The terrain of every chunk of `chunks` for `client`, generated now while the period's budget
   * lasts, by the head of the queue, or by any client while none waits; or undefined while some
   * chunk still waits, and the client then waits in the queue: in its place when it waited
   * already, whatever it needs now, else at the back. The head's hold keeps only what it still
   * needs. Once it returns the terrain, the client leaves the queue.
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
    const head = this.#isHead(client);
    const { found, missing } = fromCache(
      needs.values(),
      head ? this.#held : NOTHING_HELD,
      this.#cache,
    );
    const generates = head || this.#waiting.size === 0;
    const pending: ChunkCoord[] = [];
    for (const at of missing) {
      if (generates && this.#left > 0) found.set(chunkKey(at), this.#generate(at));
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
    if (waiting === undefined) {
      this.#waiting.set(client, { needs, pending });
      if (this.#waiting.size === 1) this.#turnUsed = 0;
    } else {
      waiting.needs = needs;
      waiting.pending = pending;
    }
    if (this.#isHead(client)) this.#held = found;
  }

  /** The head's turn is over: it goes to the back, nothing held for it, and the next is the head. */
  #back(): void {
    const head = this.#first();
    this.#turnUsed = 0;
    if (head === undefined || this.#waiting.size === 1) return;
    const [client, waiting] = head;
    this.#waiting.delete(client);
    this.#promote();
    this.#waiting.set(client, waiting);
  }

  /** The next client is the head: it holds what the cache has of its needs, and waits for the rest. */
  #promote(): void {
    this.#held = new Map();
    this.#turnUsed = 0;
    const next = this.#first();
    if (next === undefined) return;
    const [, waiting] = next;
    const { found, missing } = fromCache(waiting.needs.values(), NOTHING_HELD, this.#cache);
    this.#held = found;
    waiting.pending = missing;
  }

  /**
   * Serves a client its pending chunks, from the cache or generated while the budget lasts; the
   * head holds them. Returns false when a generation threw: the client is then removed and
   * reported through `fault`.
   */
  #served(
    [client, waiting]: [ClientId, Waiting],
    fault: (client: ClientId, cause: unknown) => void,
  ): boolean {
    const held = this.#isHead(client) ? this.#held : undefined;
    try {
      for (let at = waiting.pending[0]; at !== undefined; at = waiting.pending[0]) {
        const terrain = this.#cache.cached(at) ?? (this.#left > 0 ? this.#generate(at) : undefined);
        if (terrain === undefined) return true;
        held?.set(chunkKey(at), terrain);
        waiting.pending.shift();
      }
      return true;
    } catch (cause) {
      this.remove(client);
      fault(client, cause);
      return false;
    }
  }

  #first(): [ClientId, Waiting] | undefined {
    for (const entry of this.#waiting) return entry;
    return undefined;
  }

  #isHead(client: ClientId): boolean {
    return this.#first()?.[0] === client;
  }

  #generate(at: ChunkCoord): EncodedText {
    this.#left -= 1;
    return this.#cache.of(at);
  }
}
