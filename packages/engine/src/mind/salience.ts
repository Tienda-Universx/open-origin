/**
 * Salience (ADR 0024, docs/architecture/mind.md "Time, salience, and forgetting"): how strongly a
 * record stays in mind at a moment, in closed form from an anchor, so it is the same whether the
 * being was processed often or seldom. It halves every half-life and falls linearly within one, in
 * exact integer arithmetic:
 *
 *     H = max(1, ⌊halfLife · retention / 1000⌋)      k = ⌊E / H⌋
 *     s = 0                                           when k ≥ 30
 *     a = ⌊w / 2^k⌋    s = a − ⌊(a − ⌊a / 2⌋) · (E mod H) / H⌋   otherwise
 *
 * where E is the seconds from the anchor to the moment. 2^k is taken only for k below 30, so no
 * shift wraps; the laws keep every product a safe integer (laws.ts).
 */
import { floorDiv, floorMod } from "../int.ts";
import { greatest, least } from "./bounds.ts";
import { type MindContext, secondsSince } from "./context.ts";
import type { MindLaws } from "./laws.ts";
import type { Belief, Episode, LocalId } from "./records.ts";

/** The halvings after which a salience is 0, whatever its weight. */
export const SALIENCE_HALVINGS = 30;

/** A half-life of `halfLife` seconds scaled by `retention`, in permille: at least 1 second. */
export function scaledHalfLife(halfLife: number, retention: number): number {
  return greatest(1, floorDiv(halfLife * retention, 1000));
}

/**
 * The weight `w` after `seconds` of decay with the half-life `halfLife` (already scaled), by the
 * formula above. The caller guarantees safe integers with `seconds` ≥ 0, `halfLife` ≥ 1, and
 * `w · halfLife` below 2^53.
 */
export function decay(w: number, seconds: number, halfLife: number): number {
  const halvings = floorDiv(seconds, halfLife);
  if (halvings >= SALIENCE_HALVINGS) return 0;
  const halved = floorDiv(w, 1 << halvings);
  const fall = halved - floorDiv(halved, 2);
  return halved - floorDiv(fall * floorMod(seconds, halfLife), halfLife);
}

/** Whether `episode` is pinned: its importance reached the pin level, so it never fades. */
export function isPinned(episode: Episode, laws: MindLaws): boolean {
  return episode.w >= laws.mind.pinLevel;
}

/** The salience of `episode` at the context's moment: its importance, decayed from `r`. */
export function episodeSalience(episode: Episode, ctx: MindContext): number {
  if (isPinned(episode, ctx.laws)) return episode.w;
  const halfLife = scaledHalfLife(ctx.laws.mind.halfLife.episode, ctx.retention);
  return decay(episode.w, secondsSince(episode.r, ctx.moment), halfLife);
}

/** The salience of `belief` at the context's moment: its certainty either way, decayed from `u`. */
export function beliefSalience(belief: Belief, ctx: MindContext): number {
  const halfLife = scaledHalfLife(ctx.laws.mind.halfLife.belief, ctx.retention);
  const weight = greatest(belief.cr, 1000 - belief.cr);
  return decay(weight, secondsSince(belief.u, ctx.moment), halfLife);
}

/**
 * `w` as the importance of the episode `id` among `episodes` (undefined for a new episode): at most
 * `pins` episodes are pinned, so beyond them a new importance is capped at `pinLevel − 1`. An
 * episode already pinned keeps its place.
 */
export function importanceWithin(
  episodes: readonly Episode[],
  id: LocalId | undefined,
  w: number,
  laws: MindLaws,
): number {
  const { pinLevel, pins } = laws.mind;
  if (w < pinLevel) return w;
  const pinned = episodes.filter((episode) => episode.id !== id && episode.w >= pinLevel).length;
  return pinned < pins ? w : pinLevel - 1;
}

/**
 * `episode`, one of `episodes`, after a recall or a citation at the context's moment: its
 * importance becomes min(1000, s + recall), within the pins, and its anchor is now.
 */
export function refreshEpisode(
  episode: Episode,
  episodes: readonly Episode[],
  ctx: MindContext,
): Episode {
  const raised = least(1000, episodeSalience(episode, ctx) + ctx.laws.mind.recall);
  const w = importanceWithin(episodes, episode.id, raised, ctx.laws);
  return { ...episode, w, r: ctx.moment.tick };
}
