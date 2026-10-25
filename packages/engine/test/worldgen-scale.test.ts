import { describe, expect, test } from "bun:test";
import type { ChunkCoord } from "../src/world/chunk.ts";
import { defaultGenesis, prepareGenesis } from "../src/worldgen/genesis.ts";
import { LATTICE_PURPOSES } from "../src/worldgen/lattice.ts";
import type { CellRect, NoiseSpec } from "../src/worldgen/noise.ts";
import { CHUNK_CELLS, chunkFirstCell, chunkOfCell } from "../src/worldgen/space.ts";
import {
  generateChunk,
  sampleRegion,
  type TerrainChunk,
  terrainDigest,
} from "../src/worldgen/terrain.ts";
import { Sfc32 } from "./support/sfc32.ts";
import {
  lipschitzBound,
  lipschitzProblems,
  type RegionSampler,
  type SeamSample,
  seamStatistics,
  type TerrainSampler,
  terrainCompositionProblems,
  valueAt,
} from "./support/worldgen-checks.ts";

/**
 * Worldgen at scale (plan §11, §12 tests 6, 9, and 10): a contiguous area of 24 × 24 = 576 chunks
 * around the origin, generated with the default genesis, keeps the properties that the terrain
 * tests check on a few chunks. Across all 23 × 2 seam lines the elevation stays within the noise's
 * Lipschitz bound, every chunk equals its part of the regions that tile the area, and the area is
 * the same generated column by column as row by row.
 *
 * It checks correctness only: the costs are the benchmark's (bench/worldgen.ts), never asserted
 * here. On the idle two-core Codespace with Bun 1.4.4, generating the area once costs about 0.3 to
 * 0.4 s, each test 0.5 to 0.9 s when run alone, and the whole file 1.25 to 1.45 s; with a full
 * `bun test` running beside it, the file took up to 3 s (2026-10-25, indicative).
 */

/** The area's side, in chunks, and its first chunk on each axis: chunks -12 to 11. */
const SIDE = 24;
const FIRST = -SIDE / 2;

/** The cells of the area: from -384 to 383 on each axis. */
const AREA: CellRect = {
  x: chunkFirstCell(FIRST),
  y: chunkFirstCell(FIRST),
  width: SIDE * CHUNK_CELLS,
  height: SIDE * CHUNK_CELLS,
};

/** The side of the regions that tile the area: the largest region sampleRegion accepts. */
const REGION_SIDE = 256;

/**
 * Each test's budget: about ten times the slowest test's cost on the idle Codespace, so that a
 * runner several times slower, or a loaded one, still passes.
 */
const TIMEOUT_MS = 10_000;

/** Eight seed words from `seed`, through sfc32. */
function seedWords(seed: number): number[] {
  const random = new Sfc32(seed);
  return Array.from({ length: 8 }, () => random.next());
}

const GENESIS = defaultGenesis(seedWords(24));
const PREPARED = prepareGenesis(GENESIS);

/** The spec that elevation samples, as terrain.ts builds it from the genesis. */
const RELIEF: NoiseSpec = { purpose: LATTICE_PURPOSES.elevation, ...GENESIS.terrain.relief };

/** The chunk coordinates of the area, row by row: y outer, x inner. */
const COORDS: readonly ChunkCoord[] = Array.from({ length: SIDE * SIDE }, (_, i) => ({
  x: FIRST + (i % SIDE),
  y: FIRST + Math.floor(i / SIDE),
}));

const keyOf = ({ x, y }: ChunkCoord) => `${x},${y}`;

/** The chunks of the area, generated in the order of `coords`, by key. */
function generateArea(coords: readonly ChunkCoord[]): Map<string, TerrainChunk> {
  return new Map(coords.map((coord) => [keyOf(coord), generateChunk(PREPARED, keyOf(coord))]));
}

let generatedByRows: Map<string, TerrainChunk> | undefined;

/** The area generated row by row, once for the file. */
function areaByRows(): Map<string, TerrainChunk> {
  generatedByRows ??= generateArea(COORDS);
  return generatedByRows;
}

/** The chunk `x`, `y` of `chunks`, which must hold it. */
function chunkAt(chunks: Map<string, TerrainChunk>, x: number, y: number): TerrainChunk {
  const chunk = chunks.get(keyOf({ x, y }));
  if (chunk === undefined) throw new RangeError(`the chunk ${x},${y} is outside the area`);
  return chunk;
}

/** The elevation of the area, row by row, composed from the rows of its chunks. */
function composedElevation(chunks: Map<string, TerrainChunk>): Int32Array {
  const values = new Int32Array(AREA.width * AREA.height);
  for (const { x, y } of COORDS) {
    const { elevation } = chunkAt(chunks, x, y);
    const column = chunkFirstCell(x) - AREA.x;
    const row = chunkFirstCell(y) - AREA.y;
    for (let j = 0; j < CHUNK_CELLS; j += 1) {
      const chunkRow = elevation.subarray(j * CHUNK_CELLS, (j + 1) * CHUNK_CELLS);
      values.set(chunkRow, (row + j) * AREA.width + column);
    }
  }
  return values;
}

/**
 * A sampler of the relief over any rect inside the area, read from `elevation`, the area's
 * composed elevation: the checks then see the chunks as generated, seams included. valueAt throws
 * for a cell outside the area.
 */
function composedSampler(elevation: Int32Array): RegionSampler {
  return (spec, rect) => {
    if (spec !== RELIEF) throw new Error("the composed elevation serves only the relief's spec");
    const values = new Int32Array(rect.width * rect.height);
    for (let j = 0; j < rect.height; j += 1) {
      for (let i = 0; i < rect.width; i += 1) {
        values[j * rect.width + i] = valueAt(elevation, AREA, rect.x + i, rect.y + j);
      }
    }
    return values;
  };
}

describe("an area of 24 × 24 chunks", () => {
  test(
    "its elevation stays within the Lipschitz bound across every seam of the 576 chunks",
    () => {
      const sampler = composedSampler(composedElevation(areaByRows()));
      expect(lipschitzProblems(sampler, RELIEF, AREA)).toEqual([]);
      // Each 2×2 block from every chunk but the last row and column: together they hold every seam.
      const samples: SeamSample[] = COORDS.filter(
        ({ x, y }) => x < FIRST + SIDE - 1 && y < FIRST + SIDE - 1,
      ).map(({ x, y }) => ({ sampler, x: chunkFirstCell(x), y: chunkFirstCell(y) }));
      const { seamMax, seamPairs, interiorMean } = seamStatistics(RELIEF, samples);
      // Each block holds 2 × 32 seam pairs along each axis.
      expect(seamPairs).toBe((SIDE - 1) ** 2 * 4 * CHUNK_CELLS);
      expect(seamMax).toBeGreaterThan(0);
      expect(seamMax).toBeLessThanOrEqual(lipschitzBound(RELIEF));
      expect(interiorMean).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );

  test(
    "every chunk equals its 32 × 32 cells of the 256 × 256 region that holds it, in every field",
    () => {
      const chunks = areaByRows();
      // Serves each chunk of the area as generateChunk made it, and each region from sampleRegion.
      const sampler: TerrainSampler = (rect) =>
        rect.width === CHUNK_CELLS
          ? chunkAt(chunks, chunkOfCell(rect.x), chunkOfCell(rect.y))
          : sampleRegion(PREPARED, rect);
      const perSide = AREA.width / REGION_SIDE;
      const chunksPerSide = REGION_SIDE / CHUNK_CELLS;
      for (let index = 0; index < perSide * perSide; index += 1) {
        const region = {
          x: AREA.x + (index % perSide) * REGION_SIDE,
          y: AREA.y + Math.floor(index / perSide) * REGION_SIDE,
          width: REGION_SIDE,
          height: REGION_SIDE,
        };
        const parts = Array.from({ length: chunksPerSide ** 2 }, (_, part) => ({
          x: region.x + (part % chunksPerSide) * CHUNK_CELLS,
          y: region.y + Math.floor(part / chunksPerSide) * CHUNK_CELLS,
          width: CHUNK_CELLS,
          height: CHUNK_CELLS,
        }));
        expect(terrainCompositionProblems(sampler, region, parts)).toEqual([]);
      }
    },
    TIMEOUT_MS,
  );

  test(
    "its chunks are the same generated column by column as row by row",
    () => {
      const byRows = areaByRows();
      const columnMajor = COORDS.map((_, i) => ({
        x: FIRST + Math.floor(i / SIDE),
        y: FIRST + (i % SIDE),
      }));
      const byColumns = generateArea(columnMajor);
      const digestsOf = (chunks: Map<string, TerrainChunk>) =>
        COORDS.map(({ x, y }) => terrainDigest(chunkAt(chunks, x, y)));
      const expected = digestsOf(byRows);
      expect(digestsOf(byColumns)).toEqual(expected);
      // Not vacuous: the two orders differ, and every chunk of the area is distinct.
      expect(columnMajor).not.toEqual(COORDS);
      expect(new Set(expected).size).toBe(SIDE * SIDE);
    },
    TIMEOUT_MS,
  );
});
