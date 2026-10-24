import type { CanonicalValue } from "../../src/index.ts";
import type { Sfc32 } from "./sfc32.ts";

/**
 * Random canonical values for seeded fuzz tests (plan §8): text that exercises escaping,
 * normalization, and surrogate pairs, integers up to 2^53 - 1 in magnitude, and arrays and
 * records nested up to 5 deep.
 */

/** Inclusive code point ranges that exercise escaping, normalization, and surrogate pairs. */
const CODE_POINT_RANGES: readonly (readonly [number, number])[] = [
  [0x20, 0x7e], // printable ASCII, with the quote and the backslash
  [0x00, 0x1f], // C0 controls, which canonical text escapes
  [0x7f, 0x9f], // DEL and C1 controls, which it writes as they are
  [0xa0, 0x2ff], // Latin-1 to spacing modifiers: the NFC fast path
  [0x300, 0x36f], // combining diacritical marks
  [0x1100, 0x1112], // Hangul leading consonants
  [0x1161, 0x1175], // Hangul vowels
  [0x11a8, 0x11c2], // Hangul trailing consonants
  [0xac00, 0xd7a3], // Hangul syllables
  [0x2028, 0x2029], // line and paragraph separators
  [0x2126, 0x212b], // Ohm, Kelvin, and Angstrom signs, which NFC replaces
  [0xfb1d, 0xfb4f], // Hebrew presentation forms, mostly excluded from composition
  [0x1d15e, 0x1d164], // astral musical symbols that NFC decomposes
  [0x1f600, 0x1f64f], // astral emoji
];

const EDGE_INTEGERS = [
  0,
  1,
  -1,
  2 ** 31,
  -(2 ** 31),
  2 ** 32,
  Number.MAX_SAFE_INTEGER,
  Number.MIN_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER - 1,
];

export function randomText(
  random: Sfc32,
  maxLength: number,
  ranges: readonly (readonly [number, number])[] = CODE_POINT_RANGES,
): string {
  const codePoints = Array.from({ length: random.below(maxLength + 1) }, () => {
    const [min, max] = random.pick(ranges);
    return random.between(min, max);
  });
  return String.fromCodePoint(...codePoints);
}

function randomInteger(random: Sfc32): number {
  switch (random.below(4)) {
    case 0:
      return random.pick(EDGE_INTEGERS);
    case 1:
      return random.between(-1000, 1000);
    case 2:
      return random.next() | 0;
    default: {
      // Up to 2^53 - 1 in magnitude, never -0.
      const magnitude = random.below(2 ** 21) * 2 ** 32 + random.next();
      return random.below(2) === 0 || magnitude === 0 ? magnitude : -magnitude;
    }
  }
}

export function randomValue(random: Sfc32, depth = 0): CanonicalValue {
  const kind = random.below(depth >= 4 ? 3 : 5);
  if (kind === 0) return random.below(2) === 0;
  if (kind === 1) return randomInteger(random);
  if (kind === 2) return randomText(random, 6).normalize("NFC");
  if (kind === 3)
    return Array.from({ length: random.below(5) }, () => randomValue(random, depth + 1));
  const record: Record<string, CanonicalValue> = {};
  for (let count = random.below(5); count > 0; count -= 1) {
    const key = randomText(random, 4).normalize("NFC");
    if (key !== "__proto__") record[key] = randomValue(random, depth + 1);
  }
  return record;
}
