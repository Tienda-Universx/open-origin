/**
 * The senses and locomotion of beings (ADR 0023, docs/architecture/beings.md "Senses"): the
 * duration of each step from terrain and the species' law, the window a being senses, with its
 * food cue over the food that beings left, and the validation of what a brain proposes against it.
 * The window's oracle recomputes every edge from sampleRegion and liquidLevel, one cell at a time.
 */
import { describe, expect, test } from "bun:test";
import { beings, worldgen } from "../src/index.ts";

const { DIRECTIONS, acceptIntention, defaultLife, minimumSteps, senseWindow, stepDuration } =
  beings;
type Species = beings.Species;
type Window = beings.SensedWindow;

const [SPECIES] = defaultLife().species;
if (SPECIES === undefined) throw new Error("the default laws have a species");
const LAW = SPECIES.locomotion;

describe("stepDuration", () => {
  test("is the flat duration for an orthogonal step, and ⌈1.414 times it⌉ for a diagonal one", () => {
    expect(stepDuration(LAW, { rise: 0, depth: 0, diagonal: false })).toBe(45_000);
    expect(stepDuration(LAW, { rise: 0, depth: 0, diagonal: true })).toBe(63_630);
  });

  test("adds the milliseconds of rise and depth, up to the largest rise and depth a step may take", () => {
    expect(stepDuration(LAW, { rise: 100, depth: 0, diagonal: false })).toBe(50_000);
    expect(stepDuration(LAW, { rise: 900, depth: 600, diagonal: false })).toBe(
      45_000 + 45_000 + 60_000,
    );
    expect(stepDuration(LAW, { rise: 901, depth: 0, diagonal: false })).toBe(-1);
    expect(stepDuration(LAW, { rise: 0, depth: 601, diagonal: false })).toBe(-1);
  });

  test("stays within 2^32 milliseconds for the steepest laws the bounds allow", () => {
    const steep = {
      stepMs: 3_600_000,
      maxRise: 0x4000_0000,
      rise: { num: 0x10_0000, den: 1 },
      maxWade: 0x4000_0000,
      wade: { num: 0x10_0000, den: 1 },
    };
    const ms = stepDuration(steep, { rise: 0x4000_0000, depth: 0x4000_0000, diagonal: true });
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(0x1_0000_0000);
  });

  test("minimumSteps gives the cheapest orthogonal and diagonal steps, a ≤ b ≤ 2a", () => {
    const { straight, diagonal } = minimumSteps(LAW);
    expect([straight, diagonal]).toEqual([45_000, 63_630]);
    for (const stepMs of [1, 2, 3, 7, 999, 3_600_000]) {
      const bounds = minimumSteps({ ...LAW, stepMs });
      expect(bounds.straight).toBeLessThanOrEqual(bounds.diagonal);
      expect(bounds.diagonal).toBeLessThanOrEqual(2 * bounds.straight);
    }
  });
});

const GENESIS = worldgen.defaultGenesis([
  2590256714, 1096632578, 4208981471, 665226768, 3699345512, 1309276000, 1796217033, 1664376194,
]);
const PREPARED = worldgen.prepareGenesis(GENESIS);
const LEVEL = worldgen.liquidLevel(GENESIS);

/** The species with a smaller window, to keep the oracle fast. */
function speciesWithRadius(radius: number, changes: Partial<Species["locomotion"]> = {}): Species {
  return { ...SPECIES, senses: { radius }, locomotion: { ...LAW, ...changes } };
}

/** Terrain of one cell, read alone: undefined outside the world. */
function cellTerrain(x: number, y: number): { elevation: number; food: number } | undefined {
  if (
    x < worldgen.MIN_CELL ||
    x > worldgen.MAX_CELL ||
    y < worldgen.MIN_CELL ||
    y > worldgen.MAX_CELL
  ) {
    return undefined;
  }
  const region = worldgen.sampleRegion(PREPARED, { x, y, width: 1, height: 1 });
  return { elevation: region.elevation[0] ?? 0, food: region.deposits[0]?.[0] ?? 0 };
}

/** The oracle's duration of the orthogonal or diagonal step from (x, y) by (dx, dy). */
function oracleStep(
  species: Species,
  from: [number, number],
  by: readonly [number, number],
): number {
  const [dx, dy] = by;
  const a = cellTerrain(from[0], from[1]);
  const b = cellTerrain(from[0] + dx, from[1] + dy);
  if (a === undefined || b === undefined) return -1;
  if (dx !== 0 && dy !== 0) {
    if (oracleStep(species, from, [dx, 0]) < 0 || oracleStep(species, from, [0, dy]) < 0) return -1;
  }
  const depth = Math.max(0, LEVEL - b.elevation);
  return stepDuration(species.locomotion, {
    rise: Math.abs(b.elevation - a.elevation),
    depth,
    diagonal: dx !== 0 && dy !== 0,
  });
}

/** A view with no chunks, or with `chunks` by key. */
function view(chunks: { [key: string]: unknown } = {}) {
  return { readChunk: (key: string) => chunks[key] as beings.BeingsChunk | undefined };
}

/** The window sensed at `center` with radius `radius`. */
function sense(center: [number, number], species: Species, chunks = {}): Window {
  return senseWindow({
    prepared: PREPARED,
    species,
    center,
    view: view(chunks),
    nowSeconds: 1_200,
    simSecondsPerTick: 12,
  });
}

/** The cue the oracle expects for `food` units under the default diet. */
function oracleCue(food: number): number {
  if (food >= SPECIES.diet.cue.plenty) return 2;
  return food >= SPECIES.diet.cue.some ? 1 : 0;
}

/** Every edge and cue of the window of side 2R + 1 at `center`, computed one cell at a time. */
function oracleWindow(
  species: Species,
  center: [number, number],
): { edgeMs: number[]; cues: number[] } {
  const radius = species.senses.radius;
  const side = 2 * radius + 1;
  const edgeMs: number[] = [];
  const cues: number[] = [];
  for (let index = 0; index < side * side; index += 1) {
    const column = index % side;
    const row = Math.floor(index / side);
    const cell: [number, number] = [center[0] - radius + column, center[1] - radius + row];
    for (const by of DIRECTIONS) {
      const inside =
        column + by[0] >= 0 && column + by[0] < side && row + by[1] >= 0 && row + by[1] < side;
      edgeMs.push(inside ? oracleStep(species, cell, by) : -1);
    }
    cues.push(oracleCue(cellTerrain(cell[0], cell[1])?.food ?? 0));
  }
  return { edgeMs, cues };
}

/** Whether the diagonal step of `window` from cell `index` by `d` cuts a blocked corner. */
function cutsCorner(window: Window, index: number, d: number): boolean {
  const [dx, dy] = DIRECTIONS[d] ?? [0, 0];
  const horizontal = window.edgeMs[index * 8 + (dx > 0 ? 0 : 4)] ?? -1;
  const vertical = window.edgeMs[index * 8 + (dy > 0 ? 2 : 6)] ?? -1;
  return (horizontal < 0 || vertical < 0) && (window.edgeMs[index * 8 + d] ?? -1) >= 0;
}

/** The diagonal steps of `window` that are passable although an orthogonal step they pass is not. */
function cornerCuts(window: Window): number[] {
  const cuts: number[] = [];
  for (let index = 0; index < window.side * window.side; index += 1) {
    for (const d of [1, 3, 5, 7]) if (cutsCorner(window, index, d)) cuts.push(index * 8 + d);
  }
  return cuts;
}

describe("senseWindow", () => {
  test.each([
    ["near the origin", [3, -2], true],
    ["across chunks in negative coordinates", [-32, -33], true],
    ["at the lowest corner of the world", [worldgen.MIN_CELL, worldgen.MIN_CELL], false],
    ["at the highest corner of the world", [worldgen.MAX_CELL, worldgen.MAX_CELL], false],
  ] as const)("matches the oracle for every edge and cue %s", (_where, center, open) => {
    const species = speciesWithRadius(3, { maxRise: 600 });
    const window = sense([center[0], center[1]], species);
    expect(window.side).toBe(7);
    expect(window.origin).toEqual([center[0] - 3, center[1] - 3]);
    const expected = oracleWindow(species, [center[0], center[1]]);
    expect([...window.edgeMs]).toEqual(expected.edgeMs);
    expect([...window.foodCue]).toEqual(expected.cues);
    // Not vacuous: away from the corners, where most of the window lies outside the world and the
    // few cells inside may all be deep liquid, some steps can be taken.
    if (open) expect(expected.edgeMs.some((ms) => ms > 0)).toBe(true);
  });

  test("blocks a diagonal step when either orthogonal step it passes between is blocked", () => {
    const window = sense([100, 100], speciesWithRadius(4, { maxRise: 120 }));
    expect(cornerCuts(window)).toEqual([]);
    // Not vacuous: some orthogonal steps are blocked, and some diagonals are open.
    expect([0, 2, 4, 6].some((d) => window.edgeMs.some((ms, at) => at % 8 === d && ms < 0))).toBe(
      true,
    );
    expect([1, 3, 5, 7].some((d) => window.edgeMs.some((ms, at) => at % 8 === d && ms > 0))).toBe(
      true,
    );
  });

  test("cues the food beings left: what was taken, less what regrew since", () => {
    const species = speciesWithRadius(2);
    // A cell with plenty of food in the default label's spawn area, cells (−32, −32) to (63, 63).
    const area = worldgen.sampleRegion(PREPARED, { x: -32, y: -32, width: 96, height: 96 });
    const at = (area.deposits[0] ?? new Int32Array()).findIndex((food) => food >= 250);
    const found: [number, number] | undefined =
      at < 0 ? undefined : [-32 + (at % 96), -32 + Math.floor(at / 96)];
    if (found === undefined) throw new Error("the default label's area has food");
    const [x, y] = found;
    const base = cellTerrain(x, y)?.food ?? 0;
    const key = `${worldgen.chunkOfCell(x)},${worldgen.chunkOfCell(y)}`;
    const cell = worldgen.cellOffset(y) * 32 + worldgen.cellOffset(x);
    const chunk = (taken: number, since: number) => ({
      [key]: { beings: [], depletion: [{ cell, taken, since }], due: beings.MAX_TICK },
    });
    const center = (window: Window) => window.foodCue[2 * window.side + 2];
    expect(center(sense(found, species))).toBe(2);
    // All but one bite's worth taken at tick 100 (1,200 s): "some".
    expect(center(sense(found, species, chunk(base - 30, 100)))).toBe(1);
    // All taken at tick 100: nothing has regrown by 1,200 s.
    expect(center(sense(found, species, chunk(base, 100)))).toBe(0);
    // All taken at tick 0: 1,200 s of regrowth at 1/504 per second is 2 units, below "some".
    expect(center(sense(found, species, chunk(base, 0)))).toBe(0);
  });
});

describe("acceptIntention", () => {
  const species = speciesWithRadius(4);
  const window = sense([200, 200], species);
  const behavior = { kind: "forage", since: 5, heading: 0 };
  const accept = (intention: unknown) =>
    acceptIntention(intention, { tick: 5, window, center: [200, 200] });
  /** A direction whose step from the center can be taken, and its duration. */
  const open = (() => {
    const center = 4 * window.side + 4;
    for (let d = 0; d < 8; d += 1) {
      const ms = window.edgeMs[center * 8 + d] ?? -1;
      if (ms > 0) return { d, ms };
    }
    throw new Error("the center of the window has an open step");
  })();

  test("starts a walk from the window, with its exact cumulative arrivals", () => {
    const result = accept({
      steps: [
        { kind: "walk", dirs: `${open.d}` },
        { kind: "eat", untilNutrition: 900_000 },
      ],
      wakeWhen: {},
      behavior,
    });
    expect(result).toEqual({
      kind: "accepted",
      activity: { kind: "walk", start: 5, dirs: `${open.d}`, ms: [open.ms], done: 0 },
      plan: [{ kind: "eat", untilNutrition: 900_000 }],
      wakeWhen: {},
      behavior,
    });
  });

  test("starts the other activities at the tick", () => {
    expect(
      accept({
        steps: [{ kind: "sleep", untilRest: 950_000 }],
        wakeWhen: { nutritionBelow: 1 },
        behavior,
      }),
    ).toEqual({
      kind: "accepted",
      activity: { kind: "sleep", untilRest: 950_000, forced: false },
      plan: [],
      wakeWhen: { nutritionBelow: 1 },
      behavior,
    });
    const idle = accept({ steps: [{ kind: "idle", ms: 60_000 }], wakeWhen: {}, behavior });
    expect(idle).toMatchObject({
      kind: "accepted",
      activity: { kind: "idle", start: 5, ms: 60_000 },
    });
  });

  test.each([
    ["not a record", 7, "malformed"],
    [
      "an unknown member",
      { steps: [{ kind: "idle", ms: 1 }], wakeWhen: {}, behavior, extra: 1 },
      "malformed",
    ],
    ["no steps", { steps: [], wakeWhen: {}, behavior }, "malformed"],
    [
      "four steps",
      { steps: Array.from({ length: 4 }, () => ({ kind: "idle", ms: 1 })), wakeWhen: {}, behavior },
      "malformed",
    ],
    [
      "a walk after another step",
      {
        steps: [
          { kind: "idle", ms: 1 },
          { kind: "walk", dirs: "0" },
        ],
        wakeWhen: {},
        behavior,
      },
      "walk_not_first",
    ],
    [
      "a walk that leaves the window",
      { steps: [{ kind: "walk", dirs: "00000" }], wakeWhen: {}, behavior },
      "walk_blocked",
    ],
  ])("rejects %s, without throwing", (_name, intention, reason) => {
    expect(accept(intention)).toEqual({ kind: "rejected", reason });
  });

  test("rejects a getter instead of running it, and a step that cannot be taken", () => {
    const hostile = { steps: [{ kind: "idle", ms: 1 }], wakeWhen: {}, behavior };
    Object.defineProperty(hostile, "steps", {
      enumerable: true,
      get: () => [{ kind: "idle", ms: 1 }],
    });
    expect(accept(hostile)).toEqual({ kind: "rejected", reason: "malformed" });
    const blockedSpecies = speciesWithRadius(2, { maxRise: 0, maxWade: 0 });
    const flatless = sense([200, 200], blockedSpecies);
    const center = 2 * flatless.side + 2;
    const closed = [0, 1, 2, 3, 4, 5, 6, 7].find((d) => (flatless.edgeMs[center * 8 + d] ?? 0) < 0);
    if (closed !== undefined) {
      const result = acceptIntention(
        { steps: [{ kind: "walk", dirs: `${closed}` }], wakeWhen: {}, behavior },
        { tick: 5, window: flatless, center: [200, 200] },
      );
      expect(result).toEqual({ kind: "rejected", reason: "walk_blocked" });
    }
  });
});
