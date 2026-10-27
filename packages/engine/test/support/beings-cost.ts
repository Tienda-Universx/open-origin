import {
  beings,
  type CanonicalValue,
  createWorld,
  type Ruleset,
  step,
  type TickContext,
  worldgen,
} from "../../src/index.ts";
import { type BeingsWorld, behavior, brain, SPECIES, spawn } from "./beings-world.ts";

/**
 * The cost of the beings' tick (plan §7; ADR 0023, cost per tick), shared by the complexity test
 * (beings-cost.test.ts), the fuzz's count of a quiet tick (beings-fuzz.test.ts), and the scale
 * benchmark (packages/agents/bench/beings.ts), so that each measures the same worlds: explored
 * worlds of empty materialized chunks, beings that sleep, and a context that counts the calls a
 * system makes.
 */

/** A chunk of a world of beings that holds nothing: what a being leaves behind when it moves on. */
export function emptyChunk(): beings.BeingsChunk {
  return { beings: [], depletion: [], due: Number.MAX_SAFE_INTEGER };
}

/**
 * `count` empty chunks, an explored world: a square block of chunks around `center`, filled row by
 * row from its southwest corner, whose side is the smallest that holds them.
 */
export function exploredChunks(
  count: number,
  center: readonly [number, number] = [0, 0],
): { [key: string]: beings.BeingsChunk } {
  const side = Math.ceil(Math.sqrt(count));
  const [x0, y0] = [center[0] - (side >> 1), center[1] - (side >> 1)];
  const chunks: { [key: string]: beings.BeingsChunk } = {};
  for (let index = 0; index < count; index += 1) {
    chunks[`${x0 + (index % side)},${y0 + Math.floor(index / side)}`] = emptyChunk();
  }
  return chunks;
}

/**
 * The test terrain (beings-world.ts) with the default day of 75,600 s, 6,300 ticks of 12 s, so that
 * no daily prune and no daily processing falls in the first 6,000 ticks.
 */
export function longDayGenesis(): worldgen.Genesis {
  return worldgen.defaultGenesis([11, 12, 13, 14, 15, 16, 17, 18]);
}

/** The rest below which `sleeper` sleeps rather than idles. */
const RESTED = 990_000;
/** How long `sleeper` idles once rested: six simulated hours. */
const IDLE_MS = 6 * 3_600_000;

/**
 * A brain that sleeps until its rest is full and idles six hours once rested, so it decides rarely:
 * the being that the cost of a tick measures, which costs one read of its chunk's `due` while it
 * sleeps.
 */
export function sleeper(): beings.Controller {
  return brain(
    (senses) =>
      senses.self.needs.rest < RESTED
        ? {
            steps: [{ kind: "sleep", untilRest: beings.NEED_MAX }],
            wakeWhen: {},
            behavior: behavior("sleep"),
          }
        : { steps: [{ kind: "idle", ms: IDLE_MS }], wakeWhen: {}, behavior: behavior("rest") },
    "sleeper@1",
  );
}

/**
 * Ten cells of the test terrain, each in its own chunk, where a being of the default species may
 * stand: dispersed beings, five chunks apart at most.
 */
export const DISPERSED_CELLS: readonly (readonly [number, number])[] = Object.freeze(
  Array.from({ length: 10 }, (_, i) => Object.freeze([i * 64 - 300, 7 * i - 30] as const)),
);

/**
 * The rest that `sleepingWorld`'s beings are spawned with: their sleep to full rest lasts 15,876 s,
 * 1,323 ticks, and crosses no level of their body, so they wake at none before it ends.
 */
const SLEEPY_REST = 400_000;

/**
 * A world of the long-day genesis with `chunks` empty chunks (exploredChunks) and ten sleeping
 * beings on DISPERSED_CELLS, stepped to tick 2: spawned at tick 1, each decided at tick 2 to sleep
 * until tick 1,325, so that ticks 3 to 1,324 are quiet. Audit is off: the complexity test times it.
 */
export function sleepingWorld(chunks: number, ruleset = sleepingRuleset()): BeingsWorld {
  const world = createWorld(
    {
      seed: [5, 6],
      simSecondsPerTick: 12,
      global: beings.beingsGlobal(longDayGenesis(), beings.defaultLife()),
      chunks: exploredChunks(chunks),
      ruleset,
    },
    { audit: false },
  );
  const needs = { nutrition: beings.NEED_MAX, rest: SLEEPY_REST };
  const spawns = DISPERSED_CELLS.map((cell, seq) =>
    spawn(1, { species: SPECIES.id, cell: [...cell], needs }, seq),
  );
  step(world, spawns);
  step(world, []);
  return world;
}

/** The beings ruleset with `sleeper` for the default species. */
export function sleepingRuleset(): Ruleset<beings.BeingsGlobal, beings.BeingsChunk> {
  return beings.createBeingsRuleset({ controllers: { [SPECIES.id]: sleeper() } });
}

/** The calls one run of a system made to its tick context, and the chunk keys it read. */
export type Calls = {
  chunkKeys: number;
  readChunk: number;
  writeGlobal: number;
  readonly keys: string[];
};

/** The methods of a tick context that `counting` counts. */
const COUNTED = new Set(["chunkKeys", "readChunk", "writeGlobal"]);

/**
 * `ruleset` whose systems each push to `sink`, at every run, a record of the calls they make to
 * their tick context: chunkKeys, readChunk with the keys it read, and writeGlobal. The calls go
 * through unchanged, so the systems do exactly what they did.
 */
export function counting<G extends CanonicalValue, C extends CanonicalValue>(
  ruleset: Ruleset<G, C>,
  sink: Calls[],
): Ruleset<G, C> {
  return {
    ...ruleset,
    systems: ruleset.systems.map((system) => ({
      name: system.name,
      streams: system.streams,
      run: (ctx: TickContext<G, C>) => {
        const calls: Calls = { chunkKeys: 0, readChunk: 0, writeGlobal: 0, keys: [] };
        sink.push(calls);
        return system.run(watched(ctx, calls));
      },
    })),
  };
}

/** `ctx`, with each call of a COUNTED method recorded in `calls`. */
function watched<G extends CanonicalValue, C extends CanonicalValue>(
  ctx: TickContext<G, C>,
  calls: Calls,
): TickContext<G, C> {
  return new Proxy(ctx, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof key !== "string" || !COUNTED.has(key)) return value;
      const name = key as "chunkKeys" | "readChunk" | "writeGlobal";
      return (...args: unknown[]) => {
        calls[name] += 1;
        if (name === "readChunk") calls.keys.push(args[0] as string);
        return (value as (...inner: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

/** The chunk keys a window of `side` cells from `origin` covers inside the world. */
export function windowChunks(origin: readonly [number, number], side: number): string[] {
  const low = (value: number) => worldgen.chunkOfCell(Math.max(value, worldgen.MIN_CELL));
  const high = (value: number) => worldgen.chunkOfCell(Math.min(value, worldgen.MAX_CELL));
  const keys: string[] = [];
  for (let cy = low(origin[1]); cy <= high(origin[1] + side - 1); cy += 1) {
    for (let cx = low(origin[0]); cx <= high(origin[0] + side - 1); cx += 1)
      keys.push(`${cx},${cy}`);
  }
  return keys;
}

/** `inner`, which records in `sink` the window of every decision it makes, unchanged. */
export function windowRecorder(
  inner: beings.Controller,
  sink: { origin: [number, number]; side: number }[],
): beings.Controller {
  return {
    brain: inner.brain,
    decide: (senses) => {
      const {
        origin: [x = 0, y = 0],
        side,
      } = senses.window;
      sink.push({ origin: [x, y], side });
      return inner.decide(senses);
    },
  };
}
