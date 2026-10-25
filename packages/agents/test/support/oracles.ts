import type { WindowGrid } from "../../src/index.ts";
import { edgeOf, neighborOf } from "./grids.ts";

/**
 * Shortest-walk oracles that share no code with packages/agents/src: each reads the grid through
 * the contract helpers of grids.ts and returns durations in milliseconds, −1 when unreachable.
 */

/**
 * Dijkstra's algorithm in its original O(V²) form (Dijkstra 1959): no heap, the next cell is the
 * unsettled one with the smallest known duration, found by a linear scan.
 */
export function quadraticDijkstra(grid: WindowGrid, start: number): number[] {
  const cells = grid.side * grid.side;
  const durations = Array.from({ length: cells }, () => Number.POSITIVE_INFINITY);
  const settled = Array.from({ length: cells }, () => false);
  durations[start] = 0;
  for (let next = nearest(durations, settled); next >= 0; next = nearest(durations, settled)) {
    settled[next] = true;
    const from = durations[next] ?? 0;
    for (let direction = 0; direction < 8; direction += 1) {
      const to = neighborOf(grid.side, next, direction);
      const edge = edgeOf(grid, next, direction);
      if (to >= 0 && edge >= 0 && from + edge < (durations[to] ?? 0)) durations[to] = from + edge;
    }
  }
  return durations.map((duration) => (Number.isFinite(duration) ? duration : -1));
}

/** The unsettled cell with the smallest finite duration, by a linear scan; −1 when none is left. */
function nearest(durations: readonly number[], settled: readonly boolean[]): number {
  let best = -1;
  let bestDuration = Number.POSITIVE_INFINITY;
  durations.forEach((duration, cell) => {
    if (!settled[cell] && duration < bestDuration) {
      best = cell;
      bestDuration = duration;
    }
  });
  return best;
}

/**
 * Breadth-first search, valid only when every passable edge lasts `duration`: the fewest steps
 * to each cell, times `duration`.
 */
export function bfsDurations(grid: WindowGrid, start: number, duration: number): number[] {
  const steps = Array.from({ length: grid.side * grid.side }, () => -1);
  steps[start] = 0;
  const queue = [start];
  for (let head = 0; head < queue.length; head += 1) {
    const cell = queue[head] ?? 0;
    for (let direction = 0; direction < 8; direction += 1) {
      const to = neighborOf(grid.side, cell, direction);
      if (to < 0 || edgeOf(grid, cell, direction) < 0 || steps[to] !== -1) continue;
      steps[to] = (steps[cell] ?? 0) + 1;
      queue.push(to);
    }
  }
  return steps.map((count) => (count < 0 ? -1 : count * duration));
}

/**
 * The shortest duration from `start` to `goal` over every simple walk between them, enumerated
 * exhaustively: with positive durations a shortest walk never repeats a cell. Only for small
 * windows, since the number of simple walks grows exponentially.
 */
export function bruteForceDuration(grid: WindowGrid, start: number, goal: number): number {
  const visited = Array.from({ length: grid.side * grid.side }, () => false);
  let best = Number.POSITIVE_INFINITY;
  const extend = (cell: number, elapsed: number): void => {
    if (cell === goal) {
      if (elapsed < best) best = elapsed;
      return;
    }
    visited[cell] = true;
    for (let direction = 0; direction < 8; direction += 1) {
      const to = neighborOf(grid.side, cell, direction);
      const edge = edgeOf(grid, cell, direction);
      if (to >= 0 && edge >= 0 && !visited[to]) extend(to, elapsed + edge);
    }
    visited[cell] = false;
  };
  extend(start, 0);
  return Number.isFinite(best) ? best : -1;
}
