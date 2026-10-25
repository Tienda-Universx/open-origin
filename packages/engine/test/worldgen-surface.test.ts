/**
 * sampleSurface (ADR 0023): the elevation and one deposit of a region, for the senses of beings.
 * It adds a reader to worldgen@1 without changing any output: each of its fields must equal the
 * field of the same name from sampleRegion, cell for cell, anywhere in the world.
 */
import { describe, expect, test } from "bun:test";
import { EngineError, worldgen } from "../src/index.ts";
import { Sfc32 } from "./support/sfc32.ts";

const { MAX_CELL, MIN_CELL, defaultGenesis, prepareGenesis, sampleRegion, sampleSurface } =
  worldgen;

describe("sampleSurface", () => {
  const prepared = prepareGenesis(defaultGenesis([9, 8, 7, 6, 5, 4, 3, 2]));

  test("equals sampleRegion's elevation and deposit on random regions, edges and both deposits included", () => {
    const random = new Sfc32(4403);
    const rects = [
      { x: MIN_CELL, y: MIN_CELL, width: 65, height: 7 },
      { x: MAX_CELL - 64, y: MAX_CELL - 64, width: 65, height: 65 },
      { x: -33, y: -1, width: 1, height: 1 },
    ];
    for (let round = 0; round < 60; round += 1) {
      const width = random.between(1, 65);
      const height = random.between(1, 65);
      rects.push({ x: random.between(-5000, 5000), y: random.between(-5000, 5000), width, height });
    }
    let compared = 0;
    let withDeposit = 0;
    for (const rect of rects) {
      const full = sampleRegion(prepared, rect);
      for (const k of [0, 1]) {
        const surface = sampleSurface(prepared, rect, k);
        expect(surface.elevation).toEqual(full.elevation);
        expect(surface.deposit).toEqual(full.deposits[k] ?? new Int32Array());
        compared += surface.elevation.length;
        withDeposit += surface.deposit.filter((value) => value > 0).length;
      }
    }
    // Not vacuous: thousands of cells compared, hundreds of them with a deposit.
    expect(compared).toBeGreaterThan(100_000);
    expect(withDeposit).toBeGreaterThan(100);
  });

  test("rejects what sampleRegion rejects, and a deposit the genesis does not have", () => {
    const issues = (run: () => unknown) => {
      try {
        run();
      } catch (error) {
        if (EngineError.isEngineError(error)) return error.issues.map((issue) => issue.path);
      }
      return [];
    };
    expect(issues(() => sampleSurface(prepared, { x: 0, y: 0, width: 257, height: 1 }, 0))).toEqual(
      issues(() => sampleRegion(prepared, { x: 0, y: 0, width: 257, height: 1 })),
    );
    expect(issues(() => sampleSurface(prepared, { x: 0, y: 0, width: 1, height: 1 }, 2))).toEqual([
      "/deposit",
    ]);
    expect(issues(() => sampleSurface(prepared, { x: 0, y: 0, width: 1, height: 1 }, -1))).toEqual([
      "/deposit",
    ]);
    expect(issues(() => sampleSurface(prepared, { x: 0, y: 0, width: 1, height: 1 }, -0))).toEqual([
      "/deposit",
    ]);
    const seed = [9, 8, 7, 6, 5, 4, 3, 2];
    const terrain = { ...defaultGenesis(seed).terrain, deposits: [] };
    const barren = prepareGenesis({ ...defaultGenesis(seed), terrain });
    expect(() => sampleSurface(barren, { x: 0, y: 0, width: 1, height: 1 }, 0)).toThrow(
      "the deposit index is not one of the genesis: the genesis defines no deposits",
    );
    expect(
      issues(() => sampleSurface({} as never, { x: 0, y: 0, width: 1, height: 1 }, 0)),
    ).toEqual(["/prepared"]);
  });
});
