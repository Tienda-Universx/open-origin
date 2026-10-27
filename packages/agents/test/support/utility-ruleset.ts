import { beings } from "@open-origin/engine";
import { utilityController } from "../../src/index.ts";

/**
 * The ruleset of the scenarios: the beings ruleset with the brain `utility@1` for the one species
 * of the default laws. The determinism suite's child processes import it by this path, so it keeps
 * no state of its own: each call makes a fresh ruleset with a fresh brain.
 */
export function utilityRuleset(): ReturnType<typeof beings.createBeingsRuleset> {
  const [species] = beings.defaultLife().species;
  if (species === undefined) throw new Error("the default laws of life have a species");
  return beings.createBeingsRuleset({ controllers: { [species.id]: utilityController() } });
}

/** Where the determinism suite's child processes find utilityRuleset. */
export const UTILITY_RULESET = Object.freeze({
  module: import.meta.resolve("./utility-ruleset.ts"),
  name: "utilityRuleset",
});
