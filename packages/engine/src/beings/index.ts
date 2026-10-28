/**
 * The beings layer (ADR 0023): the body of the beings, whose laws the engine applies, above
 * worldgen. Brains live in packages/agents and only propose.
 */

export { REFUSED_IDLE_MS } from "./advance.ts";
export {
  type Activity,
  BEING_BOUNDS,
  type Behavior,
  type Being,
  beingIssues,
  type Cell,
  type Cooldown,
  type CooldownRequest,
  MAX_TICK,
  type Outcome,
  type PlanStep,
  RESULTS,
  type WakeConditions,
} from "./being.ts";
export { type Body, bodyAt } from "./body.ts";
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
export { type BeingsGlobal, BRAIN_STREAM, CONTEST_STREAM } from "./env.ts";
export { type Depletion, takenAt } from "./food.ts";
export {
  type Accepted,
  acceptIntention,
  type IntentionContext,
  type Refused,
} from "./intention.ts";
export {
  checkLife,
  defaultLife,
  LIFE_BOUNDS,
  LIFE_RULES,
  LIFE_VERSION,
  type LifeConfig,
  type LifeRules,
  lifeSeal,
  type NutritionLaw,
  type RestLaw,
  SLOWEST_STEP_INNER,
  type Species,
  STAGES,
  sealedLifeIssues,
  sealLife,
} from "./laws.ts";
export {
  checkLife2,
  defaultLife2,
  LIFE2_BOUNDS,
  LIFE2_RULES,
  LIFE2_VERSION,
  type LifeConfig2,
  lifeSeal2,
  type Perception,
  type Species2,
  type SpeechLaws,
  sealLife2,
} from "./life2.ts";
export { type LightClock, type LightWatch, nextLightTick } from "./light.ts";
export { minimumSteps, type StepGeometry, stepDuration } from "./locomotion.ts";
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
export {
  BEINGS_RULESET_VERSION,
  type BeingsRulesetOptions,
  beingsGlobal,
  createBeingsRuleset,
} from "./ruleset.ts";
export { type SenseInput, senseWindow } from "./senses.ts";
