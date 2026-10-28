/**
 * The benchmark of the cost of `mind@1` (packages/agents/bench/mind-cost.ts): it refuses every
 * argument it does not know, and it counts a being's write as one of the body alone only when its
 * mind is the very text it was, the evidence for the entity section of T7 (plan §10.4).
 */
import { describe, expect, test } from "bun:test";
import { readView, step } from "@open-origin/engine";
import { being2, beings2World, chunksOf, idler2 } from "../../engine/test/support/beings2-world.ts";
import { countWrites, parseArguments, type Writes } from "../bench/mind-cost.ts";

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

  test("count nothing for beings seen for the first time, or unchanged", () => {
    const { world, keys } = idleWorld();
    const known = new Map<number, { readonly body: string; readonly mind: string }>();
    const writes: Writes = { beings: 0, bodyOnly: 0, bodyBytes: 0, mindBytes: 0 };
    countWrites(world, keys, known, writes);
    countWrites(world, keys, known, writes);
    expect(writes).toEqual({ beings: 0, bodyOnly: 0, bodyBytes: 0, mindBytes: 0 });
    expect([...known.keys()]).toEqual([1, 2]);
  });

  test("count a being whose body changed, and whether its mind changed with it", () => {
    const { world, keys } = idleWorld();
    const known = new Map<number, { readonly body: string; readonly mind: string }>();
    const writes: Writes = { beings: 0, bodyOnly: 0, bodyBytes: 0, mindBytes: 0 };
    countWrites(world, keys, known, writes);
    // Both beings wake at tick 1 and idle again: their bodies change, their empty minds do not.
    step(world, []);
    countWrites(world, keys, known, writes);
    expect(writes.beings).toBe(2);
    expect(writes.bodyOnly).toBe(2);
    expect(writes.bodyBytes).toBeGreaterThan(2 * 300);
    expect(writes.mindBytes).toBeGreaterThan(0);
    // A mind that differs from the one last seen makes the write no longer one of the body alone.
    const seen = known.get(1) as { readonly body: string; readonly mind: string };
    known.set(1, { body: `${seen.body} `, mind: `${seen.mind} ` });
    countWrites(world, keys, known, writes);
    expect([writes.beings, writes.bodyOnly]).toEqual([3, 2]);
  });
});
