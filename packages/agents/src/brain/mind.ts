/**
 * The brain `mind@1` (ADR 0024, docs/architecture/mind.md "The brain mind@1"): a brain of beings@2
 * that composes `utility@1` without changing it. At every decision it asks `utility@1` for its
 * plan, and adds the mental operations of memory.ts: what it hears, what it sees of what it
 * believes, and what it sees anew.
 *
 * It is a pure function of its senses, called without `this`: what it must find again travels in
 * its records and in what `utility@1` keeps; its laws are copied when it is built.
 */
import type { beings, DeepReadonly } from "@open-origin/engine";
import { brainLaws } from "./mind/laws.ts";
import { mentalOperations } from "./mind/memory.ts";
import { MIND_BEHAVIORS, MIND_BRAIN, MIND_CONCEPTS } from "./mind/parameters.ts";
import { utilityController } from "./utility.ts";

type Senses2 = DeepReadonly<beings.Senses2>;
type Intention2 = beings.Intention2;

/** What `mind@1` is built with: the laws of its species, and the seconds of its world's day. */
export type MindConfig = { readonly species: beings.Species2; readonly dayLength: number };

/**
 * The brain `mind@1` for a species of `config.species`, in a world whose day lasts
 * `config.dayLength` seconds. Throws EngineError("invalid_value") for a day that is not a positive
 * safe integer.
 */
export function mindController(config: MindConfig): beings.Controller2 {
  const laws = brainLaws(config.species, config.dayLength);
  const survival = utilityController();
  return Object.freeze({
    brain: MIND_BRAIN,
    behaviors: MIND_BEHAVIORS,
    concepts: MIND_CONCEPTS,
    decide: (senses: Senses2): Intention2 => {
      const base = survival.decide(senses);
      const ops = mentalOperations(senses, laws, {});
      return ops === undefined ? base : { ...base, mind: ops };
    },
  });
}
