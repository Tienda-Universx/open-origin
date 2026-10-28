/**
 * The laws `mind@1` decides by (docs/architecture/mind.md "Beliefs" and "The brain mind@1"): its
 * rules may read the laws of its species, and its acts must keep them, so the brain is built with
 * the laws of its species and the length of its world's day. It copies the few it reads into a
 * frozen record when it is built, so that nothing its host changes later reaches a decision.
 */
import { type beings, EngineError } from "@open-origin/engine";

/** What `mind@1` reads of the laws: its mind, its relationships, its speech, and its day. */
export type BrainLaws = {
  readonly mind: {
    readonly ops: number;
    readonly episodes: number;
    readonly beliefs: number;
    readonly pinLevel: number;
    readonly pins: number;
    readonly halfLife: { readonly episode: number; readonly belief: number };
  };
  readonly relations: { readonly delta: number };
  readonly speech: {
    readonly range: number;
    readonly turns: number;
    readonly gap: number;
    readonly cooldown: number;
    readonly perDay: number;
  };
  /** The concept its species perceives: the observable of its food deposit, all it may ask about. */
  readonly food: string;
  /** The seconds of its world's day, whose quota of speech it keeps. */
  readonly dayLength: number;
};

/**
 * The laws of `species` for `mind@1`, in a world whose day lasts `dayLength` seconds. Throws
 * EngineError("invalid_value") for a day that is not a positive safe integer.
 */
export function brainLaws(species: beings.Species2, dayLength: number): BrainLaws {
  if (!Number.isSafeInteger(dayLength) || dayLength < 1)
    throw new EngineError("invalid_value", [
      {
        path: "/dayLength",
        message: `the day must last a positive whole number of seconds, not ${dayLength}`,
      },
    ]);
  const { ops, episodes, beliefs, pinLevel, pins, halfLife } = species.mind;
  const { range, turns, gap, cooldown, perDay } = species.speech;
  return Object.freeze({
    mind: Object.freeze({
      ops,
      episodes,
      beliefs,
      pinLevel,
      pins,
      halfLife: Object.freeze({ episode: halfLife.episode, belief: halfLife.belief }),
    }),
    relations: Object.freeze({ delta: species.relations.delta }),
    speech: Object.freeze({ range, turns, gap, cooldown, perDay }),
    food: `obs.deposit.${species.diet.deposit}`,
    dayLength,
  });
}
