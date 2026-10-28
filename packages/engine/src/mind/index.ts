/**
 * The mind layer (ADR 0024): propositions, records, taints, salience, forgetting, and the rules
 * that form beliefs, as pure functions of values the beings layer has already copied and bounded.
 * It imports only int.ts, errors.ts, and the modules under canonical/ and digest/, so it cannot read
 * the world, and it keeps no module state.
 */

export {
  applyBeliefs,
  type BeliefChanges,
  type BeliefOperations,
  type BeliefsApplied,
  type BelieveOperation,
  LIVE_MANIFEST,
  type Manifest,
  type MindReason,
  type MindRefused,
  type ReviseOperation,
} from "./beliefs.ts";
export { INT31_MAX, type IntRange, MIND_BOUNDS } from "./bounds.ts";
export type { MindContext, Moment } from "./context.ts";
export { familiarity, familiarSeconds, perceivedAgain } from "./familiarity.ts";
export { forget } from "./forget.ts";
export { checkMind } from "./invariants.ts";
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
  refreshEpisode,
  scaledHalfLife,
} from "./salience.ts";
export { settle } from "./settle.ts";
export { type Admitted, admitEpisode, type Unlinked } from "./store.ts";
export {
  exposureAfterBelief,
  exposureAfterMessage,
  formedTaints,
  isReasoned,
  revisedTaints,
  TAINTS,
  type Taints,
  taintsOf,
} from "./taints.ts";
export {
  type BeliefView,
  type EpisodeView,
  type MindView,
  type RelationshipView,
  viewOf,
} from "./view.ts";
