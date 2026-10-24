import { describe, expect, test } from "bun:test";
import { utf8Encode } from "../src/canonical/utf8.ts";
import { engineErrorOf } from "./support/engine-error.ts";
import { Sfc32 } from "./support/sfc32.ts";

/**
 * The engine's own UTF-8 encoder (plan §5.2: `TextEncoder` is not ECMAScript), checked against
 * the host's TextEncoder, which tests may use.
 */

const encoder = new TextEncoder();

/** Code points at every boundary between UTF-8 lengths, and around the surrogates. */
const BOUNDARIES = [
  0x00, 0x7f, 0x80, 0x7ff, 0x800, 0xd7ff, 0xe000, 0xfffd, 0xffff, 0x10000, 0x10ffff,
];

/** Inclusive code point ranges, one per UTF-8 length, the astral planes included. */
const RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x7f],
  [0x80, 0x7ff],
  [0x800, 0xd7ff],
  [0xe000, 0xffff],
  [0x10000, 0x10ffff],
];

function randomText(random: Sfc32): string {
  const points = Array.from({ length: random.below(40) }, () => {
    const [low, high] = random.pick(RANGES);
    return random.between(low, high);
  });
  return String.fromCodePoint(...points);
}

/** The encoding, and whether its buffer holds exactly its bytes. */
function encoded(text: string): { bytes: number[]; exact: boolean } {
  const bytes = utf8Encode(text);
  return {
    bytes: [...bytes],
    exact: bytes.byteOffset === 0 && bytes.buffer.byteLength === bytes.length,
  };
}

describe("utf8Encode", () => {
  test("encodes every length boundary as TextEncoder does, into a buffer of the exact size", () => {
    for (const point of BOUNDARIES) {
      const text = String.fromCodePoint(point);
      expect(encoded(text)).toEqual({ bytes: [...encoder.encode(text)], exact: true });
    }
    expect(encoded("")).toEqual({ bytes: [], exact: true });
  });

  test("agrees with TextEncoder on random well-formed text, astral characters included", () => {
    const random = new Sfc32(11);
    for (let sample = 0; sample < 2_000; sample += 1) {
      const text = randomText(random);
      expect(encoded(text)).toEqual({ bytes: [...encoder.encode(text)], exact: true });
    }
  });

  test.each([
    ["a high surrogate at the end", "ab\ud800", 2],
    ["a high surrogate before another character", "\ud83dx", 0],
    ["a low surrogate alone", "a\udc00b", 1],
    ["a reversed pair", "\ude00\ud83d", 0],
  ])("rejects %s with invalid_value and its offset", (_name, text, offset) => {
    const error = engineErrorOf(() => utf8Encode(text));
    expect(error.code).toBe("invalid_value");
    expect(error.issues).toEqual([
      {
        path: "",
        message: `the text has a lone surrogate at UTF-16 offset ${offset}: strings must be well-formed UTF-16`,
      },
    ]);
  });
});
