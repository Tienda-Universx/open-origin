import { describe, expect, test } from "bun:test";
import { ownKeyCount, sortedOwnKeys, symbolKeyCount } from "../src/canonical/order.ts";

/** The keys of the RFC 8785 §3.2.3 sorting example, written as code points. */
const RFC_8785_KEYS = {
  euroSign: String.fromCodePoint(0x20ac),
  carriageReturn: "\r",
  daletWithDagesh: String.fromCodePoint(0xfb33),
  one: "1",
  grinningFace: String.fromCodePoint(0x1f600),
  control: String.fromCodePoint(0x80),
  oWithDiaeresis: String.fromCodePoint(0xf6),
};

describe("sortedOwnKeys", () => {
  test("sorts by UTF-16 code units, as the RFC 8785 §3.2.3 example does", () => {
    const keys = RFC_8785_KEYS;
    const record = Object.fromEntries(Object.values(keys).map((key) => [key, 0]));
    // U+1F600 is the surrogate pair D83D DE00, so it sorts before U+FB33 although its code
    // point is larger.
    expect(sortedOwnKeys(record)).toEqual([
      keys.carriageReturn,
      keys.one,
      keys.control,
      keys.oWithDiaeresis,
      keys.euroSign,
      keys.grinningFace,
      keys.daletWithDagesh,
    ]);
  });

  test("sorts integer-like keys as strings, which JavaScript lists first in numeric order", () => {
    expect(sortedOwnKeys({ b: 0, 10: 0, 9: 0, a: 0, 1: 0 })).toEqual(["1", "10", "9", "a", "b"]);
  });

  test("does not depend on insertion order", () => {
    expect(sortedOwnKeys({ b: 0, a: 0, c: 0 })).toEqual(sortedOwnKeys({ c: 0, a: 0, b: 0 }));
    expect(sortedOwnKeys({ b: 0, a: 0, c: 0 })).toEqual(["a", "b", "c"]);
  });

  test("lists non-enumerable string keys too, and never symbol keys", () => {
    const record = Object.defineProperty({ b: 0, [Symbol("s")]: 0 }, "a", { value: 0 });
    expect(sortedOwnKeys(record)).toEqual(["a", "b"]);
  });
});

describe("own key counts", () => {
  test("ownKeyCount counts own string keys, enumerable or not, including an array's length", () => {
    expect(ownKeyCount({})).toBe(0);
    expect(ownKeyCount(Object.defineProperty({ a: 0 }, "b", { value: 0 }))).toBe(2);
    expect(ownKeyCount([5, 6])).toBe(3);
    expect(ownKeyCount({ [Symbol("s")]: 0 })).toBe(0);
  });

  test("symbolKeyCount counts own symbol keys only", () => {
    expect(symbolKeyCount({ a: 0 })).toBe(0);
    expect(symbolKeyCount({ [Symbol("s")]: 0, [Symbol("t")]: 0, a: 0 })).toBe(2);
    expect(symbolKeyCount(Object.create({ [Symbol("inherited")]: 0 }))).toBe(0);
  });
});
