/**
 * The state root (ADR 0020, digests). Every digest hashes a canonical array that starts with a
 * domain tag:
 *
 * - kernelDigest = digest(["kernel", { epoch, tick, nextEntityId, rng, config }]);
 * - globalDigest = digest(["global", global]);
 * - each chunk adds the term digest(["chunk", key, chunk]), read as a 128-bit integer;
 * - chunkSum = the sum of the terms modulo 2^128, in four 32-bit lanes with carry;
 * - stateRoot = digest(["state", kernelDigest, globalDigest, chunkSum, chunkCount]), with the
 *   sum written as a digest.
 *
 * The sum does not depend on the order of the chunks, can be updated by subtracting a chunk's old
 * term and adding its new one, and composes by region. A world caches the terms, the sum, the
 * global digest, and the root; the kernel digest has a fixed size and is recomputed.
 */
import type { CanonicalValue } from "../canonical/value.ts";
import { type Digest, digest, digestWords, hexOf } from "../digest/digest.ts";
import { addLanes, type Lanes } from "../digest/lanes.ts";
import type { ChunkKey } from "./chunk.ts";
import type { ChunkIndex } from "./chunk-index.ts";
import { type ChunkEntry, type DigestCache, type Kernel, type World, worldState } from "./world.ts";

/** The chunk sum of a world without chunks. */
const ZERO: Lanes = [0, 0, 0, 0];

function kernelDigest({ epoch, tick, nextEntityId, rng, config }: Kernel): Digest {
  const { algorithm, seed } = rng;
  const kernel = {
    epoch,
    tick,
    nextEntityId,
    rng: { algorithm, seed: [seed[0], seed[1]] },
    config: { simSecondsPerTick: config.simSecondsPerTick },
  };
  return digest(["kernel", kernel]);
}

function globalDigest(global: CanonicalValue): Digest {
  return digest(["global", global]);
}

/** The term that the chunk `key` adds to the chunk sum. */
export function chunkTerm(key: ChunkKey, chunk: CanonicalValue): Lanes {
  return digestWords(["chunk", key, chunk]);
}

/** The state root of a world with these digests, chunk sum, and number of chunks. */
function composeRoot(kernel: Digest, global: Digest, chunkSum: Lanes, chunkCount: number): Digest {
  return digest(["state", kernel, global, hexOf(chunkSum), chunkCount]);
}

/** The sum of the cached terms of `chunks`. */
function sumTerms(chunks: ChunkIndex<ChunkEntry>): Lanes {
  let sum = ZERO;
  for (const [, entry] of chunks.sortedEntries()) sum = addLanes(sum, entry.term);
  return sum;
}

/** The digests of a world with this kernel, global value, and chunks, whose terms are set. */
export function digestCache(
  kernel: Kernel,
  global: CanonicalValue,
  chunks: ChunkIndex<ChunkEntry>,
): DigestCache {
  const cache = { globalDigest: globalDigest(global), chunkSum: sumTerms(chunks) };
  const root = composeRoot(kernelDigest(kernel), cache.globalDigest, cache.chunkSum, chunks.size);
  return { ...cache, stateRoot: root };
}

/**
 * The state root of `world`, as the world keeps it: O(1). Throws EngineError("invalid_input")
 * when `world` is not a world.
 */
export function stateRoot(world: World): Digest {
  return worldState(world).digests.stateRoot;
}

/**
 * The state root of `world` recomputed from its state alone, never from a cached digest: O(N)
 * for N chunks, for audits and checkpoints. It equals stateRoot unless something changed the
 * state without the engine knowing. Throws EngineError("invalid_input") when `world` is not a
 * world.
 */
export function fullChecksum(world: World): Digest {
  const { kernel, global, chunks } = worldState(world);
  let sum = ZERO;
  for (const [key, entry] of chunks.sortedEntries())
    sum = addLanes(sum, chunkTerm(key, entry.value));
  return composeRoot(kernelDigest(kernel), globalDigest(global), sum, chunks.size);
}

/**
 * Each chunk's cached term, written as a digest, in a fresh record whose keys are in canonical
 * order: O(N), to find which chunks differ between two worlds. Throws
 * EngineError("invalid_input") when `world` is not a world.
 */
export function chunkHashes(world: World): Record<ChunkKey, Digest> {
  const { chunks } = worldState(world);
  return Object.fromEntries(chunks.sortedEntries().map(([key, entry]) => [key, hexOf(entry.term)]));
}
