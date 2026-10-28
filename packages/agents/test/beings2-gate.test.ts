/**
 * The gate benchmark (packages/agents/bench/gate.ts; docs/architecture/mind.md "Cost"): its draws
 * follow the order of mind.md, its beings of beings@2 are those of beings@1 with the six traits and
 * the gate's mind, its two worlds live one life, its statistics are exact, and it refuses an
 * argument it does not know.
 */
import { describe, expect, test } from "bun:test";
import { beings, canonicalize, mind, readView } from "@open-origin/engine";
import { gateMind } from "../../engine/test/support/beings2-world.ts";
import { Sfc32 } from "../../engine/test/support/sfc32.ts";
import {
  divergentTicks,
  type GateSample,
  gateBeings,
  gateDraws,
  gateScene,
  gateTicks,
  gateWorld,
  pairedQuietNs,
  quietWakeNs,
  runGate,
  TRIGGER_BYTES,
} from "../bench/gate.ts";
import { DAY_TICKS, dispersedCells } from "../bench/scale.ts";

describe("the draws of the gate", () => {
  test("take nutrition, rest, then the six traits of each being in turn, in the order of mind.md", () => {
    const random = new Sfc32(42);
    const expected = Array.from({ length: 2 }, () => {
      const [nutrition, rest] = [
        random.between(600_000, 900_000),
        random.between(600_000, 900_000),
      ];
      const names = [
        "appetite",
        "sleepiness",
        "curiosity",
        "sociability",
        "credulity",
        "retention",
      ];
      const traits = Object.fromEntries(names.map((name) => [name, random.between(800, 1200)]));
      return { needs: { nutrition, rest }, traits };
    });
    expect(gateDraws(2, 42)).toEqual(expected as never);
  });
});

describe("the beings of the gate", () => {
  const cells: [number, number][] = [
    [3, 3],
    [70, 3],
  ];
  const { one, two } = gateBeings(cells, gateDraws(2, 7));

  test("are, under beings@2, those of beings@1 with six traits and the gate's mind", () => {
    two.forEach((being, n) => {
      const { mind: held, traits, ...body } = being;
      const { traits: three, ...rest } = one[n] as beings.Being;
      expect(body).toEqual(rest);
      expect(traits).toMatchObject(three);
      expect(held).toEqual(gateMind());
      expect(new TextEncoder().encode(canonicalize(held)).length).toBe(2680);
    });
    expect(two[0]?.mind).not.toBe(two[1]?.mind);
  });

  test("are valid beings of their versions", () => {
    for (const being of one) expect(beings.beingIssues(being, "")).toEqual([]);
    for (const being of two) expect(beings.beingIssues(being, "", "beings@2")).toEqual([]);
    let issues = 0;
    mind.checkMind(gateMind(), "", { report: () => (issues += 1) });
    expect(issues).toBe(0);
  });
});

describe("the two worlds of the gate", () => {
  test("live one life on the terrain of open-origin/t5/bench: the same wakes and decisions", () => {
    const scene = gateScene();
    const cells = dispersedCells(4, scene.center, scene.prepared);
    const placed = gateBeings(cells, gateDraws(cells.length, scene.seeds.spawn));
    const benches = [
      gateWorld(scene, placed.one, false),
      gateWorld(scene, placed.two, true),
    ] as const;
    const { samples } = runGate(benches, 300, 0);
    expect(divergentTicks(samples[0], samples[1])).toEqual([]);
    expect(samples[0].reduce((sum, sample) => sum + sample.wakes, 0)).toBeGreaterThan(0);
    // Every being of beings@2 still holds the gate's mind: the baseline changes no mind.
    const view = readView(benches[1].world);
    const minds = view
      .readGlobal()
      .occupancy.flatMap((key) => (view.readChunk(key)?.beings ?? []) as beings.Being2[])
      .map((being) => being.mind);
    expect(minds).toEqual(cells.map(() => gateMind()));
    // The second world hashes more: every chunk it writes holds a mind.
    const hashed = samples.map((run) => run.reduce((sum, sample) => sum + sample.hashed, 0));
    expect(hashed[1]).toBeGreaterThan(hashed[0] ?? 0);
  });
});

describe("the statistics of the gate", () => {
  const sample = (ns: number, wakes: number, decisions = 0): GateSample => ({
    ns,
    hashed: 0,
    wakes,
    decisions,
  });

  test("cost a quiet wake as its tick less a tick without a wake, over its wakes, at the median", () => {
    const samples = [
      sample(100, 0),
      sample(110, 0),
      sample(410, 2),
      sample(710, 3),
      sample(360, 1),
      sample(9_000, 1, 1),
    ];
    // The base is the median of the ticks without a wake, the upper middle one, 110; the quiet
    // wakes cost 150, 200, and 250.
    expect(quietWakeNs(samples)).toEqual({ ns: 200, ticks: 3 });
    // Without a tick without a wake, the fastest tick is the base.
    expect(quietWakeNs([sample(300, 1), sample(500, 2)])).toEqual({ ns: 200 / 2, ticks: 2 });
  });

  test("pair the two worlds tick by tick, over ticks with wakes and no decision", () => {
    const one = [sample(100, 0), sample(400, 2), sample(500, 1, 1), sample(600, 3)];
    const two = [sample(150, 0), sample(600, 2), sample(9_000, 1, 1), sample(1_200, 3)];
    expect(pairedQuietNs(one, two)).toBe(200);
    expect(divergentTicks(one, two)).toEqual([]);
    expect(divergentTicks(one, [...two.slice(0, 3), sample(1, 2)])).toEqual([3]);
  });

  test("trigger at 1 MB, and time one simulated day unless --ticks says otherwise", () => {
    expect(TRIGGER_BYTES).toBe(1_048_576);
    expect(gateTicks([])).toBe(DAY_TICKS);
    expect(gateTicks(["--ticks", "30"])).toBe(30);
    for (const argv of [["--ticks"], ["--ticks", "0"], ["--ticks", "1.5"], ["--tick", "3"], ["x"]])
      expect(() => gateTicks(argv)).toThrow("usage: gate.ts [--ticks N]");
  });
});
