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
export { ageAt, type MindContext, type Moment, secondsSince } from "./context.ts";
export { familiarity, familiarSeconds, perceivedAgain } from "./familiarity.ts";
export { forget } from "./forget.ts";
export {
  checkMindLaws,
  defaultMindLaws,
  familiaritySaturation,
  MIND_LAW_BOUNDS,
  type MindLaws,
  type Ratio,
} from "./laws.ts";
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
export {
  ACTS,
  type Act,
  type BeingEpisode,
  type Belief,
  type Cell,
  type Episode,
  EVIDENCE,
  type ExternalEpisode,
  FAILURES,
  freeId,
  type HeardEpisode,
  type InboxMessage,
  type LocalId,
  type Mind,
  type MindRecord,
  newMind,
  type OwnEpisode,
  type Quota,
  type Relationship,
  recordOf,
  type TaintMask,
} from "./records.ts";
export { type Perceived, perceive, relationshipWith } from "./relations.ts";
export {
  beliefSalience,
  decay,
  episodeSalience,
  importanceWithin,
  isPinned,
  refreshEpisode,
  SALIENCE_HALVINGS,
  scaledHalfLife,
} from "./salience.ts";
export {
  type Admitted,
  admitBelief,
  admitEpisode,
  admitRelationship,
  type Unlinked,
  withoutRecords,
} from "./store.ts";
export {
  type BeliefView,
  type EpisodeView,
  type MindView,
  type RelationshipView,
  viewOf,
} from "./view.ts";
