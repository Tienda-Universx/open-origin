import { describe, expect, test } from "bun:test";
import { IssueList } from "../src/errors.ts";
import { worldgen } from "../src/index.ts";
import { readCell, readWorldChunkKey } from "../src/worldgen/space.ts";
import { revokedProxy } from "./support/revoked.ts";

/**
 * Space (ADR 0021, space): chunks of 32×32 cells indexed y·32 + x, cells in [−2^31, 2^31 − 1],
 * chunks in [−2^26, 2^26 − 1], and floor rounding toward negative infinity at negative cells.
 */

const {
  CHUNK_CELLS,
  MAX_CELL,
  MAX_CHUNK,
  MIN_CELL,
  MIN_CHUNK,
  WORLDGEN_VERSION,
  cellIndex,
  cellOffset,
  chunkFirstCell,
  chunkKeyIssues,
  chunkOfCell,
} = worldgen;

const FORM = 'the chunk key must be two integers joined by one comma, as in "-1,0"';
const notDecimal = (axis: "x" | "y") =>
  `the ${axis} of the chunk key is not a safe integer in canonical decimal`;
const chunkOutside = (axis: "x" | "y", value: number) =>
  `the ${axis} of the chunk key, ${value}, is outside the world: chunk coordinates lie from -67108864 to 67108863`;
const cellOutside = (value: number) =>
  `${value} is outside the world: cell coordinates lie from -2147483648 to 2147483647`;

test("WORLDGEN_VERSION is pinned to worldgen@1", () => {
  expect(WORLDGEN_VERSION).toBe("worldgen@1");
});

describe("space constants", () => {
  test("are 32 cells per chunk side and the bounds of ADR 0021", () => {
    expect(CHUNK_CELLS).toBe(32);
    expect([MIN_CELL, MAX_CELL]).toEqual([-(2 ** 31), 2 ** 31 - 1]);
    expect([MIN_CHUNK, MAX_CHUNK]).toEqual([-(2 ** 26), 2 ** 26 - 1]);
  });

  test("agree: the edge cells of the world lie in the edge chunks", () => {
    expect(chunkOfCell(MIN_CELL)).toBe(MIN_CHUNK);
    expect(chunkOfCell(MAX_CELL)).toBe(MAX_CHUNK);
  });
});

describe("cell and chunk helpers", () => {
  test.each<[string, number, number, number]>([
    ["0", 0, 0, 0],
    ["31", 31, 0, 31],
    ["32", 32, 1, 0],
    ["-1", -1, -1, 31],
    ["-32", -32, -1, 0],
    ["-33", -33, -2, 31],
    ["-2^31", MIN_CELL, MIN_CHUNK, 0],
    ["2^31 - 1", MAX_CELL, MAX_CHUNK, 31],
  ])("the cell %s lies where floor rounding puts it", (_, cell, chunk, offset) => {
    expect(chunkOfCell(cell)).toBe(chunk);
    expect(cellOffset(cell)).toBe(offset);
    expect(chunkFirstCell(chunk) + offset).toBe(cell);
  });

  test.each<[string, number, number, number]>([
    ["2^31", 2 ** 31, 2 ** 26, 0],
    ["-2^31 - 1", -(2 ** 31) - 1, -(2 ** 26) - 1, 31],
    ["2^40", 2 ** 40, 2 ** 35, 0],
    ["-2^40", -(2 ** 40), -(2 ** 35), 0],
    ["2^53 - 1", Number.MAX_SAFE_INTEGER, 2 ** 48 - 1, 31],
    ["-(2^53 - 1)", -Number.MAX_SAFE_INTEGER, -(2 ** 48), 1],
  ])("floor the safe integer %s beyond int32, where >> would wrap", (_, cell, chunk, offset) => {
    expect(chunkOfCell(cell)).toBe(chunk);
    expect(cellOffset(cell)).toBe(offset);
  });

  test("never return -0, which canonical values reject", () => {
    for (const cell of [0, -32, -64, MIN_CELL]) {
      expect(Object.is(cellOffset(cell), -0)).toBe(false);
    }
    for (const cell of [0, 1, 31]) expect(Object.is(chunkOfCell(cell), -0)).toBe(false);
    expect(Object.is(chunkFirstCell(0), -0)).toBe(false);
  });

  test.each<[number, number]>([
    [0, 0],
    [1, 32],
    [-1, -32],
    [MIN_CHUNK, MIN_CELL],
    [MAX_CHUNK, MAX_CELL - 31],
  ])("the first cell of the chunk %d is %d", (chunk, cell) => {
    expect(chunkFirstCell(chunk)).toBe(cell);
    expect(chunkOfCell(cell)).toBe(chunk);
    expect(cellOffset(cell)).toBe(0);
  });

  test("index the cells of a chunk row by row, y·32 + x, onto 0 to 1023 one to one", () => {
    expect(cellIndex(0, 0)).toBe(0);
    expect(cellIndex(31, 0)).toBe(31);
    expect(cellIndex(0, 1)).toBe(32);
    expect(cellIndex(5, 2)).toBe(69);
    expect(cellIndex(31, 31)).toBe(1023);
    const seen = new Set<number>();
    for (let y = 0; y < CHUNK_CELLS; y += 1) {
      for (let x = 0; x < CHUNK_CELLS; x += 1) seen.add(cellIndex(x, y));
    }
    expect(seen.size).toBe(1024);
    expect(Math.min(...seen)).toBe(0);
    expect(Math.max(...seen)).toBe(1023);
  });
});

describe("chunkKeyIssues", () => {
  test.each(["0,0", "-1,1", `${MIN_CHUNK},${MAX_CHUNK}`, `${MAX_CHUNK},${MIN_CHUNK}`])(
    "accepts %s, inside the world's chunks",
    (key) => {
      expect(chunkKeyIssues(key)).toEqual([]);
    },
  );

  test.each<[string, string, "x" | "y", number]>([
    ["one past the upper x", `${MAX_CHUNK + 1},0`, "x", MAX_CHUNK + 1],
    ["one past the lower x", `${MIN_CHUNK - 1},0`, "x", MIN_CHUNK - 1],
    ["one past the upper y", `0,${MAX_CHUNK + 1}`, "y", MAX_CHUNK + 1],
    ["one past the lower y", `0,${MIN_CHUNK - 1}`, "y", MIN_CHUNK - 1],
  ])("rejects a key %s, naming the bounds", (_, key, axis, value) => {
    expect(chunkKeyIssues(key)).toEqual([{ path: "", message: chunkOutside(axis, value) }]);
  });

  test("reports both coordinates when both lie outside", () => {
    const key = `${MAX_CHUNK + 1},${MIN_CHUNK - 1}`;
    expect(chunkKeyIssues(key)).toEqual([
      { path: "", message: chunkOutside("x", MAX_CHUNK + 1) },
      { path: "", message: chunkOutside("y", MIN_CHUNK - 1) },
    ]);
  });

  test("rejects a key far outside, at the safe integers", () => {
    const max = Number.MAX_SAFE_INTEGER;
    expect(chunkKeyIssues(`${max},0`)).toEqual([{ path: "", message: chunkOutside("x", max) }]);
  });

  test.each<[string, unknown, string[]]>([
    ["a number", 3, ["the chunk key must be a string, not number"]],
    ["a coordinate record", { x: 0, y: 0 }, ["the chunk key must be a string, not object"]],
    ["one part", "12", [FORM]],
    ["three parts", "1,2,3", [FORM]],
    ["a semicolon", "1;2", [FORM]],
    ["non-canonical parts", "01,-0", [notDecimal("x"), notDecimal("y")]],
    ["a part beyond the safe integers", "9007199254740992,0", [notDecimal("x")]],
    ["an empty part", ",5", [notDecimal("x")]],
  ])("rejects a malformed key: %s", (_, key, messages) => {
    expect(chunkKeyIssues(key)).toEqual(messages.map((message) => ({ path: "", message })));
  });
});

describe("readWorldChunkKey", () => {
  test("returns the coordinates of a key inside the world", () => {
    const issues = new IssueList();
    expect(readWorldChunkKey(`${MIN_CHUNK},7`, "/key", issues)).toEqual({ x: MIN_CHUNK, y: 7 });
    expect(issues.issues).toEqual([]);
  });

  test("reports every problem at its path and returns undefined", () => {
    const issues = new IssueList();
    expect(readWorldChunkKey(`${MAX_CHUNK + 1},x`, "/key", issues)).toBeUndefined();
    expect(issues.issues).toEqual([{ path: "/key", message: notDecimal("y") }]);
    expect(readWorldChunkKey(`0,${MAX_CHUNK + 1}`, "/key", issues)).toBeUndefined();
    expect(issues.issues.at(-1)).toEqual({
      path: "/key",
      message: chunkOutside("y", MAX_CHUNK + 1),
    });
  });
});

describe("readCell", () => {
  /** What readCell returns for `value` at "/cell", and the issues it reports. */
  function read(value: unknown) {
    const issues = new IssueList();
    const cell = readCell(value, "/cell", issues);
    return { cell, issues: issues.issues, cause: issues.toError("invalid_value").cause };
  }

  test("returns a fresh record of a cell at the edges of the world", () => {
    const value = { x: MIN_CELL, y: MAX_CELL };
    const { cell, issues } = read(value);
    expect(issues).toEqual([]);
    expect(cell).toEqual({ x: MIN_CELL, y: MAX_CELL });
    expect(cell).not.toBe(value);
    expect(Object.getPrototypeOf(cell)).toBe(Object.prototype);
  });

  test("reads only x and y, from any object that is not an array", () => {
    class Point {
      constructor(
        readonly x: number,
        readonly y: number,
      ) {}
    }
    expect(read(new Point(3, -4)).cell).toEqual({ x: 3, y: -4 });
    expect(read({ x: 1, y: 2, z: Number.NaN }).cell).toEqual({ x: 1, y: 2 });
  });

  test("rejects coordinates one past the bounds, every one, naming the bounds", () => {
    expect(read({ x: MAX_CELL + 1, y: MIN_CELL - 1 })).toEqual({
      cell: undefined,
      cause: undefined,
      issues: [
        { path: "/cell/x", message: cellOutside(MAX_CELL + 1) },
        { path: "/cell/y", message: cellOutside(MIN_CELL - 1) },
      ],
    });
  });

  test.each<[string, unknown, string]>([
    ["a fraction", 1.5, "1.5 is not a safe integer"],
    ["-0", -0, "-0 is not canonical: use 0"],
    ["NaN", Number.NaN, "NaN is not a safe integer"],
    ["2^53", 2 ** 53, "9007199254740992 is not a safe integer"],
    ["a string", "1", "a value of type string is not a safe integer"],
    ["missing", undefined, "a value of type undefined is not a safe integer"],
  ])("rejects a coordinate that is %s", (_, x, message) => {
    expect(read({ x, y: 0 }).issues).toEqual([{ path: "/cell/x", message }]);
  });

  test("reads an inherited coordinate as missing", () => {
    const cell = Object.create({ x: 1 }) as object;
    Object.defineProperty(cell, "y", { value: 2, enumerable: true });
    expect(read(cell).issues).toEqual([
      { path: "/cell/x", message: "a value of type undefined is not a safe integer" },
    ]);
  });

  test("rejects an accessor without running it, and a coordinate that is not enumerable", () => {
    let calls = 0;
    const cell = Object.defineProperty({}, "x", {
      get: () => {
        calls += 1;
        return 1;
      },
      enumerable: true,
    });
    Object.defineProperty(cell, "y", { value: 0, enumerable: false });
    expect(read(cell).issues).toEqual([
      { path: "/cell/x", message: "the property is an accessor: only data properties are read" },
      {
        path: "/cell/y",
        message: "the property is not enumerable: only enumerable data properties are read",
      },
    ]);
    expect(calls).toBe(0);
  });

  test.each<[string, unknown]>([
    ["an array", [0, 0]],
    ["a number", 7],
    ["null", null],
  ])("rejects a cell that is %s", (_, value) => {
    expect(read(value).issues).toEqual([
      { path: "/cell", message: "the cell must be a record { x, y }" },
    ]);
  });

  test("reports an object that throws while read as one issue, with the cause", () => {
    const { cell, issues, cause } = read(revokedProxy());
    expect(cell).toBeUndefined();
    expect(issues.map(({ path }) => path)).toEqual(["/cell"]);
    expect(issues[0]?.message).toStartWith("the object threw while being read: TypeError");
    expect(cause).toBeInstanceOf(TypeError);
  });
});
