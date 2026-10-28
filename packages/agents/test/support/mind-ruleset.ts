import { beings } from "@open-origin/engine";
import { life2With } from "../../../engine/test/support/beings2-world.ts";
import { mindController } from "../../src/index.ts";

/**
 * The ruleset of the determinism subject of `mind@1` (docs/architecture/mind.md, "Verification
 * plan"): beings@2 with the brain `mind@1` for the one species of SUBJECT_LIFE, in a world whose day
 * lasts SUBJECT_DAY seconds, the day of the engine's test genesis. The determinism suite's child
 * processes import this module by its path, so it keeps no state of its own: each call makes a
 * fresh ruleset with a fresh brain.
 */

/** The seconds of the test genesis' day: 100 ticks of 12 seconds. */
export const SUBJECT_DAY = 1200;

/**
 * The laws of the subject: the frozen laws of life@2, with two changes so that about a hundred
 * ticks hold what the suite cuts at: an episode's half-life of 120 seconds, so that episodes fade
 * within the run, and room for two beings in a chunk, so that a being that walks into a full one
 * loses the contest for room.
 */
export const SUBJECT_LIFE: beings.LifeConfig2 = life2With(
  (species) => ({
    ...species,
    mind: { ...species.mind, halfLife: { ...species.mind.halfLife, episode: 120 } },
  }),
  2,
);

/** The one species of SUBJECT_LIFE. */
export const SUBJECT_SPECIES = SUBJECT_LIFE.species[0] as beings.Species2;

/** `mind@1` as the subject builds it. */
export const subjectBrain = (): beings.Controller2 =>
  mindController({ species: SUBJECT_SPECIES, dayLength: SUBJECT_DAY });

/** The ruleset beings@2 with `controller` as the brain of the subject's species. */
export function rulesetOf(
  controller: beings.Controller2,
): ReturnType<typeof beings.createBeingsRuleset> {
  return beings.createBeingsRuleset({
    controllers: { [SUBJECT_SPECIES.id]: controller },
    rules: "beings@2",
  });
}

/** The subject's ruleset: beings@2 with one `mind@1` brain that every decision shares. */
export function mindRuleset(): ReturnType<typeof beings.createBeingsRuleset> {
  return rulesetOf(subjectBrain());
}

/**
 * A controller that asks `make` for a new brain at every decision and decides with it, so that
 * nothing one decision leaves in a brain can reach another: the fresh differential of the brain
 * `make` builds. A brain that is a pure function of its senses decides here exactly as when one
 * instance serves every decision (plan §6, "Pasar información entre seres del mismo tick").
 */
export function freshEach(make: () => beings.Controller2): beings.Controller2 {
  const { brain, behaviors, concepts } = make();
  return { brain, behaviors, concepts, decide: (senses) => make().decide(senses) };
}

/** The subject's ruleset with a fresh `mind@1` for every decision. */
export function freshMindRuleset(): ReturnType<typeof beings.createBeingsRuleset> {
  return rulesetOf(freshEach(subjectBrain));
}

/** Where the determinism suite's child processes find mindRuleset. */
export const MIND_RULESET = Object.freeze({
  module: import.meta.resolve("./mind-ruleset.ts"),
  name: "mindRuleset",
});
