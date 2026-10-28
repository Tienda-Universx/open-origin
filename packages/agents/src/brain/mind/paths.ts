/**
 * The walks `mind@1` adds to those of `utility@1` (docs/architecture/mind.md "The brain mind@1"):
 * to food it believes in beyond its window, when hungry with none in sight, and toward a being it
 * would greet. Both search the window once with Dijkstra, as foraging does, and walk to the
 * reachable cell that best serves the goal, then by the shortest route, then by the lowest index.
 * A walk to food beyond the window ends at the reachable cell nearest it, so each walk brings the
 * being strictly nearer, or none is proposed.
 */
import { type beings, type DeepReadonly, floorDiv, type mind } from "@open-origin/engine";
import { dijkstra, pathTo } from "../../navigation/dijkstra.ts";
import { centerOf, type View, walkable } from "../recipes.ts";
import { chebyshev, cueAt } from "./cells.ts";
import type { BrainLaws } from "./laws.ts";
import { APPROACH_REACH, TELL_FLOOR } from "./parameters.ts";
import { memoryHalfLife, retrieve } from "./retrieval.ts";
import { foodClaim } from "./rules.ts";
import { metAnew } from "./social.ts";

type Senses2 = DeepReadonly<beings.Senses2>;

/** The window as the navigation reads it. */
function viewOf(senses: Senses2): View {
  const { origin, side, edgeMs, foodCue } = senses.window;
  return { origin, side, edgeMs: edgeMs as Int32Array, foodCue: foodCue as Uint8Array };
}

/** The absolute cell of the window index `index`. */
function cellAt(view: View, index: number): mind.Cell {
  const column = index % view.side;
  return [
    (view.origin[0] as number) + column,
    (view.origin[1] as number) + (index - column) / view.side,
  ];
}

/** A reachable cell of the window as a goal: its index, its cost, and its route's milliseconds. */
type Goal = { readonly index: number; readonly cost: number; readonly ms: number };

/** Whether `a` is a better goal than `b`: a lower cost, then a shorter route; the scan breaks ties. */
function betterGoal(a: Goal, b: Goal | undefined): boolean {
  if (b === undefined || a.cost !== b.cost) return b === undefined || a.cost < b.cost;
  return a.ms < b.ms;
}

/**
 * The walk to the reachable cell of the window with the lowest `cost`, then the shortest route,
 * then the lowest index; a cell whose cost is undefined is no goal. Undefined when no cell is a
 * goal or the best one is where the being stands.
 */
function walkTo(
  senses: Senses2,
  cost: (cell: mind.Cell) => number | undefined,
): string | undefined {
  const view = viewOf(senses);
  const center = centerOf(view);
  const paths = dijkstra({ side: view.side, edgeMs: view.edgeMs }, center);
  let best: Goal | undefined;
  for (let index = 0; index < view.side * view.side; index += 1) {
    const ms = paths.durationMs[index] as number;
    const value = ms < 0 ? undefined : cost(cellAt(view, index));
    if (value !== undefined && betterGoal({ index, cost: value, ms }, best))
      best = { index, cost: value, ms };
  }
  if (best === undefined || best.index === center) return undefined;
  return walkable(pathTo(paths, best.index) ?? "");
}

/** Food the being believes in beyond its window, the one it would walk to. */
export type Sought = { readonly id: number; readonly cell: mind.Cell };

/**
 * The food to seek, by retrieval: a belief of food at TELL_FLOOR or more, of a cell beyond the
 * window that it does not cool; the nearer and the higher its band, the more relevant.
 */
export function soughtFood(senses: Senses2, laws: BrainLaws): Sought | undefined {
  const radius = floorDiv(senses.window.side, 2);
  const cooled = senses.self.cooldowns.map(({ cell }) => cell);
  const halfLife = memoryHalfLife(laws, senses.self.traits.retention);
  const claimOf = (belief: Senses2["mind"]["beliefs"][number]) => {
    const claim = foodClaim(belief.p);
    if (claim === undefined || claim.v === 0 || belief.cr < TELL_FLOOR) return undefined;
    if (cueAt(senses.window, claim.cell) !== undefined) return undefined;
    return cooled.some((cell) => chebyshev(cell, claim.cell) === 0) ? undefined : claim;
  };
  const belief = retrieve(
    senses.mind.beliefs,
    (candidate) => {
      const claim = claimOf(candidate);
      if (claim === undefined) return undefined;
      const distance = chebyshev(claim.cell, senses.self.cell);
      const relevance = floorDiv(1000 * radius * claim.v, 2 * (radius + distance));
      return { id: candidate.id, age: candidate.u, importance: candidate.cr, relevance };
    },
    halfLife,
  );
  const claim = belief === undefined ? undefined : claimOf(belief);
  return belief === undefined || claim === undefined
    ? undefined
    : { id: belief.id, cell: claim.cell };
}

/** The walk toward `cell`, beyond the window: to the reachable cell nearest it. */
export function seekLeg(senses: Senses2, cell: mind.Cell): string | undefined {
  return walkTo(senses, (at) => chebyshev(at, cell));
}

/**
 * The walk toward the nearest being it would greet beyond reach of speech: met anew, awake, not
 * walking, and at most APPROACH_REACH cells away, felt through sociability; the walk ends at the
 * reachable cell within reach of speech of it that has the shortest route.
 */
export function approachLeg(senses: Senses2, laws: BrainLaws): string | undefined {
  const reach = floorDiv(APPROACH_REACH * senses.self.traits.sociability, 1000);
  for (const being of senses.perceived.beings) {
    const relation = senses.mind.relations.find(({ who }) => who === being.id);
    if (relation === undefined || !metAnew(relation, laws)) continue;
    if (being.activity === "sleep" || being.activity === "walk") continue;
    const distance = chebyshev(being.cell, senses.self.cell);
    if (distance <= laws.speech.range || distance > reach) continue;
    const near = (at: mind.Cell) => {
      const away = chebyshev(at, being.cell);
      return away >= 1 && away <= laws.speech.range ? 0 : undefined;
    };
    return walkTo(senses, near);
  }
  return undefined;
}
