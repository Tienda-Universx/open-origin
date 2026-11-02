/**
 * The public terrain of a chunk (ADR 0026, "Projections and classification"; ADR 0025, "Planes and
 * the boundary"): `readTerrain`, a pure closure over the prepared genesis that the presentation
 * plane receives. It generates the chunk's terrain with worldgen, which never touches the world,
 * and returns only the observables whose exposure is `surface` and that vary from cell to cell:
 * elevation, liquid depth, and substrate, never the thermal bases or the deposits a TerrainChunk
 * also holds.
 */
import { worldgen } from "@open-origin/engine";
import {
  type ChunkCoord,
  encodeTerrain,
  type IntRange,
  type TerrainPublic,
} from "@open-origin/protocol/public";
import { deepFrozen } from "../world/published.ts";

/** The public terrain of a chunk. */
export type ReadTerrain = (chunk: ChunkCoord) => TerrainPublic;

/** The range of the observable `id` of `catalog`, which must be one the surface presents. */
function surfaceRange(catalog: readonly worldgen.Observable[], id: string): IntRange {
  const observable = catalog.find((entry) => entry.id === id);
  if (observable?.exposure !== "surface") {
    throw new Error(`the observable ${id} is not one the surface presents`);
  }
  return observable.range;
}

/**
 * The reader of the public terrain of the world whose genesis `prepared` holds. Each field is as
 * wide as the world's declared range of its observable asks (observableCatalog), never as one
 * chunk's values would. The liquid depth of a cell is max(0, L − elevation), with L the level of
 * liquid, as worldgen's observable `liquid.depth` measures it.
 */
export function terrainReader(prepared: worldgen.PreparedGenesis): ReadTerrain {
  const catalog = worldgen.observableCatalog(prepared);
  const ranges = Object.freeze({
    elevation: surfaceRange(catalog, "elevation"),
    liquidDepth: surfaceRange(catalog, "liquid.depth"),
    substrate: surfaceRange(catalog, "substrate"),
  });
  const level = worldgen.liquidLevel(worldgen.genesisOf(prepared));
  return ([x, y]) => {
    const { elevation, substrate } = worldgen.generateChunk(prepared, `${x},${y}`);
    const liquidDepth = Array.from(elevation, (height) => (height < level ? level - height : 0));
    return deepFrozen(encodeTerrain({ elevation, liquidDepth, substrate }, ranges));
  };
}
