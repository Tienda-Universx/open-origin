/**
 * Space (ADR 0021, space): the world's cells and chunks along each axis. A chunk has CHUNK_CELLS ×
 * CHUNK_CELLS cells; cells lie in [MIN_CELL, MAX_CELL] and chunks in [MIN_CHUNK, MAX_CHUNK], so
 * every cell of the world lies in a chunk of the world. Kernel chunk keys stay any safe integers: a
 * ruleset that uses worldgen rejects a key outside these bounds in `check`, with chunkKeyIssues.
 *
 * The helpers round toward negative infinity with floorDiv and floorMod (int.ts), never with `|0`,
 * which rounds toward zero, nor with `>>`, which floors only within int32 and wraps beyond it. They
 * check nothing: callers on hot paths
 * validate coordinates once, with the readers below, and keep to the preconditions documented on
 * each helper.
 */
import { type IssueSink, numberProblem } from "../canonical/value.ts";
import { describeValue, type Issue, IssueList } from "../errors.ts";
import { floorDiv, floorMod } from "../int.ts";
import { type ChunkCoord, readChunkKey } from "../world/chunk.ts";
import { expectRecord, readMember, UNREAD } from "../world/members.ts";

/** How many cells a chunk has along each axis. */
export const CHUNK_CELLS = 32;

/** The lowest cell coordinate, −2^31. */
export const MIN_CELL = -0x8000_0000;

/** The highest cell coordinate, 2^31 − 1. */
export const MAX_CELL = 0x7fff_ffff;

/** The lowest chunk coordinate, −2^26: the chunk of MIN_CELL. */
export const MIN_CHUNK = -0x400_0000;

/** The highest chunk coordinate, 2^26 − 1: the chunk of MAX_CELL. */
export const MAX_CHUNK = 0x3ff_ffff;

/** The position of a cell in the world. */
export type CellCoord = { readonly x: number; readonly y: number };

/**
 * The chunk that holds the cell coordinate `cell`, on the same axis: ⌊cell / 32⌋, so the cell −1
 * lies in the chunk −1. Precondition: `cell` is a safe integer; inside the world, the result lies
 * in [MIN_CHUNK, MAX_CHUNK].
 */
export function chunkOfCell(cell: number): number {
  return floorDiv(cell, CHUNK_CELLS);
}

/**
 * The offset of the cell coordinate `cell` inside its chunk, on the same axis: cell − 32·⌊cell /
 * 32⌋, in [0, 32), so the cell −1 has the offset 31. Precondition: `cell` is a safe integer.
 */
export function cellOffset(cell: number): number {
  return floorMod(cell, CHUNK_CELLS);
}

/**
 * The first cell coordinate of the chunk coordinate `chunk`, on the same axis: chunk·32, exact for
 * every chunk of the world. Precondition: `chunk` is a safe integer in [MIN_CHUNK, MAX_CHUNK],
 * not −0.
 */
export function chunkFirstCell(chunk: number): number {
  return chunk * CHUNK_CELLS;
}

/**
 * The row-major index of the cell at the offsets `x` and `y` of a chunk: y·32 + x, in [0, 1024).
 * Precondition: `x` and `y` are integers in [0, 32), as cellOffset returns them.
 */
export function cellIndex(x: number, y: number): number {
  return y * CHUNK_CELLS + x;
}

/** Why `value` is not a cell coordinate of the world; undefined when it is one. */
function cellProblem(value: unknown): string | undefined {
  if (typeof value !== "number") return `${describeValue(value)} is not a safe integer`;
  const problem = numberProblem(value);
  if (problem !== undefined) return problem;
  if (value >= MIN_CELL && value <= MAX_CELL) return undefined;
  return `${value} is outside the world: cell coordinates lie from ${MIN_CELL} to ${MAX_CELL}`;
}

/**
 * The coordinate `axis` of the host object `cell`, read once through its own descriptor;
 * undefined after an issue at `path/axis`.
 */
function readCellAxis(
  cell: object,
  axis: "x" | "y",
  path: string,
  sink: IssueSink,
): number | undefined {
  const value = readMember(cell, axis, `${path}/${axis}`, sink);
  if (value === UNREAD) return undefined;
  const problem = cellProblem(value);
  if (problem !== undefined) sink.report(`${path}/${axis}`, problem);
  return typeof value === "number" && problem === undefined ? value : undefined;
}

/**
 * The cell that the host value `value` names, as a fresh record; undefined after every problem is
 * reported to `sink` under `path`. `value` is any object that is not an array, and only its `x` and
 * `y` are read, each once, as chunkKey reads chunk coordinates (world/members.ts): an inherited
 * coordinate reads as missing, an accessor never runs, and an object that throws while read is
 * one issue at `path`. Each coordinate is a safe integer, not −0, in [MIN_CELL, MAX_CELL].
 */
export function readCell(value: unknown, path: string, sink: IssueSink): CellCoord | undefined {
  if (!expectRecord(value, path, "the cell must be a record { x, y }", sink)) return undefined;
  const x = readCellAxis(value, "x", path, sink);
  const y = readCellAxis(value, "y", path, sink);
  return x === undefined || y === undefined ? undefined : { x, y };
}

/** Whether the chunk coordinate `value` lies in the world; if not, an issue at `path`. */
function chunkInWorld(value: number, axis: "x" | "y", path: string, sink: IssueSink): boolean {
  if (value >= MIN_CHUNK && value <= MAX_CHUNK) return true;
  sink.report(
    path,
    `the ${axis} of the chunk key, ${value}, is outside the world: chunk coordinates lie from ${MIN_CHUNK} to ${MAX_CHUNK}`,
  );
  return false;
}

/**
 * The coordinates of `key`, a kernel chunk key (world/chunk.ts) whose coordinates lie in
 * [MIN_CHUNK, MAX_CHUNK]; undefined after every problem is reported to `sink` at `path`.
 */
export function readWorldChunkKey(
  key: unknown,
  path: string,
  sink: IssueSink,
): ChunkCoord | undefined {
  const reading = readChunkKey(key);
  if (reading.coord === undefined) {
    for (const problem of reading.problems) sink.report(path, problem);
    return undefined;
  }
  const { x, y } = reading.coord;
  const inside = chunkInWorld(x, "x", path, sink);
  return chunkInWorld(y, "y", path, sink) && inside ? reading.coord : undefined;
}

/**
 * Why `key` is not the key of a chunk of the world, as issues at the path "": a malformed kernel
 * chunk key, or a coordinate outside [MIN_CHUNK, MAX_CHUNK]; empty when it is one. A ruleset that
 * uses worldgen calls it from `check`, to reject such a key without faulting the world.
 */
export function chunkKeyIssues(key: unknown): Issue[] {
  const issues = new IssueList();
  readWorldChunkKey(key, "", issues);
  return issues.issues;
}
