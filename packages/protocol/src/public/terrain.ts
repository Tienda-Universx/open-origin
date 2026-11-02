/**
 * TerrainPublic (ADR 0026): the terrain of one chunk as the public sees it. It holds only the
 * observables whose exposure is `surface` and that vary from cell to cell (worldgen's
 * observables.ts): `elevation`, `liquid.depth` (here `liquidDepth`), and `substrate`. Radiance is a
 * surface observable too, but it is equal in every cell and follows the clock, so it is not sent;
 * thermal values and deposits take measuring, and stay out.
 *
 * Each observable is one field of its 1,024 cells, row by row (cell x + 32·y of the chunk), as the
 * canonical Base64 of their little-endian integers: `width` bytes each, the narrowest width of 1,
 * 2, or 4 that the observable's declared range for the world allows (signed for elevation,
 * unsigned for the others). The range is the world's, never the chunk's, so the width says nothing
 * of one chunk. A substrate is one byte, a code of SUBSTRATE_CODES.
 */
import { z } from "zod";
import { base64Length, decodeBase64, encodeBase64 } from "./base64.ts";
import { CHUNK_AREA, SUBSTRATE_CODES } from "./constants.ts";

/** A width a field's values may take, in bytes. */
export const TERRAIN_WIDTHS = Object.freeze([1, 2, 4] as const);
export type TerrainWidth = (typeof TERRAIN_WIDTHS)[number];

/** An inclusive range of integers. */
export type IntRange = { readonly min: number; readonly max: number };

/** The values of one field: whether they are signed, and the range of each width. */
const WIDTH_RANGES: Readonly<Record<"signed" | "unsigned", Record<TerrainWidth, IntRange>>> = {
  signed: {
    1: { min: -0x80, max: 0x7f },
    2: { min: -0x8000, max: 0x7fff },
    4: { min: -0x8000_0000, max: 0x7fff_ffff },
  },
  unsigned: {
    1: { min: 0, max: 0xff },
    2: { min: 0, max: 0xffff },
    4: { min: 0, max: 0xffff_ffff },
  },
};

/** Whether each field is signed. */
const SIGNED = Object.freeze({ elevation: true, liquidDepth: false, substrate: false } as const);

/** A field's name. */
export type TerrainFieldName = keyof typeof SIGNED;

/** Whether `field`, a field of `width` bytes per cell, is the canonical Base64 of 1,024 cells. */
function isFieldOf(width: TerrainWidth, data: string): boolean {
  return data.length === base64Length(CHUNK_AREA * width) && decodeBase64(data) !== undefined;
}

/** A field of 1,024 cells of `width` bytes each. */
const TerrainField = z
  .strictObject({ width: z.literal(TERRAIN_WIDTHS), data: z.string() })
  .refine(({ width, data }) => isFieldOf(width, data), {
    message: "the data must be the canonical Base64 of 1,024 cells of the field's width",
  });

/** Whether every byte of `data` is a substrate code. */
function holdsSubstrateCodes(data: string): boolean {
  const bytes = decodeBase64(data);
  return bytes?.every((code) => code < SUBSTRATE_CODES.length) ?? false;
}

/** The substrate field: one byte per cell, each a code of SUBSTRATE_CODES. */
const SubstrateField = z
  .strictObject({ width: z.literal(1), data: z.string() })
  .refine(({ data }) => isFieldOf(1, data) && holdsSubstrateCodes(data), {
    message: "the data must be the canonical Base64 of 1,024 substrate codes",
  });

/** The schema of TerrainPublic. */
export const TerrainPublic = z.strictObject({
  elevation: TerrainField,
  liquidDepth: TerrainField,
  substrate: SubstrateField,
});
export type TerrainPublic = z.output<typeof TerrainPublic>;

/** The values of a chunk's fields, 1,024 each, and the world's declared range of each field. */
export type TerrainValues = Readonly<Record<TerrainFieldName, ArrayLike<number>>>;
export type TerrainRanges = Readonly<Record<TerrainFieldName, IntRange>>;

/**
 * The narrowest width whose integers hold every value of `range`, signed or not. Throws a
 * RangeError when no width holds it, or when the range is empty.
 */
export function terrainWidth(range: IntRange, signed: boolean): TerrainWidth {
  if (!(range.min <= range.max)) throw new RangeError("the range is empty");
  const ranges = WIDTH_RANGES[signed ? "signed" : "unsigned"];
  const width = TERRAIN_WIDTHS.find(
    (w) => range.min >= ranges[w].min && range.max <= ranges[w].max,
  );
  if (width === undefined) throw new RangeError("no width of 1, 2, or 4 bytes holds the range");
  return width;
}

/** An encoded field: its width, and the Base64 of its cells. */
type EncodedField = { width: TerrainWidth; data: string };

/** The field `name` of `values`, as wide as `range` asks; throws when a value leaves `range`. */
function encodeField(
  name: TerrainFieldName,
  values: ArrayLike<number>,
  range: IntRange,
): EncodedField {
  if (values.length !== CHUNK_AREA) throw new RangeError(`${name} must have ${CHUNK_AREA} cells`);
  const width = name === "substrate" ? 1 : terrainWidth(range, SIGNED[name]);
  const view = new DataView(new ArrayBuffer(CHUNK_AREA * width));
  for (let cell = 0; cell < CHUNK_AREA; cell += 1) {
    const value = values[cell];
    if (value === undefined || !Number.isInteger(value) || value < range.min || value > range.max) {
      throw new RangeError(`${name} of cell ${cell} lies outside the field's declared range`);
    }
    if (width === 1) view.setUint8(cell, value & 0xff);
    else if (width === 2) view.setUint16(2 * cell, value & 0xffff, true);
    else view.setUint32(4 * cell, value >>> 0, true);
  }
  return { width, data: encodeBase64(new Uint8Array(view.buffer)) };
}

/**
 * The TerrainPublic of a chunk whose fields hold `values`, each field as wide as the world's
 * declared range of it in `ranges` asks. Throws a RangeError when a field does not have 1,024
 * cells, a value is not an integer in its range, a range fits no width, or the substrate range
 * leaves SUBSTRATE_CODES.
 */
export function encodeTerrain(values: TerrainValues, ranges: TerrainRanges): TerrainPublic {
  if (ranges.substrate.min < 0 || ranges.substrate.max >= SUBSTRATE_CODES.length) {
    throw new RangeError("the substrate range must lie within SUBSTRATE_CODES");
  }
  // The schema checks the encoding once more, and gives the result its type.
  return TerrainPublic.parse({
    elevation: encodeField("elevation", values.elevation, ranges.elevation),
    liquidDepth: encodeField("liquidDepth", values.liquidDepth, ranges.liquidDepth),
    substrate: encodeField("substrate", values.substrate, ranges.substrate),
  });
}

/** The decoded fields of a TerrainPublic: 1,024 cells each, row by row. */
export type DecodedTerrain = {
  readonly elevation: Int32Array;
  readonly liquidDepth: Uint32Array;
  readonly substrate: Uint8Array;
};

/** The 1,024 values of `field`, as integers of their signedness. */
function decodeField(field: EncodedField, signed: boolean): number[] {
  const bytes = decodeBase64(field.data);
  if (bytes?.length !== CHUNK_AREA * field.width) {
    throw new RangeError("a terrain field must be the canonical Base64 of 1,024 cells");
  }
  const view = new DataView(bytes.buffer);
  return Array.from({ length: CHUNK_AREA }, (_, cell) => {
    if (field.width === 1) return signed ? view.getInt8(cell) : view.getUint8(cell);
    if (field.width === 2) {
      return signed ? view.getInt16(2 * cell, true) : view.getUint16(2 * cell, true);
    }
    return signed ? view.getInt32(4 * cell, true) : view.getUint32(4 * cell, true);
  });
}

/** The fields of `terrain`, a TerrainPublic the schema accepted. */
export function decodeTerrain(terrain: TerrainPublic): DecodedTerrain {
  return {
    elevation: Int32Array.from(decodeField(terrain.elevation, SIGNED.elevation)),
    liquidDepth: Uint32Array.from(decodeField(terrain.liquidDepth, SIGNED.liquidDepth)),
    substrate: Uint8Array.from(decodeField(terrain.substrate, SIGNED.substrate)),
  };
}
