import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { hexOf } from "../src/digest/digest.ts";
import { type CanonicalValue, canonicalize, digest, step, type World } from "../src/index.ts";
import { worldState } from "../src/world/world.ts";
import { type Data, stepRuleset, stepWorld, system, writable } from "./support/step-rulesets.ts";

/**
 * The cost of a tick (ADR 0020, cost): the kernel hashes only what changed, plus digests of a
 * fixed size, so `stats.hashedBytes` is exact and deterministic, and it does not grow with the
 * number of chunks.
 */

// Creating a world of 10,000 chunks takes a moment on a cold CI runner.
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
