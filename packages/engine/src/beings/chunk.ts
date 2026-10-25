/**
 * A materialized chunk of the beings layer (ADR 0023): the beings whose cell lies in it, the cells
 * whose food was eaten, and `due`, the earliest tick at which one of its beings must be processed.
 * Terrain never enters it (ADR 0021): only what beings changed and who is there.
 */
import { type Issue, IssueList } from "../errors.ts";
import type { ChunkKey } from "../world/chunk.ts";
import { readChunkKey } from "../world/chunk.ts";
import { CHUNK_CELLS, chunkOfCell } from "../worldgen/index.ts";
import { type Being, checkBeing, MAX_TICK } from "./being.ts";
import type { Depletion } from "./food.ts";
import { range, readFields, readInt, readList, TICKS } from "./schema.ts";

/**
 * A chunk's value. Its own members are writable, because writeChunk hands the system the live value
 * to change; every read goes through the kernel's DeepReadonly view.
 */
export type BeingsChunk = { beings: Being[]; depletion: Depletion[]; due: number };

/** The bounds of a chunk: up to 2^16 beings, one depletion entry per cell, takes up to 2^20. */
export const CHUNK_BOUNDS = Object.freeze({
  beings: range(0, 0x1_0000),
  depletion: range(0, CHUNK_CELLS * CHUNK_CELLS),
  cell: range(0, CHUNK_CELLS * CHUNK_CELLS - 1),
  taken: range(1, 0x10_0000),
});

/** The earliest wake of `beings`, or MAX_TICK when there is none. */
export function dueOf(beings: readonly { readonly wake: number }[]): number {
  let due = MAX_TICK;
  for (const being of beings) if (being.wake < due) due = being.wake;
  return due;
}

/** Reports a valid being whose cell does not lie in the chunk `x, y`. */
function checkPlace(
  being: Being,
  path: string,
  chunk: { x: number; y: number },
  issues: IssueList,
): void {
  const [x, y] = being.cell;
  const [cx, cy] = [chunkOfCell(x), chunkOfCell(y)];
  if (cx === chunk.x && cy === chunk.y) return;
  issues.report(
    `${path}/cell`,
    `the cell (${x}, ${y}) lies in chunk ${cx},${cy}, not in this chunk ${chunk.x},${chunk.y}`,
  );
}

/** Reports every problem of the beings of a chunk: each one, their order, and their cells. */
function checkBeings(
  value: unknown,
  chunk: { x: number; y: number } | undefined,
  issues: IssueList,
): void {
  const beings = readList(value, "/beings", CHUNK_BOUNDS.beings, issues);
  let previous: number | undefined;
  beings?.forEach((being, index) => {
    const path = `/beings/${index}`;
    const before = issues.count;
    checkBeing(being, path, issues);
    if (issues.count !== before) return;
    // checkBeing reported nothing, so `being` is a valid Being.
    const valid = being as Being;
    if (previous !== undefined && valid.id <= previous) {
      issues.report(`${path}/id`, `ids rise strictly: ${valid.id} must exceed ${previous}`);
    }
    previous = valid.id;
    if (chunk !== undefined) checkPlace(valid, path, chunk, issues);
  });
}

/** Reports every problem of the depletion entries of a chunk. */
function checkDepletion(value: unknown, issues: IssueList): void {
  const entries = readList(value, "/depletion", CHUNK_BOUNDS.depletion, issues);
  let previous: number | undefined;
  entries?.forEach((entry, index) => {
    const path = `/depletion/${index}`;
    const fields = readFields(entry, path, { required: ["cell", "since", "taken"] }, issues);
    const cell = fields?.int("cell", CHUNK_BOUNDS.cell);
    fields?.int("taken", CHUNK_BOUNDS.taken);
    fields?.int("since", TICKS);
    if (cell === undefined) return;
    if (previous !== undefined && cell <= previous) {
      issues.report(`${path}/cell`, `cells rise strictly: ${cell} must exceed ${previous}`);
    }
    previous = cell;
  });
}

/** Reports a `due` that is not the earliest wake of the chunk's beings, all of them valid. */
function checkDue(due: number, beings: readonly Being[], issues: IssueList): void {
  const earliest = dueOf(beings);
  if (due === earliest) return;
  const expected =
    beings.length === 0
      ? `a chunk without beings has due ${MAX_TICK}`
      : `the earliest wake of the chunk's beings is ${earliest}`;
  issues.report("/due", `due is ${due}, but ${expected}`);
}

/**
 * Every problem of `value` as the chunk `key` of the beings layer, for the ruleset's
 * validateChunk: its beings, each in a cell of this chunk and ordered by id; its depletion,
 * ordered by cell; and its due tick, which must be the earliest wake when every being is valid.
 * `value` is canonical, as the kernel passes it to a validator; a host that holds an arbitrary
 * value copies it first with copyCanonical. Never throws for a canonical value.
 */
export function beingsChunkIssues(key: ChunkKey, value: unknown): Issue[] {
  const issues = new IssueList();
  if (value === undefined) {
    issues.report("", "the chunk is missing");
    return issues.issues;
  }
  const chunk = readFields(value, "", { required: ["beings", "depletion", "due"] }, issues);
  if (chunk === undefined) return issues.issues;
  const before = issues.count;
  checkBeings(chunk.value("beings"), readChunkKey(key).coord, issues);
  // The earliest wake means something only when every being, and the list itself, is valid.
  const beingsValid = issues.count === before && Array.isArray(chunk.value("beings"));
  checkDepletion(chunk.value("depletion"), issues);
  const due = readInt(chunk.value("due"), "/due", TICKS, issues);
  if (beingsValid && due !== undefined) {
    // checkBeings reported nothing, so every entry is a valid Being.
    checkDue(due, chunk.value("beings") as readonly Being[], issues);
  }
  return issues.issues;
}
