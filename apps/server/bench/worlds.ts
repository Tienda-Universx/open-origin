/**
 * The worlds the server's benchmarks run (plan §11): the default world of T5, as the server runs
 * it, and the worlds of the beings benchmark (packages/agents/bench/scale.ts), 1,000 beings under
 * `utility@1` dispersed one to a chunk or concentrated in one chunk. The benchmarks load this module
 * only when they run, so their tests, which check their arithmetic, load no world.
 */
import { type Command, readView, step, type World } from "@open-origin/engine";
import type { ChunkCoord, TerrainPublic } from "@open-origin/protocol/public";
import {
  benchCenter,
  benchWorld,
  concentratedCells,
  dispersedCells,
  spawnsOf,
} from "../../../packages/agents/bench/scale.ts";
import { BeingsProjection } from "../src/projection/projection.ts";
import type { PublishedTick } from "../src/world/published.ts";
import { ScenarioSource } from "../src/world/source.ts";

/** A world and the commands of each of its ticks, stamped as the server's host stamps them. */
export type BenchSource = {
  readonly world: World;
  commandsAt(tick: number): readonly Command[];
};

/** The default world of T5, the server's: its eight admin spawns at tick 1. */
export function defaultSource(): BenchSource {
  const source = new ScenarioSource();
  return {
    world: source.world,
    commandsAt: (tick) =>
      source.commandsAt(tick).map((intent, seq) => ({ ...intent, applyTick: tick, seq })),
  };
}

/** A world of the beings benchmark whose `spawns` arrive at tick 1. */
function benchSource(spawns: readonly Command[]): BenchSource {
  const { world } = benchWorld({});
  return { world, commandsAt: (tick) => (tick === 1 ? spawns : []) };
}

/** "dispersed 1,000" of the beings benchmark: 1,000 beings one to a chunk, chunks two apart. */
export const dispersedSource = () =>
  benchSource(spawnsOf("s1", dispersedCells(1_000, benchCenter())));

/** "concentrated 1,000 in 1 × 1" of the beings benchmark: 1,000 beings in one chunk. */
export const concentratedSource = () =>
  benchSource(spawnsOf("s1", concentratedCells(1_000, 1, benchCenter())));

/** Steps `source` to its next tick. */
function stepNext(source: BenchSource) {
  return step(source.world, source.commandsAt(readView(source.world).tick + 1));
}

/** Steps `source` `ticks` times, projecting nothing. */
export function skip(source: BenchSource, ticks: number): void {
  for (let tick = 0; tick < ticks; tick += 1) stepNext(source);
}

/** The C0 projection of `source`'s world, booted at its tick, as the server builds it. */
export const projectionOf = (source: BenchSource) => new BeingsProjection(source.world);

/** One tick: its step and its projection, each timed with Bun.nanoseconds, and what they gave. */
export type TimedTick = {
  readonly stepNs: number;
  readonly projectNs: number;
  readonly changedChunks: number;
  readonly published: PublishedTick;
};

/** Steps `source` to its next tick, then projects it with `projection`, as the server's host does. */
export function timedTick(source: BenchSource, projection: BeingsProjection): TimedTick {
  const commands = source.commandsAt(readView(source.world).tick + 1);
  const start = Bun.nanoseconds();
  const result = step(source.world, commands);
  const stepped = Bun.nanoseconds();
  const published = projection.project(result);
  const projectNs = Bun.nanoseconds() - stepped;
  return {
    stepNs: stepped - start,
    projectNs,
    changedChunks: result.changedChunks.length,
    published,
  };
}

/** Published ticks recorded once: the boot record, the ticks after it, and the world's terrain. */
export type Stream = {
  readonly boot: PublishedTick;
  readonly ticks: readonly PublishedTick[];
  readonly readTerrain: (chunk: ChunkCoord) => TerrainPublic;
};

/** The projection of `source` after its world's tick, booted there, and its next `ticks` ticks. */
export function recordStream(source: BenchSource, ticks: number): Stream {
  const projection = projectionOf(source);
  const recorded = Array.from({ length: ticks }, () => projection.project(stepNext(source)));
  return {
    boot: projection.boot(),
    ticks: recorded,
    readTerrain: (chunk) => projection.readTerrain(chunk),
  };
}
