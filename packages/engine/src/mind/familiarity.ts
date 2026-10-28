/**
 * Familiarity (ADR 0024, docs/architecture/mind.md "Relationships"): a law, never a judgment. It
 * counts seconds of co-presence, not decisions: at each perception of the other being, the seconds
 * since it was last seen are added exactly when they are at most `relations.gap`, and after a longer
 * absence the familiarity decays over the whole absence and nothing is added. So a being that
 * decides every tick earns no more than one that decides every minute while the other stays in
 * view. The decay is the salience formula with `w = f`, the anchor `seen`, and
 * `relations.halfLife`, which retention does not scale. Hearing a being is no co-presence: a
 * relationship a message created holds `seen` 0 and `f` 0 until its first perception.
 */
import { floorDiv, least } from "../int.ts";
import { type MindContext, secondsSince } from "./context.ts";
import { familiaritySaturation } from "./laws.ts";
import { NEVER_SEEN, type Relationship } from "./records.ts";
import { decay } from "./salience.ts";

/**
 * The seconds of familiarity `relationship` holds at the context's moment, f′: `f` itself while the
 * absence lasts at most `relations.gap`, and `f` decayed over the whole absence after a longer one.
 */
export function familiarSeconds(relationship: Relationship, ctx: MindContext): number {
  const absent = secondsSince(relationship.seen, ctx.moment);
  const { gap, halfLife } = ctx.laws.relations;
  return absent <= gap ? relationship.f : decay(relationship.f, absent, halfLife);
}

/**
 * The familiarity of `relationship` at the context's moment, min(1000, ⌊rate · f′⌋). The product
 * is exact: f′ is at most 2^22 and the rate's numerator at most 2^20.
 */
export function familiarity(relationship: Relationship, ctx: MindContext): number {
  const { num, den } = ctx.laws.relations.rate;
  return least(1000, floorDiv(num * familiarSeconds(relationship, ctx), den));
}

/**
 * `relationship` after a perception of its being at the context's moment: the absence is credited
 * when it lasts at most `relations.gap`, up to the saturation ⌈1000 / rate⌉, and decays the
 * familiarity otherwise; then `seen` is now. A relationship whose `seen` is 0, which a message
 * created before any perception, gains nothing at its first perception: the time since was never
 * co-presence. No perception is at tick 0, the tick before the first a world computes.
 */
export function perceivedAgain(relationship: Relationship, ctx: MindContext): Relationship {
  if (relationship.seen === NEVER_SEEN) return { ...relationship, seen: ctx.moment.tick };
  const absent = secondsSince(relationship.seen, ctx.moment);
  const { gap, halfLife, rate } = ctx.laws.relations;
  const f =
    absent <= gap
      ? least(familiaritySaturation(rate), relationship.f + absent)
      : decay(relationship.f, absent, halfLife);
  return { ...relationship, f, seen: ctx.moment.tick };
}
