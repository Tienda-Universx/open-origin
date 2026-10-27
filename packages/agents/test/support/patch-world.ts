import {
  beings,
  type Command,
  createWorld,
  readView,
  type Seed,
  type World,
  worldgen,
} from "@open-origin/engine";
import { testGenesis } from "../../../engine/test/support/beings-world.ts";
import type { SuiteRuleset } from "../../../engine/test/support/determinism-records.ts";

/**
 * A small world for the integration tests of the beings that do not need the preregistered
 * scenario: the engine's test genesis, whose day lasts 100 ticks (SHORT_DAY), with its deposit 0
 * reshaped so that one small patch of food lies near the origin. The determinism suite's subject,
 * the observer test, and the scarcity test spawn their beings around it.
 */

/** Deposit 0 of the patch world: one patch of 17 cells and 353 units, the only one within 128 cells of the origin. */
const PATCH_DEPOSIT = Object.freeze({ wavelength: 32, octaves: 1, threshold: 970, peak: 60 });

/** The genesis of the patch world. */
function patchGenesis(): worldgen.Genesis {
  const base = testGenesis();
  const deposits = base.terrain.deposits.map((deposit, index) =>
    index === 0 ? PATCH_DEPOSIT : deposit,
  );
  return worldgen.genesisOf(
    worldgen.prepareGenesis({ ...base, terrain: { ...base.terrain, deposits } }),
  );
}

/** The prepared genesis of the patch world, for reading its terrain in the tests. */
export const PATCH_PREPARED = worldgen.prepareGenesis(patchGenesis());

/** The patch: the cells from (−54, −68) to (−50, −65) hold every unit of deposit 0 near the origin. */
export const PATCH = Object.freeze({ x: -56, y: -70, width: 9, height: 8 });

/** The seconds of one tick in the patch world. */
export const PATCH_SPS = 12;

/**
 * A patch world at tick 0 with `seed`, running `ruleset`, under audit when `audit` is true: the
 * world factory of a determinism subject. The laws are the default ones.
 */
export function patchWorld(seed: Seed, ruleset: SuiteRuleset, audit: boolean): World {
  const global = beings.beingsGlobal(patchGenesis(), beings.defaultLife());
  return createWorld(
    { seed, simSecondsPerTick: PATCH_SPS, global, chunks: {}, ruleset },
    { audit },
  );
}

/** A being to spawn: its cell and needs, with neutral traits. */
export type Spawn = {
  readonly cell: readonly [number, number];
  readonly nutrition: number;
  readonly rest: number;
};

/** The admin spawns of `spawns` at `tick`, in order. */
export function spawnsAt(tick: number, spawns: readonly Spawn[]): Command[] {
  return spawns.map(({ cell, nutrition, rest }, seq) => ({
    applyTick: tick,
    seq,
    type: "beings.spawn",
    origin: { kind: "admin" },
    payload: { species: "s1", cell: [cell[0], cell[1]], needs: { nutrition, rest } },
  }));
}

// The readers below read a world that runs the beings ruleset, whose validators accepted its values.

/** The global value of `world`, a world of beings. */
export function globalOf(world: World): beings.BeingsGlobal {
  return readView(world).readGlobal() as unknown as beings.BeingsGlobal;
}

/** The chunk `key` of `world`, a world of beings, or undefined when it is not materialized. */
export function chunkIn(world: World, key: string): beings.BeingsChunk | undefined {
  return readView(world).readChunk(key) as beings.BeingsChunk | undefined;
}

/** Every being of `world`, a world of beings, by id, read from the chunks of its occupancy index. */
export function beingsIn(world: World): beings.Being[] {
  return globalOf(world)
    .occupancy.flatMap((key) => (chunkIn(world, key)?.beings ?? []) as beings.Being[])
    .sort((a, b) => a.id - b.id);
}

/** The chunk key of `cell`. */
export function chunkOf(cell: readonly [number, number]): string {
  return `${worldgen.chunkOfCell(cell[0])},${worldgen.chunkOfCell(cell[1])}`;
}

/** The radiance of the patch world at `tick`. */
export function lightAt(tick: number): number {
  return worldgen.radiance(PATCH_PREPARED, { tick, simSecondsPerTick: PATCH_SPS });
}
