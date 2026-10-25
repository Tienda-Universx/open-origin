/**
 * The best-first search that Dijkstra's algorithm and A* share over a window grid (Dijkstra 1959;
 * Hart, Nilsson, and Raphael 1968). Every buffer belongs to one search, so searches never share
 * state.
 *
 * Each cell is expanded at most once: a heuristic that is 0, or consistent, never finds a shorter
 * walk to a cell after expanding it. So a search expands at most the window's cell count, which is
 * its node budget, and the heap never holds more.
 *
 * A cell keeps the first walk that reached it with its shortest duration: a later walk replaces
 * it only when strictly shorter. Cells are expanded in heap order (heap.ts), and each one's edges
 * in direction order, so equal-duration alternatives always resolve the same way.
 */
import { EngineError } from "@open-origin/engine";
import { type CheckedGrid, type Compass, compass, DIRECTIONS, neighbor } from "./grid.ts";
import { type CellHeap, createHeap, popFirst, pushOrRaise } from "./heap.ts";

/** Where a search heads: its goal (−1 for none) and a heuristic toward it (0 for none). */
export type SearchTarget = {
  readonly goal: number;
  /** A lower bound on the duration of any walk from `cell` to the goal; consistent. */
  readonly heuristic: (cell: number) => number;
};

/** What a search found about each cell of the window, and how many cells it expanded. */
export type SearchResult = {
  /** The duration of the shortest walk found from the start, or −1 when it was not reached. */
  readonly g: Float64Array;
  /** The direction of the last step of that walk; −1 for the start and cells not reached. */
  readonly arrival: Int8Array;
  readonly expanded: number;
};

/** The buffers of one search: the result's arrays, the heuristic of each cell, and the heap. */
type Frontier = {
  readonly grid: CheckedGrid;
  readonly compass: Compass;
  readonly g: Float64Array;
  readonly h: Float64Array;
  readonly arrival: Int8Array;
  /** 1 for each cell already expanded. */
  readonly closed: Uint8Array;
  readonly heap: CellHeap;
  readonly heuristic: (cell: number) => number;
};

/** Records a walk of `duration` to `cell` whose last step is `direction`, if it is shorter. */
function improve(frontier: Frontier, cell: number, duration: number, direction: number): void {
  const known = frontier.g[cell] as number;
  if (known >= 0 && duration >= known) return;
  if (known < 0) frontier.h[cell] = frontier.heuristic(cell);
  frontier.g[cell] = duration;
  frontier.arrival[cell] = direction;
  pushOrRaise(frontier.heap, cell);
}

/** Offers every passable step from the expanded `cell` to the neighbors not yet expanded. */
function relax(frontier: Frontier, cell: number): void {
  const { side, edgeMs } = frontier.grid;
  const column = cell % side;
  const row = (cell - column) / side;
  // Durations are below 2^31 and walks shorter than 65² steps, so every sum is an exact integer.
  const before = frontier.g[cell] as number;
  for (let direction = 0; direction < DIRECTIONS; direction += 1) {
    const duration = edgeMs[cell * DIRECTIONS + direction] as number;
    const next = duration < 0 ? -1 : neighbor(frontier.compass, column, row, direction);
    if (next >= 0 && frontier.closed[next] === 0) {
      improve(frontier, next, before + duration, direction);
    }
  }
}

/**
 * Searches `grid` from `start`, a valid cell, expanding cells in heap order until it expands the
 * goal or runs out of cells. Without a goal, every reachable cell ends with its shortest duration.
 */
export function search(grid: CheckedGrid, start: number, target: SearchTarget): SearchResult {
  const g = new Float64Array(grid.cells).fill(-1);
  const h = new Float64Array(grid.cells);
  const frontier: Frontier = {
    grid,
    compass: compass(grid.side),
    g,
    h,
    arrival: new Int8Array(grid.cells).fill(-1),
    closed: new Uint8Array(grid.cells),
    heap: createHeap(g, h),
    heuristic: target.heuristic,
  };
  g[start] = 0;
  h[start] = target.heuristic(start);
  pushOrRaise(frontier.heap, start);
  let expanded = 0;
  while (frontier.heap.size > 0) {
    const cell = popFirst(frontier.heap);
    frontier.closed[cell] = 1;
    expanded += 1;
    if (cell === target.goal) break;
    relax(frontier, cell);
  }
  return { g, arrival: frontier.arrival, expanded };
}

/**
 * The digits of the walk that `arrival` records from `start` to `target` in a window of `side`,
 * read back from the target. Throws EngineError("invalid_value") at /paths/arrival when the
 * directions do not lead back to the start inside the window in fewer steps than it has cells,
 * which a search's own result always does.
 */
export function tracePath(side: number, arrival: Int8Array, start: number, target: number): string {
  const window = compass(side);
  const digits: number[] = [];
  let cell = target;
  while (cell !== start) {
    const direction = arrival[cell] as number;
    const column = cell % side;
    const row = (cell - column) / side;
    const valid = direction >= 0 && direction < DIRECTIONS;
    // One step back: the opposite of direction d is d + 4, modulo 8.
    const previous = valid ? neighbor(window, column, row, (direction + 4) % DIRECTIONS) : -1;
    if (previous < 0 || digits.length >= side * side - 1) {
      throw new EngineError("invalid_value", [
        { path: "/paths/arrival", message: "the arrival directions do not lead back to the start" },
      ]);
    }
    digits.push(direction);
    cell = previous;
  }
  return digits.reverse().join("");
}
