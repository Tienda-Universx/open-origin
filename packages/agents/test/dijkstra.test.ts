import { describe, expect, test } from "bun:test";
import { aStar, dijkstra, pathTo } from "../src/index.ts";
import {
  cellAt,
  gridOf,
  neighborOf,
  ringGrid,
  uniformGrid,
  walk,
  wallGrid,
} from "./support/grids.ts";

/** Durations as a plain array, for readable comparisons. */
const durations = (side: number, start: number, grid = uniformGrid(side, 10, 14)) => [
  ...dijkstra(grid, start).durationMs,
];

describe("dijkstra", () => {
  test("a window of one cell reaches only its start, in no time and no steps", () => {
    const paths = dijkstra(uniformGrid(1, 10), 0);
    expect([...paths.durationMs]).toEqual([0]);
    expect([...paths.arrival]).toEqual([-1]);
    expect(paths).toMatchObject({ side: 1, start: 0, expanded: 1 });
    expect(pathTo(paths, 0)).toBe("");
  });

  test("gives the exact duration of every cell of an open window, and expands each once", () => {
    // Rows go north: row 0 is the southern edge. From the center, the octile distances.
    expect(durations(3, 4)).toEqual([14, 10, 14, 10, 0, 10, 14, 10, 14]);
    expect(durations(3, 0)).toEqual([0, 10, 20, 10, 14, 24, 20, 24, 28]);
    expect(dijkstra(uniformGrid(9, 10, 14), 40).expanded).toBe(81);
  });

  test("steps in the direction its digit names, with y growing northward", () => {
    const paths = dijkstra(uniformGrid(3, 10, 14), 4);
    // The eight neighbors of the center, in direction order E, NE, N, NW, W, SW, S, SE.
    const neighbors = [5, 8, 7, 6, 3, 0, 1, 2];
    expect(neighbors.map((cell) => pathTo(paths, cell))).toEqual([
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
    ]);
    expect(neighbors.map((cell) => paths.arrival[cell])).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  test("marks unreachable cells with -1 and gives them no path", () => {
    const paths = dijkstra(
      gridOf(3, () => -1),
      4,
    );
    expect([...paths.durationMs]).toEqual([-1, -1, -1, -1, 0, -1, -1, -1, -1]);
    expect([...paths.arrival]).toEqual([-1, -1, -1, -1, -1, -1, -1, -1, -1]);
    expect(paths.expanded).toBe(1);
    expect(pathTo(paths, 0)).toBeUndefined();
    expect(pathTo(paths, 4)).toBe("");
  });

  test("does not reach a cell behind a wall, and goes around a wall with a gap", () => {
    // Column 2 is a wall: without a gap, the east half is cut off.
    const sealed = dijkstra(wallGrid(-1), cellAt(5, 0, 2));
    expect(pathTo(sealed, cellAt(5, 4, 2))).toBeUndefined();
    expect(sealed.expanded).toBe(10);
    const gapped = wallGrid(cellAt(5, 2, 4));
    const open = dijkstra(gapped, cellAt(5, 0, 0));
    const target = cellAt(5, 4, 0);
    // Through the gap at the north end of the wall: 2 diagonal and 2 straight steps up to it, the
    // same down again.
    expect(open.durationMs[target]).toBe(2 * (2 * 14 + 2 * 10));
    expect(walk(gapped, cellAt(5, 0, 0), pathTo(open, target) ?? "")).toEqual({
      end: target,
      durationMs: 96,
    });
  });

  test("ignores every edge that leaves the window, whatever its entry", () => {
    // Edges inside the window last 1000; edges that leave it claim 1, and are never taken.
    const grid = gridOf(4, (cell, direction) => (neighborOf(4, cell, direction) < 0 ? 1 : 1000));
    const paths = dijkstra(grid, 0);
    expect(paths.durationMs[15]).toBe(3000);
    expect(paths.expanded).toBe(16);
    for (let cell = 0; cell < 16; cell += 1) {
      expect(walk(grid, 0, pathTo(paths, cell) ?? "?")).toEqual({
        end: cell,
        durationMs: paths.durationMs[cell] ?? -1,
      });
    }
  });

  test("walks along every edge of the window, where only its border is passable", () => {
    const side = 6;
    const ring = ringGrid(side);
    const southWest = cellAt(side, 0, 0);
    const paths = dijkstra(ring, southWest);
    // Each corner, the long way included: east along the south edge, then north along the east one.
    expect(pathTo(paths, cellAt(side, 5, 0))).toBe("00000");
    expect(pathTo(paths, cellAt(side, 0, 5))).toBe("22222");
    expect(paths.durationMs[cellAt(side, 5, 5)]).toBe(100);
    expect(paths.durationMs[cellAt(side, 2, 2)]).toBe(-1);
    // From the north-east corner, west along the north edge and south along the west one.
    const back = dijkstra(ring, cellAt(side, 5, 5));
    expect(pathTo(back, cellAt(side, 0, 5))).toBe("44444");
    expect(pathTo(back, cellAt(side, 5, 0))).toBe("66666");
    expect(back.expanded).toBe(20);
  });

  test("breaks a tie between equal durations by the lower cell index", () => {
    // A 2 × 2 window with only east and north steps of 10 ms: cells 1 (east) and 2 (north) both
    // reach cell 3 in 20 ms. Cell 1 has the lower index, so it is expanded first and its walk, east
    // then north, is the one cell 3 keeps.
    const edgeMs = new Int32Array(32).fill(-1);
    for (const entry of [0 * 8 + 0, 0 * 8 + 2, 1 * 8 + 2, 2 * 8 + 0]) edgeMs[entry] = 10;
    const grid = { side: 2, edgeMs };
    expect(pathTo(dijkstra(grid, 0), 3)).toBe("02");
    expect(aStar(grid, 0, 3, { straight: 10, diagonal: 10 })?.path).toBe("02");
  });

  test("breaks ties by duration, then by cell index: a pinned path among equal ones", () => {
    // A diagonal lasts as long as two straight steps, so many walks to each cell tie. A cell
    // keeps the first walk that reached it with its shortest duration; cells are expanded in
    // order of (duration, index), and each one's edges in direction order.
    const grid = uniformGrid(4, 10, 20);
    const paths = dijkstra(grid, 0);
    expect(paths.durationMs[15]).toBe(60);
    expect(pathTo(paths, 15)).toBe("111");
    expect(pathTo(paths, cellAt(4, 3, 1))).toBe("001");
    expect(pathTo(paths, cellAt(4, 1, 3))).toBe("221");
    // Every cell's path is one of its shortest walks.
    for (let cell = 0; cell < 16; cell += 1) {
      expect(walk(grid, 0, pathTo(paths, cell) ?? "?")).toEqual({
        end: cell,
        durationMs: paths.durationMs[cell] ?? -1,
      });
    }
  });

  test("sums durations exactly beyond the int32 range", () => {
    // 64 steps of 2^31 - 1 ms along one row of a 65-cell window: about 1.4·10^11 ms.
    const longest = 2 ** 31 - 1;
    const paths = dijkstra(uniformGrid(65, longest), 0);
    expect(paths.durationMs[64]).toBe(64 * longest);
    expect(paths.durationMs[65 * 65 - 1]).toBe(64 * longest);
  });

  test("returns fresh arrays: one result does not change another", () => {
    const grid = uniformGrid(3, 10, 14);
    const first = dijkstra(grid, 0);
    first.durationMs[8] = 1;
    expect(dijkstra(grid, 0).durationMs[8]).toBe(28);
  });
});
