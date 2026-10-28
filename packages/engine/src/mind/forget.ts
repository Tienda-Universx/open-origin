/**
 * Forgetting (ADR 0024, docs/architecture/mind.md "Time, salience, and forgetting"): an episode
 * whose salience at a moment is below `mind.floor` leaves the mind, and every belief that cites it
 * loses it, which the ledger records. A pinned episode never fades; beliefs and relationships are
 * never forgotten by salience, only displaced from a full store. The engine forgets only when the
 * being decides, and since salience is a closed form, forgetting at several moments up to now
 * leaves the same mind as forgetting once now.
 */
import type { MindContext } from "./context.ts";
import type { Mind } from "./records.ts";
import { episodeSalience } from "./salience.ts";
import { type Unlinked, withoutRecords } from "./store.ts";

/**
 * `mind` without the episodes that have faded by the context's moment, and each of them, by
 * increasing id, with the beliefs that lost it. The mind is the same value when nothing faded.
 */
export function forget(
  mind: Mind,
  ctx: MindContext,
): { readonly mind: Mind; readonly forgot: readonly Unlinked[] } {
  const faded = mind.episodes
    .filter((episode) => episodeSalience(episode, ctx) < ctx.laws.mind.floor)
    .map((episode) => episode.id);
  const { mind: kept, unlinked } = withoutRecords(mind, faded);
  return { mind: kept, forgot: unlinked };
}
