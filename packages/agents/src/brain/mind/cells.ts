/**
 * Cells as `mind@1` reads them: their distance, and the food cue its window shows of them.
 */
import type { beings, DeepReadonly, mind } from "@open-origin/engine";
import { greatest } from "../curves.ts";

type Senses2 = DeepReadonly<beings.Senses2>;

/** The Chebyshev distance between two cells. */
export function chebyshev(a: readonly number[], b: readonly number[]): number {
  const dx = (a[0] as number) - (b[0] as number);
  const dy = (a[1] as number) - (b[1] as number);
  return greatest(dx < 0 ? -dx : dx, dy < 0 ? -dy : dy);
}

/** The food cue of `cell` in the window, or undefined when the window does not cover it. */
export function cueAt(window: Senses2["window"], cell: mind.Cell): number | undefined {
  const column = cell[0] - (window.origin[0] as number);
  const row = cell[1] - (window.origin[1] as number);
  if (column < 0 || column >= window.side || row < 0 || row >= window.side) return undefined;
  return window.foodCue[row * window.side + column];
}
