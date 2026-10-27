/**
 * The parameters of the brain `utility@1`: its response curves, its thresholds, and how long it
 * commits to what it does. They were calibrated together with the default laws of life on the
 * calibration seeds only, and frozen with them (docs/architecture/beings.md, "Calibration");
 * changing any of them is a new brain version.
 */
import type { Curve } from "./curves.ts";

/** The version of the brain, which the ruleset's brain version composes. */
export const UTILITY_BRAIN = "utility@1";

/** The behaviors, in the order that breaks a tie between equal scores. */
export const BEHAVIORS: readonly string[] = Object.freeze([
  "forage",
  "eat",
  "sleep",
  "explore",
  "rest",
]);

/**
 * Hunger, in permille, against the drive to start eating: nothing until a being has lost 40% of
 * its nutrition, then a strong drive that grows until it has lost 70%.
 */
export const START_EATING: Curve = Object.freeze([400, 0, 401, 700, 700, 1000]);

/**
 * Hunger against the drive to keep eating, once foraging or eating: the hysteresis that keeps a
 * meal going, from cell to cell, until the being has lost at most 10% of its nutrition.
 */
export const KEEP_EATING: Curve = Object.freeze([100, 0, 101, 700, 700, 1000]);

/** The nutrition a meal eats to: full. */
export const MEAL_TARGET = 1_000_000;

/**
 * Tiredness, in permille, against the need to sleep in the dark: any being that lost more than
 * 10% of its rest sleeps at night, more readily the more it lost.
 */
export const NIGHT_SLEEP: Curve = Object.freeze([100, 0, 101, 750, 600, 1000]);

/**
 * Tiredness against the need to keep sleeping, once asleep: the hysteresis of sleep, which holds
 * until at most 2% of rest is lost.
 */
export const KEEP_SLEEPING: Curve = Object.freeze([20, 0, 21, 750, 600, 1000]);

/** Tiredness against the need to sleep whatever the light: only past 65% of rest lost. */
export const URGENT_SLEEP: Curve = Object.freeze([650, 0, 651, 1000]);

/** The rest a sleep restores to: full, so that every sleep ends rested. */
export const SLEEP_TARGET = 1_000_000;

/** The light, in the units of radiance, against darkness: dark at or below 100, light from 200. */
export const DARKNESS: Curve = Object.freeze([100, 1000, 200, 0]);

/** The light at or below which a being is woken at dusk, and at or above which at dawn. */
export const DUSK_LIGHT = 100;
export const DAWN_LIGHT = 200;

/** Tiredness against alertness, which exploring needs: full until half of rest is lost. */
export const ALERTNESS: Curve = Object.freeze([500, 1000, 650, 0]);

/** The drive to wander, in permille, of a sated being of neutral curiosity in full light. */
export const WANDER_DRIVE = 500;

/** The worth of a cell by its food cue: 0 none, 1 some, 2 plenty. */
export const CUE_WORTH: readonly number[] = Object.freeze([0, 600, 1000]);

/** The milliseconds of a route against its worth: an hour's walk still keeps 70%. */
export const ROUTE_WORTH: Curve = Object.freeze([0, 1000, 3_600_000, 700, 14_400_000, 300]);

/** The score of resting, which every other behavior must beat. */
export const REST_SCORE = 250;

/** The bonus of the behavior the being is already doing, and the margin another must add. */
export const COMMITMENT = 100;
export const SWITCH_MARGIN = 50;

/** The turns an exploring being tries from its heading, in order: ahead, then wider each side. */
export const TURNS: readonly number[] = Object.freeze([0, 1, 7, 2, 6, 3, 5, 4]);

/**
 * The legs a search tries from the offset (dx, dy) of the being from its anchor, in order, as
 * multiples of a tangent step counterclockwise around the anchor and of a radial step away from
 * it: around first, then around and out, then out. Every one of them ends farther from the
 * anchor than the being is.
 */
export const SPIRAL_LEGS: readonly (readonly [number, number])[] = Object.freeze([
  Object.freeze([1, 0] as const),
  Object.freeze([1, 1] as const),
  Object.freeze([0, 1] as const),
  Object.freeze([1, 2] as const),
  Object.freeze([2, 0] as const),
  Object.freeze([0, 2] as const),
  Object.freeze([-1, 1] as const),
  Object.freeze([-1, 0] as const),
]);

/** How far a wandering being aims along its heading. */
export const WANDER_REACH = 16;

/** How near food a wandering being's target must lie: it never wanders out of sight of food. */
export const WANDER_SIGHT = 12;

/**
 * The step of a search's spiral, in cells: its turns lie about π·12 ≈ 38 cells apart, less than
 * the window's side of 49, so that what the being senses on one turn overlaps the last.
 */
export const SEARCH_STEP = 12;

/**
 * How near the place a search began, along either axis, the being keeps spiraling around it,
 * about five turns; and how long it keeps that place, two days, longer than a being can search
 * before its health is gone.
 */
export const SEARCH_RANGE = 200;
export const SEARCH_ANCHOR_MS = 172_800_000;

/** How long a wandering being pauses after each leg, and how long a resting one idles. */
export const WANDER_PAUSE_MS = 10_800_000;
export const REST_MS = 7_200_000;
export const NIGHT_REST_MS = 43_200_000;

/** Rest at or below which a being that is not asleep is woken, whatever it does. */
export const EXHAUSTION_GUARD = 150_000;

/** Nutrition at or below which a sleeping being is woken to eat. */
export const STARVING = 250_000;

/** How long a cell whose meal failed, and a heading target with no route, are avoided. */
export const MEAL_COOLDOWN_MS = 21_600_000;
export const ROUTE_COOLDOWN_MS = 21_600_000;
