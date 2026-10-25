/**
 * The occupancy index of the global value (ADR 0023): the chunks that may hold beings, in the
 * kernel's order of chunk keys, UTF-16 code units (canonical/order.ts). A chunk enters when it
 * receives a being and leaves at the daily prune once it holds none, so the global value is written
 * rarely. The index is world data only: nothing viewed, cached, or projected changes it.
 */
import { compareCodeUnits } from "../canonical/order.ts";
import { type Issue, IssueList } from "../errors.ts";
import type { ChunkKey } from "../world/chunk.ts";
import { chunkKeyIssues } from "../worldgen/index.ts";
import { range, readList } from "./schema.ts";

/** At most 2^24 chunks, far beyond what a world of v0.1 occupies. */
export const OCCUPANCY_BOUNDS = range(0, 0x100_0000);

/**
 * Every problem of `value` as an occupancy index, at paths from `path`. `value` is canonical, as a
 * validator's value is; it never throws for a canonical value.
 */
export function occupancyIssues(value: unknown, path: string): Issue[] {
  const issues = new IssueList();
  if (value === undefined) {
    issues.report(path, "the occupancy index is missing");
    return issues.issues;
  }
  const keys = readList(value, path, OCCUPANCY_BOUNDS, issues);
  let previous: string | undefined;
  keys?.forEach((key, index) => {
    const at = `${path}/${index}`;
    const problems = chunkKeyIssues(key);
    for (const problem of problems) issues.report(`${at}${problem.path}`, problem.message);
    if (problems.length > 0 || typeof key !== "string") return;
    if (previous !== undefined && compareCodeUnits(key, previous) <= 0) {
      issues.report(
        at,
        `keys rise strictly in UTF-16 order: "${key}" must come after "${previous}"`,
      );
    }
    previous = key;
  });
  return issues.issues;
}

/** Inserts `key` into the ordered `keys` in place; false when it was already there. */
export function insertOccupied(keys: ChunkKey[], key: ChunkKey): boolean {
  let low = 0;
  let high = keys.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const order = compareCodeUnits(keys[middle] ?? "", key);
    if (order === 0) return false;
    if (order < 0) low = middle + 1;
    else high = middle;
  }
  keys.splice(low, 0, key);
  return true;
}

/** The keys of `keys` whose chunk is not `empty`, in the same order: a new array. */
export function pruneOccupancy(
  keys: readonly ChunkKey[],
  empty: (key: ChunkKey) => boolean,
): ChunkKey[] {
  return keys.filter((key) => !empty(key));
}
