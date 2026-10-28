/**
 * The stores of a mind (ADR 0024, docs/architecture/mind.md "Time, salience, and forgetting"): how
 * a record leaves them, and how a full one admits a new record. When a record leaves, every belief
 * that cites it loses it: its id leaves `ev` and `lost` grows, while `tn`, `ex`, `src`, and `who`
 * stay; the links are reported for the ledger. A full store of episodes or beliefs evicts the record
 * with the lowest salience, the new one included, then the oldest, then the lowest id. A full store
 * of relationships always admits a being met for the first time, and evicts the other relationship
 * with the lowest familiarity, then the one seen longest ago, then the lowest id.
 */
import { INT31_MAX, least } from "./bounds.ts";
import type { MindContext } from "./context.ts";
import { familiarity } from "./familiarity.ts";
import type { Belief, Episode, LocalId, Mind, Relationship } from "./records.ts";
import { beliefSalience, episodeSalience } from "./salience.ts";

/** A record that left the mind, and the beliefs that cited it and lost it. */
export type Unlinked = { readonly id: LocalId; readonly beliefs: readonly LocalId[] };

/** A mind after a record entered it, and the records a full store evicted for it. */
export type Admitted = { readonly mind: Mind; readonly displaced: readonly Unlinked[] };

/** `belief` without the citations of `ids`, each counted in `lost`, up to 2^31 − 1. */
function uncite(belief: Belief, ids: readonly LocalId[]): Belief {
  const ev = belief.ev.filter((id) => !ids.includes(id));
  if (ev.length === belief.ev.length) return belief;
  const lost = least(INT31_MAX, belief.lost + belief.ev.length - ev.length);
  return { ...belief, ev, lost };
}

/**
 * `mind` without the records whose ids are `ids`, and for each of them, in the order of `ids`, the
 * remaining beliefs that cited it. The mind is the same value when `ids` is empty.
 */
export function withoutRecords(
  mind: Mind,
  ids: readonly LocalId[],
): { readonly mind: Mind; readonly unlinked: readonly Unlinked[] } {
  if (ids.length === 0) return { mind, unlinked: [] };
  const keeps = (record: { readonly id: LocalId }) => !ids.includes(record.id);
  const kept = mind.beliefs.filter(keeps);
  const unlinked = ids.map((id) => ({
    id,
    beliefs: kept.filter((belief) => belief.ev.includes(id)).map((belief) => belief.id),
  }));
  const next: Mind = {
    ...mind,
    episodes: mind.episodes.filter(keeps),
    beliefs: kept.map((belief) => uncite(belief, ids)),
    relations: mind.relations.filter(keeps),
  };
  return { mind: next, unlinked };
}

/** Whether the rank `a` comes before `b`: compared key by key, lowest first. */
function ranksBefore(a: readonly number[], b: readonly number[]): boolean {
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (left !== right) return left < right;
  }
  return false;
}

/** The record of `records` with the lowest rank; undefined when there is none. */
function lowest<T>(records: readonly T[], rank: (record: T) => readonly number[]): T | undefined {
  let found: { record: T; rank: readonly number[] } | undefined;
  for (const record of records) {
    const ranked = rank(record);
    if (found === undefined || ranksBefore(ranked, found.rank)) found = { record, rank: ranked };
  }
  return found?.record;
}

/** `mind` after a full store evicted `victim`, which may be the record just added. */
function evicted(mind: Mind, victim: { readonly id: LocalId } | undefined): Admitted {
  if (victim === undefined) return { mind, displaced: [] };
  const { mind: kept, unlinked } = withoutRecords(mind, [victim.id]);
  return { mind: kept, displaced: unlinked };
}

/**
 * `mind` with the new episode `episode`, whose id it already took; when the store holds more than
 * `mind.episodes`, the episode with the lowest salience, `episode` included, then by `t`, then by
 * id, leaves it.
 */
export function admitEpisode(mind: Mind, episode: Episode, ctx: MindContext): Admitted {
  const episodes = [...mind.episodes, episode];
  const added: Mind = { ...mind, episodes };
  if (episodes.length <= ctx.laws.mind.episodes) return { mind: added, displaced: [] };
  return evicted(
    added,
    lowest(episodes, (record) => [episodeSalience(record, ctx), record.t, record.id]),
  );
}

/**
 * `mind` with the new belief `belief`, whose id it already took; when the store holds more than
 * `mind.beliefs`, the belief with the lowest salience, `belief` included, then by `u`, then by id,
 * leaves it.
 */
export function admitBelief(mind: Mind, belief: Belief, ctx: MindContext): Admitted {
  const beliefs = [...mind.beliefs, belief];
  const added: Mind = { ...mind, beliefs };
  if (beliefs.length <= ctx.laws.mind.beliefs) return { mind: added, displaced: [] };
  return evicted(
    added,
    lowest(beliefs, (record) => [beliefSalience(record, ctx), record.u, record.id]),
  );
}

/**
 * `mind` with the new relationship `relationship`, whose id it already took, which a store with
 * room for at least one always admits: when the store is full, the other relationship with the
 * lowest familiarity, then seen longest ago, then with the lowest id, leaves it first.
 */
export function admitRelationship(
  mind: Mind,
  relationship: Relationship,
  ctx: MindContext,
): Admitted {
  const others = mind.relations;
  const full = others.length >= ctx.laws.mind.relations;
  const { mind: room, displaced } = full
    ? evicted(
        mind,
        lowest(others, (record) => [familiarity(record, ctx), record.seen, record.id]),
      )
    : { mind, displaced: [] };
  return { mind: { ...room, relations: [...room.relations, relationship] }, displaced };
}
