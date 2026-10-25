/**
 * The window grid that navigation searches: the part of a being's senses that holds the duration
 * of every step (docs/architecture/beings.md, "Senses"). The indexing and the direction vectors
 * here are the contract the engine, the brain, and every oracle share.
 */
import type { Issue } from "@open-origin/engine";

/**
 * A square window of `side` cells and the 8 edges of each. Cell (x, y) of the world has index
 * `(y − origin.y)·side + (x − origin.x)`, so the cell in column c and row r of the window has index
 * `r·side + c`, rows growing northward. Entry `index·8 + d` of `edgeMs` is the duration in integer
 * milliseconds of the step from that cell in direction d, or −1 when it is impassable.
 */
export type WindowGrid = { readonly side: number; readonly edgeMs: Int32Array };

/** The largest side of a window: 2R + 1 for the largest senses radius R, 32. */
export const MAX_WINDOW_SIDE = 65;

/** How many edges a cell has, one per direction. */
export const DIRECTIONS = 8;

/** The entry of an edge that cannot be walked. */
export const IMPASSABLE = -1;

/** The longest step an edge can hold, the largest int32: 2^31 − 1 ms. */
export const MAX_EDGE_MS = 0x7fff_ffff;

/** A grid that passed readGrid, with its cell count. */
export type CheckedGrid = WindowGrid & { readonly cells: number };

/** A window's side and the direction vectors, as one search reads them. */
export type Compass = {
  readonly side: number;
  /** Direction d moves by (dx[d], dy[d]). */
  readonly dx: Int8Array;
  readonly dy: Int8Array;
};

/**
 * The direction vectors for one search over a window of `side`: 0 E (1, 0), 1 NE (1, 1),
 * 2 N (0, 1), 3 NW (−1, 1), 4 W (−1, 0), 5 SW (−1, −1), 6 S (0, −1), 7 SE (1, −1),
 * counterclockwise from east with y growing northward. Even directions are orthogonal and odd ones
 * diagonal, and d + 4 (mod 8) is the opposite of d. A path writes direction d as the digit d.
 * Each search gets fresh arrays: a module-level table would be module state, and a frozen one
 * made the search about twice as slow on Bun 1.4.4.
 */
export function compass(side: number): Compass {
  return {
    side,
    dx: Int8Array.of(1, 1, 0, -1, -1, -1, 0, 1),
    dy: Int8Array.of(0, 1, 1, 1, 0, -1, -1, -1),
  };
}

/**
 * The cell one step from column `column` and row `row` in direction `direction`, or −1 when the
 * step leaves the window: such a step is impassable whatever its entry says.
 */
export function neighbor(window: Compass, column: number, row: number, direction: number): number {
  const toColumn = column + (window.dx[direction] as number);
  const toRow = row + (window.dy[direction] as number);
  const { side } = window;
  if (toColumn < 0 || toColumn >= side || toRow < 0 || toRow >= side) return -1;
  return toRow * side + toColumn;
}

/** `value` for a message: a number as JavaScript writes it, anything else by its type alone. */
function describe(value: unknown): string {
  return typeof value === "number" ? `${value}` : `a value of type ${typeof value}`;
}

/**
 * `value` if it is a safe integer from `min` to `max`; undefined after an issue at `path`. Without
 * `max`, only that it is a safe integer is checked.
 */
export function readInteger(
  value: unknown,
  path: string,
  range: { readonly min: number; readonly max?: number | undefined },
  issues: Issue[],
): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    issues.push({ path, message: `${describe(value)} is not a safe integer` });
    return undefined;
  }
  if (range.max === undefined || (value >= range.min && value <= range.max)) return value;
  issues.push({
    path,
    message: `${value} is out of bounds: it must be from ${range.min} to ${range.max}`,
  });
  return undefined;
}

/** Whether `entry` is −1 or a positive duration, the only values an edge holds. */
const isEdge = (entry: number): boolean => entry === IMPASSABLE || entry > 0;

/** The edges `edgeMs` if they fit a window of `side` (when known); undefined after issues. */
function readEdges(
  edgeMs: unknown,
  side: number | undefined,
  issues: Issue[],
): Int32Array | undefined {
  if (!(edgeMs instanceof Int32Array)) {
    issues.push({ path: "/grid/edgeMs", message: "the edges must be an Int32Array" });
    return undefined;
  }
  if (side === undefined) return undefined;
  const expected = side * side * DIRECTIONS;
  if (edgeMs.length !== expected) {
    issues.push({
      path: "/grid/edgeMs",
      message: `it has ${edgeMs.length} entries: a window of side ${side} has ${expected}`,
    });
    return undefined;
  }
  const before = issues.length;
  // A plain loop: a callback per entry measured about 4 times slower on Bun 1.4.4.
  for (let index = 0; index < expected; index += 1) {
    const entry = edgeMs[index] as number;
    if (isEdge(entry)) continue;
    issues.push({
      path: `/grid/edgeMs/${index}`,
      message: `${entry} is not a duration: an edge lasts a positive number of milliseconds, or is -1 when impassable`,
    });
  }
  return issues.length === before ? edgeMs : undefined;
}

/**
 * What readGrid learned: the grid, when it is a window grid, and its side, when that alone is
 * valid, so that cell indices can still be checked against it.
 */
export type GridReading = {
  readonly grid: CheckedGrid | undefined;
  readonly side: number | undefined;
};

/**
 * `grid` with its cell count if it is a window grid: a record whose `side` is an integer from 1
 * to 65 and whose `edgeMs` is an Int32Array of side²·8 entries, each −1 or positive. Every problem
 * is reported, at /grid and below. Each member is read once.
 */
export function readGrid(grid: unknown, issues: Issue[]): GridReading {
  if (typeof grid !== "object" || grid === null) {
    issues.push({ path: "/grid", message: "the grid must be a record { side, edgeMs }" });
    return { grid: undefined, side: undefined };
  }
  const { side: sideValue, edgeMs: edgeValue } = grid as { side?: unknown; edgeMs?: unknown };
  const side = readInteger(sideValue, "/grid/side", { min: 1, max: MAX_WINDOW_SIDE }, issues);
  const edgeMs = readEdges(edgeValue, side, issues);
  if (side === undefined || edgeMs === undefined) return { grid: undefined, side };
  return { grid: { side, edgeMs, cells: side * side }, side };
}

/**
 * `value` if it is the index of a cell of a window of `side`; undefined after an issue at `path`.
 * Without a valid side, only that `value` is a safe integer is checked.
 */
export function readCell(
  value: unknown,
  path: string,
  side: number | undefined,
  issues: Issue[],
): number | undefined {
  const max = side === undefined ? undefined : side * side - 1;
  return readInteger(value, path, { min: 0, max }, issues);
}
