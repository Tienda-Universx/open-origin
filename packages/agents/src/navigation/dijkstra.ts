/**
 * Single-source shortest walks over a window: one search gives the duration to every cell, so a
 * brain can weigh every cell with a food cue at once (plan §5.4).
 */
import { EngineError, type Issue } from "@open-origin/engine";
import { readCell, readGrid, type WindowGrid } from "./grid.ts";
import { type SearchTarget, search, tracePath } from "./search.ts";

/** The shortest walks from `start` to every cell of a window of `side`. */
export type ShortestPaths = {
  readonly side: number;
  readonly start: number;
  /**
   * For each cell, the duration in milliseconds of its shortest walk from `start`, an exact
   * integer, or −1 when no walk reaches it.
   */
  readonly durationMs: Float64Array;
  /** For each cell, the direction of the last step of that walk; −1 at `start` and unreachable cells. */
  readonly arrival: Int8Array;
  /** How many cells the search expanded: each reachable cell once. */
  readonly expanded: number;
};

/** Dijkstra's algorithm: no goal, and a heuristic of 0, so cells leave the heap by (g, index). */
const EVERY_CELL: SearchTarget = Object.freeze({ goal: -1, heuristic: () => 0 });

/**
 * The shortest walk from the cell `start` to every cell of `grid`. Ties between walks of equal
 * duration break as search.ts describes, so the result is the same on every run. Throws
 * EngineError("invalid_value") with every problem: under /grid, what readGrid finds; at /start, a
 * value that is not the index of a cell of the window.
 */
export function dijkstra(grid: WindowGrid, start: number): ShortestPaths {
  const issues: Issue[] = [];
  const reading = readGrid(grid, issues);
  const from = readCell(start, "/start", reading.side, issues);
  if (reading.grid === undefined || from === undefined || issues.length > 0) {
    throw new EngineError("invalid_value", issues);
  }
  const { g, arrival, expanded } = search(reading.grid, from, EVERY_CELL);
  return { side: reading.grid.side, start: from, durationMs: g, arrival, expanded };
}

/**
 * The shortest walk of `paths` to the cell `target`, as the digits of its directions from the
 * start: "" for the start itself, undefined when no walk reaches it. Throws
 * EngineError("invalid_value") at /target for a value that is not a cell of the window, and at
 * /paths/arrival when the arrival directions, which a caller can change, do not lead back to the
 * start.
 */
export function pathTo(paths: ShortestPaths, target: number): string | undefined {
  const issues: Issue[] = [];
  const cell = readCell(target, "/target", paths.side, issues);
  if (cell === undefined) throw new EngineError("invalid_value", issues);
  if ((paths.durationMs[cell] as number) < 0) return undefined;
  return tracePath(paths.side, paths.arrival, paths.start, cell);
}
