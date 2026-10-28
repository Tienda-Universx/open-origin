/**
 * Taints (ADR 0024, refining ADR 0006): two measures of contamination, kept in two fields. `tn` is
 * a record's lineage, the exact union over what it was formed from; `ex` is exposure, the being's
 * lifetime exposure when a belief was formed or revised, which no citation or rephrasing avoids.
 * Both are masks of the three taints, and both only grow (docs/architecture/mind.md, "Provenance
 * and taints").
 */
import type { MindRecord, TaintMask } from "./records.ts";

/** The taints, by their bits in a mask. */
export const TAINTS = Object.freeze({
  modelPriorSuspect: 1,
  humanExternal: 2,
  implementationLeak: 4,
});

/** A record's two measures. */
export type Taints = { readonly tn: TaintMask; readonly ex: TaintMask };

const UNTAINTED: Taints = Object.freeze({ tn: 0, ex: 0 });

/**
 * The taints `record` passes to what cites it: a belief's own; a relationship's lineage, with no
 * exposure of its own; a `heard` episode's, which its message carried; an `external` episode's
 * lineage; and nothing for an episode of the being's own experience.
 */
export function taintsOf(record: MindRecord): Taints {
  if (record.store === "beliefs") return { tn: record.record.tn, ex: record.record.ex };
  if (record.store === "relations") return { tn: record.record.tn, ex: 0 };
  const episode = record.record;
  if (episode.kind === "heard") return { tn: episode.tn, ex: episode.ex };
  if (episode.kind === "external") return { tn: episode.tn, ex: 0 };
  return UNTAINTED;
}

/** The union of the taints of every record in `cited`. */
export function citedTaints(cited: readonly MindRecord[]): Taints {
  let tn = 0;
  let ex = 0;
  for (const record of cited) {
    const taints = taintsOf(record);
    tn |= taints.tn;
    ex |= taints.ex;
  }
  return { tn, ex };
}

/**
 * The taints of a new belief that cites `cited`, formed with the being's exposure `exposure`: the
 * union of what it cites, plus `model-prior-suspect` when it cites nothing; and the exposure with
 * what it cites.
 */
export function formedTaints(cited: readonly MindRecord[], exposure: TaintMask): Taints {
  const union = citedTaints(cited);
  const prior = cited.length === 0 ? TAINTS.modelPriorSuspect : 0;
  return { tn: union.tn | prior, ex: exposure | union.ex };
}

/**
 * The taints of a belief whose taints were `own`, revised with the new evidence `cited` and the
 * exposure `exposure`: never smaller than `own`.
 */
export function revisedTaints(
  own: Taints,
  cited: readonly MindRecord[],
  exposure: TaintMask,
): Taints {
  const union = citedTaints(cited);
  return { tn: own.tn | union.tn, ex: exposure | own.ex | union.ex };
}

/** The exposure after a message with the taints `message` reaches the inbox. */
export function exposureAfterMessage(exposure: TaintMask, message: Taints): TaintMask {
  return exposure | message.tn | message.ex;
}

/** The exposure after the being forms or revises a belief with the taints `belief`: its lineage. */
export function exposureAfterBelief(exposure: TaintMask, belief: Taints): TaintMask {
  return exposure | belief.tn;
}

/** Whether a belief with the taints `taints` is reasoned: it holds neither measure. */
export function isReasoned(taints: Taints): boolean {
  return (taints.tn | taints.ex) === 0;
}

/** Whether `whole` holds every taint of `part`, in both measures. */
export function coversTaints(whole: Taints, part: Taints): boolean {
  return (whole.tn | part.tn) === whole.tn && (whole.ex | part.ex) === whole.ex;
}
