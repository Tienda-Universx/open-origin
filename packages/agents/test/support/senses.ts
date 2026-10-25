import { beings, type DeepReadonly } from "@open-origin/engine";

/**
 * Senses built by hand for the tests of the brain: a flat window whose cells may be walls or hold
 * food, with the durations the engine's law gives a flat step, and a being whose needs, light,
 * behavior, outcome, and cooldowns a test chooses. The window follows the contract of
 * docs/architecture/beings.md ("Senses"): cell (column, row) has index row·side + column, rows
 * growing north, and a diagonal step is impassable when either orthogonal step it passes is.
 */

export type Senses = DeepReadonly<beings.Senses>;

/** The flat steps of the default species: 45 s straight, ⌈1.414·45 s⌉ diagonal. */
export const STRAIGHT_MS = 45_000;
export const DIAGONAL_MS = 63_630;

/** A cell of a window, as an offset from its center. */
export type Offset = readonly [number, number];

/** What a hand-built window holds: its radius, its walls, and its food cues. */
export type WindowSpec = {
  readonly radius: number;
  readonly walls?: readonly Offset[];
  readonly cues?: readonly (readonly [number, number, number])[];
};

/** The window index of the offset `[dx, dy]` from the center of a window of `radius`. */
export function at(radius: number, [dx, dy]: Offset): number {
  const side = 2 * radius + 1;
  return (radius + dy) * side + (radius + dx);
}

/** A flat window centered on `center`, with the walls and cues of `spec`. */
export function windowOf(spec: WindowSpec, center: Offset = [0, 0]): beings.SensedWindow {
  const { radius } = spec;
  const side = 2 * radius + 1;
  const wall = new Uint8Array(side * side);
  for (const offset of spec.walls ?? []) wall[at(radius, offset)] = 1;
  const open = (column: number, row: number) =>
    column >= 0 && column < side && row >= 0 && row < side && wall[row * side + column] === 0;
  const edgeMs = new Int32Array(side * side * 8).fill(-1);
  for (let index = 0; index < side * side; index += 1) {
    for (let d = 0; d < 8; d += 1) edgeMs[index * 8 + d] = edge(side, open, index, d);
  }
  const foodCue = new Uint8Array(side * side);
  for (const [dx, dy, cue] of spec.cues ?? []) foodCue[at(radius, [dx, dy])] = cue;
  return { origin: [center[0] - radius, center[1] - radius], side, edgeMs, foodCue };
}

/**
 * The flat step from cell `index` of a window of `side` in direction `d`, or −1 when it leaves an
 * open cell, enters a closed one, or cuts the corner of one.
 */
function edge(
  side: number,
  open: (column: number, row: number) => boolean,
  index: number,
  d: number,
): number {
  const column = index % side;
  const row = (index - column) / side;
  const [dx, dy] = beings.DIRECTIONS[d] as readonly [number, number];
  if (!open(column, row) || !open(column + dx, row + dy)) return -1;
  if (d % 2 === 0) return STRAIGHT_MS;
  return open(column + dx, row) && open(column, row + dy) ? DIAGONAL_MS : -1;
}

/** The being and its world at a decision, as a test sets them. */
export type Being = {
  readonly cell?: Offset;
  readonly nutrition?: number;
  readonly rest?: number;
  readonly light?: number;
  readonly condition?: "ok" | "incapacitated";
  readonly traits?: { appetite: number; sleepiness: number; curiosity: number };
  readonly behavior?: { kind: string; heading: number };
  readonly outcome?: { result: string; reason: string };
  readonly cooldowns?: readonly beings.Cooldown[];
  readonly draws?: readonly number[];
};

/** Daylight at its peak, and the night floor of the default genesis. */
export const NOON = 1000;
export const NIGHT = 40;

/** The neutral traits. */
export const NEUTRAL = Object.freeze({ appetite: 1000, sleepiness: 1000, curiosity: 1000 });

/** A sated, rested being at noon at the cell (0, 0), which already decided once and rested. */
const DEFAULT_BEING = Object.freeze({
  cell: [0, 0] as Offset,
  nutrition: 900_000,
  rest: 950_000,
  light: NOON,
  condition: "ok" as "ok" | "incapacitated",
  traits: NEUTRAL,
  behavior: { kind: "rest", heading: 0 },
  outcome: { result: "done", reason: "" },
  cooldowns: [] as readonly beings.Cooldown[],
  draws: [0, 0] as readonly number[],
});

/** The senses of `being` in `window`, each member it leaves out taken from DEFAULT_BEING. */
export function sensesOf(window: beings.SensedWindow, being: Being = {}): Senses {
  const chosen = { ...DEFAULT_BEING, ...being };
  const [x, y] = chosen.cell;
  return {
    self: {
      id: 1,
      species: "s1",
      cell: [x, y],
      needs: { nutrition: chosen.nutrition, rest: chosen.rest },
      health: beings.NEED_MAX,
      condition: chosen.condition,
      traits: { ...chosen.traits },
      activity: { kind: "idle", start: 100, ms: 1 },
      behavior: { kind: chosen.behavior.kind, since: 10, heading: chosen.behavior.heading },
      outcome: { result: chosen.outcome.result, tick: 100, reason: chosen.outcome.reason },
      cooldowns: chosen.cooldowns,
    },
    light: chosen.light,
    window,
    draws: chosen.draws,
  };
}

/** The cells a walk `dirs` from the center of a window of `radius` passes, as offsets. */
export function walkCells(dirs: string): Offset[] {
  const cells: Offset[] = [];
  let [x, y] = [0, 0];
  for (const digit of dirs) {
    const [dx, dy] = beings.DIRECTIONS[Number(digit)] as readonly [number, number];
    x += dx;
    y += dy;
    cells.push([x, y]);
  }
  return cells;
}

/** Where a walk `dirs` from the center ends, as an offset. */
export function walkEnd(dirs: string): Offset {
  return walkCells(dirs).at(-1) ?? [0, 0];
}
