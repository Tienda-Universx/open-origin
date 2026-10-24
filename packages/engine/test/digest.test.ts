import { describe, expect, test } from "bun:test";
import { canonicalize, digest } from "../src/index.ts";
import { engineErrorOf } from "./support/engine-error.ts";

/**
 * digest (ADR 0020): MurmurHash3 x86_128 with seed 0 over the UTF-8 bytes of the canonical text,
 * written as h1, h2, h3, h4 in 8 lowercase hexadecimal digits each. The pinned digests were also
 * computed by SMHasher's C reference (src/MurmurHash3.cpp) over the same bytes.
 */

describe("digest", () => {
  test.each([
    [0, "0ab2409ea5eb34f8a5eb34f8a5eb34f8"],
    [true, "b209b3f44b380c974b380c974b380c97"],
    [[], "32a11dee00b149c400b149c400b149c4"],
    [{}, "c860c38f7f2fb2247f2fb2247f2fb224"],
    ["\u03c0", "275c58fcf41b2781f41b2781f41b2781"],
    [["chunk", "0:0", { b: [true, -7], a: 1 }], "d7212002b43c6ad7df750d4ed930d006"],
  ])("of %j is %s", (value, expected) => {
    expect(digest(value)).toBe(expected);
  });

  test("hashes the canonical text, so key order does not matter and every digest differs", () => {
    expect(canonicalize({ b: [true, -7], a: 1 })).toBe('{"a":1,"b":[true,-7]}');
    expect(digest({ b: 1, a: 2 })).toBe(digest({ a: 2, b: 1 }));
    const values = [0, "0", [0], { "0": 0 }, false, "", [], {}];
    const digests = values.map(digest);
    expect(new Set(digests).size).toBe(values.length);
    for (const text of digests) expect(text).toMatch(/^[0-9a-f]{32}$/);
  });

  test("rejects a value that is not canonical, as canonicalize does", () => {
    const error = engineErrorOf(() => digest({ a: [Number.NaN] }));
    expect(error.code).toBe("invalid_value");
    expect(error.issues).toEqual([{ path: "/a/0", message: "NaN is not a safe integer" }]);
  });
});
