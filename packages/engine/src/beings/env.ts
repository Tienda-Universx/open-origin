/**
 * What the beings system knows during one tick (ADR 0023): the tick and its simulated second, the
 * laws, the brains, and lazy readers of the terrain and the light. Everything here lives for one run
 * of the system and is dropped when it returns, so nothing is shared between ticks or worlds.
 */
import type { CanonicalValue } from "../canonical/value.ts";
import { EngineError } from "../errors.ts";
import { simSeconds, type Tick } from "../time/tick.ts";
import type { ChunkKey } from "../world/chunk.ts";
import type { DeepReadonly, TickContext } from "../world/contracts.ts";
import {
  CHUNK_CELLS,
  cellOffset,
  chunkOfCell,
  type Genesis,
  instantOf,
  type PreparedGenesis,
  prepareGenesis,
  radiance,
  sampleSurface,
} from "../worldgen/index.ts";
import type { Cell } from "./being.ts";
import type { Brain, Controllers } from "./capture.ts";
import type { BeingsChunk } from "./chunk.ts";
import { takenAt } from "./food.ts";
import type { LifeConfig, Species } from "./laws.ts";
import { greatest, type Ratio } from "./rates.ts";
import { type BeingsRules, BRAIN_STREAM } from "./rules.ts";

/** The global value of a world of beings. */
export type BeingsGlobal = {
  readonly genesis: Genesis;
  readonly genesisSeal: string;
  readonly life: LifeConfig;
  readonly lifeSeal: string;
  /** Written by the system: the occupancy index and the last pruned day. */
  occupancy: ChunkKey[];
  prunedDay: number;
};

export { BRAIN_STREAM, CONTEST_STREAM, CROWD_STREAM } from "./rules.ts";

/** What the second and third phases read and do during one tick. */
export type BeingsEnv = {
  readonly ctx: TickContext<BeingsGlobal, BeingsChunk>;
  /** The rules of the ruleset's version. */
  readonly rules: BeingsRules;
  readonly tick: Tick;
  readonly sps: number;
  /** The simulated second at the start of the tick. */
  readonly now: number;
  readonly deathEnabled: boolean;
  readonly dayLength: number;
  readonly view: { readChunk(key: ChunkKey): BeingsChunk | undefined };
  emit(type: string, payload: CanonicalValue): void;
  species(id: string): Species;
  controller(species: string): Brain;
  prepared(): PreparedGenesis;
  light(): number;
  draws(id: number): number[];
  place(cell: Cell): { readonly chunk: ChunkKey; readonly cell: number };
  foodAt(cell: Cell, species: Species): number;
  /** The regrowth of the world's food deposit, which life@1 shares across its species. */
  regrowth(): Ratio;
};

/** The chunk of `cell` and its index there. */
function placeOf(cell: Cell): { readonly chunk: ChunkKey; readonly cell: number } {
  const [x, y] = cell;
  return {
    chunk: `${chunkOfCell(x)},${chunkOfCell(y)}`,
    cell: cellOffset(y) * CHUNK_CELLS + cellOffset(x),
  };
}

/** The tick's environment, over `ctx` and the brains and rules of the ruleset. */
export function envOf(
  ctx: TickContext<BeingsGlobal, BeingsChunk>,
  controllers: Controllers,
  rules: BeingsRules,
): BeingsEnv {
  const global = ctx.readGlobal();
  const sps = ctx.simSecondsPerTick;
  const now = simSeconds(ctx.tick, sps);
  let prepared: PreparedGenesis | undefined;
  let light: number | undefined;
  const view = { readChunk: (key: ChunkKey) => ctx.readChunk(key) as BeingsChunk | undefined };
  const env: BeingsEnv = {
    ctx,
    rules,
    tick: ctx.tick,
    sps,
    now,
    deathEnabled: global.life.deathEnabled,
    dayLength: global.genesis.laws.day.length,
    view,
    emit: (type, payload) => ctx.emit(type, payload),
    species: (id) => speciesIn(global.life, id),
    controller: (species) => controllerOf(controllers, species),
    prepared: () => {
      prepared ??= prepareGenesis(global.genesis);
      return prepared;
    },
    light: () => {
      light ??= radiance(env.prepared(), instantOf(ctx));
      return light;
    },
    draws: (id) => [ctx.random.u32(BRAIN_STREAM, id), ctx.random.u32(BRAIN_STREAM, id)],
    place: placeOf,
    foodAt: (cell, species) => foodIn(env, cell, species),
    regrowth: () => (global.life.species[0] as Species).regrowth,
  };
  return env;
}

/** The species `id` of `life`; its validator guarantees that every being's species exists. */
function speciesIn(life: DeepReadonly<LifeConfig>, id: string): Species {
  const found = life.species.find((species) => species.id === id);
  if (found === undefined) throw integrity(`no species "${id}" in the laws of life`);
  return found as Species;
}

/** The brain of `species`; validateGlobal guarantees one for every species. */
function controllerOf(controllers: Controllers, species: string): Brain {
  const controller = controllers[species];
  if (controller === undefined) throw integrity(`no brain for the species "${species}"`);
  return controller;
}

/** The effective food of `cell` for `species` at the tick: its deposit less what was taken. */
function foodIn(env: BeingsEnv, cell: Cell, species: Species): number {
  const [x, y] = cell;
  const base =
    sampleSurface(env.prepared(), { x, y, width: 1, height: 1 }, species.diet.deposit).deposit[0] ??
    0;
  const place = placeOf(cell);
  const entry = env.view
    .readChunk(place.chunk)
    ?.depletion.find((candidate) => candidate.cell === place.cell);
  if (entry === undefined) return base;
  const missing = takenAt(entry, species.regrowth, env.now - simSeconds(entry.since, env.sps));
  return greatest(base - missing, 0);
}

/** An inconsistency in the world, which faults the tick. */
export function integrity(message: string): EngineError {
  return new EngineError("integrity_violation", [{ path: "", message }]);
}
