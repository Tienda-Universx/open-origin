/**
 * The parameters of the brain `mind@1` (ADR 0024, docs/architecture/mind.md "The brain mind@1"):
 * the confidences of its rules, the floors of its policy, the importance it gives what it
 * remembers, and the measures of its social acts. They were calibrated together with the default
 * laws of life@2 on the calibration seeds only, and frozen with them (mind-freeze.test.ts);
 * changing any of them is a new calibration, which burns every held-out label already evaluated.
 */
import { BEHAVIORS } from "../parameters.ts";

/** The version of the brain, which the ruleset's brain version composes. */
export const MIND_BRAIN = "mind@1";

/** The namespace of the concepts `mind@1` forms (docs/architecture/mind.md, "Propositions"). */
export const MIND_CONCEPTS = "m1";

/** The one concept `mind@1` forms: the band of the food of its species' deposit at a cell. */
export const FOOD_AT = "m1.food-at";

/**
 * The behaviors `behavior.kind` may take: the five of `utility@1`, which `mind@1` keeps as they
 * are, then walking to food it believes in (`seek`), walking toward a being to greet it
 * (`approach`), an act of speech (`talk`), and the idle that waits for an answer (`wait`).
 */
export const MIND_BEHAVIORS: readonly string[] = Object.freeze([
  ...BEHAVIORS,
  "seek",
  "approach",
  "talk",
  "wait",
]);

/** The rules of the beliefs `mind@1` forms, as the ledger names them. */
export const RULE_IDS = Object.freeze({ seen: "seen-food", told: "told-food" });

/** The confidence of a belief in what the being saw: a band of food, seen or seen again. */
export const SEEN_CR = 900;

/** The confidence of a belief whose cell the being saw with another band. */
export const CONTRADICTED_CR = 100;

/** The confidence a testimony starts from, by the speaker's band: unsure, fairly sure, sure. */
export const TOLD_CR: readonly number[] = Object.freeze([300, 600, 800]);

/** The band of a message that carries none, a research injection's: the middle one. */
export const UNSPOKEN_BAND = 1;

/** The trust of a being the mind does not know: that of a new relationship, which the engine gives. */
export const STRANGER_TRUST = 500;

/** A testimony is believed only from this confidence. */
export const TESTIMONY_FLOOR = 500;

/** A being tells a belief, and walks to the food it believes in, only from this confidence. */
export const TELL_FLOOR = 500;

/** The importance of what the being remembers: a food cue, a message, and a being it met. */
export const FOOD_W = 500;
export const HEARD_W = 600;
export const BEING_W = 400;

/** No new food belief is formed within this many cells of a food it already believes in. */
export const LANDMARK_SPACING = 12;

/** The change of trust in a speaker when the being checks its testimony against what it sees. */
export const TRUST_STEP = 100;

/** How long, in simulated milliseconds, a being waits idle for an answer after it spoke. */
export const WAIT_MS = 60_000;

/** The will to speak, in permille, felt through sociability: the chance of an unprompted act. */
export const SPEAK_WILL = 800;

/** How many cells away a being walks to greet another, felt through sociability. */
export const APPROACH_REACH = 8;
