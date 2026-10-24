import { describe, expect, test } from "bun:test";
import { copyCanonical } from "../src/index.ts";
import { engineErrorOf } from "./support/engine-error.ts";

/**
 * copyCanonical validates and deep-copies a value in one pass (ADR 0020, ownership): it reads
 * each property once, through its own property descriptor, so a getter or a Proxy cannot show
 * one value to validation and another to the copy. The copy shares no object with the input.
 */

/** Every array and record inside `value`, `value` included. */
function objectsIn(value: unknown): object[] {
  if (typeof value !== "object" || value === null) return [];
  const children = Array.isArray(value) ? value : Object.values(value);
  return [value, ...children.flatMap(objectsIn)];
}

const sample = () => ({ list: [1, { deep: ["x", []] }], flag: true, nested: { n: -7 } });

describe("copyCanonical", () => {
  test("returns scalars as they are", () => {
    for (const scalar of [true, 0, -9, "text"]) expect(copyCanonical(scalar)).toBe(scalar);
  });

  test("returns an equal value that shares no array or record with the input", () => {
    const input = sample();
    const copy = copyCanonical(input);
    expect(copy).toEqual(sample());
    const inputObjects = objectsIn(input);
    expect(inputObjects).toHaveLength(6);
    for (const object of objectsIn(copy)) expect(inputObjects).not.toContain(object);
  });

  test("is independent of the input in both directions", () => {
    const input = sample();
    const copy = copyCanonical(input);
    input.list.push(2);
    input.nested.n = 0;
    expect(copy).toEqual(sample());
    const source = sample();
    // CanonicalValue is read-only in TypeScript only: the copy is made of ordinary records.
    const copied = copyCanonical(source) as { nested: { n: number } };
    copied.nested.n = 99;
    expect(source.nested.n).toBe(-7);
  });

  test("copies a record without a prototype into a plain record", () => {
    const copy = copyCanonical(Object.assign(Object.create(null), { a: 1 }));
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    expect(copy).toEqual({ a: 1 });
  });

  test("throws invalid_value with every issue", () => {
    const error = engineErrorOf(() => copyCanonical({ b: 1.5, a: [null] }));
    expect(error.code).toBe("invalid_value");
    expect(error.issues).toEqual([
      { path: "/a/0", message: "null is not a canonical value" },
      { path: "/b", message: "1.5 is not a safe integer" },
    ]);
  });

  test("rejects an object reached twice, so the copy is a tree, as canonical values are", () => {
    const shared = { a: 1 };
    expect(engineErrorOf(() => copyCanonical({ x: shared, y: [shared] })).issues).toEqual([
      {
        path: "/y/0",
        message: "the value is the same object as the value at /x: canonical values are trees",
      },
    ]);
  });

  test("keeps 50 issues and counts the dropped ones in its message", () => {
    const error = engineErrorOf(() => copyCanonical(new Array(120).fill(Number.NaN)));
    expect(error.issues).toHaveLength(50);
    expect(error.message).toBe(
      "invalid_value at /0: NaN is not a safe integer; 120 issues in all, 70 dropped beyond the first 50",
    );
  });

  test("rejects a getter without calling it", () => {
    let calls = 0;
    const input = {
      get a() {
        calls += 1;
        return calls;
      },
    };
    const error = engineErrorOf(() => copyCanonical(input));
    expect(error.issues).toEqual([
      { path: "/a", message: "the property is an accessor: only data properties are canonical" },
    ]);
    expect(calls).toBe(0);
  });

  test("never consults a Proxy's get trap, so a lying get yields one consistent copy", () => {
    let reads = 0;
    const handler = {
      get: () => {
        reads += 1;
        return reads;
      },
    };
    const record = new Proxy({ a: 1, b: [2, 3] }, handler);
    const array = new Proxy([4, 5], handler);
    expect(copyCanonical(record)).toEqual({ a: 1, b: [2, 3] });
    expect(copyCanonical(array)).toEqual([4, 5]);
    expect(reads).toBe(0);
  });

  test("reads each property of a Proxy once, and copies the value it validated", () => {
    let reads = 0;
    const record = new Proxy(
      { a: 0, b: 0 },
      {
        getOwnPropertyDescriptor: () => {
          reads += 1;
          return { value: reads, writable: true, enumerable: true, configurable: true };
        },
      },
    );
    expect(copyCanonical(record)).toEqual({ a: 1, b: 2 });
    expect(reads).toBe(2);
  });

  test("rejects a Proxy that reports an accessor, without calling it", () => {
    let calls = 0;
    const record = new Proxy(
      { a: 0 },
      {
        getOwnPropertyDescriptor: () => ({
          get: () => {
            calls += 1;
            return 1;
          },
          enumerable: true,
          configurable: true,
        }),
      },
    );
    expect(engineErrorOf(() => copyCanonical(record)).issues).toEqual([
      { path: "/a", message: "the property is an accessor: only data properties are canonical" },
    ]);
    expect(calls).toBe(0);
  });
});
