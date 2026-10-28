/**
 * The stores of a mind (ADR 0024, docs/architecture/mind.md "Time, salience, and forgetting"): how
 * a record leaves them, and how a full one admits a new record. When a record leaves, every belief
 * that cites it loses it: its id leaves `ev` and `lost` grows, while `tn`, `ex`, `src`, and `who`
 * stay; the links are reported for the ledger. A full store of episodes or beliefs evicts the record
 * with the lowest salience, the new one included, then the oldest, then the lowest id. A full store
 * of relationships admits a being met for the first time, and evicts, among the relationships whose
 * being it did not address within the talk window, the one with the lowest familiarity, then the
 * one seen longest ago, then the lowest id; when it addressed every one of them within the window,
 * it admits none and keeps them all, since they hold the quotas of each pair.
 */
import { least } from "../int.ts";
import { INT31_MAX } from "./bounds.ts";
import { type MindContext, secondsSince } from "./context.ts";
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
 * Whether the being addressed the being of `relationship` within the context's talk window: at a
 * tick `talk`, from 1 to now, less than that many seconds ago. `talk` 0 is no act, and a `talk`
 * after now, which no world holds, is no act within the window either.
 */
function inTalkWindow(relationship: Relationship, ctx: MindContext): boolean {
  const { talk } = relationship;
  if (talk === 0 || talk > ctx.moment.tick) return false;
  return secondsSince(talk, ctx.moment) < ctx.talkWindow;
}

/**
 * `mind` with the new relationship `relationship`, whose id it already took, which a store with
 * room for at least one admits: when the store is full, the relationship out of the talk window
 * with the lowest familiarity, then seen longest ago, then with the lowest id, leaves it first.
 * Undefined when every relationship of a full store is within the window: none leaves, and the new
 * one is not admitted.
 */
export function admitRelationship(
  mind: Mind,
  relationship: Relationship,
  ctx: MindContext,
): Admitted | undefined {
  const others = mind.relations;
  if (others.length < ctx.laws.mind.relations)
    return { mind: { ...mind, relations: [...others, relationship] }, displaced: [] };
  const leavable = others.filter((record) => !inTalkWindow(record, ctx));
  if (leavable.length === 0) return undefined;
  const { mind: room, displaced } = evicted(
    mind,
    lowest(leavable, (record) => [familiarity(record, ctx), record.seen, record.id]),
  );
  return { mind: { ...room, relations: [...room.relations, relationship] }, displaced };
}
