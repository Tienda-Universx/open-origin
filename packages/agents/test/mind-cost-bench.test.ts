/**
 * The benchmark of the cost of `mind@1` (packages/agents/bench/mind-cost.ts): it refuses every
 * argument it does not know, and it counts every write of the timed ticks, each being's first
 * included, as one of the body alone only when its mind is the very text it was, the evidence for
 * the entity section of T7 (plan §10.4).
 */
import { describe, expect, test } from "bun:test";
import { readView, type StepResult, step } from "@open-origin/engine";
import { being2, beings2World, chunksOf, idler2 } from "../../engine/test/support/beings2-world.ts";
import {
  countWrites,
  parseArguments,
  partsOf,
  WriteCounter,
  type Writes,
} from "../bench/mind-cost.ts";

describe("the arguments of the cost benchmark of mind@1", () => {
  test("run every group by default, or those named, with the ticks given", () => {
    expect(parseArguments([])).toEqual({
      groups: ["dispersed", "concentrated", "sleeping", "speech"],
      ticks: undefined,
    });
    expect(parseArguments(["speech", "--ticks", "40", "dispersed"])).toEqual({
      groups: ["speech", "dispersed"],
      ticks: 40,
    });
  });

  test.each([
    [["micro"]],
    [["dispersed", "dispersed"]],
    [["--ticks"]],
    [["--ticks", "0"]],
    [["--ticks", "1.5"]],
    [["--ticks", "3", "--ticks", "4"]],
  ])("refuse %p", (argv) => {
    expect(() => parseArguments(argv)).toThrow();
  });

  test("refuse more than 1,223 ticks for the sleeping group, whose sleepers wake at tick 1,325", () => {
    expect(parseArguments(["sleeping", "--ticks", "1223"])).toEqual({
      groups: ["sleeping"],
      ticks: 1_223,
    });
    const message = "would time the sleeping beings awake";
    expect(() => parseArguments(["sleeping", "--ticks", "1224"])).toThrow(message);
    // Every group runs by default, the sleeping one among them.
    expect(() => parseArguments(["--ticks", "2000"])).toThrow(message);
    expect(parseArguments(["dispersed", "--ticks", "2000"])).toEqual({
      groups: ["dispersed"],
      ticks: 2_000,
    });
  });
});

describe("the writes the cost benchmark counts", () => {
  /**
   * A world of two idle beings, each alone in its chunk and beyond the other's sight, so that no
   * perception changes their minds, and the keys of their chunks.
   */
  function idleWorld() {
    const world = beings2World({
      controllers: { s1: idler2(60_000) },
      chunks: chunksOf([being2(1, [5, 5]), being2(2, [69, 5])]),
      audit: false,
    });
    return { world, keys: readView(world).readGlobal().occupancy };
  }

  test("count each being's first timed write: what each being held is read before the timed ticks", () => {
    const { world } = idleWorld();
    const counter = new WriteCounter(world);
    counter.start();
    // Both beings wake at tick 1 and idle again: their bodies change, their empty minds do not.
    counter.after(step(world, []));
    expect(counter.writes.beings).toBe(2);
    expect(counter.writes.bodyOnly).toBe(2);
    expect(counter.writes.bodyBytes).toBeGreaterThan(2 * 300);
    expect(counter.writes.mindBytes).toBeGreaterThan(0);
  });

  test("count nothing for beings that did not change", () => {
    const { world, keys } = idleWorld();
    const counter = new WriteCounter(world);
    counter.start();
    counter.after({ changedChunks: keys } as unknown as StepResult);
    expect(counter.writes).toEqual({ beings: 0, bodyOnly: 0, bodyBytes: 0, mindBytes: 0 });
  });

  test("count a write as one of the body alone only when the mind is the same text", () => {
    const { world, keys } = idleWorld();
    const known = partsOf(world);
    const writes: Writes = { beings: 0, bodyOnly: 0, bodyBytes: 0, mindBytes: 0 };
    step(world, []);
    // Being 1's mind as last seen differs from the one it holds now.
    const seen = known.get(1) as { readonly body: string; readonly mind: string };
    known.set(1, { body: seen.body, mind: `${seen.mind} ` });
    countWrites(world, keys, known, writes);
    expect([writes.beings, writes.bodyOnly]).toEqual([2, 1]);
  });
});
