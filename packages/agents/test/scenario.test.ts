/**
 * The preregistered scenario (docs/architecture/beings.md, "Preregistration"), built from terrain
 * alone: the seeds of each label, the spawn table of all eleven labels, the beings a label draws,
 * the variants of the laws, and the ecological targets that depend on the typical food cell f of
 * the calibration areas. Nothing here runs the simulation, so no label is burned.
 */
import { describe, expect, test } from "bun:test";
import { beings, readView, worldgen } from "@open-origin/engine";
import {
  AREA_SIDE,
  areaNeeds,
  BEINGS,
  drawBeings,
  drawIn,
  LABELS,
  labelSeeds,
  scenarioFrom,
  type Terrain,
  terrainOf,
  variantLife,
} from "./support/scenario.ts";

/** The terrain of each label, measured once: the coverage of each costs about 0.2 s. */
const measured = new Map<string, Terrain>();
function terrain(label: string): Terrain {
  const known = measured.get(label) ?? terrainOf(label);
  measured.set(label, known);
  return known;
}

/** The spawn table of beings.md: coverage, area needs, center chunk, land cells, food cells. */
const TABLE = [
  { name: "default", coverage: 93_579, needs: 823, center: [0, 0], land: 9216, food: 2289 },
  { name: "calibration/1", coverage: 92_120, needs: 810, center: [0, 0], land: 9216, food: 4811 },
  { name: "calibration/2", coverage: 95_565, needs: 840, center: [0, 0], land: 9216, food: 5696 },
  { name: "calibration/3", coverage: 71_601, needs: 630, center: [-6, -1], land: 9216, food: 811 },
  { name: "calibration/4", coverage: 49_768, needs: 438, center: [2, -2], land: 9216, food: 603 },
  { name: "heldout/1", coverage: 89_154, needs: 784, center: [7, 11], land: 7921, food: 834 },
  { name: "heldout/2", coverage: 70_167, needs: 617, center: [10, -6], land: 4897, food: 2176 },
  { name: "heldout/3", coverage: 91_207, needs: 802, center: [-3, -3], land: 9216, food: 1607 },
  { name: "heldout/4", coverage: 93_031, needs: 818, center: [-3, -3], land: 9216, food: 1815 },
  { name: "heldout/5", coverage: 89_380, needs: 786, center: [10, -10], land: 9216, food: 901 },
  { name: "heldout/6", coverage: 83_655, needs: 736, center: [-5, -5], land: 9216, food: 1766 },
] as const;

describe("the seeds of a label", () => {
  test("come from SHA-256 of the label and a suffix, read as big-endian words", () => {
    const seeds = labelSeeds("open-origin/t4/calibration/1");
    const words = (text: string) => {
      const digest = new Bun.CryptoHasher("sha256").update(text).digest("hex");
      return Array.from({ length: 8 }, (_, i) =>
        Number.parseInt(digest.slice(8 * i, 8 * i + 8), 16),
      );
    };
    expect([...seeds.world]).toEqual(words("open-origin/t4/calibration/1/world").slice(0, 2));
    expect(seeds.terrain).toEqual(words("open-origin/t4/calibration/1/terrain"));
    expect(seeds.spawn).toBe(words("open-origin/t4/calibration/1/spawn")[0] as number);
  });
});

describe("the spawn table", () => {
  test.each(TABLE)(
    "of $name, from terrain alone",
    ({ name, coverage, needs, center, land, food }) => {
      const { coverage: measuredCoverage, area } = terrain(`open-origin/t4/${name}`);
      expect(measuredCoverage).toBe(coverage);
      expect(areaNeeds(coverage)).toEqual({ land: 4608, food: needs });
      expect(area).toMatchObject({
        center,
        origin: [32 * (center[0] - 1), 32 * (center[1] - 1)],
        food,
      });
      expect(area?.land).toHaveLength(land);
    },
  );
});

describe("the beings a label draws", () => {
  const first = terrain(LABELS.calibration[0] as string);
  const species = beings.defaultLife().species[0] as beings.Species;
  const area = first.area;
  if (area === undefined) throw new Error("calibration/1 is habitable");
  const payloads = drawBeings(area, first.seeds.spawn, species);

  test("stand on distinct dry cells of the area, with needs and traits within their bounds", () => {
    expect(payloads).toHaveLength(BEINGS);
    const cells = payloads.map(({ cell }) => `${cell[0]},${cell[1]}`);
    expect(new Set(cells).size).toBe(BEINGS);
    const dry = new Set(area.land.map(([x, y]) => `${x},${y}`));
    for (const payload of payloads) {
      expect(dry.has(`${payload.cell[0]},${payload.cell[1]}`)).toBe(true);
      expect(payload.cell[0] - area.origin[0]).toBeWithin(0, AREA_SIDE);
      expect(payload.cell[1] - area.origin[1]).toBeWithin(0, AREA_SIDE);
      for (const need of [payload.needs.nutrition, payload.needs.rest])
        expect(need).toBeWithin(600_000, 900_001);
      for (const trait of Object.values(payload.traits)) expect(trait).toBeWithin(800, 1201);
    }
  });

  test("draw a number by rejection, so that every value of the range is as likely", () => {
    // For [0, 2], k = 3 and k·⌊2^32/3⌋ = 2^32 − 1: only the largest u is drawn again.
    const sequence = (values: number[]) => ({ next: () => values.shift() ?? 0 });
    expect(drawIn(sequence([2 ** 32 - 1, 2 ** 32 - 2]), 0, 2)).toBe((2 ** 32 - 2) % 3);
    expect(drawIn(sequence([7]), 10, 12)).toBe(11);
    expect(drawIn(sequence([0x8000_0000, 5]), 0, 0x7fff_ffff + 0x4000_0000)).toBe(0x8000_0000);
  });

  test("never put two beings on one cell", () => {
    // An area of exactly eight dry cells: every being gets one of its own.
    const land = Array.from({ length: BEINGS }, (_, x) => [x, 0] as const);
    const small = { center: [0, 0] as const, origin: [0, 0] as const, land, food: 0 };
    const cells = drawBeings(small, 12_345, species).map(({ cell }) => cell[0]);
    expect([...cells].sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  test("are the same on every run: the first and the last of calibration/1", () => {
    expect(drawBeings(area, first.seeds.spawn, species)).toEqual(payloads);
    // Checked against an independent reading of the rule before being pinned here.
    expect(payloads[0]).toEqual({
      species: "s1",
      cell: [16, 31],
      needs: { nutrition: 860_881, rest: 667_189 },
      traits: { appetite: 1050, sleepiness: 1126, curiosity: 934 },
    });
    expect(payloads[7]).toEqual({
      species: "s1",
      cell: [13, 10],
      needs: { nutrition: 730_042, rest: 783_726 },
      traits: { appetite: 912, sleepiness: 1015, curiosity: 841 },
    });
  });
});

describe("the scenario of a label", () => {
  const measured = terrain(LABELS.calibration[0] as string);
  const species = beings.defaultLife().species[0] as beings.Species;
  const idle: beings.Controller = {
    brain: "idle@1",
    decide: () => ({
      steps: [{ kind: "idle", ms: 60_000 }],
      wakeWhen: {},
      behavior: { kind: "rest", since: 0, heading: 0 },
    }),
  };
  const area = measured.area;
  if (area === undefined) throw new Error("calibration/1 is habitable");

  test("is the default genesis of the terrain seed at 12 s per tick, without death, 8 spawns at 1", () => {
    const scenario = scenarioFrom(measured, { controllers: { s1: idle } });
    const view = readView(scenario.world);
    // The preregistered pace, written as the number it is rather than read from the builder.
    expect(view.simSecondsPerTick).toBe(12);
    expect(view.tick).toBe(0);
    expect(view.readGlobal().genesis).toEqual(worldgen.defaultGenesis(measured.seeds.terrain));
    expect(view.readGlobal().life).toEqual({ ...beings.defaultLife(), deathEnabled: false });
    const drawn = drawBeings(area, measured.seeds.spawn, species);
    expect(scenario.payloads).toEqual(drawn);
    expect(scenario.spawns).toEqual(
      drawn.map((payload, seq) => ({
        applyTick: 1,
        seq,
        type: "beings.spawn",
        origin: { kind: "admin" },
        payload: { ...payload, cell: [...payload.cell] },
      })),
    );
  });

  test("draws its beings from <label>/spawn<suffix> when given a spawn suffix", () => {
    const word = (text: string) =>
      Number.parseInt(new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 8), 16);
    const other = scenarioFrom(measured, { controllers: { s1: idle }, spawnSuffix: "/1" });
    const seed = word("open-origin/t4/calibration/1/spawn/1");
    expect(other.payloads).toEqual(drawBeings(area, seed, species));
    expect(other.payloads).not.toEqual(drawBeings(area, measured.seeds.spawn, species));
  });
});

describe("the variants of the laws", () => {
  test("move every rate by 10%, numerators rounded half up, against the beings or for them", () => {
    const [base] = beings.defaultLife().species;
    const [adverse] = variantLife("adverse").species;
    const [favorable] = variantLife("favorable").species;
    if (base === undefined || adverse === undefined || favorable === undefined)
      throw new Error("the laws have a species");
    const rates = (species: beings.Species) => [
      species.needs.nutrition.awake,
      species.needs.nutrition.walking,
      species.needs.nutrition.asleep,
      species.needs.rest.awake,
      species.needs.rest.walking,
      species.health.starve,
      species.sleep.recover,
      species.health.recover,
      species.regrowth,
    ];
    const half = (num: number, factor: number) => Math.floor((num * factor + 5) / 10);
    const lowering = 6;
    rates(base).forEach((rate, index) => {
      const [against, for_] = index < lowering ? [11, 9] : [9, 11];
      expect(rates(adverse)[index]).toEqual({ num: half(rate.num, against), den: rate.den });
      expect(rates(favorable)[index]).toEqual({ num: half(rate.num, for_), den: rate.den });
    });
    // 625·11/10 = 687.5 rounds up to 688; 625·9/10 = 562.5 rounds up to 563.
    expect(adverse.needs.nutrition.walking.num).toBe(688);
    expect(favorable.needs.nutrition.walking.num).toBe(563);
    expect({
      ...adverse,
      needs: base.needs,
      sleep: base.sleep,
      health: base.health,
      regrowth: base.regrowth,
    }).toEqual(base);
  });
});

describe("the targets that depend on the typical food cell", () => {
  /** f: the lower median of the positive values of deposit 0 over the calibration areas, pooled. */
  function typicalFood(terrains: readonly Terrain[]): number {
    const values: number[] = [];
    for (const { prepared, area } of terrains) {
      if (area === undefined) throw new Error("every calibration label is habitable");
      const rect = { x: area.origin[0], y: area.origin[1], width: AREA_SIDE, height: AREA_SIDE };
      for (const food of worldgen.sampleSurface(prepared, rect, 0).deposit)
        if (food > 0) values.push(food);
    }
    values.sort((a, b) => a - b);
    return values[Math.floor((values.length - 1) / 2)] as number;
  }

  const f = typicalFood(LABELS.calibration.map((label) => terrain(label)));
  const species = beings.defaultLife().species[0] as beings.Species;
  const L = worldgen.defaultGenesis([1, 2, 3, 4, 5, 6, 7, 8]).laws.day.length;

  test("f is 84 units", () => {
    expect(f).toBe(84);
  });

  test("a full meal, from 400,000 to 1,000,000, needs 0.5 f to 1.5 f units", () => {
    const units = 600_000 / species.diet.nutritionPerUnit;
    expect(units / f).toBeWithin(0.5, 1.5);
  });

  test("an emptied cell regrows to f units in 1 L to 3 L", () => {
    const seconds = (f * species.regrowth.den) / species.regrowth.num;
    expect(seconds / L).toBeWithin(1, 3);
  });
});
