import {
  beings,
  type Command,
  createWorld,
  type Seed,
  type World,
  worldgen,
} from "@open-origin/engine";
import { Sfc32 } from "../../../engine/test/support/sfc32.ts";

/**
 * The preregistered scenario of T4 (docs/architecture/beings.md, "Preregistration"), built from a
 * public label exactly as the text says, so that no seed, cell, need, or trait is chosen by hand:
 * the seeds from SHA-256 of the label, the spawn area from the terrain alone, and the eight beings
 * from the label's spawn generator. Building a scenario runs no simulation.
 */

/** The labels of the scenarios. The calibration labels are the only ones calibration may run. */
export const LABELS = Object.freeze({
  default: "open-origin/t4/default",
  calibration: Object.freeze([1, 2, 3, 4].map((n) => `open-origin/t4/calibration/${n}`)),
  heldout: Object.freeze([1, 2, 3, 4, 5, 6].map((n) => `open-origin/t4/heldout/${n}`)),
});

/** The u32 words of SHA-256 of the UTF-8 text `text`, read big-endian. */
function sha256Words(text: string): number[] {
  const bytes = new Bun.CryptoHasher("sha256").update(text).digest();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: 8 }, (_, index) => view.getUint32(index * 4, false));
}

/** The seeds of a label: the world's, the terrain's, and the first word of the spawn generator's. */
export type LabelSeeds = {
  readonly world: Seed;
  readonly terrain: readonly number[];
  readonly spawn: number;
};

/** The seeds of `label`, each from SHA-256 of `<label>/world`, `/terrain`, and `/spawn`. */
export function labelSeeds(label: string): LabelSeeds {
  const [w0 = 0, w1 = 0] = sha256Words(`${label}/world`);
  const [spawn = 0] = sha256Words(`${label}/spawn`);
  return { world: [w0, w1], terrain: sha256Words(`${label}/terrain`), spawn };
}

/** The deposit the species of the scenario eats. */
const DEPOSIT = 0;

/** The side of the square over which the genesis' food coverage is measured, from (−512, −512). */
const COVERAGE_SIDE = 1024;

/** The side of the tiles sampled at once when measuring coverage: the widest region worldgen reads. */
const COVERAGE_TILE = 256;

/**
 * The genesis' food coverage: how many of the 1024 × 1024 cells from (−512, −512) to (511, 511)
 * have deposit 0 above 0.
 */
function foodCoverage(prepared: worldgen.PreparedGenesis): number {
  let count = 0;
  const first = -COVERAGE_SIDE / 2;
  for (let y = first; y < first + COVERAGE_SIDE; y += COVERAGE_TILE) {
    for (let x = first; x < first + COVERAGE_SIDE; x += COVERAGE_TILE) {
      const rect = { x, y, width: COVERAGE_TILE, height: COVERAGE_TILE };
      for (const food of worldgen.sampleSurface(prepared, rect, DEPOSIT).deposit)
        if (food > 0) count += 1;
    }
  }
  return count;
}

/** The side of a spawn area in cells: 3 × 3 chunks. */
export const AREA_SIDE = 3 * worldgen.CHUNK_CELLS;

/** The largest ring of chunks a spawn area's center may lie on. */
const MAX_RING = 64;

/** A spawn area: its center chunk, its first cell, and its land and food cells. */
export type SpawnArea = {
  readonly center: readonly [number, number];
  readonly origin: readonly [number, number];
  /** The cells with liquid depth 0, by y, then x, ascending. */
  readonly land: readonly (readonly [number, number])[];
  /** How many of its cells have deposit 0 above 0. */
  readonly food: number;
};

/** How many cells of one chunk are dry and how many have food. */
type ChunkCount = { readonly land: number; readonly food: number };

/**
 * A counter of the dry and food cells of each chunk of `prepared`, which samples each chunk once:
 * neighboring candidate areas share six of their nine chunks.
 */
function chunkCounter(
  prepared: worldgen.PreparedGenesis,
  level: number,
): (cx: number, cy: number) => ChunkCount {
  const counted = new Map<string, ChunkCount>();
  const side = worldgen.CHUNK_CELLS;
  return (cx, cy) => {
    const key = `${cx},${cy}`;
    const known = counted.get(key);
    if (known !== undefined) return known;
    const rect = { x: cx * side, y: cy * side, width: side, height: side };
    const { elevation, deposit } = worldgen.sampleSurface(prepared, rect, DEPOSIT);
    let land = 0;
    let food = 0;
    for (let index = 0; index < side * side; index += 1) {
      // Liquid depth is max(level − elevation, 0), so a cell is dry from the level up.
      if ((elevation[index] as number) >= level) land += 1;
      if ((deposit[index] as number) > 0) food += 1;
    }
    const count = { land, food };
    counted.set(key, count);
    return count;
  };
}

/** The area around the chunk `center`, with its dry cells listed by y, then x. */
function areaAt(
  prepared: worldgen.PreparedGenesis,
  center: readonly [number, number],
  level: number,
): SpawnArea {
  const origin: [number, number] = [
    worldgen.CHUNK_CELLS * (center[0] - 1),
    worldgen.CHUNK_CELLS * (center[1] - 1),
  ];
  const rect = { x: origin[0], y: origin[1], width: AREA_SIDE, height: AREA_SIDE };
  const { elevation, deposit } = worldgen.sampleSurface(prepared, rect, DEPOSIT);
  const land: [number, number][] = [];
  let food = 0;
  for (let index = 0; index < AREA_SIDE * AREA_SIDE; index += 1) {
    const column = index % AREA_SIDE;
    if ((elevation[index] as number) >= level)
      land.push([origin[0] + column, origin[1] + (index - column) / AREA_SIDE]);
    if ((deposit[index] as number) > 0) food += 1;
  }
  return { center, origin, land, food };
}

/** The candidate centers on the ring `ring`, ordered by y, then x. */
function ring(ring: number): [number, number][] {
  const centers: [number, number][] = [];
  // 0 − ring, not −ring: the center of ring 0 is (0, 0), never (−0, −0).
  for (let y = 0 - ring; y <= ring; y += 1) {
    for (let x = 0 - ring; x <= ring; x += 1) {
      if ((x < 0 ? -x : x) === ring || (y < 0 ? -y : y) === ring) centers.push([x, y]);
    }
  }
  return centers;
}

/** What an area needs to qualify: half of its cells dry, and the genesis' average food. */
export function areaNeeds(coverage: number): { readonly land: number; readonly food: number } {
  return {
    land: (AREA_SIDE * AREA_SIDE) / 2,
    food: Math.ceil((coverage * AREA_SIDE * AREA_SIDE) / 2 ** 20),
  };
}

/**
 * The spawn area of `prepared`: the first center, by (max(|x|, |y|), y, x), whose 3 × 3 chunks
 * have at least 4,608 dry cells and at least ⌈coverage·9,216 / 2^20⌉ cells with food, on a ring of
 * at most 64; undefined when none qualifies, which makes the label uninhabitable.
 */
function spawnArea(prepared: worldgen.PreparedGenesis, coverage: number): SpawnArea | undefined {
  const needs = areaNeeds(coverage);
  const level = worldgen.liquidLevel(worldgen.genesisOf(prepared));
  const count = chunkCounter(prepared, level);
  for (let distance = 0; distance <= MAX_RING; distance += 1) {
    for (const [x, y] of ring(distance)) {
      let land = 0;
      let food = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const chunk = count(x + dx, y + dy);
          land += chunk.land;
          food += chunk.food;
        }
      }
      if (land >= needs.land && food >= needs.food) return areaAt(prepared, [x, y], level);
    }
  }
  return undefined;
}

/** A number in [a, b] from `random`, by rejection: u is drawn again while u ≥ k·⌊2^32 / k⌋. */
export function drawIn(random: { next(): number }, a: number, b: number): number {
  const k = b - a + 1;
  const limit = k * Math.floor(2 ** 32 / k);
  let u = random.next();
  while (u >= limit) u = random.next();
  return a + (u % k);
}

/** The payload of a spawn: the species, the cell, the needs, and the traits. */
export type SpawnPayload = {
  readonly species: string;
  readonly cell: readonly [number, number];
  readonly needs: { readonly nutrition: number; readonly rest: number };
  readonly traits: {
    readonly appetite: number;
    readonly sleepiness: number;
    readonly curiosity: number;
  };
};

/** How many beings a scenario has. */
export const BEINGS = 8;

/**
 * The beings of `area`, drawn from the generator seeded with `seed`: for each in turn, a dry cell
 * no other being has, then nutrition and rest in [600,000, 900,000], then appetite, sleepiness,
 * and curiosity within the species' trait bounds.
 */
export function drawBeings(area: SpawnArea, seed: number, species: beings.Species): SpawnPayload[] {
  const random = new Sfc32(seed);
  const taken: number[] = [];
  const payloads: SpawnPayload[] = [];
  for (let n = 0; n < BEINGS; n += 1) {
    let entry = drawIn(random, 0, area.land.length - 1);
    while (taken.includes(entry)) entry = drawIn(random, 0, area.land.length - 1);
    taken.push(entry);
    const needs = {
      nutrition: drawIn(random, 600_000, 900_000),
      rest: drawIn(random, 600_000, 900_000),
    };
    const trait = () => drawIn(random, species.traits.min, species.traits.max);
    const traits = { appetite: trait(), sleepiness: trait(), curiosity: trait() };
    const cell = area.land[entry] as readonly [number, number];
    payloads.push({ species: species.id, cell: [cell[0], cell[1]], needs, traits });
  }
  return payloads;
}

/** The variants of the laws of the soak: every rate 10% against the beings, or 10% for them. */
export type Variant = "adverse" | "favorable";

/** `ratio` with its numerator multiplied by `factor`/10, rounded to the nearest integer, halves up. */
function scaled(ratio: beings.Ratio, factor: number): beings.Ratio {
  return { num: Math.floor((ratio.num * factor + 5) / 10), den: ratio.den };
}

/**
 * `species` under `variant` (docs/architecture/beings.md, "Evaluation"): in the adverse variant,
 * every rate that lowers a need or health is multiplied by 11/10 and every rate that raises a
 * need, health, or food by 9/10; the favorable variant has the opposite factors.
 */
function variantSpecies(species: beings.Species, variant: Variant): beings.Species {
  const [lower, raise] = variant === "adverse" ? [11, 9] : [9, 11];
  const { nutrition, rest } = species.needs;
  return {
    ...species,
    needs: {
      nutrition: {
        awake: scaled(nutrition.awake, lower),
        walking: scaled(nutrition.walking, lower),
        asleep: scaled(nutrition.asleep, lower),
      },
      rest: { awake: scaled(rest.awake, lower), walking: scaled(rest.walking, lower) },
    },
    sleep: { recover: scaled(species.sleep.recover, raise) },
    health: {
      ...species.health,
      starve: scaled(species.health.starve, lower),
      recover: scaled(species.health.recover, raise),
    },
    regrowth: scaled(species.regrowth, raise),
  };
}

/** The default laws of life under `variant`. */
export function variantLife(variant: Variant): beings.LifeConfig {
  const life = beings.defaultLife();
  return { ...life, species: life.species.map((species) => variantSpecies(species, variant)) };
}

/** The terrain of a label: its genesis, prepared, its food coverage, and its spawn area. */
export type Terrain = {
  readonly label: string;
  readonly seeds: LabelSeeds;
  readonly prepared: worldgen.PreparedGenesis;
  readonly coverage: number;
  readonly area: SpawnArea | undefined;
};

/** The terrain of `label`, measured without running any simulation. */
export function terrainOf(label: string): Terrain {
  const seeds = labelSeeds(label);
  const prepared = worldgen.prepareGenesis(worldgen.defaultGenesis(seeds.terrain));
  const coverage = foodCoverage(prepared);
  return { label, seeds, prepared, coverage, area: spawnArea(prepared, coverage) };
}

export type ScenarioWorld = World<beings.BeingsGlobal, beings.BeingsChunk>;

/** What a scenario may change: the brains, the laws, and audit, which long runs keep off. */
export type ScenarioOptions = {
  readonly controllers: { readonly [species: string]: beings.Controller };
  readonly life?: beings.LifeConfig;
  readonly audit?: boolean;
  /**
   * For checks of calibration only, never the registered scenario: another spawn draw, from the
   * first word of SHA-256 of `<label>/spawn<spawnSuffix>` instead of `<label>/spawn`.
   */
  readonly spawnSuffix?: string;
};

/** A scenario ready to run: its world at tick 0, the spawns of tick 1, and what built them. */
export type Scenario = {
  readonly terrain: Terrain;
  /** The prepared genesis of its terrain, which a run reads deposits from. */
  readonly prepared: worldgen.PreparedGenesis;
  readonly area: SpawnArea;
  readonly world: ScenarioWorld;
  readonly spawns: readonly Command[];
  readonly payloads: readonly SpawnPayload[];
};

/** The seconds of one tick in the scenario (plan §I.1.1). */
export const SCENARIO_SPS = 12;

/**
 * The scenario of `label`: the default genesis of its terrain seed, 12 seconds per tick, the laws
 * (the default ones unless `options.life` is given, always with death disabled), and its 8 beings,
 * spawned by the admin at tick 1. Throws for an uninhabitable label.
 */
export function scenarioOf(label: string, options: ScenarioOptions): Scenario {
  return scenarioFrom(terrainOf(label), options);
}

/** The scenario of a label from its terrain, measured once: what scenarioOf builds. */
export function scenarioFrom(terrain: Terrain, options: ScenarioOptions): Scenario {
  const { area, label } = terrain;
  if (area === undefined) throw new Error(`the label ${label} has no spawn area: uninhabitable`);
  const base = options.life ?? beings.defaultLife();
  const life = { ...base, deathEnabled: false };
  const species = life.species[0] as beings.Species;
  const spawnSeed =
    options.spawnSuffix === undefined
      ? terrain.seeds.spawn
      : (sha256Words(`${label}/spawn${options.spawnSuffix}`)[0] as number);
  const payloads = drawBeings(area, spawnSeed, species);
  const world = createWorld(
    {
      seed: terrain.seeds.world,
      simSecondsPerTick: SCENARIO_SPS,
      global: beings.beingsGlobal(worldgen.genesisOf(terrain.prepared), life),
      chunks: {},
      ruleset: beings.createBeingsRuleset({ controllers: options.controllers }),
    },
    { audit: options.audit ?? false },
  );
  const spawns = payloads.map((payload, seq) => spawnCommand(payload, seq));
  return { terrain, prepared: terrain.prepared, area, world, spawns, payloads };
}

/** The admin spawn of `payload` at tick 1, the `seq`-th of the tick. */
export function spawnCommand(payload: SpawnPayload, seq: number): Command {
  const { species, cell, needs, traits } = payload;
  return {
    applyTick: 1,
    seq,
    type: "beings.spawn",
    origin: { kind: "admin" },
    payload: { species, cell: [cell[0], cell[1]], needs: { ...needs }, traits: { ...traits } },
  };
}
