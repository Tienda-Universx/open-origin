/**
 * The recipes of `utility@1` (plan §5.4, L2): how a chosen behavior finds its way over the window
 * of the senses. Foraging searches the window once with Dijkstra and weighs every cell with a food
 * cue by its cue and route time. A sated being wanders with A* toward a cell along its heading,
 * and turns when that cell has no route or no food near it; a hungry being with nothing in sight
 * searches along a spiral around where its search began, with A* toward each step of it.
 * Routes are walks of at most 64 steps: a longer route is walked in parts, deciding again at the
 * end of each.
 */
import { beings, floorDiv, worldgen } from "@open-origin/engine";
import { aStar, type StepBounds } from "../navigation/astar.ts";
import { dijkstra, pathTo } from "../navigation/dijkstra.ts";
import { greatest, least, PERMILLE, respond } from "./curves.ts";
import { CUE_WORTH, ROUTE_WORTH, SPIRAL_LEGS, TURNS } from "./parameters.ts";

/** The part of the senses a recipe reads: the window, as the engine built it. */
export type View = {
  readonly origin: readonly number[];
  readonly side: number;
  readonly edgeMs: Int32Array;
  readonly foodCue: Uint8Array;
};

/** The index of the window's center, where the being stands. */
export function centerOf(view: View): number {
  const radius = floorDiv(view.side, 2);
  return radius * view.side + radius;
}

/** The window index of the absolute cell `cell`, or −1 when it lies outside the window. */
export function indexOf(view: View, cell: readonly number[]): number {
  const column = (cell[0] as number) - (view.origin[0] as number);
  const row = (cell[1] as number) - (view.origin[1] as number);
  if (column < 0 || column >= view.side || row < 0 || row >= view.side) return -1;
  return row * view.side + column;
}

/** The absolute cell of the window index `index`. */
function cellOf(view: View, index: number): [number, number] {
  const column = index % view.side;
  const [x = 0, y = 0] = view.origin;
  return [x + column, y + floorDiv(index, view.side)];
}

/**
 * Whether the window cell `index` lies inside the world. The window covers cells outside it,
 * impassable and without food; the brain never aims at one, nor gives one a cooldown, which the
 * engine would refuse.
 */
function inWorld(view: View, index: number): boolean {
  const [x, y] = cellOf(view, index);
  const { MIN_CELL, MAX_CELL } = worldgen;
  return x >= MIN_CELL && x <= MAX_CELL && y >= MIN_CELL && y <= MAX_CELL;
}

/** The worth of a cell with food cue `cue`, in permille. */
export function cueWorth(cue: number): number {
  return CUE_WORTH[cue] ?? 0;
}

/** A cell to forage: its index, its cue, the milliseconds of its route, the route, its worth. */
export type FoodTarget = {
  readonly cell: number;
  readonly cue: number;
  readonly ms: number;
  readonly path: string;
  readonly worth: number;
};

/**
 * The best cell to forage in the window: among the cells other than the center with a food cue,
 * a route, and no cooldown, the one whose worth, the worth of its cue times the worth of its route
 * time, is highest; ties go to the shorter route, then to the lower index. Undefined when no such
 * cell exists.
 */
export function bestFood(view: View, cooled: readonly number[]): FoodTarget | undefined {
  const center = centerOf(view);
  const paths = dijkstra({ side: view.side, edgeMs: view.edgeMs }, center);
  let best: Candidate | undefined;
  for (let cell = 0; cell < view.side * view.side; cell += 1) {
    if (cell === center || cooled.includes(cell)) continue;
    const candidate = candidateAt(view, paths.durationMs, cell);
    if (candidate !== undefined && (best === undefined || beats(candidate, best))) best = candidate;
  }
  if (best === undefined) return undefined;
  return { ...best, path: pathTo(paths, best.cell) ?? "" };
}

/** A cell with food and a route, and what it is worth. */
type Candidate = {
  readonly cell: number;
  readonly cue: number;
  readonly ms: number;
  readonly worth: number;
};

/** The cell `cell` as a place to forage, or undefined when it has no food cue or no route. */
function candidateAt(view: View, durationMs: Float64Array, cell: number): Candidate | undefined {
  const cue = view.foodCue[cell] as number;
  const ms = durationMs[cell] as number;
  if (cue === 0 || ms < 0) return undefined;
  return { cell, cue, ms, worth: floorDiv(cueWorth(cue) * respond(ROUTE_WORTH, ms), PERMILLE) };
}

/** Whether `a` is worth more than `b`, or as much with a shorter route. */
function beats(a: Candidate, b: Candidate): boolean {
  return a.worth > b.worth || (a.worth === b.worth && a.ms < b.ms);
}

/**
 * The shortest steps of the window, as A*'s bounds: the cheapest orthogonal and diagonal steps
 * that can be taken, with diagonal ≤ 2·straight. They never exceed a step of the window, so the
 * octile heuristic stays admissible. Undefined when no step can be taken.
 */
function windowBounds(edgeMs: Int32Array): StepBounds | undefined {
  const straight = cheapest(edgeMs, 0);
  const diagonal = cheapest(edgeMs, 1);
  if (straight === 0) return undefined;
  // In the engine's law a diagonal step is never cheaper than a straight one; A* needs
  // straight ≤ diagonal ≤ 2·straight whatever the window holds, and no diagonal step may exist.
  const low = diagonal > 0 ? least(diagonal, straight) : straight;
  return { straight: low, diagonal: diagonal > 0 ? least(diagonal, 2 * low) : 2 * low };
}

/** The cheapest step that can be taken among the entries of `edgeMs` of parity `parity`, or 0. */
function cheapest(edgeMs: Int32Array, parity: number): number {
  let found = 0;
  for (let entry = parity; entry < edgeMs.length; entry += 2) {
    const ms = edgeMs[entry] as number;
    if (ms > 0 && (found === 0 || ms < found)) found = ms;
  }
  return found;
}

/** A leg of exploration: its heading and walk, and the targets that had no route. */
type Leg = {
  readonly heading: number | undefined;
  readonly path: string;
  readonly blocked: readonly (readonly [number, number])[];
};

/** The window cell `reach` cells from the center along direction `heading`. */
function ahead(view: View, heading: number, reach: number): number {
  const [dx, dy] = beings.DIRECTIONS[heading] as readonly [number, number];
  const radius = floorDiv(view.side, 2);
  const span = least(reach, radius);
  return (radius + dy * span) * view.side + (radius + dx * span);
}

/**
 * Whether a cell of the window with a food cue lies within `sight` cells of `goal`, along both
 * axes: what the being would still see of food once there.
 */
function foodNear(view: View, goal: number, sight: number): boolean {
  const column = goal % view.side;
  const row = floorDiv(goal, view.side);
  const last = view.side - 1;
  for (let y = greatest(row - sight, 0); y <= least(row + sight, last); y += 1) {
    for (let x = greatest(column - sight, 0); x <= least(column + sight, last); x += 1)
      if ((view.foodCue[y * view.side + x] as number) > 0) return true;
  }
  return false;
}

/** How far a wandering being aims along its heading, and how near food its target must lie. */
type Wander = { readonly reach: number; readonly sight: number };

/**
 * A leg of a wandering being: toward the cell `wander.reach` cells away along `heading`, planned
 * with A*. When that cell lies outside the world, has a cooldown, has no food within `wander.sight`
 * cells, or has no route, the leg turns, trying each heading of TURNS in order, so that the being
 * never wanders out of sight of food; the targets without a route are returned to be avoided. The
 * heading is undefined when every target failed.
 */
export function wanderLeg(
  view: View,
  heading: number,
  wander: Wander,
  cooled: readonly number[],
): Leg {
  const bounds = windowBounds(view.edgeMs);
  const blocked: [number, number][] = [];
  if (bounds === undefined) return { heading: undefined, path: "", blocked };
  const grid = { side: view.side, edgeMs: view.edgeMs };
  for (const turn of TURNS) {
    const direction = (heading + turn) % 8;
    const goal = ahead(view, direction, wander.reach);
    if (!inWorld(view, goal) || cooled.includes(goal)) continue;
    if (!foodNear(view, goal, wander.sight)) continue;
    const route = aStar(grid, centerOf(view), goal, bounds);
    if (route !== undefined && route.path.length > 0)
      return { heading: direction, path: route.path, blocked };
    blocked.push(cellOf(view, goal));
  }
  return { heading: undefined, path: "", blocked };
}

/** The spiral of a search: the cell where it began, and the length of each of its steps. */
type Spiral = { readonly anchor: readonly number[]; readonly step: number };

/** ⌊√n⌋ for a safe integer n ≥ 0, by Newton's method on integers. */
function isqrt(n: number): number {
  if (n < 2) return n;
  let x = n;
  let y = floorDiv(x + 1, 2);
  while (y < x) {
    x = y;
    y = floorDiv(x + floorDiv(n, x), 2);
  }
  return x;
}

/** a / b rounded to the nearest integer, halves up, for a positive b. */
function nearestDiv(a: number, b: number): number {
  return floorDiv(2 * a + b, 2 * b);
}

/** The direction of the step whose signs are those of (dx, dy), for a non-zero offset. */
function headingTo(dx: number, dy: number): number {
  const sign = (value: number) => (value > 0 ? 1 : 0) - (value < 0 ? 1 : 0);
  const direction = beings.DIRECTIONS.findIndex(([x, y]) => x === sign(dx) && y === sign(dy));
  return greatest(direction, 0);
}

/** The offsets of the legs a search tries from the being's cell, by SPIRAL_LEGS or by heading. */
function spiralLegs(spiral: Spiral, dx: number, dy: number, heading: number): [number, number][] {
  const { step } = spiral;
  const r = isqrt(dx * dx + dy * dy);
  if (r === 0) {
    // At the anchor itself, the first leg leaves along the being's heading, turning if blocked.
    return TURNS.map((turn) => {
      const [hx, hy] = beings.DIRECTIONS[(heading + turn) % 8] as readonly [number, number];
      return [hx * step, hy * step];
    });
  }
  const around = [nearestDiv(-dy * step, r), nearestDiv(dx * step, r)];
  const out = [nearestDiv(dx * step, r), nearestDiv(dy * step, r)];
  return SPIRAL_LEGS.map(([a, b]) => [
    a * (around[0] as number) + b * (out[0] as number),
    a * (around[1] as number) + b * (out[1] as number),
  ]);
}

/**
 * A leg of a hungry being's search, planned with A*: a step of `spiral.step` cells around the
 * anchor, counterclockwise, from wherever the being stands. Since each step ends farther from the
 * anchor, the being's path is a spiral whose turns lie about π·step cells apart, which sweeps the
 * land nearest the anchor first and never comes back to a place it passed; it needs no memory but
 * the anchor. A leg that ends outside the world, on a cooldown, or without a route gives way to
 * the next of SPIRAL_LEGS. The heading is undefined when every leg failed.
 */
export function searchLeg(
  view: View,
  spiral: Spiral,
  heading: number,
  cooled: readonly number[],
): Leg {
  const bounds = windowBounds(view.edgeMs);
  if (bounds === undefined) return { heading: undefined, path: "", blocked: [] };
  const center = centerOf(view);
  const [x, y] = cellOf(view, center);
  const [ax = 0, ay = 0] = spiral.anchor;
  for (const [ox, oy] of spiralLegs(spiral, x - ax, y - ay, heading)) {
    const goal = nearestInWindow(view, ox, oy);
    if (goal === center || !inWorld(view, goal) || cooled.includes(goal)) continue;
    const route = aStar({ side: view.side, edgeMs: view.edgeMs }, center, goal, bounds);
    if (route !== undefined && route.path.length > 0)
      return { heading: headingTo(ox, oy), path: route.path, blocked: [] };
  }
  return { heading: undefined, path: "", blocked: [] };
}

/** The window cell nearest the offset (dx, dy) from the center: the offset clipped to the window. */
function nearestInWindow(view: View, dx: number, dy: number): number {
  const radius = floorDiv(view.side, 2);
  const column = radius + greatest(-radius, least(dx, radius));
  const row = radius + greatest(-radius, least(dy, radius));
  return row * view.side + column;
}

/** The first part of `path` that one walk may take. */
export function walkable(path: string): string {
  return path.length > beings.MAX_WALK_STEPS ? path.slice(0, beings.MAX_WALK_STEPS) : path;
}

/** Whether the being can take its whole route in one walk. */
export function fitsOneWalk(path: string): boolean {
  return path.length <= beings.MAX_WALK_STEPS;
}
