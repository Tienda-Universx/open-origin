import { describe, expect, test } from "bun:test";
import { aStar, dijkstra, octileMs, pathTo, type WindowGrid } from "../src/index.ts";
import { engineErrorOf } from "./support/engine-error.ts";
import { uniformGrid } from "./support/grids.ts";

/**
 * Navigation validates its inputs at the boundary and reports every problem it finds, each at its
 * JSON Pointer path under the argument's name, in one EngineError("invalid_value").
 */

const BOUNDS = { straight: 10, diagonal: 14 };
const GRID = uniformGrid(2, 10, 14);

/** The issues of the EngineError that `action` throws, after checking its code. */
function issuesOf(action: () => unknown): { path: string; message: string }[] {
  const error = engineErrorOf(action);
  expect(error.code).toBe("invalid_value");
  expect(error.issueCount).toBe(error.issues.length);
  return error.issues.map(({ path, message }) => ({ path, message }));
}

/** A value of any type, passed where the types forbid it, as a host might. */
const anyGrid = (value: unknown) => value as WindowGrid;

describe("the window grid", () => {
  test.each([
    ["null", null],
    ["a number", 7],
    ["a string", "grid"],
  ])("must be a record, not %s", (_name, value) => {
    expect(issuesOf(() => dijkstra(anyGrid(value), 0))).toEqual([
      { path: "/grid", message: "the grid must be a record { side, edgeMs }" },
    ]);
  });

  test.each([
    [0, "0 is out of bounds: it must be from 1 to 65"],
    [66, "66 is out of bounds: it must be from 1 to 65"],
    [-1, "-1 is out of bounds: it must be from 1 to 65"],
    [1.5, "1.5 is not a safe integer"],
    [Number.NaN, "NaN is not a safe integer"],
    [2 ** 53, "9007199254740992 is not a safe integer"],
    ["3", "a value of type string is not a safe integer"],
    [undefined, "a value of type undefined is not a safe integer"],
  ])("rejects the side %p", (side, message) => {
    // Without a valid side, neither the length of the edges nor the start can be checked.
    const grid = anyGrid({ side, edgeMs: new Int32Array(8) });
    expect(issuesOf(() => dijkstra(grid, 0))).toEqual([{ path: "/grid/side", message }]);
  });

  test("accepts the sides 1 and 65, the bounds of a window", () => {
    expect(dijkstra(uniformGrid(1, 5), 0).expanded).toBe(1);
    expect(dijkstra(uniformGrid(65, 5), 0).expanded).toBe(65 * 65);
  });

  test.each([
    ["an array", [10, 10, 10, 10, 10, 10, 10, 10]],
    ["a Uint32Array", new Uint32Array(8)],
    ["a Float64Array", new Float64Array(8)],
    ["missing", undefined],
  ])("rejects edges that are %s, not an Int32Array", (_name, edgeMs) => {
    expect(issuesOf(() => dijkstra(anyGrid({ side: 1, edgeMs }), 0))).toEqual([
      { path: "/grid/edgeMs", message: "the edges must be an Int32Array" },
    ]);
  });

  test.each([
    [7, "it has 7 entries: a window of side 1 has 8"],
    [9, "it has 9 entries: a window of side 1 has 8"],
    [0, "it has 0 entries: a window of side 1 has 8"],
  ])("rejects %p edges for a window of side 1", (length, message) => {
    const grid = { side: 1, edgeMs: new Int32Array(length).fill(10) };
    expect(issuesOf(() => dijkstra(grid, 0))).toEqual([{ path: "/grid/edgeMs", message }]);
  });

  test("reports every entry that is neither -1 nor a positive duration, at its index", () => {
    const edgeMs = new Int32Array(2 * 2 * 8).fill(10);
    edgeMs[0] = 0;
    edgeMs[9] = -2;
    edgeMs[31] = -2_147_483_648;
    edgeMs[17] = -1;
    edgeMs[18] = 2_147_483_647;
    const message = (value: number) =>
      `${value} is not a duration: an edge lasts a positive number of milliseconds, or is -1 when impassable`;
    expect(issuesOf(() => dijkstra({ side: 2, edgeMs }, 0))).toEqual([
      { path: "/grid/edgeMs/0", message: message(0) },
      { path: "/grid/edgeMs/9", message: message(-2) },
      { path: "/grid/edgeMs/31", message: message(-2_147_483_648) },
    ]);
  });

  test("counts every bad entry, beyond the issues an EngineError keeps", () => {
    const error = engineErrorOf(() => dijkstra({ side: 3, edgeMs: new Int32Array(72) }, 0));
    expect(error.issueCount).toBe(72);
    expect(error.issues).toHaveLength(50);
  });
});

describe("cell indices", () => {
  test.each([
    [-1, "-1 is out of bounds: it must be from 0 to 3"],
    [4, "4 is out of bounds: it must be from 0 to 3"],
    [0.5, "0.5 is not a safe integer"],
    ["0", "a value of type string is not a safe integer"],
  ])("rejects the start %p of a window of side 2", (start, message) => {
    expect(issuesOf(() => dijkstra(GRID, start as number))).toEqual([{ path: "/start", message }]);
  });

  test("rejects the goal of A* as it rejects the start", () => {
    expect(issuesOf(() => aStar(GRID, 4, -1, BOUNDS))).toEqual([
      { path: "/start", message: "4 is out of bounds: it must be from 0 to 3" },
      { path: "/goal", message: "-1 is out of bounds: it must be from 0 to 3" },
    ]);
  });

  test("checks a start beside an invalid grid as far as it can", () => {
    const grid = anyGrid({ side: "two", edgeMs: [] });
    expect(issuesOf(() => dijkstra(grid, Number.POSITIVE_INFINITY))).toEqual([
      { path: "/grid/side", message: "a value of type string is not a safe integer" },
      { path: "/grid/edgeMs", message: "the edges must be an Int32Array" },
      { path: "/start", message: "Infinity is not a safe integer" },
    ]);
  });

  test("rejects the target of pathTo", () => {
    const paths = dijkstra(GRID, 0);
    expect(issuesOf(() => pathTo(paths, 4))).toEqual([
      { path: "/target", message: "4 is out of bounds: it must be from 0 to 3" },
    ]);
    expect(issuesOf(() => pathTo(paths, Number.NaN))).toEqual([
      { path: "/target", message: "NaN is not a safe integer" },
    ]);
  });

  // The arrays of a result are typed arrays, which cannot be frozen, so a caller can change them.
  test.each([
    // Cell 3 is entered northward from cell 1, and cell 1 southward from cell 3: a cycle.
    ["a cycle", [6, 2]],
    // Cell 1 is entered westward, from a cell east of it, outside the window.
    ["a step from outside the window", [4, 2]],
    // Cell 1 has no arrival direction, though it is not the start.
    ["a cell without one", [-1, 2]],
  ])("refuses arrival directions that do not lead back to the start: %s", (_name, [one, three]) => {
    const paths = dijkstra(uniformGrid(2, 10), 0);
    paths.arrival[1] = one ?? 0;
    paths.arrival[3] = three ?? 0;
    expect(issuesOf(() => pathTo(paths, 3))).toEqual([
      { path: "/paths/arrival", message: "the arrival directions do not lead back to the start" },
    ]);
  });
});

describe("the step bounds of A*", () => {
  const STRAIGHT = "/bounds/straight";
  const DIAGONAL = "/bounds/diagonal";

  test.each([
    [{ straight: 10, diagonal: 21 }, DIAGONAL, "21 is out of bounds: it must be from 10 to 20"],
    [{ straight: 10, diagonal: 9 }, DIAGONAL, "9 is out of bounds: it must be from 10 to 20"],
    [{ straight: 0, diagonal: 0 }, STRAIGHT, "0 is out of bounds: it must be from 1 to 2147483647"],
    [
      { straight: -3, diagonal: 4 },
      STRAIGHT,
      "-3 is out of bounds: it must be from 1 to 2147483647",
    ],
    [
      { straight: 2 ** 31, diagonal: 2 ** 31 },
      STRAIGHT,
      "2147483648 is out of bounds: it must be from 1 to 2147483647",
    ],
    [{ straight: 2 ** 53, diagonal: 14 }, STRAIGHT, "9007199254740992 is not a safe integer"],
    [{ straight: 10, diagonal: 2 ** 53 + 2 }, DIAGONAL, "9007199254740994 is not a safe integer"],
    [{ straight: 1.5, diagonal: 2 }, STRAIGHT, "1.5 is not a safe integer"],
    [{ straight: 10, diagonal: "14" }, DIAGONAL, "a value of type string is not a safe integer"],
  ])("rejects %p", (bounds, path, message) => {
    // A bound outside its range leaves the other unchecked against it, so one issue each time.
    const grid = uniformGrid(2, 2 ** 31 - 1);
    expect(issuesOf(() => aStar(grid, 0, 3, bounds as typeof BOUNDS))).toEqual([{ path, message }]);
  });

  test("accepts diagonal bounds equal to straight and to twice straight", () => {
    expect(aStar(uniformGrid(2, 10), 0, 3, { straight: 10, diagonal: 10 })?.durationMs).toBe(10);
    expect(aStar(uniformGrid(2, 10, 20), 0, 3, { straight: 10, diagonal: 20 })?.durationMs).toBe(
      20,
    );
  });

  test("must be a record", () => {
    expect(issuesOf(() => aStar(GRID, 0, 3, null as unknown as typeof BOUNDS))).toEqual([
      { path: "/bounds", message: "the bounds must be a record { straight, diagonal }" },
    ]);
  });

  test("reports every edge shorter than its bound, which would make the heuristic overestimate", () => {
    const grid = uniformGrid(2, 10, 14);
    grid.edgeMs[0] = 9;
    grid.edgeMs[8 * 3 + 5] = 13;
    expect(issuesOf(() => aStar(grid, 0, 3, BOUNDS))).toEqual([
      {
        path: "/grid/edgeMs/0",
        message:
          "9 is shorter than the bound of a straight step, 10: the heuristic would overestimate",
      },
      {
        path: "/grid/edgeMs/29",
        message:
          "13 is shorter than the bound of a diagonal step, 14: the heuristic would overestimate",
      },
    ]);
  });

  test("reports problems of every argument together", () => {
    const grid = anyGrid({ side: 2, edgeMs: new Int32Array(31) });
    expect(issuesOf(() => aStar(grid, 7, 0.5, { straight: 5, diagonal: 11 }))).toEqual([
      { path: "/grid/edgeMs", message: "it has 31 entries: a window of side 2 has 32" },
      { path: "/start", message: "7 is out of bounds: it must be from 0 to 3" },
      { path: "/goal", message: "0.5 is not a safe integer" },
      { path: "/bounds/diagonal", message: "11 is out of bounds: it must be from 5 to 10" },
    ]);
  });
});

describe("octileMs", () => {
  test("validates its bounds and its offset, which must lie inside a window", () => {
    expect(issuesOf(() => octileMs({ straight: 4, diagonal: 9 }, 65, -65))).toEqual([
      { path: "/bounds/diagonal", message: "9 is out of bounds: it must be from 4 to 8" },
      { path: "/dx", message: "65 is out of bounds: it must be from -64 to 64" },
      { path: "/dy", message: "-65 is out of bounds: it must be from -64 to 64" },
    ]);
    expect(issuesOf(() => octileMs(BOUNDS, 0.5, Number.NaN))).toEqual([
      { path: "/dx", message: "0.5 is not a safe integer" },
      { path: "/dy", message: "NaN is not a safe integer" },
    ]);
  });
});
