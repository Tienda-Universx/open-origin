/**
 * The encoded terrain of chunks that enter a view (ADR 0026, "Limits and backpressure": an LRU of
 * 2,048 entries). Terrain is generated from the world's genesis by `readTerrain`, a closure of the
 * world plane, and encoded once; the most recently used entries are kept. The fair queue that caps
 * how many chunks are generated per period comes in T6-6b.
 */
import {
  type ChunkCoord,
  chunkKey,
  type TerrainPublic,
  utf8Length,
} from "@open-origin/protocol/public";
import type { EncodedText } from "./parts.ts";

/** The entries the cache keeps. */
export const TERRAIN_ENTRIES = 2048;

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

  /** The encoded terrain of `at`. */
  of(at: ChunkCoord): EncodedText {
    const key = chunkKey(at);
    const cached = this.#cache.get(key);
    if (cached !== undefined) {
      this.#cache.delete(key);
      this.#cache.set(key, cached);
      return cached;
    }
    this.#reads += 1;
    const json = JSON.stringify(this.#read(at));
    const encoded = Object.freeze({ json, bytes: utf8Length(json) });
    this.#cache.set(key, encoded);
    for (const oldest of this.#cache.keys()) {
      if (this.#cache.size <= this.#entries) break;
      this.#cache.delete(oldest);
    }
    return encoded;
  }
}
