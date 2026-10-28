/**
 * The laws of the mind and of relationships (ADR 0024): the parts `mind` and `relations` of a
 * species of life@2 (docs/architecture/mind.md, "Laws of life@2"). The beings layer reads them with
 * the rest of the laws; this module names their type, their defaults, and their bounds, including
 * the two that span several laws. Their seal and their other parts belong to the beings layer.
 */
import type { IssueSink } from "../canonical/value.ts";
import { ceilDiv } from "../int.ts";
import { INT31_MAX, type IntRange, MIND_BOUNDS, range, within } from "./bounds.ts";

/** A rate of `num` units per `den` simulated seconds, as the rates of T4. */
export type Ratio = { readonly num: number; readonly den: number };

export type MindLaws = {
  readonly mind: {
    /** Capacities: the most episodes, beliefs, relationships, and inbox messages a being holds. */
    readonly episodes: number;
    readonly beliefs: number;
    readonly relations: number;
    readonly inbox: number;
    /** Mental operations per decision. */
    readonly ops: number;
    /** The deepest inference: the largest depth of a belief. */
    readonly depth: number;
    /** Half-lives of salience, in seconds, before retention scales them. */
    readonly halfLife: { readonly episode: number; readonly belief: number };
    /** An episode whose salience falls below `floor` is forgotten. */
    readonly floor: number;
    /** An episode whose importance reaches `pinLevel` never fades; at most `pins` do. */
    readonly pinLevel: number;
    readonly pins: number;
    /** The importance a recall, or a citation, adds to an episode. */
    readonly recall: number;
  };
  readonly relations: {
    /** Familiarity per second of co-presence. */
    readonly rate: Ratio;
    /** The longest pause between two perceptions that still counts as co-presence, in seconds. */
    readonly gap: number;
    /** The half-life of familiarity in absence, in seconds; retention does not scale it. */
    readonly halfLife: number;
    /** The largest change of affinity or trust in one operation. */
    readonly delta: number;
  };
};

/** The bounds of each law. A rate's terms are bounded as the rates of T4 (beings/rates.ts). */
export const MIND_LAW_BOUNDS = Object.freeze({
  episodes: MIND_BOUNDS.episodes,
  beliefs: MIND_BOUNDS.beliefs,
  relations: MIND_BOUNDS.relations,
  inbox: MIND_BOUNDS.inbox,
  ops: range(0, 8),
  depth: MIND_BOUNDS.depth,
  halfLife: range(1, INT31_MAX),
  floor: range(0, 999),
  pinLevel: range(1, 1000),
  pins: range(0, 4),
  recall: range(0, 1000),
  rate: Object.freeze({ num: range(0, 0x10_0000), den: range(1, 0x1_0000_0000) }),
  gap: range(1, INT31_MAX),
  delta: range(0, 1000),
});

/**
 * The seconds of co-presence at which familiarity saturates, ⌈1000 / rate⌉, for a rate whose
 * numerator is positive.
 */
export function familiaritySaturation(rate: Ratio): number {
  return ceilDiv(1000 * rate.den, rate.num);
}

/** The defaults of the table, where calibration starts (T5-7). */
export function defaultMindLaws(): MindLaws {
  return {
    mind: {
      episodes: 8,
      beliefs: 8,
      relations: 6,
      inbox: 2,
      ops: 4,
      depth: 6,
      halfLife: { episode: 75_600, belief: 302_400 },
      floor: 50,
      pinLevel: 900,
      pins: 2,
      recall: 200,
    },
    relations: { rate: { num: 5, den: 36 }, gap: 600, halfLife: 756_000, delta: 200 },
  };
}

/** Reports `value` at `path` unless it is a safe integer within `bounds`; whether it is. */
function checkLaw(value: number, bounds: IntRange, path: string, sink: IssueSink): boolean {
  if (Number.isSafeInteger(value) && within(value, bounds)) return true;
  sink.report(path, `must be an integer from ${bounds.min} to ${bounds.max}`);
  return false;
}

/** Reports every problem of the part `mind`; the pin level must lie above the floor. */
function checkMindPart(laws: MindLaws["mind"], path: string, sink: IssueSink): void {
  const B = MIND_LAW_BOUNDS;
  for (const name of ["episodes", "beliefs", "relations", "inbox", "ops", "depth"] as const) {
    checkLaw(laws[name], B[name], `${path}/${name}`, sink);
  }
  checkLaw(laws.halfLife.episode, B.halfLife, `${path}/halfLife/episode`, sink);
  checkLaw(laws.halfLife.belief, B.halfLife, `${path}/halfLife/belief`, sink);
  const floor = checkLaw(laws.floor, B.floor, `${path}/floor`, sink);
  const pinLevel = checkLaw(laws.pinLevel, B.pinLevel, `${path}/pinLevel`, sink);
  checkLaw(laws.pins, B.pins, `${path}/pins`, sink);
  checkLaw(laws.recall, B.recall, `${path}/recall`, sink);
  if (floor && pinLevel && laws.pinLevel <= laws.floor) {
    sink.report(
      `${path}/pinLevel`,
      `${laws.pinLevel} is not above the floor (${laws.floor}): an episode is pinned only from an importance above the salience it is forgotten below`,
    );
  }
}

/**
 * Reports a rate whose terms leave their bounds, or whose familiarity would saturate beyond 2^22
 * seconds: the salience formula multiplies familiarity by the seconds within a half-life, below
 * 2^31, and the product must stay a safe integer.
 */
function checkRate(rate: Ratio, path: string, sink: IssueSink): void {
  const num = checkLaw(rate.num, MIND_LAW_BOUNDS.rate.num, `${path}/num`, sink);
  const den = checkLaw(rate.den, MIND_LAW_BOUNDS.rate.den, `${path}/den`, sink);
  if (!num || !den) return;
  if (rate.num === 0) {
    sink.report(
      path,
      "a rate of 0 never gives familiarity: the rate must be positive, so that familiarity saturates",
    );
    return;
  }
  const saturation = familiaritySaturation(rate);
  const most = MIND_BOUNDS.familiarity.max;
  if (saturation <= most) return;
  sink.report(
    path,
    `familiarity saturates at ⌈1000 / rate⌉ = ${saturation} seconds: at most ${most} (2^22), so every product of salience and familiarity stays a safe integer`,
  );
}

/** Reports every problem of the part `relations`. */
function checkRelationsPart(laws: MindLaws["relations"], path: string, sink: IssueSink): void {
  checkRate(laws.rate, `${path}/rate`, sink);
  checkLaw(laws.gap, MIND_LAW_BOUNDS.gap, `${path}/gap`, sink);
  checkLaw(laws.halfLife, MIND_LAW_BOUNDS.halfLife, `${path}/halfLife`, sink);
  checkLaw(laws.delta, MIND_LAW_BOUNDS.delta, `${path}/delta`, sink);
}

/**
 * Reports to `sink` every problem of the laws `laws`, at paths from `path` (the species that holds
 * them): a law outside its bounds, a pin level at or below the floor, and a rate whose familiarity
 * saturates beyond 2^22 seconds. `laws` has the shape of MindLaws, as the beings layer read it.
 */
export function checkMindLaws(laws: MindLaws, path: string, sink: IssueSink): void {
  checkMindPart(laws.mind, `${path}/mind`, sink);
  checkRelationsPart(laws.relations, `${path}/relations`, sink);
}
