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
 * global digest, and the root; the kernel digest has a fixed size and is recomputed. A step
 * updates them for what it changed (step/commit.ts); fullChecksum recomputes them all.
 */
import { type CanonicalValue, pointer } from "../canonical/value.ts";
import { type Digest, Digester, digest, digestWords, hexOf } from "../digest/digest.ts";
import { addLanes, type Lanes } from "../digest/lanes.ts";
import { EngineError } from "../errors.ts";
import type { ChunkKey } from "./chunk.ts";
import type { ChunkIndex } from "./chunk-index.ts";
import {
  type ChunkEntry,
  type DigestCache,
  healthyState,
  type Kernel,
  type World,
  type WorldState,
} from "./world.ts";

/** The chunk sum of a world without chunks. */
const ZERO: Lanes = [0, 0, 0, 0];

/** The kernel digest, digest(["kernel", { epoch, tick, nextEntityId, rng, config }]). */
export function kernelDigest(
  { epoch, tick, nextEntityId, rng, config }: Kernel,
  digester: Digester,
): Digest {
  const { algorithm, seed } = rng;
  const kernel = {
    epoch,
    tick,
    nextEntityId,
    rng: { algorithm, seed: [seed[0], seed[1]] },
    config: { simSecondsPerTick: config.simSecondsPerTick },
  };
  return digester.digest(["kernel", kernel]);
}

/** The global digest, digest(["global", global]). */
export function globalDigest(global: CanonicalValue): Digest {
  return digest(["global", global]);
}

/** The term that the chunk `key` adds to the chunk sum. */
export function chunkTerm(key: ChunkKey, chunk: CanonicalValue): Lanes {
  return digestWords(["chunk", key, chunk]);
}

/** What the state root composes. */
export type RootParts = {
  readonly kernel: Digest;
  readonly global: Digest;
  readonly chunkSum: Lanes;
  readonly chunkCount: number;
};

/** The state root of these parts, digest(["state", kernel, global, chunkSum, chunkCount]). */
export function composeRoot(parts: RootParts, digester: Digester): Digest {
  const { kernel, global, chunkSum, chunkCount } = parts;
  return digester.digest(["state", kernel, global, hexOf(chunkSum), chunkCount]);
}

/** The sum of the cached terms of `chunks`. */
function sumTerms(chunks: ChunkIndex<ChunkEntry>): Lanes {
  let sum = ZERO;
  for (const [, entry] of chunks.sortedEntries()) sum = addLanes(sum, entry.term);
  return sum;
}

/** The digests of a world with this kernel, global digest, and chunks, whose terms are set. */
export function digestCache(
  kernel: Kernel,
  global: Digest,
  chunks: ChunkIndex<ChunkEntry>,
): DigestCache {
  const digester = new Digester();
  const chunkSum = sumTerms(chunks);
  const parts = {
    kernel: kernelDigest(kernel, digester),
    global,
    chunkSum,
    chunkCount: chunks.size,
  };
  return { globalDigest: global, chunkSum, stateRoot: composeRoot(parts, digester) };
}

/**
 * The path, under `path`, of an issue at `issuePath` in `tagged`, a domain tag and its parts whose
 * last part is a value: the issue's path into that value, after `path`.
 */
export function pathInValue(issuePath: string, tagged: readonly unknown[], path: string): string {
  return `${path}${issuePath.slice(`/${tagged.length - 1}`.length)}`;
}

/**
 * `error` with each issue moved from its path in `tagged` to the same place under `path`, and the
 * original as its cause; anything that is not an EngineError comes back unchanged.
 */
export function relocated(error: unknown, tagged: readonly unknown[], path: string): unknown {
  if (!EngineError.isEngineError(error)) return error;
  const issues = error.issues.map(({ path: at, message }) => ({
    path: pathInValue(at, tagged, path),
    message,
  }));
  return new EngineError(error.code, issues, { cause: error });
}

/** `hash(tagged)`, where the value is the last part of `tagged` and lives at `path`. */
function hashAt<T>(tagged: CanonicalValue[], path: string, hash: (value: CanonicalValue) => T): T {
  try {
    return hash(tagged);
  } catch (error) {
    throw relocated(error, tagged, path);
  }
}

/**
 * The state root of `state` recomputed from its values alone, never from a cached digest: O(N)
 * for N chunks. Throws EngineError("invalid_value") at the path of the first value that is not
 * canonical, as `/chunks/<key>/...` or `/global/...`, which only a write that bypassed the barrier
 * can cause.
 */
export function recomputeRoot({ kernel, global, chunks }: WorldState): Digest {
  const digester = new Digester();
  let chunkSum = ZERO;
  for (const [key, entry] of chunks.sortedEntries()) {
    const term = hashAt(["chunk", key, entry.value], `/chunks${pointer([key])}`, digestWords);
    chunkSum = addLanes(chunkSum, term);
  }
  const globalPart = hashAt(["global", global], "/global", digest);
  const parts = { kernel: kernelDigest(kernel, digester), global: globalPart, chunkSum };
  return composeRoot({ ...parts, chunkCount: chunks.size }, digester);
}

/**
 * The state root of `world`, as the world keeps it: O(1). Throws EngineError("invalid_input")
 * when `world` is not a world, EngineError("world_busy") while a step runs on it, and
 * EngineError("world_faulted") when its tick failed.
 */
export function stateRoot(world: World): Digest {
  return healthyState(world, "stateRoot").digests.stateRoot;
}

/**
 * The state root of `world` recomputed from its state alone, never from a cached digest: O(N)
 * for N chunks, for audits and checkpoints. It equals stateRoot unless something changed the
 * state without the engine knowing. Throws EngineError("invalid_input") when `world` is not a
 * world, EngineError("world_busy") while a step runs on it, EngineError("world_faulted") when its
 * tick failed, and EngineError("invalid_value") at `/chunks/<key>/...` or `/global/...` when a
 * write that bypassed the barrier left a value that is not canonical.
 */
export function fullChecksum(world: World): Digest {
  return recomputeRoot(healthyState(world, "fullChecksum"));
}

/**
 * Each chunk's cached term, written as a digest, in a fresh record whose keys are in canonical
 * order: O(N), to find which chunks differ between two worlds. Throws
 * EngineError("invalid_input") when `world` is not a world, EngineError("world_busy") while a step
 * runs on it, and EngineError("world_faulted") when its tick failed.
 */
export function chunkHashes(world: World): Record<ChunkKey, Digest> {
  const { chunks } = healthyState(world, "chunkHashes");
  return Object.fromEntries(chunks.sortedEntries().map(([key, entry]) => [key, hexOf(entry.term)]));
}
