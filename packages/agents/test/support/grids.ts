import { Sfc32 } from "../../../engine/test/support/sfc32.ts";
import type { WindowGrid } from "../../src/index.ts";

/**
 * Window grids for the navigation tests, written from the contract in docs/architecture/beings.md
 * ("Senses") rather than from the code under test: cell (column, row) has index row·side + column,
 * and its edge in direction d is entry index·8 + d, −1 when impassable.
 */

/** Direction d as (dx, dy): E, NE, N, NW, W, SW, S, SE, counterclockwise from east, y north. */
export const VECTORS: readonly (readonly [number, number])[] = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
];

/** The two orthogonal directions a diagonal passes between: NE (1) between E (0) and N (2). */
export function flanks(diagonal: number): readonly [number, number] {
  return [(diagonal + 7) % 8, (diagonal + 1) % 8];
}

export const isDiagonal = (direction: number): boolean => direction % 2 === 1;

/** The index of the cell at (column, row). */
export const cellAt = (side: number, column: number, row: number): number => row * side + column;

/** The cell one step from `cell` in `direction`, or −1 when the step leaves the window. */
export function neighborOf(side: number, cell: number, direction: number): number {
  const column = cell % side;
  const row = (cell - column) / side;
  const [dx, dy] = VECTORS[direction] ?? [0, 0];
  const toColumn = column + dx;
  const toRow = row + dy;
  if (toColumn < 0 || toColumn >= side || toRow < 0 || toRow >= side) return -1;
  return cellAt(side, toColumn, toRow);
}

/** The entry of `cell`'s edge in `direction`. */
export function edgeOf(grid: WindowGrid, cell: number, direction: number): number {
  return grid.edgeMs[cell * 8 + direction] ?? Number.NaN;
}

/** A grid of `side` where every edge lasts `duration(cell, direction)`. */
export function gridOf(
  side: number,
  duration: (cell: number, direction: number) => number,
): WindowGrid {
  const edgeMs = new Int32Array(side * side * 8);
  for (let cell = 0; cell < side * side; cell += 1) {
    for (let direction = 0; direction < 8; direction += 1) {
      edgeMs[cell * 8 + direction] = duration(cell, direction);
    }
  }
  return { side, edgeMs };
}

/** A grid where every orthogonal step lasts `straight` and every diagonal one `diagonal`. */
export function uniformGrid(side: number, straight: number, diagonal = straight): WindowGrid {
  return gridOf(side, (_cell, direction) => (isDiagonal(direction) ? diagonal : straight));
}

/**
 * A 5 × 5 window with steps of 10 and 14 ms whose column 2 is a wall: no edge enters it, except
 * the edges into the cell `gap` (−1 for none).
 */
export function wallGrid(gap: number): WindowGrid {
  return gridOf(5, (cell, direction) => {
    const to = neighborOf(5, cell, direction);
    if (to >= 0 && to % 5 === 2 && to !== gap) return -1;
    return isDiagonal(direction) ? 14 : 10;
  });
}

/** A window of `side` where only the border is passable, by straight steps of 10 ms along it. */
export function ringGrid(side: number): WindowGrid {
  const onBorder = (cell: number) => {
    const column = cell % side;
    const row = (cell - column) / side;
    return column === 0 || row === 0 || column === side - 1 || row === side - 1;
  };
  return gridOf(side, (cell, direction) => {
    const to = neighborOf(side, cell, direction);
    return to >= 0 && !isDiagonal(direction) && onBorder(cell) && onBorder(to) ? 10 : -1;
  });
}

/**
 * The walk of `path` from `start`: the cell it ends on and its duration, or a description of the
 * first step that is not a valid step of the grid (a digit outside 0–7, a step that leaves the
 * window, or an impassable edge).
 */
export function walk(
  grid: WindowGrid,
  start: number,
  path: string,
): { end: number; durationMs: number } | string {
  let cell = start;
  let durationMs = 0;
  for (let index = 0; index < path.length; index += 1) {
    const direction = path.charCodeAt(index) - 48;
    if (!(direction >= 0 && direction < 8)) return `step ${index} is not a direction digit`;
    const next = neighborOf(grid.side, cell, direction);
    if (next < 0) return `step ${index} leaves the window`;
    const edge = edgeOf(grid, cell, direction);
    if (edge < 0) return `step ${index} is impassable`;
    durationMs += edge;
    cell = next;
  }
  return { end: cell, durationMs };
}

/** What a random grid draws: its side and its step bounds. */
export type RandomGridSpec = { side: number; straight: number; diagonal: number };

/** The bounds and grid of one random case. */
export type RandomCase = RandomGridSpec & { grid: WindowGrid };

/**
 * A random window: each orthogonal edge is impassable with a probability drawn for the grid, else
 * lasts `straight` plus a random excess; a diagonal is impassable when either orthogonal step it
 * passes between is, as the engine encodes corner cutting, and otherwise when drawn so. Edges that
 * leave the window get random entries, often passable, which navigation must ignore. A third of
 * the grids draw excesses from {0, straight}, so equal-cost alternatives are common.
 */
export function randomGrid(rng: Sfc32, spec: RandomGridSpec): WindowGrid {
  const { side, straight, diagonal } = spec;
  const blocked = rng.below(50);
  const fewCosts = rng.below(3) === 0;
  const excess = (base: number): number =>
    fewCosts ? base * rng.below(2) : rng.below(base * 3 + 1);
  const edgeMs = new Int32Array(side * side * 8).fill(-1);
  for (let cell = 0; cell < side * side; cell += 1) {
    for (const direction of [0, 2, 4, 6]) {
      const open = rng.below(100) >= blocked;
      edgeMs[cell * 8 + direction] = open ? straight + excess(straight) : -1;
    }
    for (const direction of [1, 3, 5, 7]) {
      const [a, b] = flanks(direction);
      const cut = (edgeMs[cell * 8 + a] ?? -1) < 0 || (edgeMs[cell * 8 + b] ?? -1) < 0;
      const open = !cut && rng.below(100) >= blocked;
      edgeMs[cell * 8 + direction] = open ? diagonal + excess(diagonal) : -1;
    }
  }
  return { side, edgeMs };
}

/** Random step bounds, straight ≤ diagonal ≤ 2·straight, the limits included often. */
export function randomBounds(rng: Sfc32): { straight: number; diagonal: number } {
  const straight = rng.pick([1, 2, 10, 1000, rng.between(1, 5000)]);
  const diagonal = rng.pick([straight, 2 * straight, rng.between(straight, 2 * straight)]);
  return { straight, diagonal };
}

/** A random case: a side from 1 to `maxSide`, random bounds, and a random grid that keeps them. */
export function randomCase(rng: Sfc32, maxSide: number): RandomCase {
  const spec = { side: rng.between(1, maxSide), ...randomBounds(rng) };
  return { ...spec, grid: randomGrid(rng, spec) };
}

export { Sfc32 };
