import { describe, expect, test } from "bun:test";
import { base64Length, decodeBase64, encodeBase64 } from "../src/public/base64.ts";
import {
  CHUNK_AREA,
  decodeTerrain,
  encodeTerrain,
  MAX_PART_BYTES,
  TerrainPublic,
  type TerrainRanges,
  type TerrainValues,
  type TerrainWidth,
  terrainWidth,
} from "../src/public/index.ts";
import { Random } from "./support/random.ts";

const bytesOf = (text: string) => Uint8Array.from(text, (character) => character.charCodeAt(0));

describe("Base64", () => {
  test("encodes the test vectors of RFC 4648, section 10", () => {
    const vectors = ["", "f", "fo", "foo", "foob", "fooba", "foobar"];
    expect(vectors.map((text) => encodeBase64(bytesOf(text)))).toEqual([
      "",
      "Zg==",
      "Zm8=",
      "Zm9v",
      "Zm9vYg==",
      "Zm9vYmE=",
      "Zm9vYmFy",
    ]);
    expect(vectors.map((text) => base64Length(text.length))).toEqual([0, 4, 4, 4, 8, 8, 8]);
  });

  test("decodes what it encodes, for random bytes of every length up to 64", () => {
    const random = new Random(0x5eed_0001);
    for (let length = 0; length <= 64; length += 1) {
      for (let run = 0; run < 4; run += 1) {
        const bytes = random.bytes(length);
        expect(decodeBase64(encodeBase64(bytes))).toEqual(bytes);
      }
    }
  });

  test("accepts only the canonical text: the length, the alphabet, padding, and zero bits", () => {
    const rejected = [
      "Zg=",
      "Zh==",
      "Zm9=",
      "Zg=a",
      "Z===",
      "Zg==Zg==",
      "Zm9v\n",
      "Zm-v",
      "Zm_v",
      "Zm9 ",
    ];
    expect(rejected.map(decodeBase64)).toEqual(rejected.map(() => undefined));
    expect(decodeBase64("Zm9v")).toEqual(bytesOf("foo"));
  });
});

describe("terrainWidth", () => {
  test("is the narrowest signed width that holds the range", () => {
    const signed: readonly (readonly [number, number, TerrainWidth])[] = [
      [-128, 127, 1],
      [-129, 0, 2],
      [0, 128, 2],
      [-32_768, 32_767, 2],
      [-32_769, 0, 4],
      [0, 32_768, 4],
      [-(2 ** 31), 2 ** 31 - 1, 4],
    ];
    for (const [min, max, width] of signed) expect(terrainWidth({ min, max }, true)).toBe(width);
  });

  test("is the narrowest unsigned width that holds the range", () => {
    const unsigned: readonly (readonly [number, number, TerrainWidth])[] = [
      [0, 255, 1],
      [0, 256, 2],
      [0, 65_535, 2],
      [0, 65_536, 4],
      [0, 2 ** 32 - 1, 4],
    ];
    for (const [min, max, width] of unsigned) expect(terrainWidth({ min, max }, false)).toBe(width);
  });

  test("throws when no width holds the range, or the range is empty", () => {
    expect(() => terrainWidth({ min: -(2 ** 31) - 1, max: 0 }, true)).toThrow(RangeError);
    expect(() => terrainWidth({ min: 0, max: 2 ** 31 }, true)).toThrow(RangeError);
    expect(() => terrainWidth({ min: 0, max: 2 ** 32 }, false)).toThrow(RangeError);
    expect(() => terrainWidth({ min: -1, max: 0 }, false)).toThrow(RangeError);
    expect(() => terrainWidth({ min: 1, max: 0 }, true)).toThrow(RangeError);
  });
});

/** The cells of a field: `value(cell)` for each of the 1,024. */
const field = (value: (cell: number) => number) =>
  Array.from({ length: CHUNK_AREA }, (_, cell) => value(cell));

/** A chunk whose fields reach both ends of the ranges below. */
const VALUES = {
  elevation: field((cell) => (cell % 2 === 0 ? -1_632_610_980 : 1_632_610_980 - cell)),
  liquidDepth: field((cell) => (cell === 7 ? 2_062_107_710 : cell)),
  substrate: field((cell) => cell % 16),
} satisfies TerrainValues;

/** The largest ranges worldgen's bounds allow (observables.ts): every field takes 4 bytes. */
const WIDEST: TerrainRanges = {
  elevation: { min: -1_632_610_980, max: 1_632_610_980 },
  liquidDepth: { min: 0, max: 2_062_107_710 },
  substrate: { min: 0, max: 15 },
};

describe("encodeTerrain and decodeTerrain", () => {
  test("round-trip the widest fields exactly, at 4, 4, and 1 bytes", () => {
    const terrain = encodeTerrain(VALUES, WIDEST);
    expect([terrain.elevation.width, terrain.liquidDepth.width, terrain.substrate.width]).toEqual([
      4, 4, 1,
    ]);
    const decoded = decodeTerrain(terrain);
    expect([...decoded.elevation]).toEqual([...VALUES.elevation]);
    expect([...decoded.liquidDepth]).toEqual([...VALUES.liquidDepth]);
    expect([...decoded.substrate]).toEqual([...VALUES.substrate]);
  });

  test("choose the width from the declared range, never from the chunk's values", () => {
    const flat = {
      elevation: field(() => 0),
      liquidDepth: field(() => 0),
      substrate: field(() => 0),
    };
    const narrow = encodeTerrain(flat, {
      elevation: { min: -100, max: 100 },
      liquidDepth: { min: 0, max: 60_000 },
      substrate: { min: 0, max: 3 },
    });
    expect([narrow.elevation.width, narrow.liquidDepth.width]).toEqual([1, 2]);
    expect([encodeTerrain(flat, WIDEST).elevation.width]).toEqual([4]);
  });

  test("round-trip negative values in every signed width", () => {
    for (const [min, max] of [
      [-128, 127],
      [-32_768, 32_767],
    ] as const) {
      const values = { ...VALUES, elevation: field((cell) => (cell % 2 === 0 ? min : max)) };
      const ranges = { ...WIDEST, elevation: { min, max } };
      expect([...decodeTerrain(encodeTerrain(values, ranges)).elevation]).toEqual([
        ...values.elevation,
      ]);
    }
  });

  test("the widest terrain takes 12,401 bytes of JSON, a fifth of a part", () => {
    const encoded = JSON.stringify(encodeTerrain(VALUES, WIDEST));
    expect(encoded.length).toBe(12_401);
    expect(encoded.length).toBeLessThan(MAX_PART_BYTES / 5);
  });

  test("reject a field without 1,024 cells, a value off its range, and a fraction", () => {
    const cases: TerrainValues[] = [
      { ...VALUES, elevation: VALUES.elevation.slice(0, CHUNK_AREA - 1) },
      { ...VALUES, liquidDepth: field(() => -1) },
      { ...VALUES, substrate: field(() => 16) },
      { ...VALUES, elevation: field(() => 0.5) },
      { ...VALUES, elevation: field(() => Number.NaN) },
    ];
    for (const values of cases) expect(() => encodeTerrain(values, WIDEST)).toThrow(RangeError);
  });

  test("reject a substrate range beyond the substrate codes", () => {
    const ranges = { ...WIDEST, substrate: { min: 0, max: 16 } };
    expect(() => encodeTerrain(VALUES, ranges)).toThrow(RangeError);
  });
});

describe("the TerrainPublic schema", () => {
  const valid = encodeTerrain(VALUES, WIDEST);

  test("accepts what encodeTerrain gives", () => {
    expect(TerrainPublic.safeParse(valid).success).toBe(true);
  });

  test("rejects an extra key, a missing field, and another width", () => {
    const { substrate: _, ...missing } = valid;
    const cases = [
      { ...valid, thermal: valid.elevation },
      missing,
      { ...valid, elevation: { ...valid.elevation, extra: 1 } },
      { ...valid, elevation: { ...valid.elevation, width: 3 } },
      { ...valid, elevation: { ...valid.elevation, width: 2 } },
      { ...valid, substrate: { ...valid.substrate, width: 4 } },
    ];
    expect(cases.map((terrain) => TerrainPublic.safeParse(terrain).success)).toEqual(
      cases.map(() => false),
    );
  });

  test("rejects data that is not the canonical Base64 of 1,024 cells", () => {
    const data = valid.liquidDepth.data;
    const cases = [
      data.slice(4),
      `${data}AAAA`,
      `${data.slice(0, -4)}AA!=`,
      `${data.slice(0, -2)}B=`,
      data.replace(/A/, "-"),
    ];
    const parsed = cases.map(
      (text) =>
        TerrainPublic.safeParse({ ...valid, liquidDepth: { width: 4, data: text } }).success,
    );
    expect(parsed).toEqual(cases.map(() => false));
  });

  test("rejects a substrate byte that is no substrate code", () => {
    const codes = new Uint8Array(CHUNK_AREA);
    codes[100] = 16;
    const substrate = { width: 1, data: encodeBase64(codes) };
    expect(TerrainPublic.safeParse({ ...valid, substrate }).success).toBe(false);
    codes[100] = 15;
    expect(
      TerrainPublic.safeParse({ ...valid, substrate: { width: 1, data: encodeBase64(codes) } })
        .success,
    ).toBe(true);
  });
});
