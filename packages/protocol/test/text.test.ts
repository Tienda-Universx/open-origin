import { describe, expect, test } from "bun:test";
import {
  FORBIDDEN_CODE_POINTS,
  MAX_TEXT_LENGTH,
  PlainText,
  plainTextProblem,
} from "../src/public/index.ts";

/**
 * Plain text (ADR 0026). Invisible and control characters are built from their code points, never
 * written literally: the repository's hygiene test rejects them in source files.
 */

const char = (point: number) => String.fromCodePoint(point);

/** Ordinary text in several scripts, each in NFC. */
const ORDINARY = [
  "Being 3 greets being 7.",
  "¿Dónde está la comida? Ñandú, über, çà",
  "Привет, мир",
  "こんにちは世界、漢字とカタカナ",
  "مرحبا بالعالم",
  "שלום עולם",
  "हिन्दी पाठ",
  "한국어 문장",
  "Ελληνικά κείμενα",
  "a 🌍 b",
  "tabs\\tand\\nescapes are plain backslashes",
].map((text) => text.normalize("NFC"));

/** Named code points of each forbidden class, each with what it is. */
const NAMED: readonly (readonly [number, string])[] = [
  [0x0000, "NUL"],
  [0x0009, "tab"],
  [0x000a, "line feed"],
  [0x000d, "carriage return"],
  [0x001b, "escape"],
  [0x007f, "delete"],
  [0x0080, "first C1 control"],
  [0x0085, "next line"],
  [0x009f, "last C1 control"],
  [0x00ad, "soft hyphen"],
  [0x034f, "combining grapheme joiner"],
  [0x061c, "Arabic letter mark"],
  [0x115f, "Hangul choseong filler"],
  [0x180e, "Mongolian vowel separator"],
  [0x200b, "zero width space"],
  [0x200c, "zero width non-joiner"],
  [0x200d, "zero width joiner"],
  [0x200e, "left-to-right mark"],
  [0x200f, "right-to-left mark"],
  [0x2028, "line separator"],
  [0x2029, "paragraph separator"],
  [0x202a, "left-to-right embedding"],
  [0x202e, "right-to-left override"],
  [0x2060, "word joiner"],
  [0x2064, "invisible plus"],
  [0x2066, "left-to-right isolate"],
  [0x2069, "pop directional isolate"],
  [0x3164, "Hangul filler"],
  [0xfe0f, "variation selector 16"],
  [0xfeff, "byte order mark"],
  [0xfff9, "interlinear annotation anchor"],
  [0x1d173, "musical symbol begin beam"],
  [0xe0001, "language tag"],
  [0xe0100, "variation selector 17"],
];

describe("PlainText accepts", () => {
  test.each(ORDINARY)("%s", (text) => {
    expect(plainTextProblem(text)).toBeUndefined();
    const result = PlainText.safeParse(text);
    expect(result.success).toBe(true);
    expect(String(result.data)).toBe(text);
  });

  test("markup as the characters it is: renderers render text as text", () => {
    const markup = '<script>alert("x")</script> & <b>bold</b>';
    expect(String(PlainText.parse(markup))).toBe(markup);
  });

  test("exactly 280 code points, even when each takes two UTF-16 code units", () => {
    expect(plainTextProblem("a".repeat(MAX_TEXT_LENGTH))).toBeUndefined();
    const astral = char(0x1f30d).repeat(MAX_TEXT_LENGTH);
    expect(astral.length).toBe(2 * MAX_TEXT_LENGTH);
    expect(plainTextProblem(astral)).toBeUndefined();
  });
});

describe("PlainText rejects", () => {
  test.each(NAMED)("U+%s inside text", (point) => {
    expect(plainTextProblem(`a${char(point)}b`)).toBe("forbidden");
    expect(PlainText.safeParse(`a${char(point)}b`).success).toBe(false);
  });

  test("the first and the last code point of every forbidden range, alone and inside text", () => {
    const problems = FORBIDDEN_CODE_POINTS.flatMap(([first, last]) =>
      [first, last].flatMap((point) => [
        plainTextProblem(char(point)),
        plainTextProblem(`ok${char(point)}`),
      ]),
    );
    expect(problems).toEqual(problems.map(() => "forbidden"));
    expect(problems).toHaveLength(4 * FORBIDDEN_CODE_POINTS.length);
  });

  test("lone surrogates, as ill-formed", () => {
    for (const unit of [0xd800, 0xdbff, 0xdc00, 0xdfff]) {
      expect(plainTextProblem(`a${String.fromCharCode(unit)}b`)).toBe("ill_formed");
    }
    // A high surrogate followed by a low one is one well-formed code point.
    expect(plainTextProblem(String.fromCharCode(0xd83c, 0xdf0d))).toBeUndefined();
  });

  test("text that is not in NFC, whose NFC form is accepted", () => {
    for (const decomposed of [`e${char(0x301)}`, `${char(0x1100)}${char(0x1161)}`, char(0x212b)]) {
      expect(plainTextProblem(decomposed)).toBe("not_nfc");
      expect(plainTextProblem(decomposed.normalize("NFC"))).toBeUndefined();
    }
  });

  test("281 code points, and the empty string", () => {
    expect(plainTextProblem("a".repeat(MAX_TEXT_LENGTH + 1))).toBe("too_long");
    expect(plainTextProblem(char(0x1f30d).repeat(MAX_TEXT_LENGTH + 1))).toBe("too_long");
    expect(plainTextProblem("a".repeat(100_000))).toBe("too_long");
    expect(plainTextProblem("")).toBe("empty");
  });

  test("anything but a string, and never echoes the text in its issues", () => {
    for (const value of [undefined, null, 7, ["a"], { text: "a" }]) {
      expect(PlainText.safeParse(value).success).toBe(false);
    }
    const secret = `secret${char(0x202e)}`;
    const result = PlainText.safeParse(secret);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map(({ message }) => message)).toEqual([
      "not plain text: forbidden",
    ]);
  });
});

describe("FORBIDDEN_CODE_POINTS", () => {
  test("is sorted and disjoint", () => {
    FORBIDDEN_CODE_POINTS.forEach(([first, last], index) => {
      expect(first).toBeLessThanOrEqual(last);
      const previous = FORBIDDEN_CODE_POINTS[index - 1];
      if (previous !== undefined) expect(first).toBeGreaterThan(previous[1] + 1);
    });
  });

  /**
   * The table is Unicode 17.0's, written out so that engines with other Unicode data agree. When
   * the runtime's Unicode data changes, this test fails, and the table is reviewed and the
   * protocol's version raised if it changes.
   */
  test("holds exactly the code points the runtime puts in Cc, Cf, Zl, Zp, or Default_Ignorable", () => {
    const runtime = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu;
    // Every scalar value once, in order: the runtime's matches, as code points.
    const scalars = Array.from({ length: 0x110000 }, (_, point) =>
      point >= 0xd800 && point <= 0xdfff ? "" : char(point),
    ).join("");
    const matched = [...scalars.matchAll(runtime)].map((match) => match[0].codePointAt(0));
    const listed = FORBIDDEN_CODE_POINTS.flatMap(([first, last]) =>
      Array.from({ length: last - first + 1 }, (_, offset) => first + offset),
    );
    expect(matched.length).toBeGreaterThan(4000);
    expect(matched).toEqual(listed);
  });
});
