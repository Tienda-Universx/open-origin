/**
 * The cost of the beings' tick (plan §7 and §9.2, test 14; ADR 0023, cost per tick): the work of
 * the beings system grows with occupied chunks, wakes, and decisions, never with the chunks the
 * world has materialized, nor with pairs of the beings it processes.
 *
 * Two checks, as the plan asks: a timed one, ten sleeping beings in worlds of 1,000 and 200,000
 * empty chunks, as step-cost.test.ts times the kernel; and a deterministic one, a context that
 * counts the calls of the system, which a planted chunkKeys() per tick fails (plan §9.4).
 * beings-fuzz.test.ts pins the reads of a quiet tick exactly; this file bounds every tick, the
 * busy ones too, in a world whose senses cover materialized chunks. A third, timed, holds the cost
 * per being of a tick that processes many beings at once, which T4-8 found quadratic and fixed.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  beings,
  type Command,
  createWorld,
  type Ruleset,
  readView,
  step,
  worldgen,
  worldStatus,
} from "../src/index.ts";
import {
  type Calls,
  counting,
  DISPERSED_CELLS,
  exploredChunks,
  sleepingWorld,
  windowChunks,
  windowRecorder,
} from "./support/beings-cost.ts";
import {
  type BeingsWorld,
  behavior,
  brain,
  chunkOf,
  lifeWith,
  PREPARED,
  SPECIES,
  spawn,
  testGenesis,
} from "./support/beings-world.ts";
import { alternatingMedians } from "./support/cost-worlds.ts";

// Creating a world of 200,000 chunks of beings takes about 3 s on the Codespace.
setDefaultTimeout(60_000);

/**
 * The timed check. Ten beings asleep in their own chunks cost a read of each chunk's `due` per
 * tick, so the tick stays near the kernel's floor, about 40 µs, where a copy of every chunk key
 * shows. Measured on the Codespace (Bun 1.4.4, 2026-10-27; indicative), the ratio of the medians,
 * 200,000 chunks over 1,000, was 0.99 to 1.02, and 4.9 to 5.2 with a planted chunkKeys() per tick.
 * The methodology and its guards against noise are step-cost.test.ts's: the garbage of creating
 * the worlds collected first, the worlds stepped alternately, 100 ticks of warm-up, the median of
 * 300, and a failed measurement repeated once.
 */
const SMALL = 1_000;
const LARGE = 200_000;
const MAX_RATIO = 2;
/** The lowest ratio measured with a planted chunkKeys() per tick. */
const PLANTED_RATIO = 4.9;
const ROUNDS = { warmUp: 100, measured: 300 } as const;

/** Whether a ratio of per-tick medians, LARGE over SMALL, shows no work that grows with chunks. */
const withinBound = (ratio: number) => ratio < MAX_RATIO;

describe("the beings' work per tick does not depend on the chunks the world has", () => {
  test(`the bound: below ${MAX_RATIO} passes; ${MAX_RATIO} and a planted chunkKeys()'s ${PLANTED_RATIO} fail`, () => {
    const ratios = [1.02, MAX_RATIO - 0.01, MAX_RATIO, PLANTED_RATIO];
    expect(ratios.map(withinBound)).toEqual([true, true, false, false]);
  });

  test(`ten sleeping beings in worlds of ${SMALL} and ${LARGE} empty chunks`, () => {
    const small = sleepingWorld(SMALL);
    const large = sleepingWorld(LARGE);
    const last = 2 + ROUNDS.warmUp + ROUNDS.measured;
    for (const world of [small, large]) {
      // Not vacuous: ten beings sleep, each in its own chunk, and none is due before the last tick.
      const view = readView(world);
      const { occupancy } = view.readGlobal();
      expect(occupancy).toHaveLength(DISPERSED_CELLS.length);
      for (const key of occupancy) {
        const chunk = view.readChunk(key);
        expect(chunk?.beings.map((being) => being.activity.kind)).toEqual(["sleep"]);
        expect(chunk?.due).toBeGreaterThan(last);
      }
    }
    // Collect the garbage of creating the worlds now, not while their ticks are timed.
    Bun.gc(true);
    let result = alternatingMedians(small, large, ROUNDS);
    if (!withinBound(result.ratio)) result = alternatingMedians(small, large, ROUNDS);
    // Every timed tick was quiet: the last one wrote nothing, and both worlds are healthy.
    for (const world of [small, large]) {
      expect(step(world, []).stats.dirtyChunks).toBe(0);
      expect(worldStatus(world)).toEqual({ kind: "ok", tick: last + 1 });
    }
    // The medians are in the failure message, for the record.
    expect({ ...result, within: withinBound(result.ratio) }).toMatchObject({ within: true });
  });
});

/** A window a brain sensed: the cell it starts at and its side. */
type Window = { origin: [number, number]; side: number };

/**
 * A brain that walks one to six steps along the heading of its first draw, as far as the window
 * lets it, then eats to full and idles a minute: it decides often, crosses chunks, and eats, and a
 * meal on a cell without food fails, so the being decides again soon after.
 */
const roamer = brain((senses) => {
  const [first = 0, second = 0] = senses.draws;
  const heading = first % 8;
  const { side, edgeMs } = senses.window;
  const [dx, dy] = beings.DIRECTIONS[heading] as readonly [number, number];
  let [x, y] = [(side - 1) / 2, (side - 1) / 2];
  let dirs = "";
  while (dirs.length < 1 + (second % 6) && (edgeMs[(y * side + x) * 8 + heading] ?? -1) >= 0) {
    dirs += `${heading}`;
    x += dx;
    y += dy;
  }
  const meal = [
    { kind: "eat", untilNutrition: beings.NEED_MAX },
    { kind: "idle", ms: 60_000 },
  ] as const;
  return {
    steps: dirs === "" ? meal : [{ kind: "walk", dirs }, ...meal],
    wakeWhen: {},
    behavior: behavior("roam", heading),
  };
}, "roamer@1");

/** One tick of a counted run: what the system called, and what the world was around it. */
type CountedTick = {
  readonly tick: number;
  readonly calls: Calls;
  /** The occupancy index before and after the tick, and the chunks of the beings after it. */
  readonly occupied: readonly string[];
  readonly listed: readonly string[];
  readonly after: readonly string[];
  /** The beings due at the tick, and the windows the decisions of the tick sensed. */
  readonly wakes: number;
  readonly windows: readonly Window[];
  /** Whether the tick starts a new simulated day, when the system prunes the occupancy index. */
  readonly dayTurns: boolean;
};

/** The empty chunks a counted run starts with, which every window of its beings covers in part. */
const EXPLORED = 4_096;
/** The seconds of a tick, and those of a day of the test genesis. */
const SPS = 12;
const DAY = testGenesis().laws.day.length;

/** The chunk keys and the beings due at the tick after `world`'s, read outside the system. */
function before(world: BeingsWorld) {
  const view = readView(world);
  const occupied = view.readGlobal().occupancy;
  const next = view.tick + 1;
  const wakes = occupied
    .flatMap((key) => view.readChunk(key)?.beings ?? [])
    .filter((being) => being.wake <= next).length;
  return { occupied: [...occupied], wakes };
}

/** The chunks of every being's cell in `world`. */
function beingChunks(world: BeingsWorld): string[] {
  const view = readView(world);
  return view
    .readGlobal()
    .occupancy.flatMap((key) => view.readChunk(key)?.beings ?? [])
    .map(({ cell: [x = 0, y = 0] }) => chunkOf([x, y]));
}

/**
 * `ticks` ticks of ten roaming beings, hungry and rested, spawned at tick 1 on DISPERSED_CELLS in
 * a world of the test genesis (a day of 100 ticks) with EXPLORED empty chunks around them, run by
 * `wrap` of the beings ruleset; every tick from 2 on, counted.
 */
function countedRun(
  ticks: number,
  wrap: (ruleset: Ruleset<beings.BeingsGlobal, beings.BeingsChunk>) => typeof ruleset = (r) => r,
) {
  const sink: Calls[] = [];
  const windows: Window[] = [];
  const controllers = { [SPECIES.id]: windowRecorder(roamer, windows) };
  const world = createWorld(
    {
      seed: [8, 9],
      simSecondsPerTick: SPS,
      global: beings.beingsGlobal(testGenesis(), beings.defaultLife()),
      chunks: exploredChunks(EXPLORED),
      ruleset: counting(wrap(beings.createBeingsRuleset({ controllers })), sink),
    },
    { audit: false },
  );
  const needs = { nutrition: 300_000, rest: beings.NEED_MAX };
  const spawns: Command[] = DISPERSED_CELLS.map((cell, seq) =>
    spawn(1, { species: SPECIES.id, cell: [...cell], needs }, seq),
  );
  step(world, spawns);
  const counted: CountedTick[] = [];
  let ate = 0;
  for (let tick = 2; tick <= ticks; tick += 1) {
    const { occupied, wakes } = before(world);
    const [calls, decided] = [sink.length, windows.length];
    ate += step(world, []).events.filter((event) => event.type === "being.ate").length;
    counted.push({
      tick,
      calls: sink[calls] as Calls,
      occupied,
      listed: readView(world).readGlobal().occupancy,
      after: beingChunks(world),
      wakes,
      windows: windows.slice(decided),
      dayTurns: Math.floor((tick * SPS) / DAY) > Math.floor(((tick - 1) * SPS) / DAY),
    });
  }
  return { counted, ate };
}

/**
 * The most chunks a tick may read: each listed chunk once, to read its `due`; each chunk a
 * decision senses; per wake, at most five more (two meals that start and read their cell, one
 * after the plan and one after a decision, a contest over the cell, and the chunks the being leaves
 * and enters, read before they are written); and on a day turn, each listed chunk again for the
 * prune, with at most one more per wake, a chunk a being entered.
 */
function readBound(tick: CountedTick): number {
  const sensed = tick.windows.reduce((sum, w) => sum + windowChunks(w.origin, w.side).length, 0);
  const prune = tick.dayTurns ? tick.occupied.length + tick.wakes : 0;
  return tick.occupied.length + sensed + 5 * tick.wakes + prune;
}

/**
 * Every problem of the calls of `tick`: chunkKeys called at all; the global value written more
 * than once, or at all when no chunk entered the occupancy index and the day did not turn; more
 * chunks read than readBound allows; and a chunk read that the tick had no reason to read, one
 * neither listed, nor sensed, nor holding a being after the tick.
 */
function callIssues(tick: CountedTick): string[] {
  const { calls } = tick;
  const issues: string[] = [];
  if (calls.chunkKeys > 0)
    issues.push(`tick ${tick.tick}: calls of chunkKeys: ${calls.chunkKeys}, none allowed`);
  // The global value changes only when a chunk enters the occupancy index or the day turns.
  const grown = tick.listed.some((key) => !tick.occupied.includes(key));
  const writes = tick.dayTurns || grown ? 1 : 0;
  if (calls.writeGlobal > writes)
    issues.push(
      `tick ${tick.tick}: writes of the global value: ${calls.writeGlobal}, at most ${writes}`,
    );
  if (calls.readChunk > readBound(tick))
    issues.push(`tick ${tick.tick}: chunk reads: ${calls.readChunk}, at most ${readBound(tick)}`);
  const reasons = new Set([
    ...tick.occupied,
    ...tick.after,
    ...tick.windows.flatMap((w) => windowChunks(w.origin, w.side)),
  ]);
  const stray = [...new Set(calls.keys.filter((key) => !reasons.has(key)))];
  if (stray.length > 0)
    issues.push(`tick ${tick.tick}: read ${stray.join(" ")}, neither listed, sensed, nor occupied`);
  return issues;
}

/** How many ticks the counted run lasts: past two day turns of the test genesis. */
const COUNTED_TICKS = 250;

describe("the calls of the beings system, counted (plan §7)", () => {
  test("each tick reads only the chunks listed, sensed, or occupied, within the bound, and never lists every chunk", () => {
    const { counted, ate } = countedRun(COUNTED_TICKS);
    expect(counted.flatMap(callIssues)).toEqual([]);
    // Not vacuous: beings decided, several in one tick; were processed without deciding; ate; left
    // their chunks for others; and the prune ran on both day turns.
    const decisions = counted.reduce((sum, tick) => sum + tick.windows.length, 0);
    expect(decisions).toBeGreaterThan(100);
    expect(Math.max(...counted.map((tick) => tick.windows.length))).toBeGreaterThan(1);
    expect(counted.some((tick) => tick.wakes > tick.windows.length)).toBe(true);
    expect(ate).toBeGreaterThan(0);
    expect(new Set(counted.flatMap((tick) => tick.after)).size).toBeGreaterThan(
      DISPERSED_CELLS.length,
    );
    expect(counted.filter((tick) => tick.dayTurns).map((tick) => tick.tick)).toEqual([100, 200]);
    expect(counted.filter((tick) => tick.calls.writeGlobal > 0).length).toBeGreaterThan(2);
    // The bound is tight enough to matter: some tick read more than its listed chunks twice over.
    expect(counted.some((tick) => tick.calls.readChunk > 2 * tick.occupied.length)).toBe(true);
  });

  test("a planted chunkKeys() per tick fails the count (plan §9.4)", () => {
    const planted = (ruleset: Ruleset<beings.BeingsGlobal, beings.BeingsChunk>) => ({
      ...ruleset,
      systems: ruleset.systems.map((system) => ({
        ...system,
        run: (ctx: Parameters<typeof system.run>[0]) => {
          ctx.chunkKeys();
          return system.run(ctx);
        },
      })),
    });
    const { counted } = countedRun(4, planted);
    expect(counted.flatMap(callIssues)).toEqual([
      "tick 2: calls of chunkKeys: 1, none allowed",
      "tick 3: calls of chunkKeys: 1, none allowed",
      "tick 4: calls of chunkKeys: 1, none allowed",
    ]);
  });

  test("the check: at its bounds passes; one read more, a stray chunk, or a needless write fails", () => {
    const calls = (readChunk: number, keys: string[], writeGlobal = 0) => ({
      chunkKeys: 0,
      readChunk,
      writeGlobal,
      keys,
    });
    // Two listed chunks, no wake: a quiet tick reads each once.
    const quiet: CountedTick = {
      tick: 7,
      calls: calls(2, ["0,0", "1,0"]),
      occupied: ["0,0", "1,0"],
      listed: ["0,0", "1,0"],
      after: ["0,0", "1,0"],
      wakes: 0,
      windows: [],
      dayTurns: false,
    };
    expect(callIssues(quiet)).toEqual([]);
    expect(callIssues({ ...quiet, calls: calls(3, ["0,0", "1,0", "0,0"]) })).toEqual([
      "tick 7: chunk reads: 3, at most 2",
    ]);
    expect(callIssues({ ...quiet, calls: calls(2, ["0,0", "5,5"]) })).toEqual([
      "tick 7: read 5,5, neither listed, sensed, nor occupied",
    ]);
    expect(callIssues({ ...quiet, calls: calls(2, ["0,0", "1,0"], 1) })).toEqual([
      "tick 7: writes of the global value: 1, at most 0",
    ]);
    // A write is allowed when a chunk entered the index, or on a day turn with the prune's reads.
    const grown = { ...quiet, listed: ["0,0", "1,0", "2,0"], calls: calls(2, ["0,0", "1,0"], 1) };
    expect(callIssues(grown)).toEqual([]);
    const pruned = { ...quiet, dayTurns: true, calls: calls(4, ["0,0", "1,0", "0,0", "1,0"], 1) };
    expect(callIssues(pruned)).toEqual([]);
    expect(callIssues({ ...pruned, calls: calls(4, ["0,0", "1,0"], 2) })).toEqual([
      "tick 7: writes of the global value: 2, at most 1",
    ]);
    // One wake that decided, with a window of 49 cells from (−24, −24) over 4 chunks: 2 + 4 + 5.
    const decided = { ...quiet, wakes: 1, windows: [{ origin: [-24, -24], side: 49 }] as Window[] };
    const sensed = ["-1,-1", "0,-1", "-1,0", "0,0"];
    const keys = [...quiet.calls.keys, ...sensed, "0,0", "0,0", "0,0", "1,0", "-1,-1"];
    expect(callIssues({ ...decided, calls: calls(11, keys) })).toEqual([]);
    expect(callIssues({ ...decided, calls: calls(12, [...keys, "0,0"]) })).toEqual([
      "tick 7: chunk reads: 12, at most 11",
    ]);
    expect(callIssues({ ...quiet, calls: { ...quiet.calls, chunkKeys: 1 } })).toEqual([
      "tick 7: calls of chunkKeys: 1, none allowed",
    ]);
  });
});

/**
 * Many wakes in one tick (AGENTS.md, "Cost per tick"): the beings processed together in a tick must
 * cost about the same each, however many there are. T4-8's benchmark found that they did not: the
 * system matched every processed being against every chunk it wrote, so a tick of 16,000 wakes took
 * 3.3 ms per being against 0.35 ms for 1,000. Here beings idle, each alone in its chunk, at 1,200 s
 * per tick, the test genesis' whole day, so the daily processing takes every being at every tick,
 * without a decision. That old work per pair of wakes, about 0.1 µs, is small beside the 85 µs or
 * so a wake costs, so it shows only when one world holds many more beings than the other: the
 * median tick of 1,200 beings must cost less than 1.6 times per being the median tick of 50.
 * Measured on the Codespace (Bun 1.4.4, 2026-10-27; indicative): 0.99 and 1.12 with the fix, and
 * 2.26 and 2.41 with the system before it; the bound lies about 1.4 times from each. The timing
 * follows step-cost.test.ts: the worlds stepped alternately, warm-up first, the medians, and a
 * failed measurement repeated once. Both worlds cost about 1.5 s on the Codespace to build and
 * time, a third of it their spawns and first decisions.
 */
const FEW = 50;
const MANY = 1_200;
const PER_BEING_BOUND = 1.6;
/** The lowest ratio per being measured with the system before the fix, quadratic in the wakes. */
const QUADRATIC_RATIO = 2.26;
const WAKE_ROUNDS = { warmUp: 1, measured: 5 } as const;

/** Whether a ratio per being, MANY over FEW, shows no work that grows with pairs of wakes. */
const scales = (ratio: number) => ratio < PER_BEING_BOUND;

/** A tick as long as the test genesis' day, so that every being is processed at every tick. */
const DAY_TICK = testGenesis().laws.day.length;

/** A species that senses only its neighbors, so that the first decisions cost little. */
const NEAR = lifeWith((species) => ({ ...species, senses: { radius: 1 } }));

/** A brain that idles for 46 days: a being that only the daily processing takes again. */
const idler = brain(
  () => ({
    steps: [{ kind: "idle", ms: 4_000_000_000 }],
    wakeWhen: {},
    behavior: behavior("rest"),
  }),
  "idler@1",
);

/** The first MANY dry cells in the middle of the chunks from (−25, −25), row by row. */
const IDLE_CELLS: readonly (readonly [number, number])[] = (() => {
  const level = worldgen.liquidLevel(testGenesis());
  const cells: [number, number][] = [];
  for (let index = 0; cells.length < MANY; index += 1) {
    const [x, y] = [((index % 50) - 25) * 32 + 16, (Math.floor(index / 50) - 25) * 32 + 16];
    const rect = { x, y, width: 1, height: 1 };
    const [elevation = -1] = worldgen.sampleSurface(PREPARED, rect, SPECIES.diet.deposit).elevation;
    if (elevation >= level) cells.push([x, y]);
  }
  return cells;
})();

/** A world of `count` idle beings on IDLE_CELLS, stepped to tick 2, when each decided. */
function idleWorld(count: number) {
  const world = createWorld(
    {
      seed: [3, 4],
      simSecondsPerTick: DAY_TICK,
      global: beings.beingsGlobal(testGenesis(), NEAR),
      chunks: {},
      ruleset: beings.createBeingsRuleset({ controllers: { [SPECIES.id]: idler } }),
    },
    { audit: false },
  );
  const spawns = IDLE_CELLS.slice(0, count).map((cell, seq) =>
    spawn(1, { species: SPECIES.id, cell: [...cell] }, seq),
  );
  step(world, spawns);
  step(world, []);
  return world;
}

describe("many wakes in one tick cost the same per being", () => {
  test(`the bound: below ${PER_BEING_BOUND} passes; ${PER_BEING_BOUND} and the quadratic system's ${QUADRATIC_RATIO} fail`, () => {
    const ratios = [1.12, PER_BEING_BOUND - 0.01, PER_BEING_BOUND, QUADRATIC_RATIO];
    expect(ratios.map(scales)).toEqual([true, true, false, false]);
  });

  test(`${FEW} and ${MANY} beings processed at every tick`, () => {
    const few = idleWorld(FEW);
    const many = idleWorld(MANY);
    // Not vacuous, and a first warm-up: the next tick processes every being of both worlds and
    // writes its chunk.
    const dirty = [step(few, []).stats.dirtyChunks, step(many, []).stats.dirtyChunks];
    expect(dirty).toEqual([FEW, MANY]);
    Bun.gc(true);
    const measure = () => {
      const { ratio, smallMedian, largeMedian } = alternatingMedians(few, many, WAKE_ROUNDS);
      return { smallMedian, largeMedian, perBeing: (ratio * FEW) / MANY };
    };
    let result = measure();
    if (!scales(result.perBeing)) result = measure();
    // The medians are in the failure message, for the record.
    expect({ ...result, scales: scales(result.perBeing) }).toMatchObject({ scales: true });
  });
});
