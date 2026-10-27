/**
 * The scale benchmark of the beings (packages/agents/bench/beings.ts): it refuses every argument it
 * does not know instead of ignoring it, its statistics and its targets are exact at their bounds,
 * its placements follow their rules, and it counts the beings due at a tick as the engine does.
 */
import { describe, expect, test } from "bun:test";
import { readView, step, worldgen } from "@open-origin/engine";
import {
  behavior,
  beingsWorld,
  brain,
  SPECIES,
  spawn,
} from "../../engine/test/support/beings-world.ts";
import {
  decisionCost,
  type Findings,
  hasRoom,
  median,
  nsPerWake,
  parseArguments,
  quantile,
  targets,
} from "../bench/beings.ts";
import {
  chunkKeyOf,
  concentratedCells,
  dispersedCells,
  PREPARED,
  type Run,
  rings,
  type Sample,
  Wakes,
} from "../bench/scale.ts";

describe("the arguments of the scale benchmark", () => {
  test("run every group at its default size and ticks by default", () => {
    expect(parseArguments([])).toEqual({
      groups: ["micro", "dispersed", "concentrated", "sleeping", "explored"],
      large: false,
      ticks: undefined,
    });
  });

  test("name groups by word, the large sizes, and the ticks to time", () => {
    expect(parseArguments(["sleeping", "micro", "--large", "--ticks", "300"])).toEqual({
      groups: ["sleeping", "micro"],
      large: true,
      ticks: 300,
    });
  });

  test.each([
    { argv: ["all"], message: 'unknown argument "all"' },
    { argv: ["micro", "micro"], message: 'unknown argument "micro"' },
    { argv: ["--tick", "3"], message: 'unknown argument "--tick"' },
    { argv: ["--ticks"], message: "--ticks needs a value" },
    { argv: ["--ticks", "0"], message: '--ticks must be a positive integer, not "0"' },
    { argv: ["--ticks", "1.5"], message: '--ticks must be a positive integer, not "1.5"' },
    { argv: ["--ticks", "-3"], message: '--ticks must be a positive integer, not "-3"' },
    { argv: ["--ticks", "2", "--ticks", "2"], message: "--ticks is given twice" },
    { argv: ["--large", "--large"], message: "--large is given twice" },
  ])("refuse $argv: $message", ({ argv, message }) => {
    expect(() => parseArguments(argv)).toThrow(message);
  });
});

describe("the memory a large scenario needs", () => {
  test("is 1.5 GB available, or an amount unknown where /proc/meminfo does not exist", () => {
    expect([hasRoom(1_536), hasRoom(1_535.9), hasRoom(0), hasRoom(undefined)]).toEqual([
      true,
      false,
      false,
      true,
    ]);
  });
});

/** A timed tick of `ns` nanoseconds with `wakes` beings due, of which `decisions` decided. */
const sample = (ns: number, wakes = 0, decisions = 0): Sample => ({
  ns,
  wakes,
  decisions,
  decideNs: 0,
  events: 0,
  hashed: 0,
});

describe("the statistics of the scale benchmark", () => {
  test("the median is the middle value, or the upper of the two in the middle", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(3);
    expect(median([])).toBe(0);
  });

  test("the p99 is the nearest rank: the 99th of 100 values, and the largest of 50", () => {
    const hundred = Array.from({ length: 100 }, (_, n) => 100 - n);
    expect(quantile(hundred, 0.99)).toBe(99);
    expect(
      quantile(
        Array.from({ length: 50 }, (_, n) => n),
        0.99,
      ),
    ).toBe(49);
  });

  test("the time per wake leaves out what a tick without one costs", () => {
    // Ticks without a wake cost 10; one wake costs 30 more, two cost 50 more: 80 over 3 wakes.
    const samples = [sample(10), sample(12), sample(8), sample(40, 1), sample(60, 2)];
    expect(nsPerWake(samples)).toBeCloseTo(80 / 3, 10);
    // When every tick has a wake, the fastest tick stands for the base.
    expect(nsPerWake([sample(20, 1), sample(50, 1)])).toBe(15);
    expect(nsPerWake([sample(10), sample(12)])).toBe(0);
  });

  test("one decision costs the median tick whose one wake decided less the one whose did not", () => {
    const samples = [
      sample(4, 1, 1),
      sample(5, 1, 1),
      sample(6, 1, 1),
      sample(1, 1),
      sample(9, 2, 1),
    ];
    const run = { samples } as unknown as Run;
    expect(decisionCost(run)).toEqual({ decided: [4, 5, 6], undecided: [1], ns: 4 });
  });
});

describe("the targets of plan §7", () => {
  /** The findings that meet every target exactly at its bound. */
  const atBounds: Findings = {
    tenMedianMs: 1,
    thousandMs: { median: 50, p99: 100 },
    decisionMs: { senses: 2, brain: 0.5, endToEnd: 3 },
    sleepingMarginalNs: 1_000,
    snapshotPerBeing: 1_024,
  };

  test("are met at their bounds", () => {
    expect(targets(atBounds).map((target) => [target.name, target.met])).toEqual([
      ["10 beings, median", true],
      ["1,000 dispersed", true],
      ["One decision, R = 24, default genesis", true],
      ["A sleeping dispersed being, marginal", true],
      ["Snapshot per being", true],
    ]);
  });

  test.each([
    { change: { tenMedianMs: 1.001 } },
    { change: { thousandMs: { median: 50.01, p99: 100 } } },
    { change: { thousandMs: { median: 50, p99: 100.01 } } },
    { change: { decisionMs: { senses: 2, brain: 0.5, endToEnd: 3.01 } } },
    { change: { sleepingMarginalNs: 1_001 } },
    { change: { snapshotPerBeing: 1_025 } },
  ])("are missed just past a bound: $change", ({ change }) => {
    expect(targets({ ...atBounds, ...change }).filter((target) => !target.met)).toHaveLength(1);
  });

  test("list only what was measured", () => {
    expect(targets({ tenMedianMs: 0.5 }).map((target) => target.name)).toEqual([
      "10 beings, median",
    ]);
  });
});

/**
 * The center chunk of the bench label's spawn area, as benchCenter finds it by the preregistration's
 * rule; finding it again takes about a second, which the benchmark pays and the tests do not.
 */
const CENTER = [22, -22] as const;
/** A chunk on the coast west of CENTER, whose land lies east of it. */
const COAST = [21, -22] as const;

describe("the worlds of the scale benchmark", () => {
  const level = worldgen.liquidLevel(worldgen.genesisOf(PREPARED));
  /** Whether `cell` is dry, as the senses read its liquid depth. */
  const dry = (cell: readonly [number, number]) => {
    const rect = { x: cell[0], y: cell[1], width: 1, height: 1 };
    return (worldgen.sampleSurface(PREPARED, rect, 0).elevation[0] ?? -1) >= level;
  };

  test("rings go around their chunk, each by y then x, without -0", () => {
    const order = rings(2, [0, 0]);
    const first = Array.from({ length: 10 }, () => order.next().value);
    expect(first).toEqual([
      [0, 0],
      [-2, -2],
      [0, -2],
      [2, -2],
      [-2, 0],
      [2, 0],
      [-2, 2],
      [0, 2],
      [2, 2],
      [-4, -4],
    ]);
    expect(Object.is(first[0]?.[0], -0)).toBe(false);
  });

  test("dispersed beings stand on dry cells, one to a chunk, and concentrated ones in their block", () => {
    const dispersed = dispersedCells(6, CENTER);
    expect(dispersed.every(dry)).toBe(true);
    const chunks = dispersed.map(chunkKeyOf);
    expect(new Set(chunks).size).toBe(6);
    for (const key of chunks) {
      const [x = 1, y = 1] = key.split(",").map(Number);
      expect([x % 2, y % 2].map(Math.abs)).toEqual([0, 0]);
    }
    // Chunk (21, −22) has 63 dry cells and (22, −23) all 1,024: the first block of one chunk around
    // the first that holds half its cells dry is (22, −23), and the first of 3 × 3 chunks the one
    // around it, with 6,177 dry cells; the two before it have 2,929 and 3,105.
    const one = concentratedCells(40, 1, COAST);
    expect(one.every(dry)).toBe(true);
    expect([...new Set(one.map(chunkKeyOf))]).toEqual(["22,-23"]);
    expect(new Set(one.map((cell) => `${cell}`)).size).toBe(40);
    const nine = concentratedCells(40, 3, COAST);
    expect(nine.every(dry)).toBe(true);
    const blocks = new Set(nine.map(chunkKeyOf));
    expect(blocks.size).toBeGreaterThan(1);
    for (const key of blocks) {
      const [x = 0, y = 0] = key.split(",").map(Number);
      expect([x >= 21 && x <= 23, y >= -24 && y <= -22]).toEqual([true, true]);
    }
  });

  test("the beings due at a tick are counted as the engine processes them, across chunks", () => {
    // Two beings that walk east three steps at a time across the chunk edge at x = 32, and one that
    // stays: the chunks they leave empty out, and their wakes must leave the count with them.
    const walker = brain(() => ({
      steps: [{ kind: "walk", dirs: "000" }],
      wakeWhen: {},
      behavior: behavior("walk"),
    }));
    const world = beingsWorld({ controllers: { [SPECIES.id]: walker }, audit: false });
    const cells = [
      [29, 5],
      [30, 9],
      [-40, 8],
    ];
    step(
      world,
      cells.map((cell, seq) => spawn(1, { species: SPECIES.id, cell }, seq)),
    );
    const wakes = new Wakes(world);
    const emptied = new Set<string>();
    let due = 0;
    for (let tick = 2; tick <= 60; tick += 1) {
      const view = readView(world);
      const chunks = view.readGlobal().occupancy.map((key) => [key, view.readChunk(key)] as const);
      for (const [key, chunk] of chunks) if (chunk?.beings.length === 0) emptied.add(key);
      const expected = chunks
        .flatMap(([, chunk]) => chunk?.beings ?? [])
        .filter((being) => being.wake <= tick).length;
      expect(wakes.due(tick)).toBe(expected);
      due += expected;
      wakes.update(step(world, []).changedChunks);
    }
    // Not vacuous: the walkers emptied the chunk they began in, and beings were due again and again.
    expect(emptied.has("0,0")).toBe(true);
    expect(due).toBeGreaterThan(20);
  });
});
