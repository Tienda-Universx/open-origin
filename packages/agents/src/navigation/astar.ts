/**
 * A* toward one goal of a window (Hart, Nilsson, and Raphael 1968), with the octile heuristic: the
 * duration of the walk to the goal if every orthogonal step lasted `straight` and every diagonal
 * one `diagonal`, the shortest durations the species can walk (plan §5.4).
 */
import { EngineError, type Issue } from "@open-origin/engine";
import {
  type CheckedGrid,
  MAX_EDGE_MS,
  MAX_WINDOW_SIDE,
  readCell,
  readGrid,
  readInteger,
  type WindowGrid,
} from "./grid.ts";
import { search, tracePath } from "./search.ts";

/**
 * The shortest possible durations of an orthogonal and of a diagonal step, in milliseconds:
 * integers with 0 < straight ≤ diagonal ≤ 2·straight.
 */
export type StepBounds = { readonly straight: number; readonly diagonal: number };

/** A shortest walk to the goal: its duration, its direction digits, and the cells expanded. */
export type Route = {
  readonly durationMs: number;
  readonly path: string;
  readonly expanded: number;
};

/**
 * straight·(dmax − dmin) + diagonal·dmin for the offset (dx, dy), where dmax and dmin are the
 * larger and the smaller of |dx| and |dy|. When every orthogonal step lasts at least `straight`,
 * every diagonal one at least `diagonal`, and straight ≤ diagonal ≤ 2·straight, no walk over the
 * offset is shorter: no pair of straight steps undercuts a diagonal one, and no diagonal step
 * undercuts a straight one. So it is admissible, and consistent: across one step it falls by at
 * most that step's duration. It stays below 2^38 for window offsets, so it is exact.
 */
function octile(bounds: StepBounds, dx: number, dy: number): number {
  const across = dx < 0 ? -dx : dx;
  const along = dy < 0 ? -dy : dy;
  // dmax − dmin is |across − along|, and dmin is half of the rest of across + along.
  const gap = across - along;
  const straights = gap < 0 ? -gap : gap;
  const diagonals = (across + along - straights) / 2;
  return bounds.straight * straights + bounds.diagonal * diagonals;
}

/** `value` if it is a record of valid step bounds; undefined after every problem, under /bounds. */
function readBounds(value: unknown, issues: Issue[]): StepBounds | undefined {
  if (typeof value !== "object" || value === null) {
    issues.push({ path: "/bounds", message: "the bounds must be a record { straight, diagonal }" });
    return undefined;
  }
  const members = value as { straight?: unknown; diagonal?: unknown };
  const straight = readInteger(
    members.straight,
    "/bounds/straight",
    { min: 1, max: MAX_EDGE_MS },
    issues,
  );
  // Without a valid straight bound, the diagonal one can only be checked as an integer.
  const range = straight === undefined ? { min: 0 } : { min: straight, max: 2 * straight };
  const diagonal = readInteger(members.diagonal, "/bounds/diagonal", range, issues);
  if (straight === undefined || diagonal === undefined) return undefined;
  return { straight, diagonal };
}

/**
 * Reports every passable edge of `grid` shorter than its bound: A* would no longer be sure to
 * find a shortest walk, since the heuristic could overestimate.
 */
function reportShortEdges(grid: CheckedGrid, bounds: StepBounds, issues: Issue[]): void {
  const { edgeMs } = grid;
  for (let index = 0; index < edgeMs.length; index += 1) {
    const entry = edgeMs[index] as number;
    // Entry index·8 + d has the parity of d: odd entries are diagonal steps.
    const kind = index % 2 === 1 ? "diagonal" : "straight";
    const bound = bounds[kind];
    if (entry < 0 || entry >= bound) continue;
    issues.push({
      path: `/grid/edgeMs/${index}`,
      message: `${entry} is shorter than the bound of a ${kind} step, ${bound}: the heuristic would overestimate`,
    });
  }
}

/** The arguments of aStar, validated: the grid, the start and goal cells, and the bounds. */
type Query = {
  readonly grid: CheckedGrid;
  readonly start: number;
  readonly goal: number;
  readonly bounds: StepBounds;
};

/** The arguments of aStar if they are valid; throws EngineError("invalid_value") otherwise. */
function readQuery(grid: unknown, start: unknown, goal: unknown, bounds: unknown): Query {
  const issues: Issue[] = [];
  const reading = readGrid(grid, issues);
  const from = readCell(start, "/start", reading.side, issues);
  const to = readCell(goal, "/goal", reading.side, issues);
  const steps = readBounds(bounds, issues);
  const checked = reading.grid;
  if (checked !== undefined && steps !== undefined) reportShortEdges(checked, steps, issues);
  if (checked === undefined || steps === undefined || from === undefined || to === undefined) {
    throw new EngineError("invalid_value", issues);
  }
  if (issues.length > 0) throw new EngineError("invalid_value", issues);
  return { grid: checked, start: from, goal: to, bounds: steps };
}

/**
 * A shortest walk from the cell `start` to the cell `goal` of `grid`, or undefined when none
 * reaches it. `bounds` must not exceed any passable step of the grid. Cells are expanded by
 * (f, h, cell index), each at most once, so the route is the same on every run. Throws
 * EngineError("invalid_value") with every problem: under /grid, what readGrid finds and every
 * edge shorter than its bound; at /start and /goal, a value that is not a cell of the window;
 * under /bounds, bounds that are not integers with 0 < straight ≤ diagonal ≤ 2·straight and
 * straight < 2^31.
 */
export function aStar(
  grid: WindowGrid,
  start: number,
  goal: number,
  bounds: StepBounds,
): Route | undefined {
  const query = readQuery(grid, start, goal, bounds);
  const { side } = query.grid;
  const goalColumn = query.goal % side;
  const goalRow = (query.goal - goalColumn) / side;
  const heuristic = (cell: number): number => {
    const column = cell % side;
    return octile(query.bounds, goalColumn - column, goalRow - (cell - column) / side);
  };
  const { g, arrival, expanded } = search(query.grid, query.start, { goal: query.goal, heuristic });
  const durationMs = g[query.goal] as number;
  if (durationMs < 0) return undefined;
  return { durationMs, path: tracePath(side, arrival, query.start, query.goal), expanded };
}

/** The largest offset between two cells of a window, along either axis. */
const MAX_OFFSET = MAX_WINDOW_SIDE - 1;

/**
 * The octile heuristic that aStar uses, for the offset (dx, dy) between two cells of a window:
 * straight·(dmax − dmin) + diagonal·dmin. Throws EngineError("invalid_value") with every problem:
 * under /bounds, as aStar; at /dx and /dy, a value that is not an integer from −64 to 64.
 */
export function octileMs(bounds: StepBounds, dx: number, dy: number): number {
  const issues: Issue[] = [];
  const steps = readBounds(bounds, issues);
  const offset = { min: -MAX_OFFSET, max: MAX_OFFSET };
  const across = readInteger(dx, "/dx", offset, issues);
  const along = readInteger(dy, "/dy", offset, issues);
  if (steps === undefined || across === undefined || along === undefined || issues.length > 0) {
    throw new EngineError("invalid_value", issues);
  }
  return octile(steps, across, along);
}
