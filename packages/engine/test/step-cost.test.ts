import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { hexOf } from "../src/digest/digest.ts";
import { type CanonicalValue, canonicalize, digest, step, type World } from "../src/index.ts";
import { worldState } from "../src/world/world.ts";
import { DIRTY_KEYS, median, sizedWorld } from "./support/cost-worlds.ts";
import { type Data, stepRuleset, stepWorld, system, writable } from "./support/step-rulesets.ts";

/**
 * The cost of a tick (ADR 0020, cost; plan §2.4, §8 "Complejidad"): the kernel hashes only what
 * changed, plus digests of a fixed size, so `stats.hashedBytes` is exact and deterministic, and
 * its work per tick does not grow with the number of chunks.
 */

// Creating a world of 200,000 chunks takes about 1.4 s on the 2-core Codespace.
setDefaultTimeout(30_000);

const encoder = new TextEncoder();
const bytes = (value: CanonicalValue) => encoder.encode(canonicalize(value)).length;

/** The bytes a tick hashes beyond the changed data: the kernel, the root, the events, the tick. */
function fixedBytes(world: World, events: readonly CanonicalValue[], global: CanonicalValue) {
  const { kernel, chunks, digests } = worldState(world);
  const kernelValue = [
    "kernel",
    {
      epoch: kernel.epoch,
      tick: kernel.tick,
      nextEntityId: kernel.nextEntityId,
      rng: { algorithm: kernel.rng.algorithm, seed: [...kernel.rng.seed] },
      config: { simSecondsPerTick: kernel.config.simSecondsPerTick },
    },
  ];
  const root = [
    "state",
    digest(kernelValue),
    digest(["global", global]),
    hexOf(digests.chunkSum),
    chunks.size,
  ];
  const eventsValue = ["events", events];
  return (
    bytes(kernelValue) +
    bytes(root) +
    bytes(eventsValue) +
    bytes(["tick", digest(root), digest(eventsValue)])
  );
}

/** A ruleset that changes chunk 0,0, and the global value when `global` is set, every tick. */
const touching = (global: boolean) =>
  stepRuleset([
    system("touch", (ctx) => {
      writable(ctx, "0,0").grass = ctx.tick;
      if (global) (ctx.writeGlobal() as Data).population = ctx.tick;
      ctx.emit("touched", ctx.tick);
    }),
  ]);

describe("stats.hashedBytes", () => {
  test("is exactly the canonical UTF-8 bytes of the changed data and the fixed digests", () => {
    const world = stepWorld(touching(true), {
      chunks: { "0,0": { grass: 0 }, "1,0": { grass: "a long chunk that nobody touches" } },
    });
    const { stats, events } = step(world, []);
    const global = { population: 1 };
    expect(stats.hashedBytes).toBe(
      bytes(["chunk", "0,0", { grass: 1 }]) +
        bytes(["global", global]) +
        fixedBytes(world, events, global),
    );
  });

  test("leaves out a global value that did not change", () => {
    const world = stepWorld(touching(false));
    const { stats, events } = step(world, []);
    expect(stats.hashedBytes).toBe(
      bytes(["chunk", "0,0", { grass: 1 }]) + fixedBytes(world, events, { population: 0 }),
    );
  });

  test("does not count audit's full recomputation", () => {
    const plain = step(stepWorld(touching(true)), []);
    const audited = step(stepWorld(touching(true), {}, true), []);
    expect(audited).toEqual(plain);
  });

  test("for 10,000 chunks with one changed, hashes only that chunk", () => {
    const chunks: { [key: string]: CanonicalValue } = {};
    for (let x = 0; x < 100; x += 1) {
      for (let y = 0; y < 100; y += 1) chunks[`${x},${y}`] = { grass: x + y, name: `chunk ${x}` };
    }
    const world = stepWorld(touching(false), { chunks });
    const { stats, events, changedChunks } = step(world, []);
    expect(changedChunks).toEqual(["0,0"]);
    expect(stats.hashedBytes).toBe(
      bytes(["chunk", "0,0", { grass: 1, name: "chunk 0" }]) +
        fixedBytes(world, events, { population: 0 }),
    );
    expect(stats.hashedBytes).toBeLessThan(1_000);
  });
});

describe("the chunk index stays lazy", () => {
  test("chunks created in a tick stay pending until someone asks for every key", () => {
    const world = stepWorld(
      stepRuleset([
        system("settle", (ctx) => {
          for (let x = 10; x > 5; x -= 1) ctx.createChunk(`${x},0`, { grass: x });
        }),
      ]),
    );
    worldState(world).chunks.sortedKeys();
    step(world, []);
    expect(worldState(world).chunks.pendingCount).toBe(5);
    expect(worldState(world).chunks.size).toBe(7);
  });
});

/**
 * The complexity test (plan §2.4, §8 "Complejidad", risk R11): with D = 10 chunks changed per
 * tick, a tick of a world of 200,000 chunks must cost less than 2 times a tick of a world of
 * 1,000. Measured, with each added to the commit, the cheapest work that grows with N, a bare copy
 * of the key list, gives 3.1 to 4.2 times; a scan of every key about 95, and a sort about 70. The
 * kernel itself gives 0.95 to 1.1. So an O(N) term is caught once it costs more than about 0.3 ns
 * per chunk per tick, as much as the 60 µs a tick of D = 10 costs. The plan's bound of 4 let the
 * bare copy pass (all indicative: Bun 1.4.4, 2-core Codespace, 2026-10-25, alone and four runs at
 * once).
 *
 * Wall-clock time is noisy, so the test is built not to flake:
 *
 * - the garbage of creating the worlds is collected before any tick is timed;
 * - both worlds step alternately, tick by tick, so they share the machine's conditions;
 * - 100 ticks of each warm the JIT up before any is measured;
 * - the median of 300 ticks of each ignores collections and other outliers;
 * - the bound of 2 is 1.8 times the kernel's highest ratio, 1.1, and the bare copy's lowest, 3.1,
 *   is 1.5 times the bound;
 * - a failed measurement is repeated once, since an O(N) bug fails both and noise rarely does.
 *
 * If it still fails intermittently, plan R11 moves it to the benchmark, with the reason recorded.
 */
const SMALL = 1_000;
const LARGE = 200_000;
const MAX_RATIO = 2;
/** The lowest ratio measured with a bare copy of the key list in the commit. */
const BARE_COPY_RATIO = 3.1;
const WARM_UP = 100;
const MEASURED = 300;

/** Whether a ratio of per-tick medians, LARGE over SMALL, shows no work that grows with N. */
const withinBound = (ratio: number) => ratio < MAX_RATIO;

/** A world of `count` chunks `{ n: 0 }`, run by `dirtying`. */
const sized = (count: number) => sizedWorld(count, () => ({ n: 0 }));

/** The per-tick medians of `small` and `large`, stepped alternately, and their ratio. */
function measure(small: World, large: World) {
  const times: [number[], number[]] = [[], []];
  for (let round = 0; round < WARM_UP + MEASURED; round += 1) {
    [small, large].forEach((world, index) => {
      const start = Bun.nanoseconds();
      step(world, []);
      if (round >= WARM_UP) times[index]?.push(Bun.nanoseconds() - start);
    });
  }
  const [smallMedian, largeMedian] = times.map(median) as [number, number];
  return { smallMedian, largeMedian, ratio: largeMedian / smallMedian };
}

describe("the kernel's work per tick does not depend on the number of chunks", () => {
  test(`the bound: below ${MAX_RATIO} passes; ${MAX_RATIO} and a bare copy's ${BARE_COPY_RATIO} fail`, () => {
    const ratios = [1.1, MAX_RATIO - 0.01, MAX_RATIO, BARE_COPY_RATIO];
    expect(ratios.map(withinBound)).toEqual([true, true, false, false]);
  });

  test(`D = 10 in worlds of ${SMALL} and ${LARGE} chunks: hashed bytes, then time`, () => {
    const small = sized(SMALL);
    const large = sized(LARGE);
    for (const world of [small, large]) {
      const { stats, events } = step(world, []);
      const dirty = DIRTY_KEYS.reduce((sum, key) => sum + bytes(["chunk", key, { n: 1 }]), 0);
      expect(stats.dirtyChunks).toBe(DIRTY_KEYS.length);
      expect(stats.hashedBytes).toBe(dirty + fixedBytes(world, events, { population: 0 }));
    }
    // Collect the garbage of creating the worlds now, not while their ticks are timed.
    Bun.gc(true);
    let result = measure(small, large);
    if (!withinBound(result.ratio)) result = measure(small, large);
    // The medians are in the failure message, for the record.
    expect({ ...result, within: withinBound(result.ratio) }).toMatchObject({ within: true });
  });
});
