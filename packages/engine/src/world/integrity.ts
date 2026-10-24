/**
 * Integrity (ADR 0020, ownership): what a state that disagrees with its incremental digests is.
 * Inside the tick, writes that bypass the barrier are detected, not prevented: audit looks for
 * them after every commit, and encodeSnapshot before it writes a snapshot. Both report them here,
 * in one integrity_violation that names each stale chunk and the global value.
 */

import type { CanonicalValue } from "../canonical/value.ts";
import { pointer } from "../canonical/value.ts";
import { type Digest, digest, hexOf } from "../digest/digest.ts";
import { describePath, EngineError, type Issue } from "../errors.ts";
import { relocatePath } from "./checksum.ts";
import type { WorldState } from "./world.ts";

/** What a stale cached digest is. */
type Cached = {
  readonly path: string;
  /** What changed behind the barrier, as the start of a sentence. */
  readonly change: string;
  /** What the cache keeps: "term" or "digest". */
  readonly noun: string;
  /** The tagged value whose digest the cache keeps, its value last. */
  readonly tagged: readonly CanonicalValue[];
  readonly cached: Digest;
};

/** Why the cached digest of `cached` is stale; undefined when it still matches. */
function staleIssue({ path, change, noun, tagged, cached }: Cached): Issue | undefined {
  try {
    if (digest(tagged) === cached) return undefined;
    return { path, message: `${change}: its cached ${noun} no longer matches it` };
  } catch (error) {
    if (!EngineError.isEngineError(error)) throw error;
    const [first] = error.issues;
    const at = describePath(relocatePath(first?.path ?? "", tagged, ""));
    return { path, message: `${change}, and it is not canonical: at ${at}: ${first?.message}` };
  }
}

/** Every chunk and global value whose cached digest no longer matches it: O(N). */
function staleDigests(state: WorldState): Issue[] {
  const cached: Cached[] = state.chunks.sortedEntries().map(([key, entry]) => ({
    path: `/chunks${pointer([key])}`,
    change: "the chunk changed without writeChunk",
    noun: "term",
    tagged: ["chunk", key, entry.value],
    cached: hexOf(entry.term),
  }));
  cached.push({
    path: "/global",
    change: "the global value changed without writeGlobal",
    noun: "digest",
    tagged: ["global", state.global],
    cached: state.digests.globalDigest,
  });
  return cached.flatMap((item) => staleIssue(item) ?? []);
}

/**
 * The integrity_violation of `state`, whose full root differs from its incremental one: each
 * stale chunk and the global value, or one issue when no cached digest is stale, as when the
 * chunk sum itself disagrees with the terms.
 */
export function integrityError(state: WorldState): EngineError {
  const issues = staleDigests(state);
  if (issues.length === 0) {
    issues.push({ path: "", message: "the full checksum differs from the incremental state root" });
  }
  return new EngineError("integrity_violation", issues);
}
