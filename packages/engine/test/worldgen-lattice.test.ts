import { describe, expect, test } from "bun:test";
import { floorDiv } from "../src/int.ts";
import { CHACHA20_BLOCK_WORDS, CHACHA20_INPUT_WORDS, ChaCha20Key } from "../src/rng/chacha.ts";
import {
  LATTICE_PURPOSES,
  NOISE_PURPOSES,
  setLatticeField,
  setLatticePoint,
  setOffsetInput,
} from "../src/worldgen/lattice.ts";
import { MAX_CELL, MIN_CELL } from "../src/worldgen/space.ts";
import { BROKEN_VARIANTS, type BrokenVariant, FAITHFUL_PARTS } from "./support/broken-worldgen.ts";
import { type LatticeUse, latticeUses, packingCollisions } from "./support/worldgen-checks.ts";

/**
 * The input words of terrain's pseudorandom function (ADR 0021, randomness for terrain; plan §12,
 * test 4): a fixed table of purposes, an injective packing of (purpose, octave, x, y), and no two
 * fields sharing a block.
 */

/** The words lattice.ts writes for `use`. */
function wordsOf(use: LatticeUse): number[] {
  const input = new Uint32Array(CHACHA20_INPUT_WORDS);
  FAITHFUL_PARTS.pack(input, use);
  return [...input];
}

/** The int32 whose two's complement is the u32 `word`. */
function int32Of(word: number): number {
  return word >= 2 ** 31 ? word - 2 ** 32 : word;
}

/**
 * A left inverse of the packing: the use that the words `words` name. Its existence proves the
 * packing injective on every use it recovers.
 */
function useOf(words: readonly number[]): LatticeUse {
  const [first, octave, third, fourth] = words as [number, number, number, number];
  if (first === LATTICE_PURPOSES.octaveOffset) return { kind: "offset", purpose: third, octave };
  return { kind: "point", purpose: first, octave, x: int32Of(third), y: int32Of(fourth) };
}

describe("purposes", () => {
  test("are the fixed table of small integers, frozen at every level", () => {
    expect(LATTICE_PURPOSES).toEqual({
      octaveOffset: 0,
      elevation: 1,
      thermal: 2,
      substrate: 3,
      deposits: [4, 5, 6, 7, 8, 9, 10, 11],
    });
    expect(Object.isFrozen(LATTICE_PURPOSES)).toBe(true);
    expect(Object.isFrozen(LATTICE_PURPOSES.deposits)).toBe(true);
  });

  test("are distinct, one per use, with 8 deposit kinds", () => {
    const { octaveOffset, elevation, thermal, substrate, deposits } = LATTICE_PURPOSES;
    const all = [octaveOffset, elevation, thermal, substrate, ...deposits];
    expect(new Set(all).size).toBe(all.length);
    expect(deposits).toHaveLength(8);
  });

  test("of noise fields exclude the offsets and the substrate, whose draws are not noise", () => {
    expect(NOISE_PURPOSES).toEqual([1, 2, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(Object.isFrozen(NOISE_PURPOSES)).toBe(true);
    expect(NOISE_PURPOSES).not.toContain(LATTICE_PURPOSES.octaveOffset);
    expect(NOISE_PURPOSES).not.toContain(LATTICE_PURPOSES.substrate);
  });
});

describe("packing", () => {
  test("writes purpose, octave, and the two's complement of each lattice coordinate", () => {
    const input = new Uint32Array(CHACHA20_INPUT_WORDS);
    setLatticeField(input, LATTICE_PURPOSES.thermal, 5);
    setLatticePoint(input, -1, 7);
    expect([...input]).toEqual([2, 5, 0xffff_ffff, 7]);
    setLatticePoint(input, -(2 ** 31), 2 ** 31 - 1);
    expect([...input]).toEqual([2, 5, 0x8000_0000, 0x7fff_ffff]);
  });

  test("writes the point words without touching the field words, so a field is set once", () => {
    const input = new Uint32Array(CHACHA20_INPUT_WORDS);
    setLatticeField(input, LATTICE_PURPOSES.elevation, 3);
    setLatticePoint(input, 10, -20);
    setLatticePoint(input, 11, -21);
    expect([...input]).toEqual([1, 3, 11, 2 ** 32 - 21]);
  });

  test("names an octave's offsets with the offset purpose, the octave, and the field's purpose", () => {
    const input = new Uint32Array(CHACHA20_INPUT_WORDS).fill(9);
    setOffsetInput(input, LATTICE_PURPOSES.deposits[7] as number, 11);
    expect([...input]).toEqual([0, 11, 11, 0]);
  });

  test("is injective: the left inverse recovers every use of the domain", () => {
    let uses = 0;
    for (const use of latticeUses()) {
      expect(useOf(wordsOf(use))).toEqual(use);
      uses += 1;
    }
    // 11 purposes × 12 octaves × (1 offset + 7 × 7 lattice points).
    expect(uses).toBe(11 * 12 * 50);
  });

  test("gives no two uses of the domain the same words", () => {
    expect(packingCollisions(FAITHFUL_PARTS.pack)).toEqual([]);
  });

  test("the collision check catches a packing that adds the purpose and the octave", () => {
    const variant = BROKEN_VARIANTS.find(({ name }) => name === "purpose collision");
    expect(variant).toBeDefined();
    expect(packingCollisions((variant as BrokenVariant).parts.pack)).not.toEqual([]);
  });
});

describe("fields at the same octave and lattice point", () => {
  const key = new ChaCha20Key([1, 2, 3, 4, 5, 6, 7, 8]);
  const blockOf = (use: LatticeUse) => {
    const input = new Uint32Array(CHACHA20_INPUT_WORDS);
    FAITHFUL_PARTS.pack(input, use);
    const block = new Uint32Array(CHACHA20_BLOCK_WORDS);
    key.blockInto(input, block);
    return [...block].join(",");
  };

  test.each([
    [0, 0, 0],
    [3, -5, 9],
    [11, 2 ** 28, -(2 ** 28)],
  ])("never share a block (octave %d, point %d,%d)", (octave, x, y) => {
    const purposes = [...NOISE_PURPOSES, LATTICE_PURPOSES.substrate];
    const blocks = purposes.map((purpose) => blockOf({ kind: "point", purpose, octave, x, y }));
    const offsets = NOISE_PURPOSES.map((purpose) => blockOf({ kind: "offset", purpose, octave }));
    const all = [...blocks, ...offsets];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("lattice coordinates", () => {
  // An octave's offset is below its wavelength, and the upper corner of a lattice cell is its
  // lower one plus 1.
  test.each([8, 16, 1024, 2 ** 16])(
    "fit int32 at the world's edges for wavelength %d",
    (wavelength) => {
      const lowest = floorDiv(MIN_CELL, wavelength);
      const highest = floorDiv(MAX_CELL + wavelength - 1, wavelength) + 1;
      expect(lowest).toBeGreaterThanOrEqual(-(2 ** 31));
      expect(highest).toBeLessThanOrEqual(2 ** 31 - 1);
      expect(lowest).toBeGreaterThanOrEqual(-(2 ** 28));
      expect(highest).toBeLessThanOrEqual(2 ** 28 + 1);
    },
  );
});
