import { describe, expect, test } from "bun:test";
import { type ChunkCoord, chunkKey, parseChunkKey } from "../src/index.ts";
import { engineErrorOf } from "./support/engine-error.ts";
import { revokedProxy } from "./support/revoked.ts";

/**
 * Chunk keys (plan §4): "x,y", both coordinates safe integers written in canonical decimal, so
 * each coordinate pair has exactly one key and each key one pair.
 */

const MAX = Number.MAX_SAFE_INTEGER;
const FORM = 'the chunk key must be two integers joined by one comma, as in "-1,0"';
const notDecimal = (axis: "x" | "y") =>
  `the ${axis} of the chunk key is not a safe integer in canonical decimal`;

describe("chunkKey and parseChunkKey", () => {
  test.each<[ChunkCoord, string]>([
    [{ x: 0, y: 0 }, "0,0"],
    [{ x: -1, y: 10 }, "-1,10"],
    [{ x: 2, y: -2 }, "2,-2"],
    [{ x: MAX, y: -MAX }, "9007199254740991,-9007199254740991"],
  ])("%j is the key %s, which parses back to it", (coord, key) => {
    expect(chunkKey(coord)).toBe(key);
    expect(parseChunkKey(key)).toEqual(coord);
  });

  test("parseChunkKey returns a fresh record", () => {
    const first = parseChunkKey("3,4");
    expect(parseChunkKey("3,4")).not.toBe(first);
    expect(Object.getPrototypeOf(first)).toBe(Object.prototype);
  });
});

describe("chunkKey rejects coordinates", () => {
  test("that are not safe integers, every one, with invalid_value", () => {
    const error = engineErrorOf(() => chunkKey({ x: 1.5, y: -0 }));
    expect(error.code).toBe("invalid_value");
    expect(error.issues).toEqual([
      { path: "/x", message: "1.5 is not a safe integer" },
      { path: "/y", message: "-0 is not canonical: use 0" },
    ]);
  });

  test.each([
    ["2^53", 2 ** 53, "9007199254740992 is not a safe integer"],
    ["NaN", Number.NaN, "NaN is not a safe integer"],
    ["a string", "1", "a value of type string is not a safe integer"],
  ])("such as %s", (_name, x, message) => {
    // Deliberately ill-typed, as a JavaScript caller can be.
    const coord = { x, y: 0 } as unknown as ChunkCoord;
    expect(engineErrorOf(() => chunkKey(coord)).issues).toEqual([{ path: "/x", message }]);
  });

  test("that throw while read, as invalid_value with the thrown value as the cause", () => {
    const coord = revokedProxy() as ChunkCoord;
    const error = engineErrorOf(() => chunkKey(coord));
    expect(error.issues.map(({ path }) => path)).toEqual([""]);
    expect(error.issues[0]?.message).toStartWith("the object threw while being read: TypeError");
    expect(error.cause).toBeInstanceOf(TypeError);
  });

  test("behind accessors, without running them", () => {
    let calls = 0;
    const coord = Object.defineProperty({ y: 0 }, "x", {
      get: () => {
        calls += 1;
        return 1;
      },
      enumerable: true,
    }) as ChunkCoord;
    expect(engineErrorOf(() => chunkKey(coord)).issues).toEqual([
      { path: "/x", message: "the property is an accessor: only data properties are read" },
    ]);
    expect(calls).toBe(0);
  });

  test("that are not a record", () => {
    // Deliberately ill-typed, as a JavaScript caller can be.
    const coord = null as unknown as ChunkCoord;
    expect(engineErrorOf(() => chunkKey(coord)).issues).toEqual([
      { path: "", message: "the chunk coordinates must be a record { x, y }" },
    ]);
  });
});

describe("parseChunkKey is strict", () => {
  test.each([
    ["-0,0", [notDecimal("x")]],
    ["0,-0", [notDecimal("y")]],
    ["01,0", [notDecimal("x")]],
    ["0,00", [notDecimal("y")]],
    ["+1,0", [notDecimal("x")]],
    [" 1,0", [notDecimal("x")]],
    ["1 ,0", [notDecimal("x")]],
    ["1, 0", [notDecimal("y")]],
    ["1e3,0", [notDecimal("x")]],
    ["0x10,0", [notDecimal("x")]],
    ["1.0,0", [notDecimal("x")]],
    ["9007199254740992,0", [notDecimal("x")]],
    ["0,-9007199254740992", [notDecimal("y")]],
    [",0", [notDecimal("x")]],
    ["0,", [notDecimal("y")]],
    [",", [notDecimal("x"), notDecimal("y")]],
    ["-0,01", [notDecimal("x"), notDecimal("y")]],
    ["", [FORM]],
    ["0", [FORM]],
    ["0,0,0", [FORM]],
    ["1,2,", [FORM]],
    ["0;0", [FORM]],
  ])("rejects %j with invalid_value", (key, messages) => {
    const error = engineErrorOf(() => parseChunkKey(key));
    expect(error.code).toBe("invalid_value");
    expect(error.issues).toEqual(messages.map((message) => ({ path: "", message })));
  });

  test("rejects a key that is not a string", () => {
    // Deliberately ill-typed, as a JavaScript caller can be.
    const key = 7 as unknown as string;
    expect(engineErrorOf(() => parseChunkKey(key)).issues).toEqual([
      { path: "", message: "the chunk key must be a string, not number" },
    ]);
  });
});
