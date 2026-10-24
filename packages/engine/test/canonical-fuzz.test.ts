import { describe, expect, test } from "bun:test";
import {
  type CanonicalValue,
  canonicalize,
  copyCanonical,
  EngineError,
  parseCanonical,
  validateCanonical,
} from "../src/index.ts";
import { Sfc32 } from "./support/sfc32.ts";

/**
 * Seeded fuzz tests of canonical values and text (ADR 0020, plan §8): random canonical values
 * round-trip exactly; a text one character away from a canonical text is either rejected or
 * canonical itself; and the NFC fast path agrees with String.prototype.normalize.
 */

const SEEDS = [1, 2, 3, 2026];

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

/** Ranges below U+0300 only, where validation skips normalize. */
const FAST_PATH_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x7f],
  [0x80, 0x2ff],
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

function randomText(
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

function randomValue(random: Sfc32, depth = 0): CanonicalValue {
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

/** An independent oracle: JSON.stringify for scalars and keys, and the default sort for keys. */
function referenceText(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(referenceText).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  // A non-null object that is not an array: index it by its own string keys.
  const record = value as Record<string, unknown>;
  const members = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${referenceText(record[key])}`);
  return `{${members.join(",")}}`;
}

/** Characters that matter to JSON syntax, escapes, numbers, normalization, and surrogates. */
const MUTATIONS = [
  ...'{}[],:"\\/ \t\n-+.0123456789eEtrufalsnx',
  String.fromCodePoint(0x301),
  String.fromCodePoint(0xe9),
  String.fromCharCode(0xd800),
  String.fromCodePoint(0x1f600),
];

/** Whether `text` has a UTF-16 code unit at or above U+0300, where normalize must run. */
function reachesCombiningMarks(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) >= 0x300) return true;
  }
  return false;
}

/** `text` with one character inserted, deleted, or replaced at a random offset. */
function mutate(random: Sfc32, text: string): string {
  const at = random.below(text.length + 1);
  const character = random.pick(MUTATIONS);
  switch (random.below(3)) {
    case 0:
      return text.slice(0, at) + character + text.slice(at);
    case 1:
      return text.slice(0, at) + text.slice(at + 1);
    default:
      return text.slice(0, at) + character + text.slice(at + 1);
  }
}

/**
 * How parseCanonical treats `text`: "rejected" with invalid_value, "accepted" when the text is
 * canonical by the independent oracle as well, and "broken" when it accepts any other text.
 */
function parseOutcome(text: string): "accepted" | "rejected" | "broken" {
  let parsed: CanonicalValue;
  try {
    parsed = parseCanonical(text);
  } catch (error) {
    if (error instanceof EngineError && error.code === "invalid_value") return "rejected";
    throw error;
  }
  const canonical = referenceText(parsed) === text && canonicalize(parsed) === text;
  return canonical ? "accepted" : "broken";
}

describe("Sfc32", () => {
  test("repeats its sequence for a seed and differs between seeds", () => {
    const sequence = (seed: number) => {
      const random = new Sfc32(seed);
      return Array.from({ length: 8 }, () => random.next());
    };
    expect(sequence(7)).toEqual(sequence(7));
    expect(sequence(7)).not.toEqual(sequence(8));
    for (const value of sequence(7)) {
      expect(Number.isInteger(value) && value >= 0 && value < 2 ** 32).toBe(true);
    }
  });

  test("keeps below, between, and pick inside their ranges", () => {
    const random = new Sfc32(1);
    for (let draw = 0; draw < 1000; draw += 1) {
      expect(random.below(3)).toBeLessThan(3);
      expect(random.between(-2, 2)).toBeGreaterThanOrEqual(-2);
    }
    expect(() => random.pick([])).toThrow(RangeError);
  });
});

describe("canonical fuzz", () => {
  test("random canonical values round-trip exactly", () => {
    const failures: string[] = [];
    for (const seed of SEEDS) {
      const random = new Sfc32(seed);
      for (let index = 0; index < 500; index += 1) {
        const value = randomValue(random);
        const text = canonicalize(value);
        const reparsed = parseCanonical(text);
        const intact =
          text === referenceText(value) &&
          validateCanonical(value).length === 0 &&
          canonicalize(reparsed) === text &&
          canonicalize(copyCanonical(value)) === text &&
          Bun.deepEquals(reparsed, value);
        if (!intact) failures.push(text);
      }
    }
    expect(failures).toEqual([]);
  });

  test("a one-character mutation is rejected or is itself canonical", () => {
    const failures: string[] = [];
    const outcomes = { accepted: 0, rejected: 0 };
    for (const seed of SEEDS) {
      const random = new Sfc32(seed);
      for (let index = 0; index < 250; index += 1) {
        const text = canonicalize(randomValue(random));
        for (let round = 0; round < 8; round += 1) {
          const mutated = mutate(random, text);
          const outcome = parseOutcome(mutated);
          if (outcome === "broken") failures.push(mutated);
          else outcomes[outcome] += 1;
        }
      }
    }
    expect(failures).toEqual([]);
    // Both outcomes occur, so neither half of the property holds vacuously.
    expect(outcomes.accepted).toBeGreaterThan(100);
    expect(outcomes.rejected).toBeGreaterThan(100);
  });

  test("the NFC check agrees with normalize for values and keys", () => {
    const mismatches: string[] = [];
    let normalized = 0;
    let notNormalized = 0;
    let normalizedAboveFastPath = 0;
    const random = new Sfc32(3);
    for (let index = 0; index < 20_000; index += 1) {
      const text = randomText(random, 5);
      const isNfc = text.normalize("NFC") === text;
      const valueAccepted = validateCanonical(text).length === 0;
      const keyAccepted = validateCanonical({ [text]: 0 }).length === 0;
      if (valueAccepted !== isNfc || keyAccepted !== isNfc) mismatches.push(text);
      if (!isNfc) notNormalized += 1;
      else if (reachesCombiningMarks(text)) normalizedAboveFastPath += 1;
      else normalized += 1;
    }
    expect(mismatches).toEqual([]);
    expect(Math.min(normalized, notNormalized, normalizedAboveFastPath)).toBeGreaterThan(1000);
  });

  test("text below U+0300 is always NFC, so the fast path never needs normalize", () => {
    const random = new Sfc32(4);
    const rejected: string[] = [];
    for (let index = 0; index < 20_000; index += 1) {
      const text = randomText(random, 8, FAST_PATH_RANGES);
      if (text.normalize("NFC") !== text || validateCanonical(text).length > 0) rejected.push(text);
    }
    expect(rejected).toEqual([]);
  });
});
