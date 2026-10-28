/**
 * The moment the mind layer works at, and what it needs to know of the being and its species. The
 * layer computes no time of its own: the beings layer gives it the tick and the world's simulated
 * seconds per tick, and it measures the seconds since an anchor as (tick − anchor) × seconds per
 * tick, which stays a safe integer because the seconds of the tick itself do.
 */
import { least } from "../int.ts";
import { INT31_MAX } from "./bounds.ts";
import type { MindLaws } from "./laws.ts";

/** A tick, and the simulated seconds each tick lasts in the world. */
export type Moment = { readonly tick: number; readonly secondsPerTick: number };

/**
 * The moment, the laws of the being's species, its retention, in permille, and its talk window: the
 * seconds after the being addressed a being during which a full store keeps their relationship,
 * which holds the quotas of the pair, `max(speech.gap, speech.cooldown)` of its species.
 */
export type MindContext = {
  readonly moment: Moment;
  readonly laws: MindLaws;
  readonly retention: number;
  readonly talkWindow: number;
};

/**
 * The simulated seconds from the tick `anchor` to `moment`; 0 for an anchor at or after it. The
 * caller guarantees that `moment.tick × moment.secondsPerTick` is a safe integer, as the seconds of
 * a tick the world reached are.
 */
export function secondsSince(anchor: number, moment: Moment): number {
  if (anchor >= moment.tick) return 0;
  return (moment.tick - anchor) * moment.secondsPerTick;
}

/** The age of the tick `anchor` at `moment`, as a view shows it: seconds, saturating at 2^31 − 1. */
export function ageAt(anchor: number, moment: Moment): number {
  return least(secondsSince(anchor, moment), INT31_MAX);
}
