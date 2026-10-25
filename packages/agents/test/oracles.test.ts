import { describe, expect, test } from "bun:test";
import {
  aStar,
  dijkstra,
  octileMs,
  pathTo,
  type ShortestPaths,
  type StepBounds,
  type WindowGrid,
} from "../src/index.ts";
import {
  neighborOf,
  randomBounds,
  randomCase,
  randomGrid,
  Sfc32,
  VECTORS,
  walk,
} from "./support/grids.ts";
import { bfsDurations, bruteForceDuration, quadraticDijkstra } from "./support/oracles.ts";

/**
 * Plan §9.2, test 4: Dijkstra and A* against oracles that share no code with them, on windows
 * drawn by a seeded generator independent of the engine's randomness. Each test gathers every
 * disagreement and checks that it found none, and that its cases were not vacuous.
 */

/** The offset (dx, dy) from cell `from` to cell `to` of a window of `side`. */
function offset(side: number, from: number, to: number): [number, number] {
  const fromColumn = from % side;
  const toColumn = to % side;
  return [toColumn - fromColumn, (to - toColumn) / side - (from - fromColumn) / side];
}

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

/** The start of a search, the oracle's durations from it, and the goals A* is asked for. */
type Case = { start: number; expected: readonly number[]; goals: readonly number[] };

/** Every disagreement of Dijkstra, pathTo, and A* with the oracle's durations from `start`. */
function searchProblems(grid: WindowGrid, { start, expected, goals }: Case, bounds: StepBounds) {
  const paths = dijkstra(grid, start);
  const reachable = expected.filter((duration) => duration >= 0).length;
  const problems =
    paths.expanded === reachable ? [] : [`expanded ${paths.expanded} of ${reachable}`];
  expected.forEach((duration, goal) => {
    const problem = routeProblem(grid, dijkstraClaim(paths, goal), duration);
    if (problem !== undefined) problems.push(`dijkstra ${problem}`);
    // The heuristic never overestimates: h(start → goal) ≤ the oracle's duration.
    const h = octileMs(bounds, ...offset(grid.side, start, goal));
    if (duration >= 0 && h > duration) problems.push(`h(${start} → ${goal}) = ${h} > ${duration}`);
  });
  for (const goal of goals) {
    const route = aStar(grid, start, goal, bounds);
    const problem = routeProblem(grid, { start, goal, ...route }, expected[goal] ?? -1);
    if (problem !== undefined) problems.push(`aStar ${problem}`);
    if (route !== undefined && route.expanded > reachable) {
      problems.push(`aStar expanded ${route.expanded} of ${reachable} reachable cells`);
    }
  }
  return problems;
}

/**
 * Where the octile heuristic toward `goal` is not consistent: a step u → v of duration c with
 * h(u) > c + h(v), or h(goal) ≠ 0.
 */
function inconsistencies(grid: WindowGrid, goal: number, bounds: StepBounds): string[] {
  const h = (cell: number) => octileMs(bounds, ...offset(grid.side, cell, goal));
  const problems = h(goal) === 0 ? [] : [`h(goal ${goal}) is ${h(goal)}`];
  for (let cell = 0; cell < grid.side * grid.side; cell += 1) {
    VECTORS.forEach((_vector, direction) => {
      const to = neighborOf(grid.side, cell, direction);
      const edge = grid.edgeMs[cell * 8 + direction] ?? -1;
      if (to >= 0 && edge >= 0 && h(cell) > edge + h(to)) {
        problems.push(`goal ${goal}: h(${cell}) > ${edge} + h(${to})`);
      }
    });
  }
  return problems;
}

describe("Dijkstra and A* against independent oracles", () => {
  test("1,000 random windows: durations, paths, reachability, and the heuristic agree", () => {
    const rng = new Sfc32(0x7404_0001);
    const problems: string[] = [];
    const seen = { cells: 0, unreachable: 0, sides: new Set<number>() };
    for (let index = 0; index < 1000; index += 1) {
      const { grid, side, straight, diagonal } = randomCase(rng, 17);
      const bounds = { straight, diagonal };
      const cells = side * side;
      seen.sides.add(side);
      for (const start of [rng.below(cells), rng.below(cells)]) {
        const goals = [rng.below(cells), rng.below(cells), rng.below(cells), start];
        const expected = quadraticDijkstra(grid, start);
        const found = searchProblems(grid, { start, expected, goals }, bounds);
        problems.push(...found.map((problem) => `grid ${index}, start ${start}: ${problem}`));
        seen.cells += expected.length;
        seen.unreachable += expected.filter((duration) => duration < 0).length;
      }
      const goal = rng.below(cells);
      problems.push(...inconsistencies(grid, goal, bounds).map((p) => `grid ${index}: ${p}`));
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
      const goals = [rng.below(side * side), rng.below(side * side)];
      const bounds = { straight: duration, diagonal: duration };
      const found = searchProblems(grid, { start, expected, goals }, bounds);
      problems.push(...found.map((problem) => `${index}: ${problem}`));
    }
    expect(problems.slice(0, 20)).toEqual([]);
  });

  test("4 × 4 windows: the shortest of every simple walk, for 40 start and goal pairs", () => {
    const rng = new Sfc32(0x7404_0003);
    const problems: string[] = [];
    let reachable = 0;
    for (let index = 0; index < 40; index += 1) {
      const bounds = randomBounds(rng);
      const grid = randomGrid(rng, { side: 4, ...bounds });
      const start = rng.below(16);
      const goal = (start + 1 + rng.below(15)) % 16;
      const expected = bruteForceDuration(grid, start, goal);
      if (expected >= 0) reachable += 1;
      // The O(V²) oracle must agree with exhaustive enumeration, or one of the oracles is wrong.
      if (quadraticDijkstra(grid, start)[goal] !== expected) problems.push(`oracles ${index}`);
      const route = aStar(grid, start, goal, bounds);
      const claims = [
        ["aStar", { start, goal, ...route }],
        ["dijkstra", dijkstraClaim(dijkstra(grid, start), goal)],
      ] as const;
      for (const [name, claim] of claims) {
        const problem = routeProblem(grid, claim, expected);
        if (problem !== undefined) problems.push(`${index} ${name}: ${problem}`);
      }
    }
    expect(problems).toEqual([]);
    expect(reachable).toBeGreaterThan(20);
  });
});
