/**
 * Relationships as a law (ADR 0024, docs/architecture/mind.md "Relationships" and "Beliefs", step
 * 1): a perception of a being updates the familiarity of the being's relationship with it, or
 * creates one, with affinity 0 and trust 500, which a full store always admits. A first perception
 * adds no familiarity. A relationship exists only after a percept or a message of that being;
 * affinity and trust change only by the brain's `relate`, which the beings layer applies.
 */
import type { MindContext } from "./context.ts";
import { perceivedAgain } from "./familiarity.ts";
import { freeId, type LocalId, type Mind, type Relationship } from "./records.ts";
import { admitRelationship, type Unlinked } from "./store.ts";

/** The relationship `mind` holds with the being `who`; undefined when it holds none. */
export function relationshipWith(mind: Mind, who: number): Relationship | undefined {
  return mind.relations.find((relationship) => relationship.who === who);
}

/** A mind after a perception, the relationship it created, and the ones a full store evicted. */
export type Perceived = {
  readonly mind: Mind;
  readonly created?: LocalId;
  readonly displaced: readonly Unlinked[];
};

/**
 * `mind` after it perceived the being `who` at the context's moment. With no room for any
 * relationship (`mind.relations` is 0), or once ids have run out, a new being leaves no record.
 */
export function perceive(mind: Mind, who: number, ctx: MindContext): Perceived {
  const held = mind.relations.findIndex((relationship) => relationship.who === who);
  const known = mind.relations[held];
  if (known !== undefined) {
    const relations = mind.relations.with(held, perceivedAgain(known, ctx));
    return { mind: { ...mind, relations }, displaced: [] };
  }
  const id = freeId(mind);
  if (id === undefined || ctx.laws.mind.relations === 0) return { mind, displaced: [] };
  const created: Relationship = {
    id,
    who,
    f: 0,
    seen: ctx.moment.tick,
    aff: 0,
    tr: 500,
    tn: 0,
    talk: 0,
    turns: 0,
  };
  const admitted = admitRelationship({ ...mind, next: id + 1 }, created, ctx);
  return { ...admitted, created: id };
}
