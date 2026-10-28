import type { beings } from "@open-origin/engine";
import type { Senses2 } from "./mind-senses.ts";

/**
 * The whole-decision ablation (b) of docs/architecture/mind.md ("Evaluation"), on decisions built
 * by hand: for each belief operation, decide again with only the records it cites, the belief it
 * revises, and every input that is no record; an operation with the same proposition and the same
 * citations must be among the result. The records the decision creates take their ids from how
 * many operations precede them, which an ablated decision may change, so a citation of one is
 * compared by the percept that creates it; the records the mind held keep their ids.
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
