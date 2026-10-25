/**
 * The beings layer (ADR 0023): the body of the beings, whose laws the engine applies, above
 * worldgen. Brains live in packages/agents and only propose.
 */
export { type Depletion, takenAt } from "./food.ts";
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
