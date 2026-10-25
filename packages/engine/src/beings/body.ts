/**
 * The physiology of a being (ADR 0023, L0): which rate moves each of its needs and its health, given
 * what it is doing; their values at a tick, in closed form from the being's anchor; and the first
 * tick at which one of them reaches a level that changes what happens to the being. Rates change
 * only at those ticks, so between two of them every value follows one rate.
 */
import { simSeconds, type Tick } from "../time/tick.ts";
import type { DeepReadonly } from "../world/contracts.ts";
import type { Being } from "./being.ts";
import type { Species } from "./laws.ts";
import { ceilDiv, levelAt, NEED_MAX, type Ratio, secondsToReach, type Trend } from "./rates.ts";

/** Needs and health, as a being stores them. */
export type Body = { readonly nutrition: number; readonly rest: number; readonly health: number };

/** The rates that move a being's needs and health from its anchor. */
type Rates = { readonly nutrition: Trend; readonly rest: Trend; readonly health: Trend };

const STILL: Ratio = Object.freeze({ num: 0, den: 1 });

/** Falling at `rate`. */
function falling(rate: Ratio): Trend {
  return { rate, sign: -1 };
}

/** Rising at `rate`. */
function rising(rate: Ratio): Trend {
  return { rate, sign: 1 };
}

/**
 * The rates of a being with `body` doing `kind`: nutrition falls by activity; rest falls while
 * awake and rises while asleep; health falls while nutrition is 0, rises while nutrition and rest
 * are both above `recoverAbove`, and holds otherwise.
 */
export function ratesOf(species: Species, kind: Being["activity"]["kind"], body: Body): Rates {
  return {
    nutrition: falling(nutritionRate(species.needs.nutrition, kind)),
    rest: restTrend(species, kind),
    health: healthTrend(species.health, body),
  };
}

/** The rate at which nutrition falls while doing `kind`. */
function nutritionRate(law: Species["needs"]["nutrition"], kind: Being["activity"]["kind"]): Ratio {
  if (kind === "sleep") return law.asleep;
  return kind === "walk" ? law.walking : law.awake;
}

/** Rest rises at the species' recovery while asleep and falls by activity while awake. */
function restTrend(species: Species, kind: Being["activity"]["kind"]): Trend {
  if (kind === "sleep") return rising(species.sleep.recover);
  return falling(kind === "walk" ? species.needs.rest.walking : species.needs.rest.awake);
}

/** Health falls while starving, rises while fed and rested above `recoverAbove`, else holds. */
function healthTrend(law: Species["health"], body: Body): Trend {
  if (body.nutrition === 0) return falling(law.starve);
  if (body.nutrition > law.recoverAbove && body.rest > law.recoverAbove) return rising(law.recover);
  return falling(STILL);
}

/** The body `seconds` after `body`, each value moved by its rate and clamped to [0, NEED_MAX]. */
function bodyAfter(body: Body, rates: Rates, seconds: number): Body {
  return {
    nutrition: levelAt(body.nutrition, rates.nutrition, seconds),
    rest: levelAt(body.rest, rates.rest, seconds),
    health: levelAt(body.health, rates.health, seconds),
  };
}

/** The stored body of `being`: its needs and health at its anchor. */
export function storedBody(being: Pick<DeepReadonly<Being>, "needs" | "health">): Body {
  return { nutrition: being.needs.nutrition, rest: being.needs.rest, health: being.health };
}

/**
 * The needs and health of `being` at `tick`, in closed form from its anchor: what the engine reads
 * when it processes the being, and what any reader may compute without writing anything. Between
 * two of the being's wakes its rates are those at its anchor.
 */
export function bodyAt(
  species: Species,
  being: DeepReadonly<Being>,
  tick: Tick,
  simSecondsPerTick: number,
): Body {
  const anchored = storedBody(being);
  const rates = ratesOf(species, being.activity.kind, anchored);
  return bodyAfter(anchored, rates, secondsBetween(being.anchor, tick, simSecondsPerTick));
}

/** A level a value must not cross without the being being processed. */
export type Level = { readonly of: keyof Body; readonly at: number };

/**
 * The levels at which a being's rates or condition change: nutrition and rest at 0 and at
 * `recoverAbove`, health at 0, and `extra`, the targets of the activity and the brain's wake
 * conditions. Levels a value already sits on or moves away from are skipped by secondsToReach.
 */
export function levelsOf(species: Species, extra: readonly Level[]): Level[] {
  const above = species.health.recoverAbove;
  const levels: Level[] = [
    { of: "nutrition", at: 0 },
    { of: "rest", at: 0 },
    { of: "health", at: 0 },
  ];
  // Crossing recoverAbove changes the health rate: from both sides, so one level each way.
  if (above < NEED_MAX)
    levels.push({ of: "nutrition", at: above + 1 }, { of: "rest", at: above + 1 });
  levels.push({ of: "nutrition", at: above }, { of: "rest", at: above });
  return [...levels, ...extra];
}

/** Where a body stands: its stored values at the anchor, its values now, and its rates. */
export type Course = {
  readonly anchor: Tick;
  readonly anchored: Body;
  readonly now: Body;
  readonly rates: Rates;
};

/**
 * The first tick after `tick` at which the body on `course` reaches one of `levels`, in the
 * direction its value moves, or undefined when none is ahead. The tick is computed from the anchor,
 * as the values are, so it is exact; a level the value already reached or moves away from is
 * skipped.
 */
export function nextLevelTick(
  course: Course,
  levels: readonly Level[],
  clock: { readonly tick: Tick; readonly simSecondsPerTick: number },
): Tick | undefined {
  let best: Tick | undefined;
  for (const { of, at } of levels) {
    const trend = course.rates[of];
    const value = course.now[of];
    if (trend.rate.num === 0 || (trend.sign < 0 ? at >= value : at <= value)) continue;
    const seconds = secondsToReach(course.anchored[of], trend, at);
    if (seconds === undefined) continue;
    const candidate = course.anchor + ceilDiv(seconds, clock.simSecondsPerTick);
    const tick = candidate > clock.tick ? candidate : clock.tick + 1;
    if (best === undefined || tick < best) best = tick;
  }
  return best;
}

/** Whether two sets of rates move every value the same way. */
export function sameRates(a: Rates, b: Rates): boolean {
  const same = (x: Trend, y: Trend) =>
    x.sign === y.sign && x.rate.num === y.rate.num && x.rate.den === y.rate.den;
  return same(a.nutrition, b.nutrition) && same(a.rest, b.rest) && same(a.health, b.health);
}

/** The simulated seconds from the start of `from` to the start of `to`. */
function secondsBetween(from: Tick, to: Tick, simSecondsPerTick: number): number {
  return simSeconds(to, simSecondsPerTick) - simSeconds(from, simSecondsPerTick);
}
