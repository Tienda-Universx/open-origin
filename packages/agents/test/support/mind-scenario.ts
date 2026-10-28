import { beings, type Command, createWorld, worldgen } from "@open-origin/engine";
import { Sfc32 } from "../../../engine/test/support/sfc32.ts";
import { mindController } from "../../src/index.ts";
import {
  BEINGS,
  drawIn,
  SCENARIO_SPS,
  type ScenarioWorld,
  type SpawnArea,
  spawnCommand,
  type Terrain,
  terrainOf,
} from "./scenario.ts";

/**
 * The preregistered scenario of T5 (docs/architecture/mind.md, "Seeds and scenario"): the rule of
 * T4 (scenario.ts) with the labels of T5, the default laws of life@2 without death, the ruleset
 * beings@2, and the brain `mind@1`; each being draws, in this order, its cell, nutrition, rest,
 * appetite, sleepiness, curiosity, sociability, credulity, and retention. Building a scenario runs
 * no simulation.
 */

/** The labels of T5. The calibration labels are the only ones calibration may run. */
export const LABELS2 = Object.freeze({
  default: "open-origin/t5/default",
  calibration: Object.freeze([1, 2, 3, 4].map((n) => `open-origin/t5/calibration/${n}`)),
  heldout: Object.freeze([1, 2, 3, 4, 5, 6].map((n) => `open-origin/t5/heldout/${n}`)),
});

/** The traits a T5 being draws after its needs, in this order. */
const TRAITS = Object.freeze([
  "appetite",
  "sleepiness",
  "curiosity",
  "sociability",
  "credulity",
  "retention",
] as const);

/** The payload of a spawn of beings@2: the species, the cell, the needs, and the six traits. */
export type SpawnPayload2 = {
  readonly species: string;
  readonly cell: readonly [number, number];
  readonly needs: { readonly nutrition: number; readonly rest: number };
  readonly traits: beings.Traits2;
};

/**
 * The beings of `area`, drawn from the generator seeded with `seed`: for each in turn, a dry cell
 * no other being has, then nutrition and rest in [600,000, 900,000], then the six traits within
 * the species' trait bounds.
 */
export function drawBeings2(
  area: SpawnArea,
  seed: number,
  species: beings.Species2,
): SpawnPayload2[] {
  const random = new Sfc32(seed);
  const taken: number[] = [];
  const payloads: SpawnPayload2[] = [];
  for (let n = 0; n < BEINGS; n += 1) {
    let entry = drawIn(random, 0, area.land.length - 1);
    while (taken.includes(entry)) entry = drawIn(random, 0, area.land.length - 1);
    taken.push(entry);
    const needs = {
      nutrition: drawIn(random, 600_000, 900_000),
      rest: drawIn(random, 600_000, 900_000),
    };
    const { min, max } = species.traits;
    const traits = Object.fromEntries(
      TRAITS.map((name) => [name, drawIn(random, min, max)]),
    ) as beings.Traits2;
    const cell = area.land[entry] as readonly [number, number];
    payloads.push({ species: species.id, cell: [cell[0], cell[1]], needs, traits });
  }
  return payloads;
}

/** What a T5 scenario may change: its laws, its brain, and audit, which long runs keep off. */
export type Scenario2Options = {
  readonly life?: beings.LifeConfig2;
  /** The brain of the species, built with its laws and the world's day; `mind@1` by default. */
  readonly controller?: (species: beings.Species2, dayLength: number) => beings.Controller2;
  readonly audit?: boolean;
  /** For checks of calibration only: another spawn draw, from `<label>/spawn<spawnSuffix>`. */
  readonly spawnSuffix?: string;
};

/** A T5 scenario ready to run: its world at tick 0, the spawns of tick 1, and what built them. */
export type Scenario2 = {
  readonly terrain: Terrain;
  readonly prepared: worldgen.PreparedGenesis;
  readonly area: SpawnArea;
  readonly world: ScenarioWorld;
  readonly ruleset: ReturnType<typeof beings.createBeingsRuleset>;
  readonly spawns: readonly Command[];
  readonly payloads: readonly SpawnPayload2[];
  /** The seconds of the world's day, which `mind@1` is built with. */
  readonly dayLength: number;
};

/** The seed of the spawn generator of `terrain`, or of another draw for `suffix`. */
function spawnSeed(terrain: Terrain, suffix: string | undefined): number {
  if (suffix === undefined) return terrain.seeds.spawn;
  const digest = new Bun.CryptoHasher("sha256").update(`${terrain.label}/spawn${suffix}`).digest();
  return new DataView(digest.buffer, digest.byteOffset).getUint32(0, false);
}

/** `mind@1` for `species` in a world whose day lasts `dayLength` seconds. */
const MIND = (species: beings.Species2, dayLength: number) =>
  mindController({ species, dayLength });

/**
 * The T5 scenario of a label from its terrain: 12 seconds per tick, the laws (the default ones of
 * life@2 unless `options.life` is given, always with death disabled), `mind@1` unless another
 * brain is given, and its 8 beings, spawned by the admin at tick 1. Throws for an uninhabitable
 * label.
 */
export function scenario2From(terrain: Terrain, options: Scenario2Options): Scenario2 {
  const { area, label } = terrain;
  if (area === undefined) throw new Error(`the label ${label} has no spawn area: uninhabitable`);
  const life = { ...(options.life ?? beings.defaultLife2()), deathEnabled: false };
  const species = life.species[0] as beings.Species2;
  const genesis = worldgen.genesisOf(terrain.prepared);
  const dayLength = genesis.laws.day.length;
  const brain = (options.controller ?? MIND)(species, dayLength);
  const controllers = { [species.id]: brain };
  const ruleset = beings.createBeingsRuleset({ controllers, rules: "beings@2" });
  const world = createWorld(
    {
      seed: terrain.seeds.world,
      simSecondsPerTick: SCENARIO_SPS,
      global: beings.beingsGlobal(genesis, life),
      chunks: {},
      ruleset,
    },
    { audit: options.audit ?? false },
  );
  const payloads = drawBeings2(area, spawnSeed(terrain, options.spawnSuffix), species);
  const spawns = payloads.map((payload, seq) => spawnCommand(payload, seq));
  return { terrain, prepared: terrain.prepared, area, world, ruleset, spawns, payloads, dayLength };
}

/** The T5 scenario of `label`. */
export function scenario2Of(label: string, options: Scenario2Options = {}): Scenario2 {
  return scenario2From(terrainOf(label), options);
}
