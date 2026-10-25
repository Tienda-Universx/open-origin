/**
 * The public worldgen API (ADR 0021), exported by the engine as the `worldgen` namespace. The
 * readers that report to an issue sink and sharedGenesis are building blocks for worldgen's own
 * modules, so they are not exported here.
 */
export {
  CURVE_SCALE,
  type DayPosition,
  dayCurve,
  dayPosition,
  diurnal,
  type Instant,
  instantOf,
  radiance,
  timeLawIssues,
} from "./calendar.ts";
export {
  type DayLaw,
  type Deposit,
  defaultGenesis,
  GENESIS_BOUNDS,
  type Genesis,
  genesisIssues,
  genesisOf,
  genesisSeal,
  type IntRange,
  type Laws,
  type LiquidLaw,
  lightPeriod,
  PreparedGenesis,
  prepareGenesis,
  type RadianceLaw,
  type Ratio,
  type Relief,
  type Substrate,
  sealedGenesisIssues,
  sealOf,
  type TerrainParams,
  type ThermalLaw,
} from "./genesis.ts";
export {
  type CategoryObservable,
  type Observable,
  type ObservableExposure,
  type ObservableQuery,
  type ObservableUnit,
  type ObservableVariation,
  observableCatalog,
  observe,
  type QuantityDimension,
  type QuantityObservable,
} from "./observables.ts";
export {
  type CellCoord,
  CHUNK_CELLS,
  cellIndex,
  cellOffset,
  chunkFirstCell,
  chunkKeyIssues,
  chunkOfCell,
  MAX_CELL,
  MAX_CHUNK,
  MIN_CELL,
  MIN_CHUNK,
} from "./space.ts";
export {
  generateChunk,
  liquidLevel,
  type SurfaceRegion,
  sampleRegion,
  sampleSurface,
  type TerrainChunk,
  type TerrainRegion,
  terrainDigest,
} from "./terrain.ts";
export { WORLDGEN_VERSION } from "./version.ts";
