/**
 * The mind layer (ADR 0024): propositions, records, taints, salience, forgetting, and the rules
 * that form beliefs, as pure functions of values the beings layer has already copied and bounded.
 * It imports only int.ts, errors.ts, and the modules under canonical/ and digest/, so it cannot read
 * the world, and it keeps no module state.
 */

export {
  ceilDiv,
  greatest,
  INT31_MAX,
  type IntRange,
  least,
  MIND_BOUNDS,
  within,
} from "./bounds.ts";
export {
  checkProposition,
  copyProposition,
  isConceptId,
  PROP_BOUNDS,
  PROP_VERSION,
  type Proposition,
  sameProposition,
  type Term,
} from "./prop.ts";
