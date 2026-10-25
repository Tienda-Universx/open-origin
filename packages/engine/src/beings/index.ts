/**
 * The beings layer (ADR 0023): the body of the beings, whose laws the engine applies, above
 * worldgen. Brains live in packages/agents and only propose.
 */
export {
  type Activity,
  BEING_BOUNDS,
  type Behavior,
  type Being,
  beingIssues,
  type Cell,
  type Cooldown,
  MAX_TICK,
  type Outcome,
  type PlanStep,
  RESULTS,
  type WakeConditions,
} from "./being.ts";
export { type BeingsChunk, beingsChunkIssues, CHUNK_BOUNDS, dueOf } from "./chunk.ts";
export {
  type Controller,
  DIRECTIONS,
  type Intention,
  MAX_INTENTION_STEPS,
  MAX_WALK_STEPS,
  type SensedWindow,
  type Senses,
} from "./contracts.ts";
export { type Depletion, takenAt } from "./food.ts";
export {
  checkLife,
  defaultLife,
  LIFE_BOUNDS,
  LIFE_VERSION,
  type LifeConfig,
  lifeSeal,
  type NutritionLaw,
  type RestLaw,
  type Species,
  STAGES,
  sealedLifeIssues,
  sealLife,
} from "./laws.ts";
export { insertOccupied, OCCUPANCY_BOUNDS, occupancyIssues, pruneOccupancy } from "./occupancy.ts";
export {
  ceilDiv,
  levelAt,
  NEED_MAX,
  RATIO_BOUNDS,
  type Ratio,
  scaledFloor,
  secondsToReach,
  type Trend,
} from "./rates.ts";
