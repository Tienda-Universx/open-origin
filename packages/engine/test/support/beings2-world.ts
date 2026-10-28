import {
  beings,
  type CanonicalValue,
  createWorld,
  mind,
  type Seed,
  worldgen,
} from "../../src/index.ts";
import { type BeingsWorld, behavior, testGenesis } from "./beings-world.ts";

/**
 * Worlds of beings@2 for the tests of the ruleset with minds (ADR 0024): the world factory of
 * beings-world.ts over the same test genesis with the default laws of life@2, brains that declare
 * what a brain of beings@2 must, and the gate's mind of docs/architecture/mind.md ("Cost"), which
 * tests and the benchmark build exactly. Every brain here is a pure function of its senses.
 */

export type Senses2 = Parameters<beings.Controller2["decide"]>[0];

/** The one species of the default laws of life@2. */
export const SPECIES2 = beings.defaultLife2().species[0] as beings.Species2;

/** The behaviors the brains of these tests may name, and their namespace of concepts. */
export const BEHAVIORS: readonly string[] = Object.freeze([
  "eat",
  "rest",
  "roam",
  "sleep",
  "travel",
  "x",
]);
export const CONCEPTS = "t1";

/** A brain of beings@2 of version `version` deciding with `decide`, with the test behaviors. */
export function brain2(
  decide: (senses: Senses2) => beings.Intention,
  version = "script@2",
): beings.Controller2 {
  return { brain: version, behaviors: BEHAVIORS, concepts: CONCEPTS, decide };
}

/** A brain of beings@2 that always idles for `ms`. */
export function idler2(ms: number): beings.Controller2 {
  return brain2(() => ({
    steps: [{ kind: "idle", ms }],
    wakeWhen: {},
    behavior: behavior("rest"),
  }));
}

/** What a world of beings@2 needs: its brains, and optionally its seed, laws, chunks, and audit. */
export type Beings2WorldOptions = {
  readonly controllers: { readonly [species: string]: beings.Controller2 };
  readonly seed?: Seed;
  readonly life?: beings.LifeConfig2;
  readonly chunks?: { readonly [key: string]: CanonicalValue };
  readonly audit?: boolean;
};

/**
 * A world of beings@2 at tick 0 over the test genesis, under audit unless told otherwise. Its
 * occupancy index lists the given chunks that hold beings, in the kernel's order of keys.
 */
export function beings2World(options: Beings2WorldOptions): BeingsWorld {
  const life = options.life ?? beings.defaultLife2();
  const chunks = (options.chunks ?? {}) as { [key: string]: beings.BeingsChunk };
  const occupancy = Object.keys(chunks)
    .filter((key) => (chunks[key]?.beings.length ?? 0) > 0)
    .sort();
  return createWorld(
    {
      seed: options.seed ?? [1, 2],
      simSecondsPerTick: 12,
      global: { ...beings.beingsGlobal(testGenesis(), life), occupancy },
      chunks,
      ruleset: beings.createBeingsRuleset({ controllers: options.controllers, rules: "beings@2" }),
    },
    { audit: options.audit ?? true },
  );
}

/** The default laws of life@2 with their one species changed by `change`, and `capacity`. */
export function life2With(
  change: (species: beings.Species2) => beings.Species2 = (species) => species,
  capacity = 64,
): beings.LifeConfig2 {
  const life = beings.defaultLife2();
  return { ...life, capacity, species: [change(life.species[0] as beings.Species2)] };
}

/**
 * The gate's mind of mind.md ("Cost", the gate of the entity section), with the values it gives:
 * 5 `food`, 1 `being`, 1 `ate`, and 1 `heard` episode of a `tell`; 8 beliefs of `m1.food-at`, each
 * citing two of the episodes 977 to 983; 6 relationships; an empty inbox; local ids 977 to 998 and
 * `next` 999; every tick 99,999,999; every cell [−99,999, −99,999]; entity ids of five digits.
 * It measures 2,680 bytes of canonical text, which mind-size.test.ts pins.
 */
export function gateMind(): mind.Mind {
  const tick = GATE_TICK;
  const beliefs = Array.from(
    { length: 8 },
    (_, index): mind.Belief => ({
      id: 985 + index,
      p: gateProposition(),
      cr: 800,
      src: 1,
      // Own episodes only: a belief citing the heard one would have `src` 2 and `who`.
      ev: [977 + (index % 5), 982 + (index % 2)],
      lost: 0,
      tn: 0,
      ex: 0,
      dp: 1,
      u: tick,
    }),
  );
  const relations = Array.from(
    { length: 6 },
    (_, index): mind.Relationship => ({
      id: 993 + index,
      who: 99_999 - index,
      f: 3600,
      seen: tick,
      aff: 100,
      tr: 600,
      tn: 0,
      talk: tick,
      turns: 1,
    }),
  );
  const quota = { day: tick, said: 5, woken: 2 };
  return { next: 999, episodes: gateEpisodes(), beliefs, relations, inbox: [], exposure: 0, quota };
}

/** Every tick of the gate's mind. */
const GATE_TICK = 99_999_999;

/** The cell of every record of the gate's mind. */
const gateCell = (): mind.Cell => [-99_999, -99_999];

/** The proposition of every record of the gate's mind that holds one. */
const gateProposition = (): mind.Proposition => ({
  p: "m1.food-at",
  a: [{ c: gateCell() }],
  v: 2,
});

/** The eight episodes of the gate's mind, 977 to 984. */
function gateEpisodes(): mind.Episode[] {
  const common = { t: GATE_TICK, w: 600, r: GATE_TICK };
  return [
    ...[977, 978, 979, 980, 981].map(
      (id): mind.Episode => ({ id, kind: "food", ...common, cell: gateCell(), v: 2 }),
    ),
    { id: 982, kind: "being", ...common, cell: gateCell(), who: 99_999, v: 1 },
    { id: 983, kind: "ate", ...common, cell: gateCell(), v: 25 },
    {
      id: 984,
      kind: "heard",
      ...common,
      cell: gateCell(),
      who: 99_999,
      p: gateProposition(),
      act: "tell",
      band: 2,
      tn: 0,
      ex: 0,
    },
  ];
}

/** Neutral traits of beings@2: the six at 1000. */
export const NEUTRAL_TRAITS = Object.freeze({
  appetite: 1000,
  sleepiness: 1000,
  curiosity: 1000,
  sociability: 1000,
  credulity: 1000,
  retention: 1000,
});

/**
 * A being of beings@2 as a spawn at tick `born` makes it, on `cell`, with `traits` and `held` as
 * its mind: a record to place in the initial chunks of a world, which a spawn never could.
 */
export function being2(
  id: number,
  cell: readonly [number, number],
  options: {
    readonly born?: number;
    readonly mind?: mind.Mind;
    readonly needs?: { readonly nutrition: number; readonly rest: number };
    readonly traits?: beings.Being2["traits"];
  } = {},
): beings.Being2 {
  const born = options.born ?? 0;
  return {
    id,
    species: SPECIES2.id,
    stage: "adult",
    born,
    cell: [cell[0], cell[1]],
    needs: { ...(options.needs ?? { nutrition: beings.NEED_MAX, rest: beings.NEED_MAX }) },
    health: beings.NEED_MAX,
    anchor: born,
    traits: { ...(options.traits ?? NEUTRAL_TRAITS) },
    condition: "ok",
    activity: { kind: "idle", start: born, ms: 1 },
    plan: [],
    behavior: { kind: "none", since: born, heading: 0 },
    wakeWhen: {},
    wake: born + 1,
    outcome: { result: "none", tick: born, reason: "" },
    cooldowns: [],
    mind: options.mind ?? mind.newMind(0),
  };
}

/**
 * The chunks that hold `placed`, beings of either version, each in the chunk of its cell, by id,
 * with their `due`: initial chunks for createWorld.
 */
export function chunksOf(placed: readonly beings.Being[]): { [key: string]: beings.BeingsChunk } {
  const chunks: { [key: string]: beings.BeingsChunk } = {};
  for (const being of [...placed].sort((a, b) => a.id - b.id)) {
    const key = `${worldgen.chunkOfCell(being.cell[0])},${worldgen.chunkOfCell(being.cell[1])}`;
    chunks[key] ??= { beings: [], depletion: [], due: beings.MAX_TICK };
    chunks[key].beings.push(being);
  }
  for (const chunk of Object.values(chunks)) chunk.due = beings.dueOf(chunk.beings);
  return chunks;
}
