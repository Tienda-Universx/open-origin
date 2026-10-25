/**
 * Integrity (ADR 0020, ownership): what a state that disagrees with its incremental digests is.
 * Inside the tick, writes that bypass the barrier are detected, not prevented: audit looks for
 * them after every commit, and encodeSnapshot before it writes a snapshot. Both report them here,
 * in one integrity_violation that names each stale chunk and the global value.
 */

import { canonicalize } from "../canonical/encode.ts";
import type { CanonicalValue } from "../canonical/value.ts";
import { pointer } from "../canonical/value.ts";
import { type Digest, Digester, hexOf } from "../digest/digest.ts";
import { describePath, EngineError, type Issue } from "../errors.ts";
import { chunkTermOfText, globalDigestOfText } from "./checksum.ts";
import type { WorldState } from "./world.ts";

/** What a stale cached digest is. */
type Cached = {
  readonly path: string;
  /** What changed behind the barrier, as the start of a sentence. */
  readonly change: string;
  /** What the cache keeps: "term" or "digest". */
  readonly noun: string;
  /** The value whose digest the cache keeps. */
  readonly value: CanonicalValue;
  /** The digest of the value that has the canonical text `text`, as the cache keeps it. */
  readonly digestOf: (text: string) => Digest;
  readonly cached: Digest;
};

/** Why the cached digest of `cached` is stale; undefined when it still matches. */
function staleIssue({ path, change, noun, value, digestOf, cached }: Cached): Issue | undefined {
  try {
    // The value is canonicalized alone: its depth is its own, as in the commit.
    if (digestOf(canonicalize(value)) === cached) return undefined;
    return { path, message: `${change}: its cached ${noun} no longer matches it` };
  } catch (error) {
    if (!EngineError.isEngineError(error)) throw error;
    const [first] = error.issues;
    const at = describePath(first?.path ?? "");
    return { path, message: `${change}, and it is not canonical: at ${at}: ${first?.message}` };
  }
}

/** Every chunk and global value whose cached digest no longer matches it: O(N). */
function staleDigests(state: WorldState): Issue[] {
  const digester = new Digester();
  const cached: Cached[] = state.chunks.sortedEntries().map(([key, entry]) => ({
    path: `/chunks${pointer([key])}`,
    change: "the chunk changed without writeChunk",
    noun: "term",
    value: entry.value,
    digestOf: (text) => hexOf(chunkTermOfText(key, text, digester)),
    cached: hexOf(entry.term),
  }));
  cached.push({
    path: "/global",
    change: "the global value changed without writeGlobal",
    noun: "digest",
    value: state.global,
    digestOf: (text) => globalDigestOfText(text, digester),
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
