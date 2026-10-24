import { describe, expect, test } from "bun:test";
import { type CanonicalValue, canonicalize, parseCanonical } from "../src/index.ts";
import { engineErrorOf } from "./support/engine-error.ts";

/**
 * Canonical text (ADR 0020) is the subset of RFC 8785 that canonical values need: keys sorted by
 * UTF-16 code units, integers in decimal, strings escaped as JSON.stringify does, no whitespace.
 * The parser accepts exactly the canonical texts.
 */

/** One backslash; escapes are spelled with it so this file holds no escape the reader must decode. */
const BACKSLASH = "\\";
const COMBINING_ACUTE = String.fromCodePoint(0x301);

describe("canonicalize", () => {
  test.each([
    [true, "true"],
    [false, "false"],
    [0, "0"],
    [-7, "-7"],
    [Number.MAX_SAFE_INTEGER, "9007199254740991"],
    [Number.MIN_SAFE_INTEGER, "-9007199254740991"],
    [Number.MAX_SAFE_INTEGER - 1, "9007199254740990"],
    ["", '""'],
    ["text", '"text"'],
    [[], "[]"],
    [{}, "{}"],
  ] as const)("writes %p as %s", (value, text) => {
    expect(canonicalize(value)).toBe(text);
  });

  test("sorts keys as the RFC 8785 §3.2.3 example does", () => {
    const euroSign = String.fromCodePoint(0x20ac);
    const control = String.fromCodePoint(0x80);
    const oWithDiaeresis = String.fromCodePoint(0xf6);
    const grinningFace = String.fromCodePoint(0x1f600);
    const value = {
      [euroSign]: "Euro Sign",
      "\r": "Carriage Return",
      "1": "One",
      [grinningFace]: "Emoji: Grinning Face",
      [control]: "Control",
      [oWithDiaeresis]: "Latin Small Letter O With Diaeresis",
    };
    expect(canonicalize(value)).toBe(
      `{"${BACKSLASH}r":"Carriage Return","1":"One","${control}":"Control",` +
        `"${oWithDiaeresis}":"Latin Small Letter O With Diaeresis","${euroSign}":"Euro Sign",` +
        `"${grinningFace}":"Emoji: Grinning Face"}`,
    );
  });

  test("rejects the example's U+FB33 key, which is not NFC (it normalizes to U+05D3 U+05BC)", () => {
    const dalet = String.fromCodePoint(0xfb33);
    expect(dalet.normalize("NFC")).toBe(String.fromCodePoint(0x5d3, 0x5bc));
    const error = engineErrorOf(() => canonicalize({ [dalet]: "Hebrew Letter Dalet With Dagesh" }));
    expect(error.issues).toEqual([
      { path: `/${dalet}`, message: "the key is not in Unicode Normalization Form C (NFC)" },
    ]);
  });

  test("sorts integer-like keys as strings", () => {
    expect(canonicalize({ 10: 1, 9: 2, 1: 3, a: 4 })).toBe('{"1":3,"10":1,"9":2,"a":4}');
  });

  test("escapes strings exactly as JSON.stringify does", () => {
    expect(canonicalize('quote " backslash \\ slash /')).toBe('"quote \\" backslash \\\\ slash /"');
    expect(canonicalize("\b\f\n\r\t")).toBe('"\\b\\f\\n\\r\\t"');
    expect(canonicalize(String.fromCharCode(0, 0x1f))).toBe(`"${BACKSLASH}u0000${BACKSLASH}u001f"`);
    // DEL, C1 controls, line separators, and non-ASCII text are written as they are.
    const raw = String.fromCodePoint(0x7f, 0x80, 0x2028, 0xe9, 0x1f600);
    expect(canonicalize(raw)).toBe(`"${raw}"`);
  });

  test("writes every canonical one-unit string as JSON.stringify does, as a value and as a key", () => {
    // Strings without a quote, a backslash, or a C0 control skip JSON.stringify; this covers both
    // paths, DEL, C1 controls, and U+2028 and U+2029 included.
    const mismatches: number[] = [];
    let written = 0;
    for (let unit = 0; unit <= 0xffff; unit += 1) {
      const text = String.fromCharCode(unit);
      // Lone surrogates and text that is not NFC are rejected before anything is written.
      if (!text.isWellFormed() || text.normalize("NFC") !== text) continue;
      written += 1;
      const quoted = JSON.stringify(text);
      if (canonicalize(text) !== quoted || canonicalize({ [text]: 0 }) !== `{${quoted}:0}`) {
        mismatches.push(unit);
      }
    }
    expect(mismatches).toEqual([]);
    expect(written).toBeGreaterThan(60_000);
    const astral = String.fromCodePoint(0x1f600, 0x10000, 0x10ffff);
    expect(canonicalize(astral)).toBe(JSON.stringify(astral));
  });

  test("never writes a lone surrogate, which JSON.stringify would escape", () => {
    for (const unit of [0xd800, 0xdbff, 0xdc00, 0xdfff]) {
      const error = engineErrorOf(() => canonicalize(`a${String.fromCharCode(unit)}`));
      expect(error.issues).toEqual([
        {
          path: "",
          message: "the string has a lone surrogate: strings must be well-formed UTF-16",
        },
      ]);
    }
  });

  test("writes nested structures without whitespace", () => {
    const value = { n: 0, list: [true, -5, "x", { b: [], a: {} }] };
    expect(canonicalize(value)).toBe('{"list":[true,-5,"x",{"a":{},"b":[]}],"n":0}');
  });

  test("fails fast, with the path of the first invalid value in canonical order", () => {
    const error = engineErrorOf(() => canonicalize({ b: null, a: [1, 1.5, Number.NaN] }));
    expect(error.code).toBe("invalid_value");
    expect(error.issues).toEqual([{ path: "/a/1", message: "1.5 is not a safe integer" }]);
    expect(error.message).toBe("invalid_value at /a/1: 1.5 is not a safe integer");
  });

  test("rejects a getter without calling it", () => {
    let calls = 0;
    const value = {
      get a() {
        calls += 1;
        return 1;
      },
    };
    expect(engineErrorOf(() => canonicalize(value)).issues).toEqual([
      { path: "/a", message: "the property is an accessor: only data properties are canonical" },
    ]);
    expect(calls).toBe(0);
  });
});

describe("parseCanonical", () => {
  const samples: CanonicalValue[] = [
    true,
    0,
    -9007199254740991,
    "",
    `caf${String.fromCodePoint(0xe9)} ${String.fromCodePoint(0x1f600)}`,
    [],
    {},
    { list: [1, { deep: ["x", [false]] }], "": "empty key", "1": 1 },
  ];

  // Wrapped, because test.each spreads an array row into arguments.
  test.each(samples.map((value) => [value]))("accepts the canonical text of %p", (value) => {
    const text = canonicalize(value);
    expect(parseCanonical(text)).toEqual(value);
  });

  test.each([
    ["whitespace inside", '{"a": 1}', 5],
    ["leading whitespace", " 1", 0],
    ["trailing whitespace", "1 ", 1],
    ["whitespace in an array", "[1, 2]", 3],
    ["unsorted keys", '{"b":1,"a":2}', 2],
    ["a duplicate key", '{"a":1,"a":1}', 6],
    ["an escaped letter", `"${BACKSLASH}u0041"`, 1],
    ["an escaped slash", `"${BACKSLASH}/"`, 1],
    ["an escaped non-ASCII character", `"${BACKSLASH}u00e9"`, 1],
    ["an escaped surrogate pair", `"${BACKSLASH}ud83d${BACKSLASH}ude00"`, 1],
    ["an uppercase hexadecimal escape", `"${BACKSLASH}u001F"`, 6],
    ["a decimal point", "1.0", 1],
    ["an exponent", "1e3", 1],
    ["an uppercase exponent", "1E3", 1],
  ] as const)("rejects %s, naming the first differing offset", (_name, text, offset) => {
    const error = engineErrorOf(() => parseCanonical(text));
    expect(error.code).toBe("invalid_value");
    expect(error.issues).toEqual([
      {
        path: "",
        message: `the text is not canonical: it first differs from its canonical form at offset ${offset}`,
      },
    ]);
  });

  test.each([
    ["-0", "-0", [{ path: "", message: "-0 is not canonical: use 0" }]],
    ["2^53", "9007199254740992", [{ path: "", message: "9007199254740992 is not a safe integer" }]],
    [
      "-(2^53)",
      "-9007199254740992",
      [{ path: "", message: "-9007199254740992 is not a safe integer" }],
    ],
    ["null", "null", [{ path: "", message: "null is not a canonical value" }]],
    ["a nested null", '{"a":[null]}', [{ path: "/a/0", message: "null is not a canonical value" }]],
    [
      "a lone surrogate escape",
      `"${BACKSLASH}ud800"`,
      [
        {
          path: "",
          message: "the string has a lone surrogate: strings must be well-formed UTF-16",
        },
      ],
    ],
    [
      "text that is not NFC",
      `"e${COMBINING_ACUTE}"`,
      [{ path: "", message: "the string is not in Unicode Normalization Form C (NFC)" }],
    ],
    [
      "an escape that is not NFC",
      `"e${BACKSLASH}u0301"`,
      [{ path: "", message: "the string is not in Unicode Normalization Form C (NFC)" }],
    ],
    [
      "the key __proto__",
      '{"__proto__":1}',
      [{ path: "/__proto__", message: "the key __proto__ is not allowed" }],
    ],
    [
      "several values at once",
      '[1.5,null,{"a":1e400}]',
      [
        { path: "/0", message: "1.5 is not a safe integer" },
        { path: "/1", message: "null is not a canonical value" },
        { path: "/2/a", message: "Infinity is not a safe integer" },
      ],
    ],
  ] as const)("rejects %s with every issue", (_name, text, issues) => {
    const error = engineErrorOf(() => parseCanonical(text));
    expect(error.code).toBe("invalid_value");
    expect(error.issues).toEqual(issues);
  });

  test.each(["", "{", "[1,]", "01", "+1", "NaN", "undefined", "'a'", '{"a":1}x'])(
    "rejects %p, which is not JSON, and keeps the parser's error as the cause",
    (text) => {
      const error = engineErrorOf(() => parseCanonical(text));
      expect(error.code).toBe("invalid_value");
      expect(error.issues).toHaveLength(1);
      expect(error.issues[0]?.path).toBe("");
      expect(error.issues[0]?.message).toStartWith("the text is not JSON: ");
      expect(error.cause).toBeInstanceOf(SyntaxError);
    },
  );

  test("rejects a value that is not a string", () => {
    // A JavaScript caller can pass anything; TypeScript callers cannot.
    const error = engineErrorOf(() => parseCanonical(5 as unknown as string));
    expect(error.issues).toEqual([
      { path: "", message: "the canonical text must be a string, not number" },
    ]);
  });
});
