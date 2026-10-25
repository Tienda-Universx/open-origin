/**
 * Snapshots (ADR 0020, snapshots and ownership; plan §2.2, §4): a world as canonical text, version
 * 1 of the schema in snapshot/schema.ts. A snapshot holds no world id, which is host metadata, so
 * replicas of a world encode to the same text.
 *
 * - encodeSnapshot canonicalizes the whole state once and recomputes every digest from that same
 *   text (recomputeState, which fullChecksum and audit also use). When the recomputed root differs
 *   from the incremental one, a write bypassed the barrier:
 *   the world is poisoned with integrity_violation and no text is returned. This is how such a
 *   write is found when audit is off. O(N) for N chunks: it runs at checkpoints, not every tick.
 * - decodeSnapshot accepts canonical text only, checks the schema, captures the ruleset, runs its
 *   validators, and requires the stored state root to equal the recomputed one. The world it
 *   makes keeps the versions the header records, so step refuses to replay it under others.
 *
 * Integrity against corruption and tampering is SHA-256 over snapshotBytes, in the adapter; the
 * state root only detects accidental divergence.
 */
import { canonicalize, recordText } from "../canonical/encode.ts";
import { utf8Encode } from "../canonical/utf8.ts";
import { type CanonicalValue, pointer } from "../canonical/value.ts";
import { type Digest, Digester } from "../digest/digest.ts";
import { EngineError, IssueList } from "../errors.ts";
import {
  chunkTermOfText,
  digestCache,
  globalDigestOfText,
  recomputeState,
  type StateText,
  textOrReport,
} from "../world/checksum.ts";
import { ChunkIndex } from "../world/chunk-index.ts";
import type { Ruleset, WorldOptions } from "../world/contracts.ts";
import { readAudit } from "../world/create.ts";
import { integrityError } from "../world/integrity.ts";
import { type CapturedRuleset, captureRuleset } from "../world/ruleset.ts";
import { runValidator } from "../world/validators.ts";
import {
  type ChunkEntry,
  newWorld,
  poison,
  type Reading,
  readState,
  type World,
  type WorldState,
} from "../world/world.ts";
import { readSnapshot, SNAPSHOT_SCHEMA_VERSION, type SnapshotV1 } from "./schema.ts";

/**
 * The encoding of `state`, whose recomputed root equals its incremental one. Otherwise it throws
 * and returns no encoding:
 *
 * - after a refusal, a read that fails is the trap's failure, not the state's: it throws without
 *   poisoning, and readState throws the first refusal instead (world/world.ts);
 * - a value that is not canonical, or a root that differs, means a write bypassed the barrier:
 *   it poisons the world and throws its integrity_violation, which names each stale chunk and
 *   the global value;
 * - any other error keeps its own classification.
 */
function verifiedEncoding(state: WorldState, reading: Reading): StateText {
  let encoded: StateText | undefined;
  try {
    encoded = recomputeState(state);
  } catch (error) {
    if (reading.refusal !== undefined) throw error;
    // Only a value that is not canonical, which integrityError names, blames the state.
    if (!EngineError.isEngineError(error) || error.code !== "invalid_value") throw error;
  }
  if (encoded !== undefined && encoded.root === state.digests.stateRoot) return encoded;
  const fault = integrityError(state);
  poison(state, fault);
  throw fault;
}

/** The text of `state`, whose members are written in canonical key order. */
function snapshotText(state: WorldState, reading: Reading): string {
  const { header, kernel } = state;
  const { global, chunks, root } = verifiedEncoding(state, reading);
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
  return readState(world, api, "encoded", snapshotText);
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

/**
 * The digests and the chunks of a snapshot, each digest taken before any validator ran. `whole` is
 * false when a value nests deeper than a value may: it was reported, and has no digest.
 */
type Hashed = {
  readonly global: Digest;
  readonly chunks: ChunkIndex<ChunkEntry>;
  readonly whole: boolean;
};

/**
 * The digests of `snapshot`. Each value is canonicalized on its own, so that it keeps its whole
 * depth of 64 although the snapshot document puts it two or three levels down; one that nests
 * deeper is an issue at `/world/global/...` or `/world/chunks/<key>/...`, and a snapshot that
 * has one has no digests.
 */
function hashed({ global, chunks }: SnapshotV1, issues: IssueList): Hashed {
  const digester = new Digester();
  const index = new ChunkIndex<ChunkEntry>();
  const globalText = textOrReport(global, "/world/global", issues);
  let whole = globalText !== undefined;
  for (const [key, value] of chunks) {
    const text = textOrReport(value, `/world/chunks${pointer([key])}`, issues);
    if (text === undefined) whole = false;
    else index.add(key, { value, term: chunkTermOfText(key, text, digester) });
  }
  const digest = globalText === undefined ? "" : globalDigestOfText(globalText, digester);
  return { global: digest, chunks: index, whole };
}

/**
 * The digests of `snapshot`, its values checked by the validators of `ruleset`, and every issue
 * at `/world/global/...` and `/world/chunks/<key>/...` reported to `issues`. Every digest is taken
 * before any validator runs, so a validator that changes a value it is given, or one it kept from
 * an earlier call, leaves a stale digest that fullChecksum and encodeSnapshot find (ADR 0020,
 * ownership), as at createWorld and at the commit. A value too deep to hash is not validated.
 */
function validated(snapshot: SnapshotV1, ruleset: CapturedRuleset, issues: IssueList): Hashed {
  const result = hashed(snapshot, issues);
  if (!result.whole) return result;
  const { global, chunks } = snapshot;
  // Called without a receiver, so ruleset code cannot reach the captured ruleset through `this`.
  const { validateGlobal, validateChunk } = ruleset;
  runValidator("validateGlobal", "/world/global", () => validateGlobal(global), issues);
  for (const [key, value] of chunks) {
    const path = `/world/chunks${pointer([key])}`;
    runValidator("validateChunk", path, () => validateChunk(key, value), issues);
  }
  return result;
}

/**
 * The world that `snapshot` holds, under `ruleset`. Throws EngineError("invalid_snapshot") with
 * every issue the validators return and a state root that is not the root of the state.
 */
function decodedState(snapshot: SnapshotV1, ruleset: CapturedRuleset, audit: boolean): WorldState {
  const issues = new IssueList();
  const { global, chunks, whole } = validated(snapshot, ruleset, issues);
  // Without every digest the state root cannot be recomputed, and the value's issue says why.
  if (!whole) issues.throwIfAny("invalid_snapshot");
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
 * 1. `options` is undefined or a record whose only member is `audit`, a boolean: otherwise
 *    invalid_input, with every unknown key at `/options/<key>`. The options are strict on
 *    purpose, as in createWorld: a misspelled option must not silently turn audit off.
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
