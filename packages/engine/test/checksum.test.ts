import { describe, expect, test } from "bun:test";
import {
  type CanonicalValue,
  chunkHashes,
  chunkKey,
  createWorld,
  digest,
  encodeSnapshot,
  fullChecksum,
  type Seed,
  stateRoot,
  type WorldInit,
} from "../src/index.ts";
import { type ChunkEntry, worldState } from "../src/world/world.ts";
import { randomValue } from "./support/canonical-random.ts";
import { testRuleset } from "./support/rulesets.ts";
import { Sfc32 } from "./support/sfc32.ts";

/**
 * The state root (ADR 0020, digests): stateRoot = digest(["state", kernelDigest, globalDigest,
 * chunkSum, chunkCount]), where chunkSum adds the terms digest(["chunk", key, chunk]) modulo
 * 2^128. The expected roots here are computed independently, with digest and BigInt, from the
 * ADR's formulas.
 */

type Chunks = Record<string, CanonicalValue>;
type Init = WorldInit<CanonicalValue, CanonicalValue>;

const MODULUS = 1n << 128n;

function init(chunks: Chunks, global: CanonicalValue = 0, seed: Seed = [1, 2], perTick = 60): Init {
  return { seed, simSecondsPerTick: perTick, global, chunks, ruleset: testRuleset() };
}

/** The sum of digests modulo 2^128, written as a digest, computed with BigInt. */
function sumOf(digests: readonly string[]): string {
  const sum = digests.reduce((total, term) => (total + BigInt(`0x${term}`)) % MODULUS, 0n);
  return sum.toString(16).padStart(32, "0");
}

const term = (key: string, chunk: CanonicalValue) => digest(["chunk", key, chunk]);

type Kernel = { epoch: number; tick: number; nextEntityId: number };

/** The root ADR 0020 gives for this state, from the formulas alone. */
function expectedRoot(world: Init, chunks: Chunks, kernel: Kernel = START): string {
  const kernelDigest = digest([
    "kernel",
    {
      ...kernel,
      rng: { algorithm: "ctr-mix32@1", seed: [...world.seed] },
      config: { simSecondsPerTick: world.simSecondsPerTick },
    },
  ]);
  const keys = Object.keys(chunks);
  const sum = sumOf(keys.map((key) => term(key, chunks[key] as CanonicalValue)));
  return digest(["state", kernelDigest, digest(["global", world.global]), sum, keys.length]);
}

const START: Kernel = { epoch: 0, tick: 0, nextEntityId: 1 };

/** A world of random chunks at random coordinates, with a random global value. */
function randomInit(random: Sfc32): { definition: Init; chunks: Chunks } {
  const chunks: Chunks = {};
  for (let count = random.below(12); count > 0; count -= 1) {
    const key = chunkKey({ x: random.between(-1000, 1000), y: random.between(-1000, 1000) });
    chunks[key] = randomValue(random);
  }
  const seed: Seed = [random.next(), random.next()];
  const definition = init(chunks, randomValue(random), seed, random.between(1, 3600));
  return { definition, chunks };
}

describe("stateRoot", () => {
  test("follows the composition of ADR 0020", () => {
    const chunks = { "0,0": { grass: 3 }, "-1,2": [1, "a"], "10,0": true };
    const definition = init(chunks, { population: 2 });
    expect(stateRoot(createWorld(definition))).toBe(expectedRoot(definition, chunks));
  });

  test("of a world without chunks sums no terms", () => {
    const definition = init({});
    expect(stateRoot(createWorld(definition))).toBe(expectedRoot(definition, {}));
    expect(sumOf([])).toBe("0".repeat(32));
  });

  test("carries between lanes, as a sum modulo 2^128 must", () => {
    // Over 64 chunks, the low lanes of the terms overflow 2^32 many times.
    const chunks: Chunks = {};
    for (let x = 0; x < 64; x += 1) chunks[`${x},0`] = x;
    const definition = init(chunks);
    expect(stateRoot(createWorld(definition))).toBe(expectedRoot(definition, chunks));
  });

  test("equals fullChecksum, the snapshot's root, and the composition on 200 random worlds", () => {
    const random = new Sfc32(2020);
    for (let sample = 0; sample < 200; sample += 1) {
      const { definition, chunks } = randomInit(random);
      const world = createWorld(definition);
      const root = expectedRoot(definition, chunks);
      expect(stateRoot(world)).toBe(root);
      expect(fullChecksum(world)).toBe(root);
      // encodeSnapshot recomputes the root from the text it writes, through the same composition.
      expect((JSON.parse(encodeSnapshot(world)) as { stateRoot: string }).stateRoot).toBe(root);
    }
  });

  test("does not depend on the order in which the chunks were given", () => {
    const forward = { "0,0": 1, "1,0": 2, "2,0": 3, "-5,7": [4] };
    const backward = { "-5,7": [4], "2,0": 3, "1,0": 2, "0,0": 1 };
    expect(stateRoot(createWorld(init(backward)))).toBe(stateRoot(createWorld(init(forward))));
  });
});

describe("stateRoot changes with any part of the state", () => {
  const chunks = { "0,0": { grass: 3 }, "1,0": { grass: 4 } };
  const base = stateRoot(createWorld(init(chunks, { population: 2 })));

  test.each<[string, Init]>([
    ["one chunk's value", init({ ...chunks, "1,0": { grass: 5 } }, { population: 2 })],
    ["one chunk's key", init({ "0,0": { grass: 3 }, "2,0": { grass: 4 } }, { population: 2 })],
    ["one chunk more", init({ ...chunks, "2,0": { grass: 0 } }, { population: 2 })],
    ["one chunk less", init({ "0,0": { grass: 3 } }, { population: 2 })],
    ["the global value", init(chunks, { population: 3 })],
    ["the seed's first word", init(chunks, { population: 2 }, [0, 2])],
    ["the seed's second word", init(chunks, { population: 2 }, [1, 3])],
    ["the seconds per tick", init(chunks, { population: 2 }, [1, 2], 61)],
  ])("%s", (_name, definition) => {
    expect(stateRoot(createWorld(definition))).not.toBe(base);
  });

  test.each<[string, Partial<Kernel>]>([
    ["the epoch", { epoch: 1 }],
    ["the tick", { tick: 1 }],
    ["the next entity id", { nextEntityId: 2 }],
  ])("%s, which only step changes", (_name, change) => {
    const definition = init(chunks, { population: 2 });
    const kernel = { ...START, ...change };
    expect(expectedRoot(definition, chunks, kernel)).not.toBe(base);
    const world = createWorld(definition);
    Object.assign(worldState(world).kernel, change);
    expect(fullChecksum(world)).toBe(expectedRoot(definition, chunks, kernel));
  });
});

describe("fullChecksum recomputes from the state, never from the cache", () => {
  test("so it sees a change that bypassed the engine, and stateRoot does not", () => {
    const chunks = { "0,0": { grass: 3 }, "1,0": { grass: 4 } };
    const definition = init(chunks, { population: 2 });
    const world = createWorld(definition);
    const root = stateRoot(world);
    const state = worldState(world);
    (state.chunks.get("1,0") as ChunkEntry).value = { grass: 9 };
    const changed = { ...chunks, "1,0": { grass: 9 } };
    expect(fullChecksum(world)).toBe(expectedRoot(definition, changed));
    expect(stateRoot(world)).toBe(root);
    state.global = { population: 7 };
    expect(fullChecksum(world)).toBe(expectedRoot(init(changed, { population: 7 }), changed));
  });
});

describe("the chunk sum composes by region", () => {
  test("the sum of a world is the lane sum of the sums of two disjoint regions", () => {
    const random = new Sfc32(77);
    const west: Chunks = {};
    const east: Chunks = {};
    for (let x = 0; x < 20; x += 1) {
      west[`${-x - 1},${x}`] = randomValue(random);
      east[`${x},${-x}`] = randomValue(random);
    }
    const whole = { ...west, ...east };
    const regionSum = (chunks: Chunks) =>
      sumOf(Object.values(chunkHashes(createWorld(init(chunks)))));
    const combined = sumOf([regionSum(west), regionSum(east)]);
    expect(combined).toBe(regionSum(whole));
    const definition = init(whole);
    const kernelDigest = digest([
      "kernel",
      {
        ...START,
        rng: { algorithm: "ctr-mix32@1", seed: [1, 2] },
        config: { simSecondsPerTick: 60 },
      },
    ]);
    const root = digest(["state", kernelDigest, digest(["global", 0]), combined, 40]);
    expect(stateRoot(createWorld(definition))).toBe(root);
  });
});

describe("chunkHashes", () => {
  const chunks = { "2,0": { grass: 1 }, "10,0": { grass: 2 }, "-1,0": { grass: 3 }, "0,0": [4] };

  test("gives each chunk's term, keyed in canonical order", () => {
    const hashes = chunkHashes(createWorld(init(chunks)));
    expect(Object.keys(hashes)).toEqual(["-1,0", "0,0", "10,0", "2,0"]);
    for (const [key, chunk] of Object.entries(chunks)) expect(hashes[key]).toBe(term(key, chunk));
  });

  test("changes only the term of the chunk that changed", () => {
    const before = chunkHashes(createWorld(init(chunks)));
    const after = chunkHashes(createWorld(init({ ...chunks, "10,0": { grass: 20 } })));
    const changed = Object.keys(before).filter((key) => before[key] !== after[key]);
    expect(changed).toEqual(["10,0"]);
  });

  test("returns a fresh record each time", () => {
    const world = createWorld(init(chunks));
    const first = chunkHashes(world);
    first["0,0"] = "x";
    expect(chunkHashes(world)["0,0"]).toBe(term("0,0", [4]));
    expect(chunkHashes(world)).not.toBe(chunkHashes(world));
  });
});
