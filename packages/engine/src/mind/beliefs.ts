/**
 * The belief operations of a decision (ADR 0024, docs/architecture/mind.md "Beliefs"): `believe`,
 * `revise`, and `drop`, applied in that order of kinds and each kind in the order given, to a mind
 * and operations the beings layer has already copied, read, and bounded. They are atomic: the first
 * operation that fails gives its reason and nothing applies, and since values are never changed in
 * place, the mind given is left as it was. The engine checks a belief's structure and references,
 * never its truth.
 *
 * - A belief cites live records of the decision's manifest, at most 3, each once; it may cite
 *   episodes and relationships of any id, but beliefs only of a lower id, so support is acyclic.
 * - Its depth is one more than that of the deepest belief it cites, at most `mind.depth`.
 * - Adopting a proposition already held, by canonical equality, revises the belief that holds it.
 * - A revision must cite a record it does not cite now; `ev` keeps the three most recent citations,
 *   while `src`, `tn`, and `ex` keep what the ones it drops brought. The ledger records the drop
 *   through the `ev` it gives of the revised belief (beings/mental.ts).
 * - Citing a record refreshes it: an episode as a recall does, a belief's `u` becomes now.
 */
import { greatest } from "../int.ts";
import { MIND_BOUNDS } from "./bounds.ts";
import type { MindContext } from "./context.ts";
import { copyProposition, type Proposition, sameProposition } from "./prop.ts";
import {
  type Belief,
  EVIDENCE,
  freeId,
  type LocalId,
  type Mind,
  type MindRecord,
  recordOf,
  type TaintMask,
} from "./records.ts";
import { refreshEpisode } from "./salience.ts";
import { settle } from "./settle.ts";
import { admitBelief, type Unlinked, withoutRecords } from "./store.ts";
import { exposureAfterBelief, formedTaints, revisedTaints } from "./taints.ts";

/** A new belief: a proposition, a confidence, the records it cites, and the brain's rule. */
export type BelieveOperation = {
  readonly p: Proposition;
  readonly cr: number;
  readonly ev: readonly LocalId[];
  readonly rule: string;
};

/** A revision of the belief `id`: its new confidence and the evidence it adds. */
export type ReviseOperation = {
  readonly id: LocalId;
  readonly cr: number;
  readonly ev: readonly LocalId[];
};

export type BeliefOperations = {
  readonly believe?: readonly BelieveOperation[];
  readonly revise?: readonly ReviseOperation[];
  readonly drop?: readonly LocalId[];
};

/** Why the mental operations of an intention were refused (the table of "Beliefs"). */
export type MindReason = "mind_malformed" | "unknown_record" | "premise_order" | "depth_exceeded";

/** Mental operations the engine refused, with the reason of the first that failed. */
export type MindRefused = { readonly kind: "rejected"; readonly reason: MindReason };

/**
 * The records a decision may cite. In T5 it is the whole live mind, so citing a record the mind
 * does not hold is `unknown_record`; T9 adds the context of a prompt.
 */
export type Manifest = { readonly kind: "live" };
export const LIVE_MANIFEST: Manifest = Object.freeze({ kind: "live" });

/** What the operations changed, for the ledger: each list in the order the changes happened. */
export type BeliefChanges = {
  /** The beliefs formed, with the brain's rule, including one its full store evicted at once. */
  readonly formed: readonly { readonly id: LocalId; readonly rule: string }[];
  /**
   * Each revision, in order: by `revise`, or, with the rule of the `believe` that made it, by
   * adopting a proposition the belief holds.
   */
  readonly revised: readonly { readonly id: LocalId; readonly rule?: string }[];
  readonly dropped: readonly LocalId[];
  /** Every record that left the mind, dropped or evicted, and the beliefs that lost it. */
  readonly unlinked: readonly Unlinked[];
  /** The beliefs whose taints grew by the downstream flow, by increasing id. */
  readonly tainted: readonly LocalId[];
};

export type BeliefsApplied = {
  readonly kind: "applied";
  readonly mind: Mind;
  readonly changes: BeliefChanges;
};

/** The kind of evidence `record` is: what the being saw, was told, inferred, or was injected. */
function evidenceOf(record: MindRecord): number {
  if (record.store !== "episodes") return EVIDENCE.inferred;
  if (record.record.kind === "heard") return EVIDENCE.told;
  return record.record.kind === "external" ? EVIDENCE.external : EVIDENCE.seen;
}

/** The union of the kinds of evidence of `cited`. */
function evidenceMask(cited: readonly MindRecord[]): number {
  return cited.reduce((mask, record) => mask | evidenceOf(record), 0);
}

/** The speaker of the last `heard` episode `cited` holds; undefined when it holds none. */
function lastSpeaker(cited: readonly MindRecord[]): number | undefined {
  let who: number | undefined;
  for (const record of cited) {
    if (record.store === "episodes" && record.record.kind === "heard") who = record.record.who;
  }
  return who;
}

/** The depth of the deepest belief `cited` holds; 0 when it holds none. */
function deepestOf(cited: readonly MindRecord[]): number {
  return cited.reduce(
    (deepest, record) =>
      record.store === "beliefs" ? greatest(deepest, record.record.dp) : deepest,
    0,
  );
}

/** The belief `id` that `op` forms from `cited`, with the being's exposure `exposure`, at `now`. */
function formedBelief(
  id: LocalId,
  op: BelieveOperation,
  cited: readonly MindRecord[],
  context: { readonly exposure: TaintMask; readonly now: number },
): Belief {
  const { tn, ex } = formedTaints(cited, context.exposure);
  const who = lastSpeaker(cited);
  return {
    id,
    p: copyProposition(op.p),
    cr: op.cr,
    src: evidenceMask(cited),
    ...(who === undefined ? {} : { who }),
    ev: [...op.ev],
    lost: 0,
    tn,
    ex,
    dp: deepestOf(cited) + 1,
    u: context.now,
  };
}

/**
 * `target` revised by `op` with the evidence `cited`: `ev` gains the citations of `op`, the most
 * recent last, and keeps the last three. Its depth is the downstream pass's to recompute.
 */
function revisedBelief(
  target: Belief,
  op: ReviseOperation,
  cited: readonly MindRecord[],
  context: { readonly exposure: TaintMask; readonly now: number },
): Belief {
  const added = op.ev;
  const merged = [...target.ev.filter((id) => !added.includes(id)), ...added];
  const cut = greatest(0, merged.length - MIND_BOUNDS.citations.max);
  const { tn, ex } = revisedTaints(target, cited, context.exposure);
  const who = lastSpeaker(cited) ?? target.who;
  return {
    ...target,
    cr: op.cr,
    src: target.src | evidenceMask(cited),
    ...(who === undefined ? {} : { who }),
    ev: merged.slice(cut),
    tn,
    ex,
    u: context.now,
  };
}

/** Whether `ids` holds an id twice. */
function repeats(ids: readonly LocalId[]): boolean {
  return ids.some((id, index) => ids.indexOf(id) !== index);
}

/**
 * The records `ids` cite in `mind`, in order, or why they cannot: an id given twice is
 * `mind_malformed`, and one outside the manifest `unknown_record`.
 */
export function citedRecords(
  mind: Mind,
  ids: readonly LocalId[],
  manifest: Manifest,
): readonly MindRecord[] | MindReason {
  if (repeats(ids)) return "mind_malformed";
  const cited: MindRecord[] = [];
  for (const id of ids) {
    const record = manifest.kind === "live" ? recordOf(mind, id) : undefined;
    if (record === undefined) return "unknown_record";
    cited.push(record);
  }
  return cited;
}

/**
 * `mind` with every record of `cited` refreshed at the context's moment, as citing it as evidence
 * does: an episode as a recall does, and a belief's `u` becomes now.
 */
export function refreshCited(mind: Mind, cited: readonly MindRecord[], ctx: MindContext): Mind {
  let { episodes, beliefs } = mind;
  for (const { store, record } of cited) {
    if (store === "episodes") {
      const current = episodes;
      episodes = current.map((e) => (e.id === record.id ? refreshEpisode(e, current, ctx) : e));
    } else if (store === "beliefs") {
      beliefs = beliefs.map((b) => (b.id === record.id ? { ...b, u: ctx.moment.tick } : b));
    }
  }
  return { ...mind, episodes, beliefs };
}

/** The mind as the operations of one decision change it, and what changed. */
class Draft {
  mind: Mind;
  readonly #ctx: MindContext;
  readonly #manifest: Manifest;
  readonly #formed: { readonly id: LocalId; readonly rule: string }[] = [];
  readonly #revised: { readonly id: LocalId; readonly rule?: string }[] = [];
  readonly #dropped: LocalId[] = [];
  readonly #unlinked: Unlinked[] = [];
  readonly #tainted: LocalId[] = [];

  constructor(mind: Mind, ctx: MindContext, manifest: Manifest) {
    this.mind = mind;
    this.#ctx = ctx;
    this.#manifest = manifest;
  }

  changes(): BeliefChanges {
    return {
      formed: this.#formed,
      revised: this.#revised,
      dropped: this.#dropped,
      unlinked: this.#unlinked,
      tainted: [...this.#tainted].sort((a, b) => a - b),
    };
  }

  /** The records `ids` cite, in order, or why they cannot: a repeat, or one outside the manifest. */
  #cite(ids: readonly LocalId[]): readonly MindRecord[] | MindReason {
    return citedRecords(this.mind, ids, this.#manifest);
  }

  /** Refreshes every record of `cited`: an episode as a recall does, a belief's `u` to now. */
  #refresh(cited: readonly MindRecord[]): void {
    this.mind = refreshCited(this.mind, cited, this.#ctx);
  }

  /**
   * Runs the downstream pass after an operation on the beliefs `before`; `depth_exceeded` when the
   * operation made a belief, new or held, deeper than it was and deeper than `mind.depth`. A belief
   * already beyond the limit does not stop an operation that leaves it no deeper.
   */
  #settle(before: readonly Belief[]): MindReason | undefined {
    const { mind, tainted } = settle(this.mind);
    this.mind = mind;
    for (const id of tainted) if (!this.#tainted.includes(id)) this.#tainted.push(id);
    const limit = this.#ctx.laws.mind.depth;
    const deepened = mind.beliefs.some((belief) => {
      const was = before.find((held) => held.id === belief.id)?.dp ?? 0;
      return belief.dp > limit && belief.dp > was;
    });
    return deepened ? "depth_exceeded" : undefined;
  }

  believe(op: BelieveOperation): MindReason | undefined {
    const held = this.mind.beliefs.find((belief) => sameProposition(belief.p, op.p));
    if (held !== undefined) return this.revise({ id: held.id, cr: op.cr, ev: op.ev }, op.rule);
    const before = this.mind.beliefs;
    const cited = this.#cite(op.ev);
    if (typeof cited === "string") return cited;
    const id = freeId(this.mind);
    if (id === undefined) return "mind_malformed";
    // Judged as formed: its store may evict it, or its premise, only once it is admitted.
    if (deepestOf(cited) + 1 > this.#ctx.laws.mind.depth) return "depth_exceeded";
    this.#refresh(cited);
    const { exposure } = this.mind;
    const belief = formedBelief(id, op, cited, { exposure, now: this.#ctx.moment.tick });
    const formed: Mind = {
      ...this.mind,
      next: id + 1,
      exposure: exposureAfterBelief(exposure, belief),
    };
    const { mind, displaced } = admitBelief(formed, belief, this.#ctx);
    this.mind = mind;
    this.#formed.push({ id, rule: op.rule });
    this.#unlinked.push(...displaced);
    return this.#settle(before);
  }

  /** Revises a belief; `rule` is the rule of the `believe` that adopted its proposition, if one did. */
  revise(op: ReviseOperation, rule?: string): MindReason | undefined {
    const before = this.mind.beliefs;
    const added = op.ev;
    const cited = this.#cite(added);
    if (typeof cited === "string") return cited;
    const target = this.mind.beliefs.find((belief) => belief.id === op.id);
    if (target === undefined) return "unknown_record";
    const higher = cited.some(({ store, record }) => store === "beliefs" && record.id >= target.id);
    if (higher || added.every((id) => target.ev.includes(id))) return "premise_order";
    this.#refresh(cited);
    const { exposure } = this.mind;
    const belief = revisedBelief(target, op, cited, {
      exposure,
      now: this.#ctx.moment.tick,
    });
    const beliefs = this.mind.beliefs.map((held) => (held.id === target.id ? belief : held));
    this.mind = { ...this.mind, beliefs, exposure: exposureAfterBelief(exposure, belief) };
    this.#revised.push({ id: target.id, ...(rule === undefined ? {} : { rule }) });
    return this.#settle(before);
  }

  drop(id: LocalId): MindReason | undefined {
    const before = this.mind.beliefs;
    if (!before.some((belief) => belief.id === id)) return "unknown_record";
    const { mind, unlinked } = withoutRecords(this.mind, [id]);
    this.mind = mind;
    this.#dropped.push(id);
    this.#unlinked.push(...unlinked);
    return this.#settle(before);
  }
}

/** The reason of the first of `items` that `apply` refuses; undefined when it applies them all. */
function firstRefusal<T>(
  items: readonly T[] | undefined,
  apply: (item: T) => MindReason | undefined,
): MindReason | undefined {
  for (const item of items ?? []) {
    const reason = apply(item);
    if (reason !== undefined) return reason;
  }
  return undefined;
}

/**
 * `mind` after the belief operations `operations` of one decision at the context's moment, with
 * what they changed; or the reason of the first that failed, and then nothing applies. Citations
 * resolve against `manifest`. Without operations the mind is the same value.
 */
export function applyBeliefs(
  mind: Mind,
  operations: BeliefOperations,
  ctx: MindContext,
  manifest: Manifest,
): BeliefsApplied | MindRefused {
  const draft = new Draft(mind, ctx, manifest);
  const reason =
    firstRefusal(operations.believe, (op) => draft.believe(op)) ??
    firstRefusal(operations.revise, (op) => draft.revise(op)) ??
    firstRefusal(operations.drop, (id) => draft.drop(id));
  if (reason !== undefined) return { kind: "rejected", reason };
  return { kind: "applied", mind: draft.mind, changes: draft.changes() };
}
