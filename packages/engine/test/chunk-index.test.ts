import { describe, expect, test } from "bun:test";
import { ChunkIndex } from "../src/world/chunk-index.ts";
import { engineErrorOf } from "./support/engine-error.ts";
import { Sfc32 } from "./support/sfc32.ts";

/**
 * The lazy, sorted chunk index (ADR 0020, cost): adding a chunk only appends its key to a pending
 * list, and the keys are sorted, by UTF-16 code units, only when a caller asks for all of them.
 */

function indexOf(keys: readonly string[]): ChunkIndex<number> {
  const index = new ChunkIndex<number>();
  keys.forEach((key, value) => {
    index.add(key, value);
  });
  return index;
}

describe("ChunkIndex", () => {
  test('sorts keys by UTF-16 code units: "-1,0" < "0,0" < "10,0" < "2,0"', () => {
    expect(indexOf(["2,0", "10,0", "0,0", "-1,0"]).sortedKeys()).toEqual([
      "-1,0",
      "0,0",
      "10,0",
      "2,0",
    ]);
  });

  test("leaves added keys pending until sortedKeys, then merges only them", () => {
    const index = indexOf(["2,0", "10,0", "0,0", "-1,0"]);
    expect(index.pendingCount).toBe(4);
    index.sortedKeys();
    expect(index.pendingCount).toBe(0);
    index.add("1,0", 4);
    index.add("-2,0", 5);
    expect(index.pendingCount).toBe(2);
    expect(index.sortedKeys()).toEqual(["-1,0", "-2,0", "0,0", "1,0", "10,0", "2,0"]);
    expect(index.pendingCount).toBe(0);
    expect(index.size).toBe(6);
  });

  test("counts pending keys in its size, before any sort", () => {
    const index = new ChunkIndex<number>();
    expect(index.size).toBe(0);
    index.add("1,0", 0);
    index.add("0,0", 1);
    expect([index.size, index.pendingCount]).toEqual([2, 2]);
    index.sortedKeys();
    index.add("2,0", 2);
    expect([index.size, index.pendingCount]).toEqual([3, 1]);
  });

  test("returns a fresh array each time, so a caller cannot change the order", () => {
    const index = indexOf(["1,0", "0,0"]);
    const keys = index.sortedKeys();
    keys.reverse();
    keys.push("9,9");
    expect(index.sortedKeys()).toEqual(["0,0", "1,0"]);
    expect(index.sortedKeys()).not.toBe(index.sortedKeys());
  });

  test("finds keys while pending and after sorting, and nothing inherited", () => {
    const index = indexOf(["0,0"]);
    expect([index.has("0,0"), index.get("0,0")]).toEqual([true, 0]);
    index.sortedKeys();
    index.add("1,1", 1);
    expect([index.has("0,0"), index.has("1,1"), index.get("1,1")]).toEqual([true, true, 1]);
    for (const key of ["2,2", "__proto__", "toString", "constructor", "hasOwnProperty"]) {
      expect([index.has(key), index.get(key)]).toEqual([false, undefined]);
    }
  });

  test("rejects a key that is already there, pending or sorted, with invalid_value", () => {
    const index = indexOf(["0,0"]);
    const expected = [{ path: "", message: "the chunk 0,0 already exists" }];
    expect(engineErrorOf(() => index.add("0,0", 1)).issues).toEqual(expected);
    index.sortedKeys();
    expect(engineErrorOf(() => index.add("0,0", 1)).issues).toEqual(expected);
    expect([index.size, index.get("0,0"), index.sortedKeys()]).toEqual([1, 0, ["0,0"]]);
  });

  test("agrees with a full sort under random adds and reads", () => {
    const random = new Sfc32(7);
    const index = new ChunkIndex<number>();
    const all: string[] = [];
    for (let step = 0; step < 2_000; step += 1) {
      if (random.below(8) === 0) {
        expect(index.sortedKeys()).toEqual([...all].sort());
        continue;
      }
      const key = `${random.between(-50, 50)},${random.between(-50, 50)}`;
      if (index.has(key)) continue;
      index.add(key, step);
      all.push(key);
    }
    expect(index.sortedKeys()).toEqual([...all].sort());
    expect(index.size).toBe(all.length);
  });
});
