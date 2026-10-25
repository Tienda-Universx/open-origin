import {
  beings,
  type CanonicalValue,
  type Command,
  createWorld,
  type EngineEvent,
  readView,
  type Seed,
  step,
  type World,
  worldgen,
} from "../../src/index.ts";

/**
 * Worlds of beings for the tests of the beings ruleset (ADR 0023): a world factory over a genesis
 * with a short day, admin spawn commands, readers of the beings a world holds, and scripted brains.
 * Every brain here is a pure function of its senses, as the Controller contract requires, so that a
 * world resumed from a snapshot decides exactly as the original.
 */

export type BeingsWorld = World<beings.BeingsGlobal, beings.BeingsChunk>;
export type Senses = Parameters<beings.Controller["decide"]>[0];

/** The terrain seed of the test genesis. */
const TERRAIN_SEED = [11, 12, 13, 14, 15, 16, 17, 18];

/**
 * A day of 1,200 simulated seconds, 100 ticks of 12 seconds, so that tests cross dawns, dusks,
 * and the daily prune of the occupancy index within a few hundred ticks.
 */
export const SHORT_DAY = Object.freeze({ length: 1200, daylight: 550 });

/** The test genesis: the default laws and terrain of TERRAIN_SEED, with SHORT_DAY. */
export function testGenesis(): worldgen.Genesis {
  const base = worldgen.defaultGenesis(TERRAIN_SEED);
  return worldgen.genesisOf(
    worldgen.prepareGenesis({ ...base, laws: { ...base.laws, day: SHORT_DAY } }),
  );
}

/** The prepared test genesis, for sensing and sampling terrain in the tests. */
export const PREPARED = worldgen.prepareGenesis(testGenesis());

/** The one species of the default laws of life. */
export const SPECIES = beings.defaultLife().species[0] as beings.Species;

/** What a world of beings needs: its brains, and optionally its seed, laws, pace, and audit. */
export type BeingsWorldOptions = {
  readonly controllers: { readonly [species: string]: beings.Controller };
  readonly seed?: Seed;
  readonly life?: beings.LifeConfig;
  readonly simSecondsPerTick?: number;
  readonly audit?: boolean;
};

/** A world of beings at tick 0, with no chunk and no being, under audit unless told otherwise. */
export function beingsWorld(options: BeingsWorldOptions): BeingsWorld {
  const genesis = testGenesis();
  return createWorld(
    {
      seed: options.seed ?? [1, 2],
      simSecondsPerTick: options.simSecondsPerTick ?? 12,
      global: beings.beingsGlobal(genesis, options.life ?? beings.defaultLife()),
      chunks: {},
      ruleset: beings.createBeingsRuleset({ controllers: options.controllers }),
    },
    { audit: options.audit ?? true },
  );
}

/** An admin spawn applied at `applyTick`. */
export function spawn(applyTick: number, payload: CanonicalValue, seq = 0): Command {
  return { applyTick, seq, type: "beings.spawn", origin: { kind: "admin" }, payload };
}

/** Steps `world` until its tick is `tick`, with `commands` at their apply ticks; every event. */
export function runTo(world: BeingsWorld, tick: number, commands: readonly Command[] = []) {
  const events: EngineEvent[] = [];
  for (let next = readView(world).tick + 1; next <= tick; next += 1) {
    const due = commands.filter((command) => command.applyTick === next);
    events.push(...step(world, due).events);
  }
  return events;
}

/** Every being of `world`, by id, read from the chunks of its occupancy index. */
export function beingsOf(world: BeingsWorld): beings.Being[] {
  const view = readView(world);
  return view
    .readGlobal()
    .occupancy.flatMap((key) => (view.readChunk(key)?.beings ?? []) as beings.Being[])
    .sort((a, b) => a.id - b.id);
}

/** The being `id` of `world`; throws when there is none. */
export function beingOf(world: BeingsWorld, id: number): beings.Being {
  const found = beingsOf(world).find((being) => being.id === id);
  if (found === undefined) throw new Error(`the world has no being ${id}`);
  return found;
}

/** The chunk key of `cell`. */
export function chunkOf(cell: readonly [number, number]): string {
  return `${worldgen.chunkOfCell(cell[0])},${worldgen.chunkOfCell(cell[1])}`;
}

/** The window of the default species around `center` in the test world, before any being ate. */
export function windowAt(center: readonly [number, number]): beings.SensedWindow {
  return beings.senseWindow({
    prepared: PREPARED,
    species: SPECIES,
    center: [center[0], center[1]],
    view: { readChunk: () => undefined },
    nowSeconds: 0,
    simSecondsPerTick: 12,
  });
}

/** The food of the default species' deposit at `cell` in the test genesis, before any being ate. */
export function baseFood(cell: readonly [number, number]): number {
  const rect = { x: cell[0], y: cell[1], width: 1, height: 1 };
  return worldgen.sampleSurface(PREPARED, rect, SPECIES.diet.deposit).deposit[0] ?? 0;
}

/**
 * The first cell, scanning rows from `from` east then north over `span` × `span` cells, that has at
 * least `food` units of the default species' deposit and where `accept` holds for the window
 * around it.
 */
export function findCell(
  from: readonly [number, number],
  span: number,
  need: {
    readonly food: number;
    readonly accept?: (cell: [number, number], window: beings.SensedWindow) => boolean;
  },
): [number, number] {
  const rect = { x: from[0], y: from[1], width: span, height: span };
  const { deposit } = worldgen.sampleSurface(PREPARED, rect, SPECIES.diet.deposit);
  for (let index = 0; index < span * span; index += 1) {
    const cell: [number, number] = [from[0] + (index % span), from[1] + Math.floor(index / span)];
    if ((deposit[index] ?? 0) < need.food) continue;
    if (need.accept === undefined || need.accept(cell, windowAt(cell))) return cell;
  }
  throw new Error(`no cell from ${from} over ${span} × ${span} cells satisfies the test's need`);
}

/** The duration of the step from the window's center by direction `d`, or −1. */
export function centerEdge(window: beings.SensedWindow, d: number): number {
  const radius = (window.side - 1) / 2;
  return window.edgeMs[(radius * window.side + radius) * 8 + d] ?? -1;
}

/** The durations of the walk `dirs` from the window's center, step by step, or undefined if blocked. */
export function walkMs(window: beings.SensedWindow, dirs: string): number[] | undefined {
  const radius = (window.side - 1) / 2;
  let [x, y] = [radius, radius];
  const durations: number[] = [];
  for (const digit of dirs) {
    const d = Number(digit);
    const ms = window.edgeMs[(y * window.side + x) * 8 + d] ?? -1;
    if (ms < 0) return undefined;
    durations.push(ms);
    const [dx, dy] = beings.DIRECTIONS[d] as readonly [number, number];
    x += dx;
    y += dy;
  }
  return durations;
}

/** A brain behavior record; `since` is the engine's to stamp. */
export function behavior(kind: string, heading = 0): beings.Behavior {
  return { kind, since: 0, heading };
}

/** A brain of version `version` deciding with `decide`. */
export function brain(
  decide: (senses: Senses) => beings.Intention,
  version = "script@1",
): beings.Controller {
  return { brain: version, decide };
}

/** A brain that always idles for `ms`, with `wakeWhen`. */
export function idler(ms: number, wakeWhen: beings.WakeConditions = {}): beings.Controller {
  return brain(() => ({ steps: [{ kind: "idle", ms }], wakeWhen, behavior: behavior("rest") }));
}

/** The default laws of life with their one species changed by `change`. */
export function lifeWith(change: (species: beings.Species) => beings.Species): beings.LifeConfig {
  const life = beings.defaultLife();
  return { ...life, species: [change(life.species[0] as beings.Species)] };
}

/** The running sums of `values`: the cumulative milliseconds of a walk's arrivals. */
export function cumulative(values: readonly number[]): number[] {
  let total = 0;
  return values.map((value) => {
    total += value;
    return total;
  });
}

/** The radiance of the test world at `tick`, at `simSecondsPerTick`. */
export function lightAt(tick: number, simSecondsPerTick = 12): number {
  return worldgen.radiance(PREPARED, { tick, simSecondsPerTick });
}
