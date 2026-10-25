import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { hexOf } from "../src/digest/digest.ts";
import { type CanonicalValue, canonicalize, digest, step, type World } from "../src/index.ts";
import { worldState } from "../src/world/world.ts";
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
 * tick, a tick of a world of 200,000 chunks must cost less than 4 times a tick of a world of
 * 1,000. Work that grows with N, such as a scan or a sort of every key per tick, gives about 100
 * times (measured with each added to the commit). An O(N) term is caught once it costs more than
 * about 1.5 ns per chunk per tick, three times the 90 µs a tick of D = 10 costs; a bare copy of
 * the key list costs less (3.6 times) and is caught by the lazy index test above instead
 * (indicative: Bun 1.4.4, 2-core Codespace, 2026-10-25).
 *
 * Wall-clock time is noisy, so the test is built not to flake:
 *
 * - the garbage of creating the worlds is collected before any tick is timed;
 * - both worlds step alternately, tick by tick, so they share the machine's conditions;
 * - 100 ticks of each warm the JIT up before any is measured;
 * - the median of 300 ticks of each ignores collections and other outliers;
 * - the bound of 4 is far from both 1, the measured ratio, and 200, the ratio of an O(N) bug;
 * - a failed measurement is repeated once, since an O(N) bug fails both and noise rarely does.
 *
 * If it still fails intermittently, plan R11 moves it to the benchmark, with the reason recorded.
 */
const SMALL = 1_000;
const LARGE = 200_000;
const MAX_RATIO = 4;
const WARM_UP = 100;
const MEASURED = 300;

/** Whether a ratio of per-tick medians, LARGE over SMALL, shows no work that grows with N. */
const withinBound = (ratio: number) => ratio < MAX_RATIO;

/** The ten chunks that change every tick, present in both worlds. */
const DIRTY = Array.from({ length: 10 }, (_, x) => `${x},0`);

const dirtying = stepRuleset([
  system("dirty", (ctx) => {
    for (const key of DIRTY) writable(ctx, key).n = ctx.tick;
  }),
]);

/** A world of `count` chunks `{ n: 0 }`, keyed on rows of 1,000. */
function sized(count: number): World {
  const chunks: { [key: string]: CanonicalValue } = {};
  for (let index = 0; index < count; index += 1) {
    chunks[`${index % 1000},${Math.floor(index / 1000)}`] = { n: 0 };
  }
  return stepWorld(dirtying, { chunks });
}

function median(values: number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[sorted.length >> 1] ?? 0;
}

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
  test(`the bound: a ratio below ${MAX_RATIO} passes; ${MAX_RATIO} and the 200 of O(N) fail`, () => {
    expect([1, 3.99, MAX_RATIO, 200].map(withinBound)).toEqual([true, true, false, false]);
  });

  test(`D = 10 in worlds of ${SMALL} and ${LARGE} chunks: hashed bytes, then time`, () => {
    const small = sized(SMALL);
    const large = sized(LARGE);
    for (const world of [small, large]) {
      const { stats, events } = step(world, []);
      const dirty = DIRTY.reduce((sum, key) => sum + bytes(["chunk", key, { n: 1 }]), 0);
      expect(stats.dirtyChunks).toBe(DIRTY.length);
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
