import { beings, type DeepReadonly, type mind } from "@open-origin/engine";
import { type Being, sensesOf } from "./senses.ts";

/**
 * Senses of beings@2 built by hand for the tests of `mind@1`: the senses of T4 that senses.ts
 * builds, with the six traits, the beings perceived and the messages heard at the decision, and
 * the view of the being's mind, as docs/architecture/mind.md ("Perception") gives them to a brain.
 */

export type Senses2 = DeepReadonly<beings.Senses2>;

/** The species of the default laws of life@2, whose laws `mind@1` is built with. */
export const SPECIES2 = beings.defaultLife2().species[0] as beings.Species2;

/** The day of the default genesis, in seconds. */
export const DAY = 75_600;

/** What a test sets of a decision of beings@2, beyond the senses of T4. */
export type Being2 = Being & {
  readonly social?: {
    readonly sociability?: number;
    readonly credulity?: number;
    readonly retention?: number;
  };
  readonly seen?: readonly beings.PerceivedBeing[];
  readonly heard?: readonly beings.HeardMessage[];
  readonly mind?: Partial<mind.MindView>;
};

/** The senses of `being` in `window`, with neutral new traits and an empty mind unless it sets them. */
export function senses2Of(window: beings.SensedWindow, being: Being2 = {}): Senses2 {
  const base = sensesOf(window, being);
  const social = { sociability: 1000, credulity: 1000, retention: 1000, ...being.social };
  const view: mind.MindView = { next: 1, episodes: [], beliefs: [], relations: [], ...being.mind };
  return {
    ...base,
    self: { ...base.self, traits: { ...base.self.traits, ...social } },
    perceived: { beings: being.seen ?? [], heard: being.heard ?? [] },
    mind: view,
  };
}

/** A perceived being `id` at `cell`, doing `activity`. */
export function seenBeing(
  id: number,
  cell: readonly [number, number],
  activity = "idle",
): beings.PerceivedBeing {
  return { id, species: "s1", cell: [cell[0], cell[1]], activity };
}

/** A relationship of the view with `who`, never addressed unless `talk` and `turns` say so. */
export function relationView(
  id: number,
  who: number,
  rest: Partial<mind.RelationshipView> = {},
): mind.RelationshipView {
  return { id, who, f: 0, seen: 0, aff: 0, tr: 500, turns: 0, ...rest };
}
