/**
 * When the light reaches a level (ADR 0023): the first tick at which the radiance of the instant
 * crosses a threshold a brain asked to be woken at. Within a day the radiance never decreases until
 * mid-light, never increases from there to the end of the light period, and stays at its night floor
 * until the day ends (worldgen's day curve), so each of those three pieces is searched by bisection
 * over its ticks. A crossing means reaching the level from the other side: a condition that already
 * holds waits until it stops holding and holds again, so it never wakes a being tick after tick.
 */
import { simSeconds, type Tick } from "../time/tick.ts";
import { type DayLaw, lightPeriod, type PreparedGenesis, radiance } from "../worldgen/index.ts";
import { ceilDiv } from "./rates.ts";

/** What to look for: radiance at or below, or at or above, `threshold`. */
export type LightWatch = { readonly threshold: number; readonly direction: "below" | "above" };

/** The world's light: its terrain, day law, and seconds per tick. */
export type LightClock = {
  readonly prepared: PreparedGenesis;
  readonly day: DayLaw;
  readonly simSecondsPerTick: number;
};

/** The radiance at the start of `tick`. */
function radianceAt(clock: LightClock, tick: Tick): number {
  return radiance(clock.prepared, { tick, simSecondsPerTick: clock.simSecondsPerTick });
}

/** Whether `value` satisfies `watch` (or its negation, when `holds` is false). */
function satisfies(watch: LightWatch, value: number, holds: boolean): boolean {
  const met = watch.direction === "below" ? value <= watch.threshold : value >= watch.threshold;
  return met === holds;
}

/** A piece of a day in ticks, from `first` to `last`, on which radiance is monotone. */
type Piece = { readonly first: Tick; readonly last: Tick };

/** The three pieces of the day that holds `tick`, as tick ranges clipped to start at `tick`. */
function piecesFrom(clock: LightClock, tick: Tick): Piece[] {
  const length = clock.day.length;
  const second = simSeconds(tick, clock.simSecondsPerTick);
  const dayStart = second - (second % length);
  const light = lightPeriod(clock.day);
  // The curve's argument ⌊second·2^16/light⌋ reaches 2^15, its middle, at the second ⌈light/2⌉:
  // before it the curve never falls, and from it on it never rises.
  const middle = (light + (light % 2)) / 2;
  const bounds = [dayStart, dayStart + middle, dayStart + light, dayStart + length];
  const pieces: Piece[] = [];
  for (let index = 0; index < 3; index += 1) {
    const first = ceilDiv(bounds[index] as number, clock.simSecondsPerTick);
    const last = ceilDiv(bounds[index + 1] as number, clock.simSecondsPerTick) - 1;
    const clipped = first > tick ? first : tick;
    if (clipped <= last) pieces.push({ first: clipped, last });
  }
  return pieces;
}

/**
 * The first tick of `piece` whose radiance satisfies `watch` (or fails it, when `holds` is false),
 * or undefined. Radiance is monotone on the piece, so the ticks that satisfy it are a prefix or a
 * suffix of it: when the first tick does not, only the last can start a suffix.
 */
function firstInPiece(
  clock: LightClock,
  piece: Piece,
  watch: LightWatch,
  holds: boolean,
): Tick | undefined {
  if (satisfies(watch, radianceAt(clock, piece.first), holds)) return piece.first;
  if (!satisfies(watch, radianceAt(clock, piece.last), holds)) return undefined;
  let low = piece.first;
  let high = piece.last;
  // Invariant: `low` fails and `high` satisfies.
  while (high - low > 1) {
    const middle = low + (high - low - ((high - low) % 2)) / 2;
    if (satisfies(watch, radianceAt(clock, middle), holds)) high = middle;
    else low = middle;
  }
  return high;
}

/** The first tick from `from` whose radiance satisfies `watch` (or fails it), within two days. */
function firstTick(
  clock: LightClock,
  from: Tick,
  watch: LightWatch,
  holds: boolean,
): Tick | undefined {
  let cursor = from;
  for (let day = 0; day < 3; day += 1) {
    const pieces = piecesFrom(clock, cursor);
    for (const piece of pieces) {
      const found = firstInPiece(clock, piece, watch, holds);
      if (found !== undefined) return found;
    }
    const last = pieces[pieces.length - 1];
    if (last === undefined) return undefined;
    cursor = last.last + 1;
  }
  return undefined;
}

/**
 * The first tick after `after` at which the radiance comes to satisfy `watch`: the first tick that
 * satisfies it after one that does not. Undefined when the light never does within two days, as
 * for a threshold below the night floor.
 */
export function nextLightTick(clock: LightClock, after: Tick, watch: LightWatch): Tick | undefined {
  const start = after + 1;
  const holdsNow = satisfies(watch, radianceAt(clock, after), true);
  const from = holdsNow ? firstTick(clock, start, watch, false) : start;
  return from === undefined ? undefined : firstTick(clock, from, watch, true);
}
