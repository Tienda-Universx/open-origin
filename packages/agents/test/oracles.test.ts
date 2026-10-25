import { describe, expect, test } from "bun:test";
import { dijkstra, pathTo, type ShortestPaths, type WindowGrid } from "../src/index.ts";
import { randomBounds, randomCase, randomGrid, Sfc32, walk } from "./support/grids.ts";
import { bfsDurations, bruteForceDuration, quadraticDijkstra } from "./support/oracles.ts";

/**
 * Plan §9.2, test 4: Dijkstra against oracles that share no code with it, on windows drawn by a
 * seeded generator independent of the engine's randomness. Each test gathers every disagreement
 * and checks that it found none, and that its cases were not vacuous.
 */

/** A route as a search reports it: undefined members when it found none. */
type Claim = { start: number; goal: number; path?: string | undefined; durationMs?: number };

/** What is wrong with `claim`, given the oracle's duration `expected` (−1 when unreachable). */
function routeProblem(grid: WindowGrid, claim: Claim, expected: number): string | undefined {
  const { start, goal, path, durationMs } = claim;
  if (expected < 0) {
    return path === undefined && durationMs === undefined ? undefined : `${goal} is unreachable`;
  }
  if (path === undefined || durationMs !== expected) {
    return `goal ${goal}: ${durationMs} ms, the oracle says ${expected} ms`;
  }
  const walked = walk(grid, start, path);
  if (typeof walked === "string") return `goal ${goal}: path ${path}: ${walked}`;
  if (walked.end !== goal || walked.durationMs !== expected) {
    return `goal ${goal}: path ${path} ends at ${walked.end} after ${walked.durationMs} ms`;
  }
  return undefined;
}

/** Dijkstra's result for `goal` as a claim: −1 marks an unreachable cell, which has no path. */
function dijkstraClaim(paths: ShortestPaths, goal: number): Claim {
  const claim = { start: paths.start, goal, path: pathTo(paths, goal) };
  const reached = paths.durationMs[goal] ?? -1;
  return reached === -1 ? claim : { ...claim, durationMs: reached };
}

/** Every disagreement of Dijkstra and pathTo with the oracle's durations `expected` from `start`. */
function searchProblems(grid: WindowGrid, start: number, expected: readonly number[]): string[] {
  const paths = dijkstra(grid, start);
  const reachable = expected.filter((duration) => duration >= 0).length;
  const problems =
    paths.expanded === reachable ? [] : [`expanded ${paths.expanded} of ${reachable}`];
  expected.forEach((duration, goal) => {
    const problem = routeProblem(grid, dijkstraClaim(paths, goal), duration);
    if (problem !== undefined) problems.push(`dijkstra ${problem}`);
  });
  return problems;
}

describe("Dijkstra against independent oracles", () => {
  test("1,000 random windows: durations, paths, and reachability agree", () => {
    const rng = new Sfc32(0x7404_0001);
    const problems: string[] = [];
    const seen = { cells: 0, unreachable: 0, sides: new Set<number>() };
    for (let index = 0; index < 1000; index += 1) {
      const { grid, side } = randomCase(rng, 17);
      const cells = side * side;
      seen.sides.add(side);
      for (const start of [rng.below(cells), rng.below(cells)]) {
        const expected = quadraticDijkstra(grid, start);
        const found = searchProblems(grid, start, expected);
        problems.push(...found.map((problem) => `grid ${index}, start ${start}: ${problem}`));
        seen.cells += expected.length;
        seen.unreachable += expected.filter((duration) => duration < 0).length;
      }
    }
    expect(problems.slice(0, 20)).toEqual([]);
    // Not vacuous: every side from 1 to 17, and both reachable and unreachable cells in quantity.
    expect(seen.sides.size).toBe(17);
    expect(seen.unreachable).toBeGreaterThan(seen.cells / 20);
    expect(seen.cells - seen.unreachable).toBeGreaterThan(seen.cells / 3);
  });

  test("windows where every step lasts the same: they agree with breadth-first search", () => {
    const rng = new Sfc32(0x7404_0002);
    const problems: string[] = [];
    for (let index = 0; index < 200; index += 1) {
      const side = rng.between(1, 17);
      const duration = rng.between(1, 2000);
      const shape = randomGrid(rng, { side, straight: 1, diagonal: 1 });
      // The same passable edges, each lasting `duration`.
      const grid = { side, edgeMs: shape.edgeMs.map((edge) => (edge < 0 ? -1 : duration)) };
      const start = rng.below(side * side);
      const expected = bfsDurations(grid, start, duration);
      // The O(V²) oracle must agree with breadth-first search, or one of the oracles is wrong.
      const oraclesAgree = quadraticDijkstra(grid, start).join() === expected.join();
      if (!oraclesAgree) problems.push(`oracles ${index}`);
      const found = searchProblems(grid, start, expected);
      problems.push(...found.map((problem) => `${index}: ${problem}`));
    }
    expect(problems.slice(0, 20)).toEqual([]);
  });

  test("4 × 4 windows: the shortest of every simple walk, for 40 start and goal pairs", () => {
    const rng = new Sfc32(0x7404_0003);
    const problems: string[] = [];
    let reachable = 0;
    for (let index = 0; index < 40; index += 1) {
      const grid = randomGrid(rng, { side: 4, ...randomBounds(rng) });
      const start = rng.below(16);
      const goal = (start + 1 + rng.below(15)) % 16;
      const expected = bruteForceDuration(grid, start, goal);
      if (expected >= 0) reachable += 1;
      // The O(V²) oracle must agree with exhaustive enumeration, or one of the oracles is wrong.
      if (quadraticDijkstra(grid, start)[goal] !== expected) problems.push(`oracles ${index}`);
      const problem = routeProblem(grid, dijkstraClaim(dijkstra(grid, start), goal), expected);
      if (problem !== undefined) problems.push(`${index} dijkstra: ${problem}`);
    }
    expect(problems).toEqual([]);
    expect(reachable).toBeGreaterThan(20);
  });
});
