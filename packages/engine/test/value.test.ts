import { describe, expect, test } from "bun:test";
import { validateCanonical } from "../src/index.ts";

/**
 * Canonical values (ADR 0020): safe integers without -0, well-formed NFC strings, booleans, dense
 * arrays, and plain records with well-formed NFC keys other than __proto__, nested at most 64
 * deep; no null. validateCanonical reports every issue, up to 50, each with its JSON Pointer.
 */

const COMBINING_ACUTE = String.fromCodePoint(0x301);
const NOT_NFC = `e${COMBINING_ACUTE}`;
const LONE_SURROGATE = String.fromCharCode(0xd800);

const NULL = "null is not a canonical value";
const MINUS_ZERO = "-0 is not canonical: use 0";
const STRING_SURROGATE = "the string has a lone surrogate: strings must be well-formed UTF-16";
const STRING_NFC = "the string is not in Unicode Normalization Form C (NFC)";
const KEY_SURROGATE = "the key has a lone surrogate: strings must be well-formed UTF-16";
const KEY_NFC = "the key is not in Unicode Normalization Form C (NFC)";
const PROTO_KEY = "the key __proto__ is not allowed";
const NOT_PLAIN =
  "the object is not a plain array or record: a record's prototype must be Object.prototype or null";
const ACCESSOR = "the property is an accessor: only data properties are canonical";
const NOT_ENUMERABLE = "the property is not enumerable: only enumerable properties are canonical";
const HOLE = "the array has a hole here: arrays must be dense";
const EXTRA = "the array has a property that is not an element: arrays hold only their elements";
const DEPTH = "the value nests deeper than 64 arrays and records";

const notType = (type: string) => `${type} is not a canonical type`;
const notSafe = (value: string) => `${value} is not a safe integer`;
const symbols = (count: number) => `the object has symbol keys (${count}): keys must be strings`;
const cycle = (where: string) =>
  `the value contains itself: it is the same object as the value at ${where}`;

/** `value` nested inside `depth` arrays: depth 1 is [value]. */
function nestedArrays(depth: number, value: unknown = 0): unknown {
  let nested = value;
  for (let level = 0; level < depth; level += 1) nested = [nested];
  return nested;
}

/** `value` nested inside `depth` records, each with the key "k". */
function nestedRecords(depth: number, value: unknown = 0): unknown {
  let nested = value;
  for (let level = 0; level < depth; level += 1) nested = { k: nested };
  return nested;
}

class Point {
  x = 1;
}

class Items extends Array<number> {}

describe("validateCanonical accepts canonical values", () => {
  test.each([
    ["true", true],
    ["false", false],
    ["zero", 0],
    ["a negative integer", -42],
    ["the largest safe integer", Number.MAX_SAFE_INTEGER],
    ["the smallest safe integer", Number.MIN_SAFE_INTEGER],
    ["the empty string", ""],
    ["text below U+0300, which skips normalization", `plain ${String.fromCodePoint(0xe9, 0x2ff)}`],
    ["a lone combining mark, which is already NFC", COMBINING_ACUTE],
    ["a precomposed character", String.fromCodePoint(0xe9)],
    ["a Hangul syllable", String.fromCodePoint(0xac00)],
    ["an astral character", String.fromCodePoint(0x1f600)],
    ["an empty array", []],
    ["an empty record", {}],
    ["nested arrays and records", { list: [1, "two", false, { deep: [[]] }], n: 0 }],
    ["a record without a prototype", Object.assign(Object.create(null), { a: 1 })],
    ["a frozen record", Object.freeze({ a: Object.freeze([1]) })],
    ["NFC keys outside the fast path", { [String.fromCodePoint(0xe9, 0x1f600)]: 1 }],
    ["64 nested arrays", nestedArrays(64)],
    ["64 nested records", nestedRecords(64)],
    ["the same object twice, which is not a cycle", ((shared) => [shared, shared])({ a: 1 })],
  ])("%s", (_name, value) => {
    expect(validateCanonical(value)).toEqual([]);
  });
});

describe("validateCanonical rejects, with the path of each issue", () => {
  test.each([
    ["null", null, NULL],
    ["undefined", undefined, notType("undefined")],
    ["a bigint", 10n, notType("bigint")],
    ["a symbol", Symbol("s"), notType("symbol")],
    ["a function", () => 0, notType("function")],
    ["-0", -0, MINUS_ZERO],
    ["NaN", Number.NaN, notSafe("NaN")],
    ["Infinity", Number.POSITIVE_INFINITY, notSafe("Infinity")],
    ["-Infinity", Number.NEGATIVE_INFINITY, notSafe("-Infinity")],
    ["a float", 1.5, notSafe("1.5")],
    ["2^53", 2 ** 53, notSafe("9007199254740992")],
    ["-(2^53)", -(2 ** 53), notSafe("-9007199254740992")],
    ["a lone surrogate", `a${LONE_SURROGATE}`, STRING_SURROGATE],
    ["text that is not NFC", NOT_NFC, STRING_NFC],
    ["a Map", new Map(), NOT_PLAIN],
    ["a Set", new Set(), NOT_PLAIN],
    ["a Date", new Date(0), NOT_PLAIN],
    ["a class instance", new Point(), NOT_PLAIN],
    ["a typed array", new Uint8Array(2), NOT_PLAIN],
    ["a regular expression", /x/, NOT_PLAIN],
    ["a boxed number", Object(1), NOT_PLAIN],
    ["an error", new Error("e"), NOT_PLAIN],
    ["an Array subclass", Items.from([1]), NOT_PLAIN],
    ["an object symbol key", { a: 1, [Symbol("s")]: 2 }, symbols(1)],
    ["an array symbol key", Object.assign([1], { [Symbol("s")]: 2 }), symbols(1)],
  ])("%s at the root", (_name, value, message) => {
    expect(validateCanonical(value)).toEqual([{ path: "", message }]);
  });

  test("an accessor, without calling it", () => {
    let calls = 0;
    const value = {
      get a() {
        calls += 1;
        return 1;
      },
    };
    expect(validateCanonical(value)).toEqual([{ path: "/a", message: ACCESSOR }]);
    expect(calls).toBe(0);
  });

  test("an accessor array element", () => {
    const value = Object.defineProperty([0], 0, { get: () => 1, enumerable: true });
    expect(validateCanonical(value)).toEqual([{ path: "/0", message: ACCESSOR }]);
  });

  test("non-enumerable properties of records and arrays", () => {
    const record = Object.defineProperty({ b: 1 }, "a", { value: 1, writable: true });
    const array = Object.defineProperty([0, 1], 1, { enumerable: false });
    expect(validateCanonical(record)).toEqual([{ path: "/a", message: NOT_ENUMERABLE }]);
    expect(validateCanonical(array)).toEqual([{ path: "/1", message: NOT_ENUMERABLE }]);
  });

  test("a sparse array, without walking its length", () => {
    const sparse: unknown[] = new Array(3);
    sparse[0] = 1;
    sparse[2] = 3;
    expect(validateCanonical(sparse)).toEqual([
      {
        path: "",
        message: "the array is sparse: its length is 3, but it has only 2 other own properties",
      },
    ]);
    const huge: unknown[] = [];
    huge.length = 2 ** 32 - 1;
    expect(validateCanonical(huge)).toEqual([
      {
        path: "",
        message:
          "the array is sparse: its length is 4294967295, but it has only 0 other own properties",
      },
    ]);
  });

  test("extra array properties, in canonical order", () => {
    expect(validateCanonical(Object.assign([1], { b: 2, a: 3, "-0": 4, "01": 5 }))).toEqual([
      { path: "/-0", message: EXTRA },
      { path: "/01", message: EXTRA },
      { path: "/a", message: EXTRA },
      { path: "/b", message: EXTRA },
    ]);
  });

  test("a hole that an extra property hides from the key count", () => {
    const hidden: unknown[] = new Array(2);
    hidden[0] = 1;
    Object.assign(hidden, { a: 0 });
    expect(validateCanonical(hidden)).toEqual([
      { path: "/1", message: HOLE },
      { path: "/a", message: EXTRA },
    ]);
  });

  test("keys that are not canonical, while still checking their values", () => {
    expect(validateCanonical({ [NOT_NFC]: 1 })).toEqual([
      { path: `/${NOT_NFC}`, message: KEY_NFC },
    ]);
    expect(validateCanonical({ [LONE_SURROGATE]: null })).toEqual([
      { path: `/${LONE_SURROGATE}`, message: KEY_SURROGATE },
      { path: `/${LONE_SURROGATE}`, message: NULL },
    ]);
  });

  test("the key __proto__, however it was created", () => {
    const parsed: unknown = JSON.parse('{"__proto__":1}');
    const defined = Object.defineProperty({}, "__proto__", { value: 1, enumerable: true });
    expect(validateCanonical(parsed)).toEqual([{ path: "/__proto__", message: PROTO_KEY }]);
    expect(validateCanonical(defined)).toEqual([{ path: "/__proto__", message: PROTO_KEY }]);
  });

  test("escapes ~ and / in paths, as JSON Pointer (RFC 6901) does", () => {
    expect(validateCanonical({ "a/b~c": [null] })).toEqual([{ path: "/a~1b~0c/0", message: NULL }]);
  });

  test("65 nested arrays or records, at the innermost container", () => {
    expect(validateCanonical(nestedArrays(65))).toEqual([
      { path: "/0".repeat(64), message: DEPTH },
    ]);
    expect(validateCanonical(nestedRecords(65))).toEqual([
      { path: "/k".repeat(64), message: DEPTH },
    ]);
  });

  test("cycles, at once and without overflowing the stack", () => {
    const self: Record<string, unknown> = {};
    self.self = self;
    expect(validateCanonical(self)).toEqual([{ path: "/self", message: cycle("the root") }]);
    // Two references per level would take 2^64 steps if only the depth limit stopped them.
    const twice: unknown[] = [];
    twice.push(twice, twice);
    expect(validateCanonical(twice)).toEqual([
      { path: "/0", message: cycle("the root") },
      { path: "/1", message: cycle("the root") },
    ]);
    const inner: Record<string, unknown> = {};
    inner.y = [inner];
    expect(validateCanonical({ x: inner })).toEqual([{ path: "/x/y/0", message: cycle("/x") }]);
  });

  test("every issue in one value, in canonical key order", () => {
    const value = { d: "ok", b: { c: undefined }, a: [1.5, null, NOT_NFC] };
    expect(validateCanonical(value)).toEqual([
      { path: "/a/0", message: notSafe("1.5") },
      { path: "/a/1", message: NULL },
      { path: "/a/2", message: STRING_NFC },
      { path: "/b/c", message: notType("undefined") },
    ]);
  });

  test("an array Proxy that reports another length, which its own keys then contradict", () => {
    const withLength = (length: number) =>
      new Proxy([1, 2], {
        getOwnPropertyDescriptor: (target, key) =>
          key === "length"
            ? { value: length, writable: true, enumerable: false, configurable: false }
            : Reflect.getOwnPropertyDescriptor(target, key),
      });
    expect(validateCanonical(withLength(1))).toEqual([{ path: "/1", message: EXTRA }]);
    expect(validateCanonical(withLength(3))).toEqual([
      {
        path: "",
        message: "the array is sparse: its length is 3, but it has only 2 other own properties",
      },
    ]);
  });

  test("a value as a whole, once, without the issues of its contents", () => {
    const sparse: unknown[] = new Array(3);
    sparse[0] = Number.NaN;
    sparse[2] = null;
    expect(validateCanonical(sparse)).toEqual([
      {
        path: "",
        message: "the array is sparse: its length is 3, but it has only 2 other own properties",
      },
    ]);
    const holder = Object.assign(new Point(), { bad: [Number.NaN, null] });
    expect(validateCanonical({ holder })).toEqual([{ path: "/holder", message: NOT_PLAIN }]);
  });

  test("at most the first 50 issues", () => {
    const value = Array.from({ length: 120 }, () => Number.NaN);
    expect(validateCanonical(value)).toEqual(
      Array.from({ length: 50 }, (_, index) => ({ path: `/${index}`, message: notSafe("NaN") })),
    );
  });
});

describe("the NFC fast path at U+0300", () => {
  const LAST_FAST = String.fromCodePoint(0x2ff);
  const FIRST_CHECKED = String.fromCodePoint(0x300);

  /** How many times `action` calls String.prototype.normalize. */
  function normalizeCalls(action: () => unknown): number {
    const normalize = String.prototype.normalize;
    let calls = 0;
    String.prototype.normalize = function (this: string, form?: string): string {
      calls += 1;
      return normalize.call(this, form);
    };
    try {
      action();
    } finally {
      String.prototype.normalize = normalize;
    }
    return calls;
  }

  test("text up to U+02FF never calls normalize, as a value or as a key", () => {
    const text = `a${String.fromCodePoint(0xe9)}${LAST_FAST}`;
    expect(normalizeCalls(() => expect(validateCanonical(text)).toEqual([]))).toBe(0);
    expect(normalizeCalls(() => expect(validateCanonical({ [text]: 0 })).toEqual([]))).toBe(0);
  });

  test("text from U+0300 calls normalize once, as a value or as a key", () => {
    expect(normalizeCalls(() => expect(validateCanonical(FIRST_CHECKED)).toEqual([]))).toBe(1);
    expect(
      normalizeCalls(() => expect(validateCanonical({ [FIRST_CHECKED]: 0 })).toEqual([])),
    ).toBe(1);
  });

  test("a letter followed by U+0300 is not NFC, as a value or as a key", () => {
    const decomposed = `a${FIRST_CHECKED}`;
    expect(decomposed.normalize("NFC")).toBe(String.fromCodePoint(0xe0));
    expect(validateCanonical(decomposed)).toEqual([{ path: "", message: STRING_NFC }]);
    expect(validateCanonical({ [decomposed]: 0 })).toEqual([
      { path: `/${decomposed}`, message: KEY_NFC },
    ]);
  });
});
