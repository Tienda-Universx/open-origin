import { beings } from "@open-origin/engine";
import { BEHAVIORS } from "../../src/brain/parameters.ts";
import { UTILITY_BRAIN, utilityController } from "../../src/index.ts";

/**
 * The mindless baseline of beings@2 (docs/architecture/mind.md, "Beliefs"): `utility@1`, unchanged,
 * as a brain of beings@2, which declares its five behaviors and the namespace of its concepts under
 * a brain version of its own. It forms no concept: the capture requires a namespace, so it declares
 * `none`, in which it defines none. It ignores what beings@2 adds to the senses, so it lives the
 * life `utility@1` lives on beings@1, which the baseline test checks.
 */

/** The brain version of the baseline, which the ruleset's brain version composes. */
export const MINDLESS_BRAIN = `mindless(${UTILITY_BRAIN})`;

/** The namespace of the baseline's concepts, of which it has none. */
export const MINDLESS_CONCEPTS = "none";

/** `utility@1` as a brain of beings@2: a fresh brain at every call, with no state of its own. */
export function mindlessUtility(): beings.Controller2 {
  const inner = utilityController();
  return Object.freeze({
    brain: MINDLESS_BRAIN,
    behaviors: BEHAVIORS,
    concepts: MINDLESS_CONCEPTS,
    decide: (senses: Parameters<beings.Controller2["decide"]>[0]) => inner.decide(senses),
  });
}

/** The ruleset beings@2 with the baseline for the one species of the default laws of life@2. */
export function mindlessRuleset(): ReturnType<typeof beings.createBeingsRuleset> {
  const [species] = beings.defaultLife2().species;
  if (species === undefined) throw new Error("the default laws of life@2 have a species");
  return beings.createBeingsRuleset({
    controllers: { [species.id]: mindlessUtility() },
    rules: "beings@2",
  });
}
