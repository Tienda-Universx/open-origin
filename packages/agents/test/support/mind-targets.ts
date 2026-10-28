import { type beings, mind } from "@open-origin/engine";

/**
 * The targets of calibration that the laws of life@2 decide alone (docs/architecture/mind.md,
 * "Targets of calibration"), computed with the engine's own laws of salience and familiarity:
 * when an episode of importance 500, never recalled, is forgotten; the familiarity of a being
 * perceived continuously for one day; and that familiarity after ten days of absence. Neutral
 * traits throughout.
 */
export type LawTargets = {
  /** The seconds after which the episode is forgotten: the first with salience below the floor. */
  readonly forgottenAfter: number;
  /** Familiarity after one day of continuous co-presence. */
  readonly familiarDay: number;
  /** That familiarity after ten days of absence. */
  readonly familiarAbsent: number;
};

/** The importance of the episode of the first target. */
const IMPORTANCE = 500;

/** The first second at which an episode of IMPORTANCE, never recalled, falls below the floor. */
function forgottenAfter(laws: mind.MindLaws): number {
  const halfLife = mind.scaledHalfLife(laws.mind.halfLife.episode, 1000);
  // decay never increases with time and is 0 after 30 half-lives: search that range.
  let low = 0;
  let high = 30 * halfLife;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (mind.decay(IMPORTANCE, middle, halfLife) < laws.mind.floor) high = middle;
    else low = middle + 1;
  }
  return low;
}

/**
 * The targets of `species` in a world whose day lasts `dayLength` seconds at `sps` seconds per
 * tick: the being is perceived at every tick that is a multiple of the largest number of ticks
 * within `relations.gap`, for one day, then not at all for ten.
 */
export function lawTargets(species: beings.Species2, dayLength: number, sps: number): LawTargets {
  const laws: mind.MindLaws = { mind: species.mind, relations: species.relations };
  const at = (tick: number): mind.MindContext => ({
    moment: { tick, secondsPerTick: sps },
    laws,
    retention: 1000,
    talkWindow: Math.max(species.speech.gap + 1, species.speech.cooldown),
  });
  const every = Math.max(1, Math.floor(species.relations.gap / sps));
  const day = Math.floor(dayLength / sps);
  let known: mind.Relationship = {
    id: 1,
    who: 2,
    f: 0,
    seen: 1,
    aff: 0,
    tr: 500,
    tn: 0,
    talk: 0,
    turns: 0,
  };
  for (let tick = 1 + every; tick <= 1 + day; tick += every)
    known = mind.perceivedAgain(known, at(tick));
  const last = known.seen;
  return {
    forgottenAfter: forgottenAfter(laws),
    familiarDay: mind.familiarity(known, at(last)),
    familiarAbsent: mind.familiarity(known, at(last + 10 * day)),
  };
}
