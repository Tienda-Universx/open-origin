/**
 * The mind at a decision of beings@2 (ADR 0024, docs/architecture/mind.md "Beliefs", "Time,
 * salience, and forgetting", and "Events"). Step 1 is a law: the engine forgets what has faded by
 * now, and the brain decides on the view of that mind. Then the operations of an accepted intention
 * apply in the order of their kinds, `remember`, `recall`, then `believe`, `revise`, and `drop`
 * through the mind layer, each kind in the order given, new records taking the ids `next`,
 * `next + 1`, and so on. They are atomic: the first that fails gives its reason, and since no value
 * is changed in place, the mind after step 1 stays as it was. A `remember` makes an episode the
 * engine copies from the percepts it kept of the decision, never from the brain: the brain only
 * picks a percept and gives its importance. What a decision changed is its ledger, which the tick
 * emits as `mind.changed` (C1) and `mind.provenance` (C3).
 */
import type { CanonicalValue } from "../canonical/value.ts";
import {
  admitEpisode,
  applyBeliefs,
  type Episode,
  FAILURES,
  forget,
  freeId,
  importanceWithin,
  LIVE_MANIFEST,
  type LocalId,
  MIND_BOUNDS,
  type Mind,
  type MindContext,
  type MindReason,
  type MindRefused,
  refreshEpisode,
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
 * the brain: the tick, its cell and outcome, the beings it perceived, its window, and the kinds of
 * activity of the ruleset, whose index a `being` episode holds.
 */
export type Percepts = {
  readonly tick: number;
  readonly cell: Cell;
  readonly outcome: Outcome;
  readonly beings: readonly PerceivedBeing[];
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

/** A ledger with nothing in it but `forgot`. */
function ledgerOf(forgot: readonly Unlinked[]): MindLedger {
  return { encoded: [], formed: [], revised: [], dropped: [], forgot, tainted: [] };
}

/**
 * Step 1 of a decision: `mind` without what has faded by the context's moment, and a ledger that
 * records it. The mind is the same value when nothing faded.
 */
export function forgetAtDecision(mind: Mind, ctx: MindContext): Decided {
  const { mind: kept, forgot } = forget(mind, ctx);
  return { kind: "applied", mind: kept, ledger: ledgerOf(forgot) };
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
 * The content the engine copies for `percept` from what it perceived: undefined for a percept the
 * decision does not hold. Nothing is heard until speech (T5-6), so no `heard` percept exists yet.
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
    default:
      return undefined;
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
  const { changes } = applied;
  const evicted = changes.unlinked.filter(({ id }) => !changes.dropped.includes(id));
  const ledger: MindLedger = {
    encoded: encoded.encoded,
    formed: changes.formed,
    revised: changes.revised,
    dropped: changes.dropped,
    forgot: [...step1.ledger.forgot, ...encoded.displaced, ...evicted],
    tainted: changes.tainted,
  };
  return { kind: "applied", mind: applied.mind, ledger };
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
    // Relationships change from T5-5b on.
    related: [],
  };
}

/**
 * The payload of `mind.provenance` for the decision of the being `id`: the taints `tn` and `ex`
 * and the evidence `ev` of each record of `mind` the decision created, revised, or tainted, by
 * increasing id, an episode citing nothing; and the being's exposure.
 */
export function mindProvenance(id: number, ledger: MindLedger, mind: Mind): CanonicalValue {
  const touched = [
    ...ledger.encoded,
    ...ledger.formed.map((formed) => formed.id),
    ...ledger.revised.map((revised) => revised.id),
    ...ledger.tainted,
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
  const records = [...episodes, ...beliefs].sort((a, b) => a.id - b.id);
  return { id, records, exposure: mind.exposure };
}
