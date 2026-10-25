import { heapStats } from "bun:jsc";
import { murmur3x86_128 } from "../src/digest/murmur3.ts";
import {
  type CanonicalValue,
  canonicalize,
  decodeSnapshot,
  encodeSnapshot,
  stateRoot,
  step,
  streamId,
} from "../src/index.ts";
import { DrawSequence } from "../src/rng/random.ts";
import { DIRTY_KEYS, dirtying, median, sizedWorld } from "../test/support/cost-worlds.ts";
import { stepRuleset } from "../test/support/step-rulesets.ts";

/**
 * The engine's benchmark (plan §2.4, §8 "Benchmark"; risk R10): manual, never run by `bun test`,
 * because it measures wall-clock time. Run it with `bun packages/engine/bench/step.ts`. It prints
 * one table of indicative numbers, which docs/architecture/determinism.md records with the
 * machine and Bun version they came from; compare runs on one machine, before and after a change
 * to a hot path, never across machines.
 *
 * Every time is the median of repeated runs after a warm-up. The worlds are built from plain
 * test fixtures, so the numbers measure the kernel, not a ruleset.
 */

type Row = readonly [string, string];

/** The median duration of `action`, in nanoseconds, over `runs` runs after `warmUp` more. */
function timed(action: () => unknown, runs: number, warmUp = Math.ceil(runs / 4)): number {
  const times: number[] = [];
  for (let run = 0; run < warmUp + runs; run += 1) {
    const start = Bun.nanoseconds();
    action();
    if (run >= warmUp) times.push(Bun.nanoseconds() - start);
  }
  return median(times);
}

const micro = (nanoseconds: number) => `${(nanoseconds / 1e3).toFixed(1)} µs`;
const milli = (nanoseconds: number) => `${(nanoseconds / 1e6).toFixed(1)} ms`;
const megabytesPerSecond = (bytes: number, nanoseconds: number) =>
  `${((bytes / nanoseconds) * 1e3).toFixed(0)} MB/s`;

/** How many chunks change each tick in the step measurements: the same as the complexity test. */
const DIRTY = DIRTY_KEYS.length;

/** A being, as T4 may keep one: about 120 bytes of canonical text, so 60 make about 7 KB. */
const being = (id: number) => ({
  id: 1_000_000 + id,
  name: `being ${id}`.padEnd(12, "."),
  at: [id % 97, id % 89],
  hunger: 50,
  thirst: 25,
  mood: "calm",
  goal: "seek water",
  age: 1_000 + id,
});

/** A chunk of `beings` beings and a counter. */
const chunkOf = (beings: number): CanonicalValue => ({
  n: 0,
  beings: Array.from({ length: beings }, (_, id) => being(id)),
});

/**
 * A tick with DIRTY chunks changed, in worlds of 1,000 to 1,000,000 small chunks. The worlds step
 * in turn, tick by tick, so that a drift of the machine or the JIT affects all of them alike.
 */
function stepRows(): Row[] {
  const counts = [1_000, 10_000, 100_000, 1_000_000];
  const worlds = counts.map((count) => sizedWorld(count, () => chunkOf(0)));
  Bun.gc(true);
  const times: number[][] = counts.map(() => []);
  for (let round = 0; round < 2_500; round += 1) {
    worlds.forEach((world, index) => {
      const start = Bun.nanoseconds();
      step(world, []);
      if (round >= 500) times[index]?.push(Bun.nanoseconds() - start);
    });
  }
  return counts.map((count, index): Row => {
    const label = `step, N = ${count.toLocaleString("en")}, D = ${DIRTY}`;
    return [label, micro(median(times[index] ?? []))];
  });
}

/** The canonical bytes of one chunk of `beings` beings. */
const chunkBytes = (beings: number) =>
  new TextEncoder().encode(canonicalize(chunkOf(beings))).length;

/** The cost of each dirty chunk, of about 1, 7, and 50 KB of canonical text, D at a time. */
function dirtyRows(): Row[] {
  return [9, 60, 425].map((beings): Row => {
    const world = sizedWorld(DIRTY, () => chunkOf(beings));
    const bytes = chunkBytes(beings);
    const tick = timed(() => step(world, []), 200);
    const label = `dirty chunk of ${(bytes / 1024).toFixed(1)} KB`;
    return [label, `${micro(tick / DIRTY)} per chunk, ${megabytesPerSecond(bytes * DIRTY, tick)}`];
  });
}

/** encodeSnapshot and decodeSnapshot of worlds of about 200 KB and 10 MB. */
function snapshotRows(): Row[] {
  return [29, 1_430].flatMap((count): Row[] => {
    const world = sizedWorld(count, () => chunkOf(60));
    const text = encodeSnapshot(world);
    const size = `${(text.length / 1e6).toFixed(1)} MB`;
    const runs = count > 100 ? 8 : 50;
    const encode = timed(() => encodeSnapshot(world), runs);
    const decode = timed(() => decodeSnapshot(text, dirtying), runs);
    return [
      [`encodeSnapshot, ${size}`, `${milli(encode)}, ${megabytesPerSecond(text.length, encode)}`],
      [`decodeSnapshot, ${size}`, `${milli(decode)}, ${megabytesPerSecond(text.length, decode)}`],
    ];
  });
}

/** The live heap after a full collection: JSC cells and the memory it tracks beside them. */
function liveHeap(): number {
  Bun.gc(true);
  const { heapSize, extraMemorySize } = heapStats();
  return heapSize + extraMemorySize;
}

/** What the kernel keeps per chunk (key, entry, term, and index), with chunks of the value 0. */
function memoryRow(): Row {
  const count = 100_000;
  const before = liveHeap();
  const world = sizedWorld(count, () => 0, stepRuleset());
  const bytes = (liveHeap() - before) / count;
  // Keeps the world alive until after the second measurement.
  stateRoot(world);
  return [`kernel memory per chunk, N = ${count.toLocaleString("en")}`, `${bytes.toFixed(0)} B`];
}

/** MurmurHash3 x86_128 over 1 MiB, and the draws of one sequence. */
function primitiveRows(): Row[] {
  const bytes = new Uint8Array(1 << 20).map((_, index) => index * 31);
  const hash = timed(() => murmur3x86_128(bytes, 0), 50);
  const draws = 1_000_000;
  const sequence = () => new DrawSequence([1, 2], streamId("bench"), [0, 0, 7, 0]);
  const u32 = timed(() => {
    const drawn = sequence();
    for (let draw = 0; draw < draws; draw += 1) drawn.u32();
  }, 10);
  const perSecond = (draws / u32) * 1e9;
  return [
    ["MurmurHash3 x86_128, 1 MiB", megabytesPerSecond(bytes.length, hash)],
    ["draws (DrawSequence.u32)", `${(perSecond / 1e6).toFixed(1)} million per second`],
  ];
}

const rows: Row[] = [
  ...stepRows(),
  ...dirtyRows(),
  ...snapshotRows(),
  memoryRow(),
  ...primitiveRows(),
];
console.log(`Bun ${Bun.version}, ${navigator.hardwareConcurrency} cores\n`);
console.log("| Measurement | Result |\n|---|---|");
for (const [name, value] of rows) console.log(`| ${name} | ${value} |`);
