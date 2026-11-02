/**
 * Plain text (ADR 0026): every text field of the protocol. A plain text is well-formed UTF-16, in
 * Unicode Normalization Form C, from 1 to 280 code points, and holds no code point of
 * FORBIDDEN_CODE_POINTS: no control character, no line or paragraph separator, no bidirectional
 * control, and nothing invisible. No markup is ever sent, and a plain text is data: `<script>` is
 * accepted as the eight characters it is, and every renderer must render text as text, never as
 * markup.
 */
import { z } from "zod";
import { MAX_TEXT_LENGTH } from "./constants.ts";

/**
 * The code points a plain text never holds, as sorted, disjoint, inclusive ranges: every code point
 * that Unicode 17.0 assigns to the general categories Cc (controls: C0, DEL, and C1), Cf (format,
 * which holds the bidirectional controls, the zero-width characters, the word joiner, and the byte
 * order mark), Zl (U+2028), or Zp (U+2029), or gives the property Default_Ignorable_Code_Point
 * (invisible fillers, variation selectors, and tags). Lone surrogates (Cs) are rejected as
 * ill-formed. The table is explicit, so that a server and a client whose JavaScript engines know
 * different versions of Unicode agree on it; text.test.ts checks it against the runtime's data.
 * Emoji sequences that need U+200D or a variation selector are rejected with it.
 */
export const FORBIDDEN_CODE_POINTS: readonly (readonly [number, number])[] = Object.freeze(
  (
    [
      [0x0000, 0x001f],
      [0x007f, 0x009f],
      [0x00ad, 0x00ad],
      [0x034f, 0x034f],
      [0x0600, 0x0605],
      [0x061c, 0x061c],
      [0x06dd, 0x06dd],
      [0x070f, 0x070f],
      [0x0890, 0x0891],
      [0x08e2, 0x08e2],
      [0x115f, 0x1160],
      [0x17b4, 0x17b5],
      [0x180b, 0x180f],
      [0x200b, 0x200f],
      [0x2028, 0x202e],
      [0x2060, 0x206f],
      [0x3164, 0x3164],
      [0xfe00, 0xfe0f],
      [0xfeff, 0xfeff],
      [0xffa0, 0xffa0],
      [0xfff0, 0xfffb],
      [0x110bd, 0x110bd],
      [0x110cd, 0x110cd],
      [0x13430, 0x1343f],
      [0x1bca0, 0x1bca3],
      [0x1d173, 0x1d17a],
      [0xe0000, 0xe0fff],
    ] as const
  ).map((range) => Object.freeze(range)),
);

/** Why a string is not a plain text. */
export type PlainTextProblem = "empty" | "too_long" | "ill_formed" | "forbidden" | "not_nfc";

/** Whether the code point `point` lies in FORBIDDEN_CODE_POINTS. */
function isForbidden(point: number): boolean {
  return FORBIDDEN_CODE_POINTS.some(([first, last]) => point >= first && point <= last);
}

/** Why the well-formed `text` breaks the rule on code points: their count, or a forbidden one. */
function codePointProblem(text: string): PlainTextProblem | undefined {
  let count = 0;
  for (const character of text) {
    count += 1;
    if (count > MAX_TEXT_LENGTH) return "too_long";
    // A character is never empty; the fallback, U+0000, is forbidden too.
    if (isForbidden(character.codePointAt(0) ?? 0)) return "forbidden";
  }
  return undefined;
}

/** Why `text` is not a plain text; undefined when it is one. */
export function plainTextProblem(text: string): PlainTextProblem | undefined {
  if (text.length === 0) return "empty";
  // 280 code points take at most 560 UTF-16 code units: a longer string is too long unread.
  if (text.length > 2 * MAX_TEXT_LENGTH) return "too_long";
  if (!text.isWellFormed()) return "ill_formed";
  const problem = codePointProblem(text);
  if (problem !== undefined) return problem;
  return text.normalize("NFC") === text ? undefined : "not_nfc";
}

/** The schema of a plain text: a string that plainTextProblem accepts, branded `PlainText`. */
export const PlainText = z
  .string()
  .check((context) => {
    const problem = plainTextProblem(context.value);
    if (problem === undefined) return;
    context.issues.push({
      code: "custom",
      message: `not plain text: ${problem}`,
      input: context.value,
    });
  })
  .brand<"PlainText">();

/** A string the PlainText schema accepted. */
export type PlainText = z.output<typeof PlainText>;
