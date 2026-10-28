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
  type Being2,
  beingIssues,
  type Cell,
  type Cooldown,
  type CooldownRequest,
  MAX_TICK,
  type Outcome,
  type PlanStep,
  RESULTS,
  type Traits,
  type Traits2,
  type WakeConditions,
} from "./being.ts";
export { type Body, bodyAt } from "./body.ts";
export { type BeingsChunk, beingsChunkIssues, CHUNK_BOUNDS, dueOf } from "./chunk.ts";
export {
  BEING_CLASSES,
  type ClassKind,
  type ClassMember,
  type ClassNode,
  COMMAND_CLASSES,
  type DataClass,
  EVENT_CLASSES,
} from "./classes.ts";
export {
  type Controller,
  type Controller2,
  DIRECTIONS,
  type HeardMessage,
  type Intention,
  type Intention2,
  MAX_INTENTION_STEPS,
  MAX_WALK_STEPS,
  type MindIntention,
  type SensedWindow,
  type Senses,
  type Senses2,
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
export type { PerceivedBeing } from "./perception.ts";
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
  BEINGS2_RULESET_VERSION,
  type BeingsVersion,
  CROWD_STREAM,
} from "./rules.ts";
export {
  type Beings2RulesetOptions,
  type BeingsRulesetOptions,
  beingsGlobal,
  createBeingsRuleset,
} from "./ruleset.ts";
export { type SenseInput, senseWindow } from "./senses.ts";
