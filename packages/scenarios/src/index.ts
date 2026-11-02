/**
 * The preregistered world recipes (ADR 0025): the scenarios of T4 (docs/architecture/beings.md,
 * "Preregistration") and of T5 (docs/architecture/mind.md, "Seeds and scenario"), each built from a
 * public label. Building a scenario runs no simulation. Unlike the engine and the brain, this
 * package is Bun-specific: it hashes labels with `Bun.CryptoHasher`.
 */

export {
  drawBeings2,
  LABELS2,
  SCENARIO2_RULESET,
  type Scenario2,
  type Scenario2Options,
  type SpawnPayload2,
  scenario2From,
  scenario2Of,
  scenario2Ruleset,
} from "./mind-scenario.ts";
export {
  AREA_SIDE,
  areaNeeds,
  BEINGS,
  drawBeings,
  drawIn,
  LABELS,
  type LabelSeeds,
  labelSeeds,
  SCENARIO_SPS,
  type Scenario,
  type ScenarioOptions,
  type ScenarioWorld,
  type SpawnArea,
  type SpawnPayload,
  scenarioFrom,
  scenarioOf,
  spawnCommand,
  type Terrain,
  terrainOf,
  terrainWith,
  type Variant,
  variantLife,
} from "./scenario.ts";
