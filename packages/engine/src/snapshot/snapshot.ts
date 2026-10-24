/**
 * Snapshots (ADR 0020, snapshots and ownership; plan §2.2, §4): a world as canonical text, version
 * 1 of the schema in snapshot/schema.ts. A snapshot holds no world id, which is host metadata, so
 * replicas of a world encode to the same text.
 *
 * - encodeSnapshot canonicalizes the whole state once and recomputes every digest from that same
 *   text. When the recomputed root differs from the incremental one, a write bypassed the barrier:
 *   the world is poisoned with integrity_violation and no text is returned. This is how such a
 *   write is found when audit is off. O(N) for N chunks: it runs at checkpoints, not every tick.
 * - decodeSnapshot accepts canonical text only, checks the schema, captures the ruleset, runs its
 *   validators, and requires the stored state root to equal the recomputed one. The world it
 *   makes keeps the versions the header records, so step refuses to replay it under others.
 *
 * Integrity against corruption and tampering is SHA-256 over snapshotBytes, in the adapter; the
 * state root only detects accidental divergence.
 */
import { arrayText, canonicalize, recordText } from "../canonical/encode.ts";
import { utf8Encode } from "../canonical/utf8.ts";
import { type CanonicalValue, pointer } from "../canonical/value.ts";
import { type Digest, Digester, hexOf } from "../digest/digest.ts";
import { addLanes, type Lanes } from "../digest/lanes.ts";
import { EngineError, IssueList } from "../errors.ts";
import {
  chunkTerm,
  composeRoot,
  digestCache,
  globalDigest,
  kernelDigest,
} from "../world/checksum.ts";
import type { ChunkKey } from "../world/chunk.ts";
import { ChunkIndex } from "../world/chunk-index.ts";
import type { Ruleset, WorldOptions } from "../world/contracts.ts";
import { readAudit } from "../world/create.ts";
import { integrityError } from "../world/integrity.ts";
import { type CapturedRuleset, captureRuleset } from "../world/ruleset.ts";
import { runValidator } from "../world/validators.ts";
import {
  type ActiveStep,
  type ChunkEntry,
  healthyState,
  newWorld,
  poison,
  type World,
  type WorldState,
} from "../world/world.ts";
import { readSnapshot, SNAPSHOT_SCHEMA_VERSION, type SnapshotV1 } from "./schema.ts";

/** Marks a world while it is encoded: a Proxy in its state must not use it meanwhile. */
const ENCODING: ActiveStep = {
  refuse: (api) => {
    const message =
      `${api} was called while encodeSnapshot read this world: ` +
      "no function may use a world while it is encoded";
    return new EngineError("world_busy", [{ path: "", message }]);
  },
};

/** The chunk sum of a world without chunks. */
const ZERO: Lanes = [0, 0, 0, 0];

/** The domain tags of the global value and of chunks, as canonical text. */
const GLOBAL_TAG = canonicalize("global");
const CHUNK_TAG = canonicalize("chunk");

/** The canonical texts of the global value and the chunks, and the root recomputed from them. */
type Encoded = {
  readonly global: string;
  readonly chunks: readonly (readonly [ChunkKey, string])[];
  readonly root: Digest;
};

/**
 * Canonicalizes every value of `state` once: each text is written into the snapshot and hashed
 * into its digest, as digest(["chunk", key, chunk]) and digest(["global", global]) hash it, so
 * the root is recomputed from the very text the snapshot holds. Throws EngineError
 * ("invalid_value") at the first value that is not canonical.
 */
function encodeState({ kernel, global, chunks }: WorldState): Encoded {
  const digester = new Digester();
  const globalText = canonicalize(global);
  const globalPart = hexOf(digester.textWords(arrayText([GLOBAL_TAG, globalText])));
  let chunkSum = ZERO;
  const texts = chunks.sortedEntries().map(([key, { value }]): [ChunkKey, string] => {
    const text = canonicalize(value);
    const term = digester.textWords(arrayText([CHUNK_TAG, canonicalize(key), text]));
    chunkSum = addLanes(chunkSum, term);
    return [key, text];
  });
  const parts = { kernel: kernelDigest(kernel, digester), global: globalPart, chunkSum };
  const root = composeRoot({ ...parts, chunkCount: texts.length }, digester);
  return { global: globalText, chunks: texts, root };
}

/**
 * The encoding of `state`, whose recomputed root equals its incremental one. Otherwise a write
 * bypassed the barrier: poisons the world and throws its integrity_violation, which names each
 * stale chunk and the global value.
 */
function verifiedEncoding(state: WorldState): Encoded {
  let encoded: Encoded | undefined;
  try {
    encoded = encodeState(state);
  } catch (error) {
    // A value that is not canonical: integrityError names it.
    if (!EngineError.isEngineError(error)) throw error;
  }
  if (encoded !== undefined && encoded.root === state.digests.stateRoot) return encoded;
  const fault = integrityError(state);
  poison(state, fault);
  throw fault;
}

/** The text of `state`, whose members are written in canonical key order. */
function snapshotText(state: WorldState): string {
  const { header, kernel } = state;
  const { global, chunks, root } = verifiedEncoding(state);
  const { epoch, tick, nextEntityId, rng, config } = kernel;
  const world = recordText([
    ["chunks", recordText(chunks)],
    ["config", canonicalize({ simSecondsPerTick: config.simSecondsPerTick })],
    ["epoch", canonicalize(epoch)],
    ["global", global],
    ["nextEntityId", canonicalize(nextEntityId)],
    ["rng", canonicalize({ algorithm: rng.algorithm, seed: [rng.seed[0], rng.seed[1]] })],
    ["tick", canonicalize(tick)],
  ]);
  return recordText([
    ["header", canonicalize({ snapshotSchemaVersion: SNAPSHOT_SCHEMA_VERSION, ...header })],
    ["stateRoot", canonicalize(root)],
    ["world", world],
  ]);
}

/** The snapshot text of `world`, for a call of `api`, with the world busy while it is read. */
function encodeFor(world: World, api: string): string {
  const state = healthyState(world, api);
  state.active = ENCODING;
  try {
    return snapshotText(state);
  } finally {
    state.active = undefined;
  }
}

/**
 * The version 1 snapshot of `world`, as canonical text: O(N) for N chunks. Throws
 * EngineError("invalid_input") when `world` is not a world, EngineError("world_busy") while a step
 * runs on it, and EngineError("world_faulted") when its tick failed. Throws
 * EngineError("integrity_violation") after poisoning the world when its state disagrees with its
 * incremental digests: a write that bypassed the barrier, at `/chunks/<key>` or `/global`.
 */
export function encodeSnapshot(world: World): string {
  return encodeFor(world, "encodeSnapshot");
}

/**
 * The UTF-8 bytes of encodeSnapshot(world), in a fresh array, which adapters hash with SHA-256.
 * Throws as encodeSnapshot does.
 */
export function snapshotBytes(world: World): Uint8Array {
  return utf8Encode(encodeFor(world, "snapshotBytes"));
}

/** The digests and the chunks of a snapshot, each digest taken before any validator ran. */
type Hashed = { readonly global: Digest; readonly chunks: ChunkIndex<ChunkEntry> };

/**
 * The digests of `snapshot`, its values checked by the validators of `ruleset`, and every issue
 * at `/world/global/...` and `/world/chunks/<key>/...` reported to `issues`. The digests are taken
 * before the validators run, as createWorld takes them.
 */
function validated(snapshot: SnapshotV1, ruleset: CapturedRuleset, issues: IssueList): Hashed {
  const { global, chunks } = snapshot;
  const hashed = { global: globalDigest(global), chunks: new ChunkIndex<ChunkEntry>() };
  // Called without a receiver, so ruleset code cannot reach the captured ruleset through `this`.
  const { validateGlobal, validateChunk } = ruleset;
  runValidator("validateGlobal", "/world/global", () => validateGlobal(global), issues);
  for (const [key, value] of chunks) {
    const path = `/world/chunks${pointer([key])}`;
    hashed.chunks.add(key, { value, term: chunkTerm(key, value) });
    runValidator("validateChunk", path, () => validateChunk(key, value), issues);
  }
  return hashed;
}

/**
 * The world that `snapshot` holds, under `ruleset`. Throws EngineError("invalid_snapshot") with
 * every issue the validators return and a state root that is not the root of the state.
 */
function decodedState(snapshot: SnapshotV1, ruleset: CapturedRuleset, audit: boolean): WorldState {
  const issues = new IssueList();
  const { global, chunks } = validated(snapshot, ruleset, issues);
  const { kernel } = snapshot;
  const digests = digestCache(kernel, global, chunks);
  if (digests.stateRoot !== snapshot.stateRoot) {
    const message =
      `the state root ${snapshot.stateRoot} is not ${digests.stateRoot}, ` +
      "the root of the state the snapshot holds";
    issues.report("/stateRoot", message);
  }
  issues.throwIfAny("invalid_snapshot");
  return {
    header: snapshot.header,
    kernel,
    global: snapshot.global,
    chunks,
    ruleset,
    digests,
    audit,
    status: { kind: "ok" },
    active: undefined,
  };
}

/**
 * The world that the snapshot `text` holds, run by `ruleset` (ADR 0020, snapshots). The checks run
 * in this order, and each stops the next:
 *
 * 1. `options` is undefined or a record whose `audit` is a boolean: otherwise invalid_input.
 * 2. `text` is canonical text (parseCanonical) of a version 1 snapshot (snapshot/schema.ts):
 *    otherwise unsupported_schema for another schema version, alone, and invalid_snapshot with
 *    every problem of the text or the schema.
 * 3. `ruleset` is captured (captureRuleset): otherwise invalid_ruleset.
 * 4. The ruleset's validators accept the global value and every chunk, and the stored state root
 *    equals the one recomputed from the state: otherwise invalid_snapshot with every issue.
 *
 * The world keeps the versions its header records, even when they differ from ENGINE_VERSION or
 * the ruleset's, so it loads but cannot be replayed (step throws version_mismatch). It shares no
 * value with `text` or `ruleset`: changing the ruleset afterwards changes nothing. As in
 * createWorld, the validators receive the values the world keeps, and must not change or keep
 * them.
 */
export function decodeSnapshot<G extends CanonicalValue, C extends CanonicalValue>(
  text: string,
  ruleset: Ruleset<G, C>,
  options?: WorldOptions,
): World<G, C> {
  const issues = new IssueList();
  const audit = readAudit(options, issues);
  issues.throwIfAny("invalid_input");
  const snapshot = readSnapshot(text);
  const state = decodedState(snapshot, captureRuleset(ruleset), audit);
  // The ruleset's validators accepted the global value as a G and every chunk as a C.
  return newWorld(state as WorldState<G, C>);
}
