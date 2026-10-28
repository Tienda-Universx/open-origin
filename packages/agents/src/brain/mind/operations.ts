/**
 * The operations of one decision of `mind@1`, and whether they may be proposed (docs/architecture/
 * mind.md "Beliefs" and "Time, salience, and forgetting"). A decision proposes at most `mind.ops`
 * operations, needs an id for each new record, and must never cite a record that a full store
 * evicts before the citation applies, or the engine rejects the whole intention. The brain
 * predicts each store as the engine fills it: every `remember` first, then every `believe`, each
 * evicting from a full store the record of lowest salience, the new one included, then the
 * oldest, then the lowest id, by the engine's law of salience at the moment of the decision.
 */
import { type beings, type DeepReadonly, mind } from "@open-origin/engine";
import { greatest } from "../curves.ts";
import type { BrainLaws } from "./laws.ts";
import { type Claim, claims, foodClaim } from "./rules.ts";

type Senses2 = DeepReadonly<beings.Senses2>;

type Percept = NonNullable<beings.MindIntention["remember"]>[number]["percept"];

/** A `remember` of the decision, and whether a later operation cites the episode it makes. */
type Remembered = { readonly percept: Percept; readonly w: number; readonly cited: boolean };

type Believed = NonNullable<beings.MindIntention["believe"]>[number];
type Revised = NonNullable<beings.MindIntention["revise"]>[number];
export type Related = NonNullable<beings.MindIntention["relate"]>[number];

/** The operations of a decision, kind by kind, in the order they apply. */
export type Ops = {
  readonly remember: readonly Remembered[];
  readonly believe: readonly Believed[];
  readonly revise: readonly Revised[];
  readonly drop: readonly number[];
  readonly relate: readonly Related[];
};

/** Operations to add together, all or nothing. */
export type Intent = Partial<Ops>;

/** What the operations of a decision are proposed against. */
export type Recall = {
  readonly senses: Senses2;
  readonly laws: BrainLaws;
  /** Beliefs the decision's act relies on, which no operation may evict or change. */
  readonly keep: readonly number[];
};

/** No operation yet. */
export const NO_OPS: Ops = Object.freeze({
  remember: [],
  believe: [],
  revise: [],
  drop: [],
  relate: [],
});

/** How many operations `ops` holds. */
function countOf(ops: Ops): number {
  const { remember, believe, revise, drop, relate } = ops;
  return remember.length + believe.length + revise.length + drop.length + relate.length;
}

/** `ops` with `intent` after it. */
function joined(ops: Ops, intent: Intent): Ops {
  return {
    remember: [...ops.remember, ...(intent.remember ?? [])],
    believe: [...ops.believe, ...(intent.believe ?? [])],
    revise: [...ops.revise, ...(intent.revise ?? [])],
    drop: [...ops.drop, ...(intent.drop ?? [])],
    relate: [...ops.relate, ...(intent.relate ?? [])],
  };
}

/** A record of a store as its eviction ranks it: lowest salience first, then oldest, then id. */
type Ranked = { readonly id: number; readonly salience: number; readonly age: number };

/** Whether `a` leaves a full store before `b`. */
function leavesBefore(a: Ranked, b: Ranked): boolean {
  if (a.salience !== b.salience) return a.salience < b.salience;
  if (a.age !== b.age) return a.age > b.age;
  return a.id < b.id;
}

/** The records a store of `capacity` holds after `added` enter it in order, each evicting when full. */
function admitted<T extends Ranked>(
  held: readonly T[],
  added: readonly T[],
  capacity: number,
): T[] {
  const store = [...held];
  for (const record of added) {
    store.push(record);
    if (store.length <= capacity) continue;
    let lowest = 0;
    store.forEach((other, index) => {
      if (leavesBefore(other, store[lowest] as T)) lowest = index;
    });
    store.splice(lowest, 1);
  }
  return store;
}

/** Whether every new episode a later operation cites survives the decision's `remember`s. */
function episodesKept(recall: Recall, ops: Ops): boolean {
  const { laws, senses } = recall;
  const { pinLevel, pins } = laws.mind;
  const halfLife = mind.scaledHalfLife(laws.mind.halfLife.episode, senses.self.traits.retention);
  const view = senses.mind;
  let pinned = view.episodes.filter(({ w }) => w >= pinLevel).length;
  const held = view.episodes.map(({ id, w, r, t }) => ({
    id,
    salience: w >= pinLevel ? w : mind.decay(w, r, halfLife),
    age: t,
  }));
  const added = ops.remember.map(({ w }, index) => {
    // A new importance beyond the pins is capped below the pin level, as the engine caps it.
    const importance = w < pinLevel || pinned < pins ? w : pinLevel - 1;
    if (importance >= pinLevel) pinned += 1;
    return { id: view.next + index, salience: importance, age: 0 };
  });
  const kept = admitted(held, added, laws.mind.episodes).map(({ id }) => id);
  return ops.remember.every(({ cited }, index) => !cited || kept.includes(view.next + index));
}

/** The beliefs the operations of `ops` and the decision's act need after every `believe`. */
function neededBeliefs(recall: Recall, ops: Ops): number[] {
  const beliefIds = recall.senses.mind.beliefs.map(({ id }) => id);
  const cited = ops.relate.flatMap(({ because }) => because).filter((id) => beliefIds.includes(id));
  return [...recall.keep, ...ops.revise.map(({ id }) => id), ...ops.drop, ...cited];
}

/** The beliefs a decision holds after its `believe`s, by id, and the id its next record takes. */
export type AfterBelieves = { readonly held: readonly number[]; readonly next: number };

/** A belief of the predicted store: its rank, and its claim. */
type Stored = Ranked & { readonly p: Claim };

/** Whether `stored` holds the claim of `p`, a food claim of mind@1. */
function holding(stored: Stored, p: Claim): boolean {
  const claim = foodClaim(p);
  return claim !== undefined && claims(stored.p, claim.cell, claim.v);
}

/**
 * The beliefs of the mind of `recall` after the `believe`s `believe` of a decision that makes
 * `remembers` episodes first, as the engine applies them, in order: a `believe` whose claim the
 * store holds at that point adopts that belief, which the engine applies as a revision, so it takes
 * no id and no room, and the belief it revises becomes as certain as the `believe`, and new; any
 * other forms a belief with the next id, which a full store admits by evicting the belief of lowest
 * salience, then the oldest, then the lowest id, itself included. A testimony that a full store
 * evicts at once is therefore not there for a landmark of its claim to adopt. Returns the ids held
 * after, and the id the decision's next record takes.
 */
export function afterBelieves(
  recall: Recall,
  remembers: number,
  believe: readonly Believed[],
): AfterBelieves {
  const { laws, senses } = recall;
  const halfLife = mind.scaledHalfLife(laws.mind.halfLife.belief, senses.self.traits.retention);
  const certainty = (cr: number) => greatest(cr, 1000 - cr);
  let store: Stored[] = senses.mind.beliefs.map(({ id, p, cr, u }) => ({
    id,
    p,
    salience: mind.decay(certainty(cr), u, halfLife),
    age: u,
  }));
  let next = senses.mind.next + remembers;
  for (const { p, cr } of believe) {
    const at = store.findIndex((stored) => holding(stored, p));
    const adopted = store[at];
    if (adopted !== undefined) {
      store = store.with(at, { ...adopted, salience: certainty(cr), age: 0 });
      continue;
    }
    store = admitted(store, [{ id: next, p, salience: certainty(cr), age: 0 }], laws.mind.beliefs);
    next += 1;
  }
  return { held: store.map(({ id }) => id), next };
}

/** Whether every belief the decision needs survives its `believe`s. */
function beliefsKept(recall: Recall, ops: Ops): boolean {
  const { held } = afterBelieves(recall, ops.remember.length, ops.believe);
  return neededBeliefs(recall, ops).every((id) => held.includes(id));
}

/**
 * Whether `ops` may be proposed: at most `mind.ops` operations, ids for every new record, and no
 * citation of a record its store evicts first.
 */
function fits(recall: Recall, ops: Ops): boolean {
  if (countOf(ops) > recall.laws.mind.ops) return false;
  if (afterBelieves(recall, ops.remember.length, ops.believe).next > mind.INT31_MAX) return false;
  return episodesKept(recall, ops) && beliefsKept(recall, ops);
}

/** `ops` with `intent` added when the whole still fits; `ops` as it was otherwise. */
export function attempt(recall: Recall, ops: Ops, intent: Intent | undefined): Ops {
  if (intent === undefined) return ops;
  const tried = joined(ops, intent);
  return fits(recall, tried) ? tried : ops;
}

/** The operations of `ops` as an intention proposes them: only the kinds it has. */
export function intentionOf(ops: Ops): beings.MindIntention | undefined {
  if (countOf(ops) === 0) return undefined;
  const { believe, revise, drop, relate } = ops;
  const remember = ops.remember.map(({ percept, w }) => ({ percept, w }));
  return {
    ...(remember.length > 0 ? { remember } : {}),
    ...(believe.length > 0 ? { believe } : {}),
    ...(revise.length > 0 ? { revise } : {}),
    ...(drop.length > 0 ? { drop } : {}),
    ...(relate.length > 0 ? { relate } : {}),
  };
}
