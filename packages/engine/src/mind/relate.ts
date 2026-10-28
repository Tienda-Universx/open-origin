/**
 * The `relate` operations of a decision (ADR 0024, docs/architecture/mind.md "Relationships" and
 * "Beliefs"), the last kind to apply: each changes the affinity and the trust of the relationship
 * the mind holds with `who`, by signed amounts the beings layer has already bounded by
 * `relations.delta`, each result saturating at its bounds, and cites in `because` one to three live
 * records of the manifest, at least one of which involves `who`. The relationship takes the
 * lineage `tn` of what it cites, which flows downstream to every belief that cites it, and the
 * records it cites are refreshed as any citation refreshes them. They are atomic like the other
 * operations: the first that fails gives its reason, and the mind given is left as it was.
 */
import { greatest, least } from "../int.ts";
import {
  citedRecords,
  type Manifest,
  type MindReason,
  type MindRefused,
  refreshCited,
} from "./beliefs.ts";
import { MIND_BOUNDS } from "./bounds.ts";
import type { MindContext } from "./context.ts";
import type { LocalId, Mind, MindRecord, Relationship } from "./records.ts";
import { settle } from "./settle.ts";
import { citedTaints } from "./taints.ts";

/** A change of the relationship with `who`: signed changes of affinity and trust, and evidence. */
export type RelateOperation = {
  readonly who: number;
  readonly aff?: number;
  readonly tr?: number;
  readonly because: readonly LocalId[];
};

/** A relationship a `relate` changed, and the records the operation cited for it. */
export type Related = { readonly id: LocalId; readonly because: readonly LocalId[] };

export type RelateApplied = {
  readonly kind: "applied";
  readonly mind: Mind;
  /** Each operation's relationship and citations, in the order of the operations. */
  readonly related: readonly Related[];
  /** The beliefs whose taints grew by the downstream flow, by increasing id. */
  readonly tainted: readonly LocalId[];
};

/**
 * Whether `record` involves the being `who`: a `being` or `heard` episode whose `who` is that
 * being, or a belief whose last speaker it is.
 */
export function involves(record: MindRecord, who: number): boolean {
  if (record.store === "beliefs") return record.record.who === who;
  if (record.store === "relations") return false;
  const episode = record.record;
  return (episode.kind === "being" || episode.kind === "heard") && episode.who === who;
}

/** `value` moved by `change`, saturating within `bounds`. */
function moved(value: number, change: number | undefined, bounds: typeof MIND_BOUNDS.affinity) {
  return least(bounds.max, greatest(bounds.min, value + (change ?? 0)));
}

/** `relationship` after `op` with the evidence `cited`: its judgments moved, its lineage grown. */
function relatedRecord(
  relationship: Relationship,
  op: RelateOperation,
  cited: readonly MindRecord[],
): Relationship {
  return {
    ...relationship,
    aff: moved(relationship.aff, op.aff, MIND_BOUNDS.affinity),
    tr: moved(relationship.tr, op.tr, MIND_BOUNDS.permille),
    tn: relationship.tn | citedTaints(cited).tn,
  };
}

/**
 * `mind` after one `relate`, with the relationship it changed and the beliefs the flow tainted; or
 * why it cannot: a citation given twice (`mind_malformed`), one the mind does not hold or no
 * relationship with `who` (`unknown_record`), or no citation involving `who` (`premise_order`).
 */
function relateOne(
  mind: Mind,
  op: RelateOperation,
  ctx: MindContext,
  manifest: Manifest,
):
  | { readonly mind: Mind; readonly id: LocalId; readonly tainted: readonly LocalId[] }
  | MindReason {
  const cited = citedRecords(mind, op.because, manifest);
  if (typeof cited === "string") return cited;
  const index = mind.relations.findIndex((relationship) => relationship.who === op.who);
  const target = mind.relations[index];
  if (target === undefined) return "unknown_record";
  if (!cited.some((record) => involves(record, op.who))) return "premise_order";
  const refreshed = refreshCited(mind, cited, ctx);
  const relations = refreshed.relations.with(index, relatedRecord(target, op, cited));
  const { mind: settled, tainted } = settle({ ...refreshed, relations });
  return { mind: settled, id: target.id, tainted };
}

/**
 * `mind` after the `relate` operations `ops` of one decision at the context's moment, in order;
 * or the reason of the first that failed, and then nothing applies. Citations resolve against
 * `manifest`. Without operations the mind is the same value.
 */
export function applyRelate(
  mind: Mind,
  ops: readonly RelateOperation[],
  ctx: MindContext,
  manifest: Manifest,
): RelateApplied | MindRefused {
  let current = mind;
  const related: Related[] = [];
  const tainted: LocalId[] = [];
  for (const op of ops) {
    const done = relateOne(current, op, ctx, manifest);
    if (typeof done === "string") return { kind: "rejected", reason: done };
    current = done.mind;
    related.push({ id: done.id, because: [...op.because] });
    for (const id of done.tainted) if (!tainted.includes(id)) tainted.push(id);
  }
  return { kind: "applied", mind: current, related, tainted: tainted.sort((a, b) => a - b) };
}
