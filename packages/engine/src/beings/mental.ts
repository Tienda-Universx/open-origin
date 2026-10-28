/**
 * The mind at a decision of beings@2 (ADR 0024, docs/architecture/mind.md "Beliefs", "Time,
 * salience, and forgetting", "Relationships", and "Events"). Step 1 is a law: the engine forgets
 * what has faded by now; updates familiarity, creating a relationship for each perceived being, in
 * the order attention keeps them, then for each speaker of the inbox, by increasing id, that has
 * none; and consumes the inbox, whose messages the brain hears. The brain decides on the view of
 * that mind. Then the operations of an accepted intention apply in the order of their kinds,
 * `remember`, `recall`, then `believe`, `revise`, `drop`, and `relate` through the mind layer, each
 * kind in the order given, new records taking the ids `next`, `next + 1`, and so on. They are
 * atomic: the first that fails gives its reason, and since no value is changed in place, the mind
 * after step 1 stays as it was. A `remember` makes an episode the engine copies from the percepts
 * it kept of the decision, never from the brain: the brain only picks a percept and gives its
 * importance. What a decision changed is its ledger, which the tick emits as `mind.changed` (C1)
 * and `mind.provenance` (C3).
 */
import type { CanonicalValue } from "../canonical/value.ts";
import {
  admitEpisode,
  applyBeliefs,
  applyRelate,
  copyProposition,
  type Episode,
  FAILURES,
  forget,
  freeId,
  type InboxMessage,
  importanceWithin,
  LIVE_MANIFEST,
  type LocalId,
  MIND_BOUNDS,
  type Mind,
  type MindContext,
  type MindReason,
  type MindRefused,
  perceive,
  type Related,
  refreshEpisode,
  relationshipWith,
  taintsOf,
  type Unlinked,
} from "../mind/index.ts";
import type { Cell, Outcome } from "./being.ts";
import type { SensedWindow } from "./contracts.ts";
import { integrity } from "./env.ts";
import type { MindOperations, Percept, RememberOperation } from "./operations.ts";
import type { PerceivedBeing } from "./perception.ts";
import { least } from "./rates.ts";

/**
 * What the being perceived at its decision, as the engine keeps it apart from the senses it gave
 * the brain: the tick, its cell and outcome, the beings it perceived, the messages it heard, its
 * window, and the kinds of activity of the ruleset, whose index a `being` episode holds.
 */
export type Percepts = {
  readonly tick: number;
  readonly cell: Cell;
  readonly outcome: Outcome;
  readonly beings: readonly PerceivedBeing[];
  readonly heard: readonly InboxMessage[];
  readonly window: SensedWindow;
  readonly activities: readonly string[];
};

/** What a decision changed in a mind, for the ledger: each list in the order it happened. */
export type MindLedger = {
  /** The episodes `remember` made, one its full store evicted at once included. */
  readonly encoded: readonly LocalId[];
  readonly formed: readonly { readonly id: LocalId; readonly rule: string }[];
  /** Each revision; with the rule of the `believe` that adopted a proposition the belief held. */
  readonly revised: readonly { readonly id: LocalId; readonly rule?: string }[];
  readonly dropped: readonly LocalId[];
  /**
   * Every record that left the mind but by `drop`: faded at step 1, by increasing id, then evicted
   * by a full store; each with the beliefs that cited it and lost it.
   */
  readonly forgot: readonly Unlinked[];
  /** The beliefs whose taints grew by the downstream flow, by increasing id. */
  readonly tainted: readonly LocalId[];
  /** The relationships step 1 created, in the order it created them, one evicted at once included. */
  readonly created: readonly LocalId[];
  /** Each `relate`'s relationship and the records it cited, in the order of the operations. */
  readonly related: readonly Related[];
};

/** An episode without the members the engine adds to every one: its id, importance, and anchor. */
type Content = Episode extends infer E
  ? E extends Episode
    ? Omit<E, "id" | "w" | "r">
    : never
  : never;

/** A decision's mind after its operations applied, and the ledger of the whole decision. */
type Decided = {
  readonly kind: "applied";
  readonly mind: Mind;
  readonly ledger: MindLedger;
};

/** The mind after step 1, its ledger, and the messages its inbox held, which the decision hears. */
export type StepOne = Decided & { readonly heard: readonly InboxMessage[] };

/** The speakers of `inbox`, each once, by increasing id. */
function speakersOf(inbox: readonly InboxMessage[]): number[] {
  const speakers: number[] = [];
  for (const { who } of inbox) if (who !== undefined && !speakers.includes(who)) speakers.push(who);
  return speakers.sort((a, b) => a - b);
}

/**
 * Step 1 of a decision, a law (mind.md, "Beliefs"): `mind` without what has faded by the context's
 * moment; then familiarity updated, with a relationship created for each being of `perceived`, in
 * that order, the order attention keeps them, and then for each speaker of the inbox that has none,
 * by increasing id, a full store evicting by its rule; then the inbox consumed. The ledger records
 * what faded and what was evicted, in that order, and the relationships created. The mind is the
 * same value when nothing changed.
 */
export function stepOne(mind: Mind, perceived: readonly number[], ctx: MindContext): StepOne {
  const { mind: kept, forgot } = forget(mind, ctx);
  let current = kept;
  const created: LocalId[] = [];
  const evicted: Unlinked[] = [];
  const meet = (who: number) => {
    const met = perceive(current, who, ctx);
    current = met.mind;
    if (met.created !== undefined) created.push(met.created);
    evicted.push(...met.displaced);
  };
  for (const who of perceived) meet(who);
  for (const who of speakersOf(current.inbox))
    if (relationshipWith(current, who) === undefined) meet(who);
  const heard = current.inbox;
  if (heard.length > 0) current = { ...current, inbox: [] };
  const ledger: MindLedger = {
    encoded: [],
    formed: [],
    revised: [],
    dropped: [],
    forgot: [...forgot, ...evicted],
    tainted: [],
    created,
    related: [],
  };
  return { kind: "applied", mind: current, ledger, heard };
}

/** The index of `cell` in the window `window`; undefined for a cell outside it. */
function windowIndex(window: SensedWindow, cell: Cell): number | undefined {
  const column = cell[0] - window.origin[0];
  const row = cell[1] - window.origin[1];
  const { side } = window;
  return column < 0 || row < 0 || column >= side || row >= side ? undefined : row * side + column;
}

/**
 * The content of an episode of the being's own outcome: its last failure, or its last meal, whose
 * units saturate at the largest value an episode holds, 2^20, which a meal of valid laws may pass.
 */
function outcomeContent(percepts: Percepts): Content | undefined {
  const { outcome } = percepts;
  const cell: Cell = [percepts.cell[0], percepts.cell[1]];
  if (outcome.result === "failed") {
    const v = FAILURES.indexOf(outcome.reason);
    return v < 0 ? undefined : { kind: "failed", t: outcome.tick, cell, v };
  }
  return outcome.units === undefined
    ? undefined
    : { kind: "ate", t: outcome.tick, cell, v: least(outcome.units, MIND_BOUNDS.value.max) };
}

/**
 * The episode of a message heard at the tick `t`: a `heard` episode of a known speaker's message,
 * with the message's act, content, and taints; an `external` one of a research injection's, with
 * its proposition and its lineage, and no speaker and no cell.
 */
function heardContent(message: InboxMessage, t: number): Content {
  const { who, cell, act, p, band, tn, ex } = message;
  if (who === undefined || cell === undefined) {
    // validateChunk accepts only an injection's message, a tell of a proposition, without a speaker.
    if (p === undefined) throw integrity("an injection's message holds no proposition");
    return { kind: "external", t, p: copyProposition(p), tn };
  }
  return {
    kind: "heard",
    t,
    cell: [cell[0], cell[1]],
    who,
    act,
    ...(p === undefined ? {} : { p: copyProposition(p) }),
    ...(band === undefined ? {} : { band }),
    tn,
    ex,
  };
}

/**
 * The content the engine copies for `percept` from what it perceived: undefined for a percept the
 * decision does not hold.
 */
function contentOf(percept: Percept, percepts: Percepts): Content | undefined {
  const t = percepts.tick;
  switch (percept.kind) {
    case "being": {
      const being = percepts.beings[percept.index];
      if (being === undefined) return undefined;
      const v = percepts.activities.indexOf(being.activity);
      // validateChunk accepts only the ruleset's kinds of activity: any other is a broken state.
      if (v < 0)
        throw integrity(
          `the being ${being.id} was perceived doing "${being.activity}", no kind of activity of the ruleset`,
        );
      return { kind: "being", t, cell: [being.cell[0], being.cell[1]], who: being.id, v };
    }
    case "food": {
      const index = windowIndex(percepts.window, percept.cell);
      if (index === undefined) return undefined;
      const v = percepts.window.foodCue[index] as number;
      return { kind: "food", t, cell: [percept.cell[0], percept.cell[1]], v };
    }
    case "outcome":
      return outcomeContent(percepts);
    default: {
      const message = percepts.heard[percept.index];
      return message === undefined ? undefined : heardContent(message, t);
    }
  }
}

/** `mind` with the episode `op` makes, admitted to its store, and what the store evicted for it. */
function remember(
  mind: Mind,
  op: RememberOperation,
  percepts: Percepts,
  ctx: MindContext,
):
  | { readonly mind: Mind; readonly id: LocalId; readonly displaced: readonly Unlinked[] }
  | MindReason {
  const content = contentOf(op.percept, percepts);
  if (content === undefined) return "unknown_record";
  const id = freeId(mind);
  if (id === undefined) return "mind_malformed";
  const w = importanceWithin(mind.episodes, undefined, op.w, ctx.laws);
  const episode: Episode = { ...content, id, w, r: ctx.moment.tick };
  const admitted = admitEpisode({ ...mind, next: id + 1 }, episode, ctx);
  return { ...admitted, id };
}

/** `mind` with the episode `id` refreshed by a recall; `unknown_record` when it holds none. */
function recall(mind: Mind, id: LocalId, ctx: MindContext): Mind | MindReason {
  const { episodes } = mind;
  if (!episodes.some((episode) => episode.id === id)) return "unknown_record";
  return {
    ...mind,
    episodes: episodes.map((e) => (e.id === id ? refreshEpisode(e, episodes, ctx) : e)),
  };
}

/** `mind` after the `remember` and `recall` operations of `ops`, or the reason of the first that failed. */
function encode(
  mind: Mind,
  ops: MindOperations,
  percepts: Percepts,
  ctx: MindContext,
):
  | { readonly mind: Mind; readonly encoded: LocalId[]; readonly displaced: Unlinked[] }
  | MindReason {
  let current = mind;
  const encoded: LocalId[] = [];
  const displaced: Unlinked[] = [];
  for (const op of ops.remember) {
    const made = remember(current, op, percepts, ctx);
    if (typeof made === "string") return made;
    current = made.mind;
    encoded.push(made.id);
    displaced.push(...made.displaced);
  }
  for (const id of ops.recall) {
    const recalled = recall(current, id, ctx);
    if (typeof recalled === "string") return recalled;
    current = recalled;
  }
  return { mind: current, encoded, displaced };
}

/**
 * The ids of `a` and `b`, each once, by increasing id, even when either repeats one, as two `relate`
 * operations on one being do.
 */
function unionOf(a: readonly LocalId[], b: readonly LocalId[]): LocalId[] {
  const union: LocalId[] = [];
  for (const id of [...a, ...b]) if (!union.includes(id)) union.push(id);
  return union.sort((x, y) => x - y);
}

/**
 * `mind`, the mind after step 1, once the operations `ops` applied at the context's moment, with
 * `step1` and what they changed in one ledger; or the reason of the first that failed, and then
 * nothing applies. The mind is the same value when the operations change nothing.
 */
export function applyOperations(
  step1: Decided,
  ops: MindOperations,
  percepts: Percepts,
  ctx: MindContext,
): Decided | MindRefused {
  const encoded = encode(step1.mind, ops, percepts, ctx);
  if (typeof encoded === "string") return { kind: "rejected", reason: encoded };
  const { believe, revise, drop } = ops;
  const applied = applyBeliefs(encoded.mind, { believe, revise, drop }, ctx, LIVE_MANIFEST);
  if (applied.kind === "rejected") return applied;
  const related = applyRelate(applied.mind, ops.relate, ctx, LIVE_MANIFEST);
  if (related.kind === "rejected") return related;
  const { changes } = applied;
  const evicted = changes.unlinked.filter(({ id }) => !changes.dropped.includes(id));
  const ledger: MindLedger = {
    encoded: encoded.encoded,
    formed: changes.formed,
    revised: changes.revised,
    dropped: changes.dropped,
    forgot: [...step1.ledger.forgot, ...encoded.displaced, ...evicted],
    tainted: unionOf(changes.tainted, related.tainted),
    created: step1.ledger.created,
    related: related.related,
  };
  return { kind: "applied", mind: related.mind, ledger };
}

/** The payload of `mind.changed` for the decision of the being `id` that `ledger` records. */
export function mindChanged(id: number, ledger: MindLedger): CanonicalValue {
  return {
    id,
    encoded: [...ledger.encoded],
    formed: ledger.formed.map((formed) => ({ id: formed.id, rule: formed.rule })),
    revised: ledger.revised.map((revised) =>
      revised.rule === undefined ? { id: revised.id } : { id: revised.id, rule: revised.rule },
    ),
    dropped: [...ledger.dropped],
    forgot: ledger.forgot.map((gone) => ({ id: gone.id, beliefs: [...gone.beliefs] })),
    related: unionOf(
      ledger.created,
      ledger.related.map((related) => related.id),
    ),
  };
}

/** The records each relationship of `ledger` was related with, in the order cited, each once. */
function relatedEvidence(ledger: MindLedger, id: LocalId): LocalId[] {
  const evidence: LocalId[] = [];
  for (const related of ledger.related) {
    if (related.id !== id) continue;
    for (const cited of related.because) if (!evidence.includes(cited)) evidence.push(cited);
  }
  return evidence;
}

/**
 * The payload of `mind.provenance` for the decision of the being `id`: the taints `tn` and `ex`
 * and the evidence `ev` of each record of `mind` the decision created, revised, related, or
 * tainted, by increasing id, an episode citing nothing and a relationship what its `relate`
 * operations cited, with no `ex` of its own; and the being's exposure.
 */
export function mindProvenance(id: number, ledger: MindLedger, mind: Mind): CanonicalValue {
  const touched = [
    ...ledger.encoded,
    ...ledger.formed.map((formed) => formed.id),
    ...ledger.revised.map((revised) => revised.id),
    ...ledger.tainted,
    ...ledger.created,
    ...ledger.related.map((related) => related.id),
  ];
  const episodes = mind.episodes
    .filter((episode) => touched.includes(episode.id))
    .map((episode) => ({
      id: episode.id,
      ...taintsOf({ store: "episodes", record: episode }),
      ev: [],
    }));
  const beliefs = mind.beliefs
    .filter((belief) => touched.includes(belief.id))
    .map((belief) => ({ id: belief.id, tn: belief.tn, ex: belief.ex, ev: [...belief.ev] }));
  const relations = mind.relations
    .filter((relationship) => touched.includes(relationship.id))
    .map((relationship) => ({
      id: relationship.id,
      tn: relationship.tn,
      ex: 0,
      ev: relatedEvidence(ledger, relationship.id),
    }));
  const records = [...episodes, ...beliefs, ...relations].sort((a, b) => a.id - b.id);
  return { id, records, exposure: mind.exposure };
}
