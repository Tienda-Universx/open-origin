/**
 * The commit of a tick (ADR 0020, digests, failures, and cost). It hashes only what changed:
 *
 * 1. The written and created chunks, in canonical key order. Each is turned into canonical text
 *    on its own, which fails fast at its first problem, then hashed into its term, and only then
 *    checked by validateChunk, so that a validator that changes the chunk leaves a stale term
 *    that audit finds. The chunk sum subtracts each old term and adds the new one.
 * 2. The global value, the same way, when it was written.
 * 3. The kernel digest, the state root, the events digest digest(["events", events]), and the
 *    tick checksum digest(["tick", stateRoot, eventsDigest]). The events list and the event
 *    records are an envelope: a payload keeps its whole depth of 64 (ENVELOPE_DEPTH).
 *
 * Steps 1 and 2 report, in one system_fault, the first problem of each value that is not
 * canonical, since canonical text fails fast, and every issue the validators return, at
 * `/chunks/<key>/...` and `/global/...`. Created chunks join the lazy index in amortized O(1), so
 * no step of the commit depends on the number of chunks in the world.
 */
import { canonicalizeEnvelope } from "../canonical/encode.ts";
import { compareCodeUnits } from "../canonical/order.ts";
import { pointer } from "../canonical/value.ts";
import { type Digest, Digester, hexOf } from "../digest/digest.ts";
import { addLanes, type Lanes, subtractLanes } from "../digest/lanes.ts";
import { EngineError, IssueList } from "../errors.ts";
import {
  chunkTermOfText,
  composeRoot,
  globalDigestOfText,
  kernelDigest,
  recomputeRoot,
  textOrReport,
} from "../world/checksum.ts";
import type { ChunkKey } from "../world/chunk.ts";
import { integrityError } from "../world/integrity.ts";
import { runValidator } from "../world/validators.ts";
import type { WorldState } from "../world/world.ts";
import type { TickSession } from "./session.ts";

/** What the commit gives the step result. */
export type Commit = {
  readonly checksum: Digest;
  /** The written and created chunks, sorted by UTF-16 code units. */
  readonly changedChunks: ChunkKey[];
  readonly hashedBytes: number;
};

/** What the commit of one value works with. */
type Tools = { readonly digester: Digester; readonly issues: IssueList };

/** Commits the chunk `key` and returns the chunk sum with its new term. */
function commitChunk(session: TickSession, key: ChunkKey, sum: Lanes, tools: Tools): Lanes {
  const { state } = session;
  const entry = state.chunks.get(key);
  const value = entry === undefined ? session.created[key] : entry.value;
  // Every changed key is a committed chunk or one created during the tick.
  if (value === undefined) return sum;
  const path = `/chunks${pointer([key])}`;
  const text = textOrReport(value, path, tools.issues);
  if (text === undefined) return sum;
  const term = chunkTermOfText(key, text, tools.digester);
  // Called without a receiver, so ruleset code cannot reach the captured ruleset through `this`.
  const { validateChunk } = state.ruleset;
  runValidator("validateChunk", path, () => validateChunk(key, value), tools.issues);
  // A validator that used a kept context and caught the fault stops the commit here.
  session.throwIfFaulted();
  if (entry === undefined) {
    state.chunks.add(key, { value, term });
    return addLanes(sum, term);
  }
  const updated = addLanes(subtractLanes(sum, entry.term), term);
  entry.term = term;
  return updated;
}

/** The global digest after the tick: recomputed, and the value validated, if it was written. */
function commitGlobal(session: TickSession, { digester, issues }: Tools): Digest {
  const { state } = session;
  const cached = state.digests.globalDigest;
  if (!session.globalDirty) return cached;
  const text = textOrReport(state.global, "/global", issues);
  if (text === undefined) return cached;
  const fresh = globalDigestOfText(text, digester);
  const { validateGlobal } = state.ruleset;
  runValidator("validateGlobal", "/global", () => validateGlobal(state.global), issues);
  session.throwIfFaulted();
  return fresh;
}

/** Commits the tick `session` ran and updates the world's digests. Throws its fault, if any. */
export function commit(session: TickSession): Commit {
  const { state } = session;
  const tools = { digester: new Digester(), issues: new IssueList() };
  const changedChunks = [...session.dirtyKeys, ...session.createdKeys].sort(compareCodeUnits);
  let chunkSum = state.digests.chunkSum;
  for (const key of changedChunks) chunkSum = commitChunk(session, key, chunkSum, tools);
  const global = commitGlobal(session, tools);
  if (tools.issues.count > 0) throw session.record(tools.issues.toError("system_fault"));
  const { digester } = tools;
  const kernel = kernelDigest(state.kernel, digester);
  const chunkCount = state.chunks.size;
  const stateRoot = composeRoot({ kernel, global, chunkSum, chunkCount }, digester);
  const events = hexOf(digester.textWords(canonicalizeEnvelope(["events", session.events])));
  const checksum = digester.digest(["tick", stateRoot, events]);
  const { digests } = state;
  digests.globalDigest = global;
  digests.chunkSum = chunkSum;
  digests.stateRoot = stateRoot;
  return { checksum, changedChunks, hashedBytes: digester.hashedBytes };
}

/** The full root of `state`, or undefined when a value that bypassed the barrier is not canonical. */
function fullRoot(state: WorldState): Digest | undefined {
  try {
    return recomputeRoot(state);
  } catch (error) {
    // staleDigests reports the value that is not canonical.
    if (EngineError.isEngineError(error)) return undefined;
    throw error;
  }
}

/**
 * Audit (ADR 0020, ownership): recomputes the root from the state alone after the commit. A
 * difference is an integrity_violation that names each stale chunk and the global value: a write
 * that bypassed the barrier, found at the tick it happened.
 */
export function audit(session: TickSession): void {
  const { state } = session;
  if (fullRoot(state) === state.digests.stateRoot) return;
  throw session.record(integrityError(state));
}
