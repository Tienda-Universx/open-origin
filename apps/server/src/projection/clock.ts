/**
 * The authoritative clock (ADR 0026, "The authoritative clock"): `{tick, day, dayPermille}`, computed
 * in the world plane with worldgen's calendar from the world's genesis. Only the clock leaves: the
 * simulated seconds of a tick and the day's length, law parameters (C3), never do.
 */
import { floorDiv, worldgen } from "@open-origin/engine";
import { Clock } from "@open-origin/protocol/public";

/** A day's position runs from 0 to 999 permille. */
const PERMILLE = 1000;

/**
 * The clock of the world whose genesis `prepared` holds and whose ticks last `simSecondsPerTick`:
 * for a tick, its day, from 0, and how far into that day it falls, in permille, rounded down.
 */
export function calendarClock(
  prepared: worldgen.PreparedGenesis,
  simSecondsPerTick: number,
): (tick: number) => Clock {
  const dayLength = worldgen.genesisOf(prepared).laws.day.length;
  return (tick) => {
    const { dayIndex, secondOfDay } = worldgen.dayPosition(prepared, { tick, simSecondsPerTick });
    const dayPermille = floorDiv(secondOfDay * PERMILLE, dayLength);
    return Clock.parse({ tick, day: dayIndex, dayPermille });
  };
}
