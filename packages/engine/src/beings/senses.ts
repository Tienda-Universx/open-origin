/**
 * The senses of a being (ADR 0023): the square window of cells it perceives around itself, with the
 * duration of each step it could take and a banded cue of the food it eats. They are bounded: a
 * brain of beings@1 sees this window, and nothing else, at each decision. Terrain is read once per
 * window with sampleSurface; the chunks the window covers are read once each, without writing or
 * materializing anything, for the food beings took and, under beings@2, for the beings a decision
 * perceives (perception.ts), which reads no other chunk (ADR 0024).
 */
import { simSeconds } from "../time/tick.ts";
import type { ChunkKey } from "../world/chunk.ts";
import {
  CHUNK_CELLS,
  chunkFirstCell,
  chunkOfCell,
  genesisOf,
  liquidLevel,
  MAX_CELL,
  MIN_CELL,
  type PreparedGenesis,
  sampleSurface,
} from "../worldgen/index.ts";
import type { Cell } from "./being.ts";
import type { BeingsChunk } from "./chunk.ts";
import { DIRECTIONS, type SensedWindow } from "./contracts.ts";
import { takenAt } from "./food.ts";
import type { Species } from "./laws.ts";
import { stepDuration } from "./locomotion.ts";
import { greatest, least } from "./rates.ts";

/** What sensing needs: the tick's terrain, the species, where the being is, and the world's chunks. */
export type SenseInput = {
  readonly prepared: PreparedGenesis;
  readonly species: Species;
  readonly center: Cell;
  readonly view: { readChunk(key: ChunkKey): BeingsChunk | undefined };
  /** The simulated second of the tick, and the seconds per tick, for regrowth since each take. */
  readonly nowSeconds: number;
  readonly simSecondsPerTick: number;
};

/** The window's cells that lie inside the world: the rectangle sampleSurface reads. */
type Clip = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

/** The part of the square `side` from `origin` inside the world; undefined when none is. */
function clip(origin: Cell, side: number): Clip | undefined {
  const x0 = greatest(origin[0], MIN_CELL);
  const y0 = greatest(origin[1], MIN_CELL);
  const x1 = least(origin[0] + side - 1, MAX_CELL);
  const y1 = least(origin[1] + side - 1, MAX_CELL);
  if (x0 > x1 || y0 > y1) return undefined;
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/** Per window cell: its elevation and food, and whether it lies inside the world. */
type Ground = {
  readonly inside: Uint8Array;
  readonly elevation: Float64Array;
  readonly food: Float64Array;
};

/** The square window and the part of it inside the world. */
type Frame = { readonly origin: Cell; readonly side: number; readonly area: Clip };

/** A chunk a window covers, as it was read once, and its coordinates. */
export type CoveredChunk = { readonly coord: Cell; readonly chunk: BeingsChunk };

/** The ground of the window and the chunks it covers, from one sample of the clipped rectangle. */
function readGround(
  input: SenseInput,
  origin: Cell,
  side: number,
): { readonly ground: Ground; readonly chunks: readonly CoveredChunk[] } {
  const ground = {
    inside: new Uint8Array(side * side),
    elevation: new Float64Array(side * side),
    food: new Float64Array(side * side),
  };
  const area = clip(origin, side);
  if (area === undefined) return { ground, chunks: [] };
  const surface = sampleSurface(input.prepared, area, input.species.diet.deposit);
  for (let row = 0; row < area.height; row += 1) {
    for (let column = 0; column < area.width; column += 1) {
      const from = row * area.width + column;
      const to = (area.y - origin[1] + row) * side + (area.x - origin[0] + column);
      ground.inside[to] = 1;
      ground.elevation[to] = surface.elevation[from] as number;
      ground.food[to] = surface.deposit[from] as number;
    }
  }
  const chunks = coveredChunks(input, area);
  const frame = { origin, side, area };
  for (const covered of chunks) subtractTaken(input, frame, covered, ground.food);
  return { ground, chunks };
}

/** The materialized chunks that `area` covers, by row then column, each read once. */
function coveredChunks(input: SenseInput, area: Clip): CoveredChunk[] {
  const chunks: CoveredChunk[] = [];
  for (let cy = chunkOfCell(area.y); cy <= chunkOfCell(area.y + area.height - 1); cy += 1) {
    for (let cx = chunkOfCell(area.x); cx <= chunkOfCell(area.x + area.width - 1); cx += 1) {
      const chunk = input.view.readChunk(`${cx},${cy}`);
      if (chunk !== undefined) chunks.push({ coord: [cx, cy], chunk });
    }
  }
  return chunks;
}

/** Subtracts from `food` what beings took in the chunk `covered` and has not regrown yet. */
function subtractTaken(
  input: SenseInput,
  frame: Frame,
  covered: CoveredChunk,
  food: Float64Array,
): void {
  const [cx, cy] = covered.coord;
  for (const entry of covered.chunk.depletion) {
    const offset = entry.cell % CHUNK_CELLS;
    const column = chunkFirstCell(cx) + offset - frame.origin[0];
    const row = chunkFirstCell(cy) + (entry.cell - offset) / CHUNK_CELLS - frame.origin[1];
    if (column < 0 || column >= frame.side || row < 0 || row >= frame.side) continue;
    const since = simSeconds(entry.since, input.simSecondsPerTick);
    const missing = takenAt(entry, input.species.regrowth, input.nowSeconds - since);
    const index = row * frame.side + column;
    food[index] = greatest((food[index] as number) - missing, 0);
  }
}

/** What computes the edges of a window: its side, ground, liquid level, and species. */
type EdgeInput = {
  readonly side: number;
  readonly ground: Ground;
  readonly level: number;
  readonly species: Species;
};

/** The duration of the step from window cell `from` to the cell `to`, both inside the world. */
function stepBetween(window: EdgeInput, from: number, to: number, diagonal: boolean): number {
  const a = window.ground.elevation[from] as number;
  const b = window.ground.elevation[to] as number;
  return stepDuration(window.species.locomotion, {
    rise: greatest(a, b) - least(a, b),
    depth: greatest(window.level - b, 0),
    diagonal,
  });
}

/** The duration of the orthogonal step from window cell `index` by `d` (0, 2, 4, or 6), or −1. */
function orthogonalEdge(window: EdgeInput, index: number, d: number): number {
  const { side, ground } = window;
  // Indexed reads: destructuring the frozen pair costs about half of the window's time on Bun.
  const direction = DIRECTIONS[d] as readonly [number, number];
  const column = (index % side) + direction[0];
  const row = (index - (index % side)) / side + direction[1];
  if (column < 0 || column >= side || row < 0 || row >= side) return -1;
  const target = row * side + column;
  if (ground.inside[index] === 0 || ground.inside[target] === 0) return -1;
  return stepBetween(window, index, target, false);
}

/** The cue of `food` units for a diet: 0 below `some`, 1 below `plenty`, 2 from `plenty`. */
function cueOf(food: number, cue: Species["diet"]["cue"]): number {
  if (food >= cue.plenty) return 2;
  return food >= cue.some ? 1 : 0;
}

/**
 * The window a being senses at `input.center`: the square of side 2R + 1 around it, R its
 * species' radius. Cells outside the world belong to it, impassable and without food. Every edge
 * follows the species' locomotion, and a diagonal step is impassable when either orthogonal step
 * it passes between is. Reads terrain and chunks; writes nothing.
 */
export function senseWindow(input: SenseInput): SensedWindow {
  return senseWindowAndChunks(input).window;
}

/**
 * senseWindow, and the materialized chunks the window covers inside the world, each read once,
 * which perception reads again from these values instead of from the world.
 */
export function senseWindowAndChunks(input: SenseInput): {
  readonly window: SensedWindow;
  readonly chunks: readonly CoveredChunk[];
} {
  const radius = input.species.senses.radius;
  const side = 2 * radius + 1;
  const origin: Cell = [input.center[0] - radius, input.center[1] - radius];
  const { ground, chunks } = readGround(input, origin, side);
  const level = liquidLevel(genesisOf(input.prepared));
  const edges = { side, ground, level, species: input.species };
  const edgeMs = new Int32Array(side * side * 8);
  const foodCue = new Uint8Array(side * side);
  for (let index = 0; index < side * side; index += 1) {
    for (let d = 0; d < 8; d += 2) edgeMs[index * 8 + d] = orthogonalEdge(edges, index, d);
    foodCue[index] =
      ground.inside[index] === 1 ? cueOf(ground.food[index] as number, input.species.diet.cue) : 0;
  }
  for (let index = 0; index < side * side; index += 1) {
    for (let d = 1; d < 8; d += 2) edgeMs[index * 8 + d] = diagonalEdge(edges, edgeMs, index, d);
  }
  return { window: { origin, side, edgeMs, foodCue }, chunks };
}

/** A copy of `window` that shares nothing with it, for a brain that may write to its senses. */
export function copyWindow(window: SensedWindow): SensedWindow {
  return {
    origin: [window.origin[0], window.origin[1]],
    side: window.side,
    edgeMs: window.edgeMs.slice(),
    foodCue: window.foodCue.slice(),
  };
}

/**
 * The duration of the diagonal step from window cell `index` by `d` (1, 3, 5, or 7), given the
 * orthogonal edges already in `edgeMs`; −1 when either orthogonal step it passes between, by
 * (dx, 0) and by (0, dy), is impassable, or when the step itself is.
 */
function diagonalEdge(window: EdgeInput, edgeMs: Int32Array, index: number, d: number): number {
  const direction = DIRECTIONS[d] as readonly [number, number];
  const dx = direction[0];
  const dy = direction[1];
  const horizontal = edgeMs[index * 8 + (dx > 0 ? 0 : 4)] as number;
  const vertical = edgeMs[index * 8 + (dy > 0 ? 2 : 6)] as number;
  if (horizontal < 0 || vertical < 0) return -1;
  // Both orthogonal steps lie inside the window and the world, so the diagonal's target does too.
  return stepBetween(window, index, index + dy * window.side + dx, true);
}
