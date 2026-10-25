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
import { arrayText, canonicalize, canonicalizeAt } from "../canonical/encode.ts";
import { type CanonicalValue, pointer } from "../canonical/value.ts";
import { type Digest, Digester, digest, digestWords, hexOf } from "../digest/digest.ts";
import { addLanes, type Lanes } from "../digest/lanes.ts";
import type { ChunkKey } from "./chunk.ts";
import type { ChunkIndex } from "./chunk-index.ts";
import {
  type ChunkEntry,
  type DigestCache,
  healthyState,
  type Kernel,
  readState,
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
 * Where an issue found in `tagged` lies in the world. `tagged` is a domain tag and its parts, the
 * last of them the value that lives at `valuePath`; `at` is the issue's JSON Pointer into
 * `tagged`. A pointer into the value keeps its rest after `valuePath`; any other pointer, into the
 * tag or a key, becomes `valuePath` itself.
 */
export function relocatePath(at: string, tagged: readonly unknown[], valuePath: string): string {
  const value = `/${tagged.length - 1}`;
  if (at === value || at.startsWith(`${value}/`)) return `${valuePath}${at.slice(value.length)}`;
  return valuePath;
}

/** The domain tags of the global value and of chunks, as canonical text. */
const GLOBAL_TAG = canonicalize("global");
const CHUNK_TAG = canonicalize("chunk");

/** The canonical texts of the values of a state, and the root recomputed from them. */
export type StateText = {
  readonly global: string;
  /** Each chunk's key and the canonical text of its value, in canonical key order. */
  readonly chunks: readonly (readonly [ChunkKey, string])[];
  readonly root: Digest;
};

/**
 * The state root of `state` recomputed from its values alone, never from a cached digest: O(N)
 * for N chunks. Each value is canonicalized once, and each digest hashes the text of a tagged
 * array built from that text, so encodeSnapshot hashes the very text it writes. `keep`, when
 * given, receives each chunk's text; otherwise each text is dropped once it is hashed, so only
 * encodeSnapshot holds them all at once. Throws EngineError("invalid_value") at the path of the
 * first value that is not canonical, as `/chunks/<key>/...` or `/global/...`, which only a write
 * that bypassed the barrier can cause, with what a Proxy threw while read, if anything, as the
 * cause.
 */
function recompute(
  { kernel, global, chunks }: WorldState,
  keep?: (key: ChunkKey, text: string) => void,
): { readonly root: Digest; readonly global: string } {
  const digester = new Digester();
  let chunkSum = ZERO;
  for (const [key, entry] of chunks.sortedEntries()) {
    const text = canonicalizeAt(entry.value, `/chunks${pointer([key])}`);
    const term = digester.textWords(arrayText([CHUNK_TAG, canonicalize(key), text]));
    chunkSum = addLanes(chunkSum, term);
    keep?.(key, text);
  }
  const globalText = canonicalizeAt(global, "/global");
  const globalPart = hexOf(digester.textWords(arrayText([GLOBAL_TAG, globalText])));
  const parts = { kernel: kernelDigest(kernel, digester), global: globalPart, chunkSum };
  const root = composeRoot({ ...parts, chunkCount: chunks.size }, digester);
  return { root, global: globalText };
}

/** The root of `state` recomputed as recompute does, with the canonical text of every value. */
export function recomputeState(state: WorldState): StateText {
  const texts: [ChunkKey, string][] = [];
  const { root, global } = recompute(state, (key, text) => {
    texts.push([key, text]);
  });
  return { global, chunks: texts, root };
}

/** The root of `state` recomputed as recompute does, keeping no text: what fullChecksum and audit compare. */
export function recomputeRoot(state: WorldState): Digest {
  return recompute(state).root;
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
 * world, EngineError("world_busy") while a step runs on it or a read runs, EngineError
 * ("world_faulted") when its tick failed, and EngineError("invalid_value") at `/chunks/<key>/...`
 * or `/global/...` when a write that bypassed the barrier left a value that is not canonical. It
 * reads every value, so it reads as readState does: a Proxy in the state that uses the world
 * meanwhile is refused, and a read that then fails throws that refusal.
 */
export function fullChecksum(world: World): Digest {
  return readState(world, "fullChecksum", "read", (state) => recomputeRoot(state));
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
