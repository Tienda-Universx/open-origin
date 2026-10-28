/**
 * The rules of each version of the beings ruleset (ADR 0024, docs/architecture/mind.md "Versions
 * and compatibility"): one immutable object per version with its own lists, which every part of
 * the layer that differs between versions reads instead of a constant. beings@1 is exactly the
 * ruleset of T4; beings@2 adds three traits and a mind to a being, perception, and the capacity of
 * a chunk, and requires the laws of life@2. Nothing here is state: the objects are frozen data.
 */
import { compareCodeUnits } from "../canonical/order.ts";
import { LIFE_RULES, type LifeRules } from "./laws.ts";
import { LIFE2_RULES } from "./life2.ts";
import { type IntRange, range } from "./schema.ts";

/** The version of the beings ruleset of T4, and of the one with minds. */
export const BEINGS_RULESET_VERSION = "beings@1";
export const BEINGS2_RULESET_VERSION = "beings@2";

/** The streams the beings system draws from: the brains' draws and the contests over food. */
export const BRAIN_STREAM = "beings.brain";
export const CONTEST_STREAM = "beings.contest";
/** The contests for room in a chunk at capacity, and those over a full inbox (T5-6). */
export const CROWD_STREAM = "beings.crowd";
export const SPEECH_STREAM = "beings.speech";

/** A kind of activity of T4. */
export type ActivityKind = "eat" | "idle" | "sleep" | "walk";

/** What differs between the versions of the beings ruleset. */
export type BeingsRules = {
  /** The ruleset's version, which its snapshots record. */
  readonly version: string;
  /** The laws of life it requires. */
  readonly life: LifeRules;
  /** The traits of a being, in the order a scenario draws them and a spawn reads them. */
  readonly traits: readonly string[];
  /** The same traits, by name, as a being's record lists them. */
  readonly traitMembers: readonly string[];
  /** The members of a being, by name. */
  readonly members: readonly string[];
  /** The kinds of activity a being may do and a brain may plan. */
  readonly activities: readonly ActivityKind[];
  /** The streams the beings system declares. */
  readonly streams: readonly string[];
  /** How many beings a chunk may hold, whatever its laws: its validator cannot see them. */
  readonly chunkBeings: IntRange;
  /**
   * Whether a being holds a mind and perceives others, a brain declares its behaviors and
   * concepts, and a chunk has a capacity: beings@2.
   */
  readonly minds: boolean;
};

/** The traits of T4, in the order a scenario draws them. */
const TRAITS = Object.freeze(["appetite", "sleepiness", "curiosity"]);
/** The traits of beings@2, in the order a scenario draws them (mind.md, "Seeds and scenario"). */
const TRAITS2 = Object.freeze([...TRAITS, "sociability", "credulity", "retention"]);

/** The members of a being of T4, by name. */
const MEMBERS = Object.freeze([
  "activity",
  "anchor",
  "behavior",
  "born",
  "cell",
  "condition",
  "cooldowns",
  "health",
  "id",
  "needs",
  "outcome",
  "plan",
  "species",
  "stage",
  "traits",
  "wake",
  "wakeWhen",
]);

/** The kinds of activity of T4; beings@2 adds `talk` with speech (T5-6). */
const ACTIVITIES: readonly ActivityKind[] = Object.freeze(["eat", "idle", "sleep", "walk"]);

/** `names`, sorted by UTF-16 code units, in a frozen copy. */
function byName(names: readonly string[]): readonly string[] {
  return Object.freeze([...names].sort(compareCodeUnits));
}

/** The rules of beings@1: T4, unchanged. A chunk holds at most 2^16 beings. */
export const BEINGS_RULES: BeingsRules = Object.freeze({
  version: BEINGS_RULESET_VERSION,
  life: LIFE_RULES,
  traits: TRAITS,
  traitMembers: byName(TRAITS),
  members: MEMBERS,
  activities: ACTIVITIES,
  streams: Object.freeze([BRAIN_STREAM, CONTEST_STREAM]),
  chunkBeings: range(0, 0x1_0000),
  minds: false,
});

/** The rules of beings@2. A chunk holds at most the largest capacity a law allows. */
export const BEINGS2_RULES: BeingsRules = Object.freeze({
  version: BEINGS2_RULESET_VERSION,
  life: LIFE2_RULES,
  traits: TRAITS2,
  traitMembers: byName(TRAITS2),
  members: byName([...MEMBERS, "mind"]),
  activities: ACTIVITIES,
  streams: Object.freeze([BRAIN_STREAM, CONTEST_STREAM, CROWD_STREAM, SPEECH_STREAM]),
  chunkBeings: range(0, 1024),
  minds: true,
});

/** The versions a host may name, and their rules. */
export type BeingsVersion = typeof BEINGS_RULESET_VERSION | typeof BEINGS2_RULESET_VERSION;

/** The rules of `version`. */
export function rulesOf(version: BeingsVersion): BeingsRules {
  return version === BEINGS2_RULESET_VERSION ? BEINGS2_RULES : BEINGS_RULES;
}
