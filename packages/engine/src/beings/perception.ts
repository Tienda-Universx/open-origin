/**
 * What a being of beings@2 perceives of others at a decision (ADR 0024, docs/architecture/mind.md
 * "Perception"): the beings within its sight, from the chunks its window already read, as the state
 * holds them at the start of the tick, since the system writes nothing before its last phase. Its
 * sight is the species' sight by day, or its dim sight when the light of the instant is below
 * `perception.dimBelow`; its attention keeps the nearest, by Chebyshev distance, then id. Each
 * gives only what an observer could see (C0 in classes.ts): its id, species, cell, the kind of its
 * activity, and the direction of the step it is on. Recognition is perfect, and terrain hides
 * nothing: two simplifications of T5.
 */
import type { Being, Cell } from "./being.ts";
import type { Perception } from "./life2.ts";
import { greatest } from "./rates.ts";
import type { CoveredChunk } from "./senses.ts";

/** A being as another perceives it: C0 only, never its needs, health, or condition. */
export type PerceivedBeing = {
  readonly id: number;
  readonly species: string;
  readonly cell: Cell;
  readonly activity: string;
  /** The direction of the step a walking being is on, by the index of DIRECTIONS. */
  readonly direction?: number;
};

/** The cells a being sees under the radiance `light`. */
export function sightOf(perception: Perception, light: number): number {
  return light < perception.dimBelow ? perception.sight.dim : perception.sight.day;
}

/** The Chebyshev distance between two cells: the steps of a walk between them. */
function distance(a: Cell, b: Cell): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return greatest(dx < 0 ? -dx : dx, dy < 0 ? -dy : dy);
}

/** What `being` shows to another: its C0 members, copied. */
function shown(being: Being): PerceivedBeing {
  const { activity } = being;
  const seen = {
    id: being.id,
    species: being.species,
    cell: [being.cell[0], being.cell[1]] as Cell,
    activity: activity.kind,
  };
  // A stored walk is always on a step: `done` stays below the number of its directions.
  return activity.kind === "walk"
    ? { ...seen, direction: activity.dirs.charCodeAt(activity.done) - 48 }
    : seen;
}

/** A copy of `being` that shares nothing with it, for the senses a brain may keep and write. */
export function copyPerceived(being: PerceivedBeing): PerceivedBeing {
  return { ...being, cell: [being.cell[0], being.cell[1]] };
}

/**
 * The beings that the being `self` perceives in `chunks`, the chunks its window covers: every other
 * being within `sight` cells of its cell, the `attention` nearest kept, by distance, then id, in
 * that order. It reads only the values in `chunks`.
 */
export function perceiveBeings(
  chunks: readonly CoveredChunk[],
  self: { readonly id: number; readonly cell: Cell },
  limits: { readonly sight: number; readonly attention: number },
): PerceivedBeing[] {
  const near: { readonly at: number; readonly being: Being }[] = [];
  for (const { chunk } of chunks) {
    for (const being of chunk.beings) {
      const at = distance(being.cell, self.cell);
      if (being.id !== self.id && at <= limits.sight) near.push({ at, being });
    }
  }
  near.sort((a, b) => a.at - b.at || a.being.id - b.being.id);
  return near.slice(0, limits.attention).map(({ being }) => shown(being));
}
