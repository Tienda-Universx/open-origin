/**
 * Food in the world (ADR 0023). A cell's food is the value of the species' deposit there, a
 * permanent field of worldgen, minus what beings took and has not regrown yet. Only cells that were
 * eaten from are stored, each with what was taken and the tick it was last changed, and regrowth is
 * computed in closed form from that tick, so no tick ever visits a cell to regrow it.
 */
import type { Tick } from "../time/tick.ts";
import { type Ratio, scaledFloor } from "./rates.ts";

/** What beings took from the cell `cell` (`y·32 + x` in its chunk), as of the tick `since`. */
export type Depletion = { readonly cell: number; readonly taken: number; readonly since: Tick };

/** What is still missing from the cell of `entry`, `seconds` after `entry.since`, at `regrowth`. */
export function takenAt(entry: Depletion, regrowth: Ratio, seconds: number): number {
  return entry.taken - scaledFloor(regrowth, seconds, entry.taken);
}
