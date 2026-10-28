import { type beings, type CanonicalValue, canonicalize } from "@open-origin/engine";
import type { Senses2 } from "./mind-senses.ts";

/**
 * The whole-decision ablations of docs/architecture/mind.md ("Evaluation"). `reformed` is (b) on
 * decisions built by hand: for each belief operation, decide again with only the records it cites,
 * the belief it revises, and every input that is no record; an operation with the same proposition
 * and the same citations must be among the result. `ablationA` and `ablationB` are (a) and (b) on
 * decisions recorded in a world, which may hear several messages: there the records an operation
 * cites include the inbox messages its heard episodes copy. The records the decision creates take
 * their ids from how many operations precede them, which an ablated decision may change, so a
 * citation of one is compared by what creates it; the records the mind held keep their ids.
 */

/** `senses` whose mind holds only the records of `ids`, every other input kept, `next` too. */
export function ablated(senses: Senses2, ids: readonly number[]): Senses2 {
  const view = senses.mind;
  const kept = <T extends { readonly id: number }>(records: readonly T[]) =>
    records.filter(({ id }) => ids.includes(id));
  return {
    ...senses,
    mind: {
      next: view.next,
      episodes: kept(view.episodes),
      beliefs: kept(view.beliefs),
      relations: kept(view.relations),
    },
  };
}

/**
 * The belief operations of `ops`, each citation of a record the decision creates written as the
 * percept that creates it, and each revision with the proposition of the belief it revises.
 */
export function citing(ops: beings.MindIntention, senses: Senses2) {
  const { next, beliefs } = senses.mind;
  const remember = ops.remember ?? [];
  const cite = (ev: readonly number[]) =>
    ev.map((id) => (id >= next ? remember[id - next]?.percept : id));
  return {
    believe: (ops.believe ?? []).map((op) => ({ ...op, ev: cite(op.ev) })),
    revise: (ops.revise ?? []).map((op) => ({
      ...op,
      p: beliefs.find(({ id }) => id === op.id)?.p,
      ev: cite(op.ev),
    })),
  };
}

/** A belief operation of a decision, and the operations of its kind its ablated decision makes. */
export type Reformed = { readonly op: unknown; readonly again: readonly unknown[] };

/**
 * Each belief operation `decide` proposes from `senses`, and the operations of the same kind it
 * proposes from `senses` ablated to the records that operation cites, and for a revision to those
 * and the belief it revises.
 */
export function reformed(
  senses: Senses2,
  decide: (senses: Senses2) => beings.Intention2,
): Reformed[] {
  const ops = decide(senses).mind ?? {};
  const { next } = senses.mind;
  const again = (ids: readonly number[]) => {
    const small = ablated(senses, ids);
    return citing(decide(small).mind ?? {}, small);
  };
  const { believe, revise } = citing(ops, senses);
  const held = (ids: readonly number[]) => ids.filter((id) => id < next);
  return [
    ...believe.map((op, index) => ({
      op,
      again: again(held(ops.believe?.[index]?.ev ?? [])).believe,
    })),
    ...revise.map((op, index) => {
      const original = ops.revise?.[index];
      return { op, again: again(held([...(original?.ev ?? []), original?.id ?? 0])).revise };
    }),
  ];
}

/**
 * A belief operation as the ablations of a recorded decision compare it, believe and revise alike:
 * its proposition, the belief's for a revise, and each citation as what it is: a record the mind
 * held, by its id, or a record the decision creates, by what it copies, the message itself for a
 * message heard, since the inbox's order changes when an ablation removes one.
 */
export type Formation = { readonly p: string; readonly ev: readonly string[] };

/** The citation `id` of a decision from `senses` whose operations remember `remember`. */
function sourceOf(
  senses: Senses2,
  remember: NonNullable<beings.MindIntention["remember"]>,
  id: number,
): string {
  const { next } = senses.mind;
  if (id < next) return `record ${id}`;
  const percept = remember[id - next]?.percept;
  if (percept === undefined) return `created ${id - next}`;
  if ("heard" in percept) return `heard ${canonicalize(messageOf(senses, percept.heard))}`;
  return `percept ${canonicalize(percept as never)}`;
}

/** The message of index `index` the decision of `senses` heard, as a canonical value. */
const messageOf = (senses: Senses2, index: number) =>
  senses.perceived.heard[index] as unknown as CanonicalValue;

/** The belief operations of `intention`, decided from `senses`, as formations. */
export function formationsOf(senses: Senses2, intention: beings.Intention2): Formation[] {
  const ops = intention.mind ?? {};
  const remember = ops.remember ?? [];
  const cite = (ev: readonly number[]) => ev.map((id) => sourceOf(senses, remember, id));
  const proposition = (id: number) =>
    canonicalize(senses.mind.beliefs.find((belief) => belief.id === id)?.p as never);
  return [
    ...(ops.believe ?? []).map((op) => ({ p: canonicalize(op.p as never), ev: cite(op.ev) })),
    ...(ops.revise ?? []).map((op) => ({ p: proposition(op.id), ev: cite(op.ev) })),
  ];
}

/** The records an operation cites: the ids of those the mind held, and the messages it copies. */
type Cited = { readonly held: readonly number[]; readonly heard: readonly number[] };

/** What the `index`-th belief operation of `intention` cites, the belief a revise revises apart. */
function citedBy(senses: Senses2, intention: beings.Intention2, index: number): Cited {
  const ops = intention.mind ?? {};
  const remember = ops.remember ?? [];
  const believes = ops.believe ?? [];
  const op = index < believes.length ? believes[index] : ops.revise?.[index - believes.length];
  const { next } = senses.mind;
  const ev = op?.ev ?? [];
  const heard = ev.flatMap((id) => {
    const percept = remember[id - next]?.percept;
    return percept !== undefined && "heard" in percept ? [percept.heard] : [];
  });
  return { held: ev.filter((id) => id < next), heard };
}

/** `senses` whose mind holds the records `record` keeps, and whose inbox the messages `message` keeps. */
function keeping(
  senses: Senses2,
  record: (id: number) => boolean,
  message: (index: number) => boolean,
): Senses2 {
  const view = senses.mind;
  const kept = <T extends { readonly id: number }>(records: readonly T[]) =>
    records.filter(({ id }) => record(id));
  return {
    ...senses,
    perceived: {
      ...senses.perceived,
      heard: senses.perceived.heard.filter((_, index) => message(index)),
    },
    mind: {
      next: view.next,
      episodes: kept(view.episodes),
      beliefs: kept(view.beliefs),
      relations: kept(view.relations),
    },
  };
}

/** What an ablation of one belief operation of a recorded decision found wrong, if anything. */
export type AblationMiss = { readonly op: Formation; readonly again: readonly Formation[] };

/**
 * Ablation (a) of mind.md ("Evaluation") on the decision `intention` made from `senses`: for each
 * belief operation, `decide` again with the records it cites removed, ids kept; no operation may
 * form or revise the same proposition unless it cites other records. The records it cites are
 * those the mind held and the inbox messages its heard episodes copy, since the inbox is a store
 * of the mind; what the being sees is no record, so an episode it makes again from its window is
 * another record. Returns the operations that came back without other evidence, and how many
 * operations cited a record the ablation could remove.
 */
export function ablationA(
  senses: Senses2,
  intention: beings.Intention2,
  decide: (senses: Senses2) => beings.Intention2,
): { readonly misses: AblationMiss[]; readonly removable: number } {
  const misses: AblationMiss[] = [];
  let removable = 0;
  formationsOf(senses, intention).forEach((op, index) => {
    const cited = citedBy(senses, intention, index);
    if (cited.held.length + cited.heard.length > 0) removable += 1;
    const small = keeping(
      senses,
      (id) => !cited.held.includes(id),
      (message) => !cited.heard.includes(message),
    );
    const gone = new Set([
      ...cited.held.map((id) => `record ${id}`),
      ...cited.heard.map((message) => `heard ${canonicalize(messageOf(senses, message))}`),
    ]);
    const again = formationsOf(small, decide(small)).filter(({ p }) => p === op.p);
    if (again.some(({ ev }) => ev.length === 0 || ev.every((source) => gone.has(source))))
      misses.push({ op, again });
  });
  return { misses, removable };
}

/**
 * Ablation (b) of mind.md ("Evaluation") on the decision `intention` made from `senses`: for each
 * belief operation, `decide` again with only the records it cites, the belief a revise revises,
 * and the messages its heard episodes copy, every input that is no record kept; an operation of
 * the same proposition and the same citations must be among the result. Confidence, and believe
 * against revise, are not compared. Returns the operations that did not come back.
 */
export function ablationB(
  senses: Senses2,
  intention: beings.Intention2,
  decide: (senses: Senses2) => beings.Intention2,
): AblationMiss[] {
  const ops = intention.mind ?? {};
  const believes = ops.believe?.length ?? 0;
  return formationsOf(senses, intention).flatMap((op, index) => {
    const cited = citedBy(senses, intention, index);
    const revised = index < believes ? [] : [ops.revise?.[index - believes]?.id ?? 0];
    const held = [...cited.held, ...revised];
    const small = keeping(
      senses,
      (id) => held.includes(id),
      (message) => cited.heard.includes(message),
    );
    const again = formationsOf(small, decide(small));
    const same = (other: Formation) =>
      other.p === op.p && JSON.stringify(other.ev) === JSON.stringify(op.ev);
    return again.some(same) ? [] : [{ op, again }];
  });
}
