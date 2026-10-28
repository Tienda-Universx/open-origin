/**
 * The downstream flow of taints and depths (ADR 0024, docs/architecture/mind.md "Provenance and
 * taints"): one pass over the beliefs by increasing id, in which each belief takes the taints of
 * every record it cites and its depth becomes one more than that of the deepest belief it cites.
 * One pass suffices because a belief only cites beliefs of a lower id, which the pass has already
 * settled. Afterwards a belief's taints contain those of everything it cites, and the taints of a
 * belief never shrink.
 */
import { greatest } from "./bounds.ts";
import type { Belief, LocalId, Mind, MindRecord } from "./records.ts";
import { citedTaints } from "./taints.ts";

/**
 * The record `id` cites, looking among the beliefs `settled` so far, then the episodes and the
 * relationships; undefined for an id the mind does not hold, or a belief of a higher id, which the
 * invariants reject.
 */
function citedRecord(mind: Mind, settled: readonly Belief[], id: LocalId): MindRecord | undefined {
  const belief = settled.find((record) => record.id === id);
  if (belief !== undefined) return { store: "beliefs", record: belief };
  const episode = mind.episodes.find((record) => record.id === id);
  if (episode !== undefined) return { store: "episodes", record: episode };
  const relationship = mind.relations.find((record) => record.id === id);
  return relationship === undefined ? undefined : { store: "relations", record: relationship };
}

/** `belief` with the taints of `cited` added and its depth recomputed from them. */
function settledBelief(belief: Belief, cited: readonly MindRecord[]): Belief {
  const union = citedTaints(cited);
  let deepest = 0;
  for (const record of cited) {
    if (record.store === "beliefs") deepest = greatest(deepest, record.record.dp);
  }
  const tn = belief.tn | union.tn;
  const ex = belief.ex | union.ex;
  const dp = deepest + 1;
  if (tn === belief.tn && ex === belief.ex && dp === belief.dp) return belief;
  return { ...belief, tn, ex, dp };
}

/**
 * `mind` after the pass, and the beliefs whose taints grew in it, by increasing id, for the ledger.
 * The mind is the same value when nothing changed.
 */
export function settle(mind: Mind): { readonly mind: Mind; readonly tainted: readonly LocalId[] } {
  const settled: Belief[] = [];
  const tainted: LocalId[] = [];
  let changed = false;
  for (const belief of mind.beliefs) {
    const cited: MindRecord[] = [];
    for (const id of belief.ev) {
      const record = citedRecord(mind, settled, id);
      if (record !== undefined) cited.push(record);
    }
    const next = settledBelief(belief, cited);
    if (next.tn !== belief.tn || next.ex !== belief.ex) tainted.push(belief.id);
    changed ||= next !== belief;
    settled.push(next);
  }
  return changed ? { mind: { ...mind, beliefs: settled }, tainted } : { mind, tainted };
}
