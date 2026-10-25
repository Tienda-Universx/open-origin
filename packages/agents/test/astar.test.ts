import { describe, expect, test } from "bun:test";
import { aStar, dijkstra, octileMs } from "../src/index.ts";
import {
  cellAt,
  gridOf,
  neighborOf,
  ringGrid,
  uniformGrid,
  walk,
  wallGrid,
} from "./support/grids.ts";

const BOUNDS = { straight: 10, diagonal: 14 };

describe("aStar", () => {
  test("a window of one cell, and any start that is its goal, give an empty route", () => {
    expect(aStar(uniformGrid(1, 10, 14), 0, 0, BOUNDS)).toEqual({
      durationMs: 0,
      path: "",
      expanded: 1,
    });
    expect(aStar(uniformGrid(9, 10, 14), 40, 40, BOUNDS)).toEqual({
      durationMs: 0,
      path: "",
      expanded: 1,
    });
  });

  test("finds the octile route of an open window, expanding only the cells along it", () => {
    const grid = uniformGrid(9, 10, 14);
    const route = aStar(grid, cellAt(9, 0, 0), cellAt(9, 8, 3), BOUNDS);
    expect(route).toEqual({ durationMs: 3 * 14 + 5 * 10, path: "11100000", expanded: 9 });
  });

  test("returns undefined when the goal cannot be reached", () => {
    expect(
      aStar(
        gridOf(3, () => -1),
        4,
        0,
        BOUNDS,
      ),
    ).toBeUndefined();
    // Every edge but those into cell 8 is open: 8 is closed off, the rest is not.
    const islands = gridOf(3, (cell, direction) =>
      neighborOf(3, cell, direction) === 8 ? -1 : 10,
    );
    expect(aStar(islands, 0, 8, { straight: 10, diagonal: 10 })).toBeUndefined();
    expect(aStar(islands, 8, 0, { straight: 10, diagonal: 10 })?.durationMs).toBe(20);
  });

  test("goes around a wall through its gap, as Dijkstra does, and not through a sealed one", () => {
    const wall = wallGrid(cellAt(5, 2, 4));
    const start = cellAt(5, 0, 0);
    const goal = cellAt(5, 4, 0);
    const route = aStar(wall, start, goal, BOUNDS);
    expect(route?.durationMs).toBe(dijkstra(wall, start).durationMs[goal]);
    expect(walk(wall, start, route?.path ?? "?")).toEqual({ end: goal, durationMs: 96 });
    expect(aStar(wallGrid(-1), start, goal, BOUNDS)).toBeUndefined();
  });

  test("ignores every edge that leaves the window, whatever its entry", () => {
    const grid = gridOf(4, (cell, direction) => (neighborOf(4, cell, direction) < 0 ? 1 : 1000));
    const bounds = { straight: 1, diagonal: 1 };
    expect(aStar(grid, cellAt(4, 0, 3), cellAt(4, 3, 0), bounds)).toMatchObject({
      durationMs: 3000,
      path: "777",
    });
    // Along the north edge, where every edge northward leaves the window and claims 1 ms.
    const route = aStar(grid, cellAt(4, 3, 3), cellAt(4, 0, 3), bounds);
    expect(route?.durationMs).toBe(3000);
    expect(walk(grid, cellAt(4, 3, 3), route?.path ?? "?")).toEqual({
      end: cellAt(4, 0, 3),
      durationMs: 3000,
    });
  });

  test("walks along each edge of the window, corner to corner", () => {
    const side = 5;
    const ring = ringGrid(side);
    const corner = (column: number, row: number) => cellAt(side, column, row);
    const route = (from: number, to: number) => aStar(ring, from, to, BOUNDS)?.path;
    expect(route(corner(0, 0), corner(4, 0))).toBe("0000");
    expect(route(corner(4, 0), corner(4, 4))).toBe("2222");
    expect(route(corner(4, 4), corner(0, 4))).toBe("4444");
    expect(route(corner(0, 4), corner(0, 0))).toBe("6666");
    expect(aStar(ring, corner(0, 0), corner(2, 2), BOUNDS)).toBeUndefined();
  });

  test("breaks ties by f, then by the smaller h, then by cell index: a pinned route", () => {
    // A diagonal lasts as long as two straight steps, so every cell of a monotone walk to the
    // goal has the same f; the smaller h leads straight to the goal.
    const grid = uniformGrid(4, 10, 20);
    const bounds = { straight: 10, diagonal: 20 };
    expect(aStar(grid, 0, 15, bounds)).toEqual({ durationMs: 60, path: "111", expanded: 4 });
    // From (1, 1), (2, 1) has the smallest h of the f = 40 cells: NE, then E twice.
    expect(aStar(grid, 0, cellAt(4, 3, 1), bounds)).toEqual({
      durationMs: 40,
      path: "100",
      expanded: 4,
    });
  });

  test("returns the same route on every run", () => {
    const grid = uniformGrid(17, 10, 20);
    const bounds = { straight: 10, diagonal: 20 };
    const first = aStar(grid, 0, 17 * 17 - 1, bounds);
    for (let run = 0; run < 3; run += 1) expect(aStar(grid, 0, 17 * 17 - 1, bounds)).toEqual(first);
  });
});

describe("octileMs", () => {
  test("is straight·(dmax − dmin) + diagonal·dmin, for offsets in any direction", () => {
    expect(octileMs(BOUNDS, 0, 0)).toBe(0);
    expect(octileMs(BOUNDS, 5, 2)).toBe(3 * 10 + 2 * 14);
    expect(octileMs(BOUNDS, -2, 5)).toBe(3 * 10 + 2 * 14);
    expect(octileMs(BOUNDS, -64, -64)).toBe(64 * 14);
    expect(octileMs({ straight: 2 ** 31 - 1, diagonal: 2 ** 32 - 2 }, 64, -63)).toBe(
      2 ** 31 - 1 + 63 * (2 ** 32 - 2),
    );
  });
});
