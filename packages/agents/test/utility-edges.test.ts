/**
 * The brain `utility@1` at the edges: of the world, where the window covers cells outside it that
 * the brain must never aim at nor cool; of its own rules, at each boundary (the range of a search,
 * the sight of food, a walk of exactly 64 steps, the window's last column and row); and the orders
 * it keeps (the oldest anchor, the first cooldowns, cooled targets skipped, alertness).
 */
import { describe, expect, test } from "bun:test";
import { beings, worldgen } from "@open-origin/engine";
import {
  MEAL_COOLDOWN_MS,
  ROUTE_COOLDOWN_MS,
  SEARCH_ANCHOR_MS,
  SEARCH_RANGE,
  SEARCH_STEP,
  WANDER_REACH,
  WANDER_SIGHT,
} from "../src/brain/parameters.ts";
import { utilityController } from "../src/index.ts";
import { type Offset, type Senses, sensesOf, walkEnd, windowOf } from "./support/senses.ts";

const brain = utilityController();
const decide = (senses: Senses) => brain.decide(senses);
const behavior = (kind: string, heading = 0) => ({ kind, since: 0, heading });

/** Plenty of food every third cell of a window of `radius`, except where `keep` says no. */
function foodEverywhere(radius: number, keep = (_offset: Offset) => true) {
  const cues: [number, number, number][] = [];
  for (let y = -radius; y <= radius; y += 3)
    for (let x = -radius; x <= radius; x += 3) if (keep([x, y])) cues.push([x, y, 2]);
  return cues;
}

/** Whether the absolute cell `cell` lies inside the world. */
const inWorld = ([x, y]: readonly number[]) =>
  (x as number) >= worldgen.MIN_CELL &&
  (x as number) <= worldgen.MAX_CELL &&
  (y as number) >= worldgen.MIN_CELL &&
  (y as number) <= worldgen.MAX_CELL;

/** The window of radius 24 around `cell`, its cells outside the world walled, with food or not. */
function edgeWindow(cell: readonly [number, number], fed: boolean): beings.SensedWindow {
  const radius = 24;
  const outside = (offset: Offset) => !inWorld([cell[0] + offset[0], cell[1] + offset[1]]);
  const walls: Offset[] = [];
  for (let y = -radius; y <= radius; y += 1)
    for (let x = -radius; x <= radius; x += 1) if (outside([x, y])) walls.push([x, y]);
  const cues = fed ? foodEverywhere(radius, (offset) => !outside(offset)) : [];
  return windowOf({ radius, walls, cues }, cell);
}

/** Checks that the engine accepts what `senses` lead to, with every cell inside the world. */
function staysInside(senses: Senses, cell: readonly [number, number]): void {
  const intention = decide(senses);
  const window = senses.window as beings.SensedWindow;
  expect(beings.acceptIntention(intention, { tick: 9, window }).kind).toBe("accepted");
  for (const cooldown of intention.cooldowns ?? []) expect(inWorld(cooldown.cell)).toBe(true);
  const walk = intention.steps[0];
  if (walk?.kind !== "walk") throw new Error("the being walks away from the edge");
  const [dx, dy] = walkEnd(walk.dirs);
  expect(inWorld([cell[0] + dx, cell[1] + dy])).toBe(true);
}

describe("the edges of the world", () => {
  const { MIN_CELL, MAX_CELL } = worldgen;
  // 14 cells inside each edge, heading out: the target 16 cells ahead lies 2 cells outside the
  // world, near food inside it.
  test.each([
    { edge: "east", cell: [MAX_CELL - 14, 0], heading: 0 },
    { edge: "west", cell: [MIN_CELL + 14, 0], heading: 4 },
    { edge: "north", cell: [0, MAX_CELL - 14], heading: 2 },
    { edge: "south", cell: [0, MIN_CELL + 14], heading: 6 },
  ] as const)(
    "by the $edge edge, it never aims at nor cools a cell outside the world",
    ({ cell, heading }) => {
      const outcome = { result: "failed", reason: "no_food" };
      // Sated by day, wandering toward the edge.
      const wandering = sensesOf(edgeWindow(cell, true), {
        cell,
        behavior: behavior("explore", heading),
        outcome,
      });
      staysInside(wandering, cell);
      // Hungry, with nothing in sight, searching from the edge.
      const searching = sensesOf(edgeWindow(cell, false), {
        cell,
        nutrition: 500_000,
        behavior: behavior("explore", heading),
      });
      staysInside(searching, cell);
    },
  );
});

describe("the orders the brain keeps", () => {
  test("searches around the oldest cooldown near it, not the newest", () => {
    // The oldest, 12 cells west, sends the being north around it; the newest, 12 cells south,
    // would send it west.
    const window = windowOf({ radius: 24 });
    const senses = sensesOf(window, {
      nutrition: 500_000,
      behavior: behavior("explore", 0),
      cooldowns: [
        { cell: [-12, 0], until: 900 },
        { cell: [0, -12], until: 950 },
      ],
    });
    expect(decide(senses).steps).toEqual([{ kind: "walk", dirs: "2".repeat(SEARCH_STEP) }]);
  });

  test("eats some food where it stands when hungry, rather than search", () => {
    const window = windowOf({ radius: 6, cues: [[0, 0, 1]] });
    expect(decide(sensesOf(window, { nutrition: 500_000 })).behavior.kind).toBe("eat");
  });

  test("keeps the first four cooldowns it would add, and adds them when it falls back to rest", () => {
    // Walled in two cells around, with food beyond: no wander target has a route. With a failed
    // meal where it stands, it would add nine cooldowns: it keeps the meal and the first three
    // targets, east, north-east, and south-east.
    const walls: Offset[] = [];
    for (let y = -2; y <= 2; y += 1)
      for (let x = -2; x <= 2; x += 1)
        if (x === -2 || x === 2 || y === -2 || y === 2) walls.push([x, y]);
    const window = windowOf({ radius: 24, walls, cues: foodEverywhere(24) }, [100, 100]);
    const intention = decide(
      sensesOf(window, {
        cell: [100, 100],
        behavior: behavior("explore", 0),
        outcome: { result: "failed", reason: "no_food" },
      }),
    );
    expect(intention.behavior.kind).toBe("rest");
    const reach = WANDER_REACH;
    expect(intention.cooldowns).toEqual([
      { cell: [100, 100], ms: MEAL_COOLDOWN_MS },
      { cell: [100 + reach, 100], ms: ROUTE_COOLDOWN_MS },
      { cell: [100 + reach, 100 + reach], ms: ROUTE_COOLDOWN_MS },
      { cell: [100 + reach, 100 - reach], ms: ROUTE_COOLDOWN_MS },
    ]);
  });

  test("never wanders to a cell it cools", () => {
    const window = windowOf({ radius: 24, cues: foodEverywhere(24) });
    const ahead = [WANDER_REACH, 0] as const;
    const senses = sensesOf(window, {
      behavior: behavior("explore", 0),
      cooldowns: [{ cell: ahead, until: 900 }],
    });
    const intention = decide(senses);
    expect(intention.behavior).toEqual(behavior("explore", 1));
    expect(walkEnd((intention.steps[0] as { dirs: string }).dirs)).toEqual([
      WANDER_REACH,
      WANDER_REACH,
    ]);
  });

  test("never searches toward a cell it cools", () => {
    // 12 cells east of the anchor, the step around ends on a cooled cell at (12, 12): the next
    // leg, around and out, ends at (24, 12).
    const window = windowOf({ radius: 24 }, [12, 0]);
    const senses = sensesOf(window, {
      cell: [12, 0],
      nutrition: 500_000,
      behavior: behavior("explore", 2),
      cooldowns: [
        { cell: [0, 0], until: 900 },
        { cell: [12, 12], until: 900 },
      ],
    });
    expect(walkEnd((decide(senses).steps[0] as { dirs: string }).dirs)).toEqual([12, 12]);
  });

  test("does not wander by day once tired enough that its alertness is low", () => {
    // Rest 400,000 is a tiredness of 600‰: alertness 333‰ leaves wandering below committed rest.
    const window = windowOf({ radius: 24, cues: foodEverywhere(24) });
    const tired = sensesOf(window, { rest: 400_000, behavior: behavior("rest", 0) });
    expect(decide(tired).behavior.kind).toBe("rest");
    const rested = sensesOf(window, { rest: 900_000, behavior: behavior("rest", 0) });
    expect(decide(rested).behavior.kind).toBe("explore");
  });
});

describe("the boundaries of the rules", () => {
  test("searches around a cooldown exactly SEARCH_RANGE cells away, and not one farther", () => {
    const window = windowOf({ radius: 24 });
    const at = (dx: number) =>
      decide(
        sensesOf(window, {
          nutrition: 500_000,
          behavior: behavior("explore", 0),
          cooldowns: [{ cell: [dx, 0], until: 900 }],
        }),
      ).cooldowns;
    expect(at(SEARCH_RANGE)).toBeUndefined();
    expect(at(SEARCH_RANGE + 1)).toEqual([{ cell: [0, 0], ms: SEARCH_ANCHOR_MS }]);
  });

  test.each([
    {
      side: "north",
      food: [WANDER_REACH, WANDER_SIGHT],
      farther: [WANDER_REACH, WANDER_SIGHT + 1],
    },
    {
      side: "south",
      food: [WANDER_REACH, -WANDER_SIGHT],
      farther: [WANDER_REACH, -WANDER_SIGHT - 1],
    },
    {
      side: "east",
      food: [WANDER_REACH + WANDER_SIGHT, 0],
      farther: [WANDER_REACH + WANDER_SIGHT + 1, 0],
    },
    {
      side: "west",
      food: [WANDER_REACH - WANDER_SIGHT, 0],
      farther: [WANDER_REACH - WANDER_SIGHT - 1, 0],
    },
  ] as const)(
    "sees food exactly WANDER_SIGHT cells $side of its target, and not one farther",
    ({ food, farther }) => {
      // A window of radius 32, so that food 28 cells east still lies inside it.
      const goesEast = (cue: readonly [number, number]) => {
        const window = windowOf({ radius: 32, cues: [[cue[0], cue[1], 2]] });
        const { behavior: chosen } = decide(sensesOf(window, { behavior: behavior("explore", 0) }));
        return chosen.kind === "explore" && chosen.heading === 0;
      };
      expect(goesEast(food)).toBe(true);
      expect(goesEast(farther)).toBe(false);
    },
  );

  test("eats on arrival after a route of exactly 64 steps, and walks a longer one in parts", () => {
    // A corridor 30 cells east, 2 north, then west: food 32 cells along its last part is 64
    // steps away, and 33 cells along it, 65.
    const radius = 32;
    const open: string[] = [];
    for (let x = 0; x <= 30; x += 1) open.push(`${x},0`);
    for (let x = -30; x <= 30; x += 1) open.push(`${x},2`);
    open.push("30,1");
    const walls: Offset[] = [];
    for (let y = -radius; y <= radius; y += 1)
      for (let x = -radius; x <= radius; x += 1)
        if (!open.includes(`${x},${y}`)) walls.push([x, y]);
    const steps = (x: number) =>
      decide(sensesOf(windowOf({ radius, walls, cues: [[x, 2, 2]] }), { nutrition: 500_000 }))
        .steps;
    expect(steps(-2)).toEqual([
      { kind: "walk", dirs: `${"0".repeat(30)}22${"4".repeat(32)}` },
      { kind: "eat", untilNutrition: 1_000_000 },
    ]);
    expect(steps(-3)).toEqual([{ kind: "walk", dirs: `${"0".repeat(30)}22${"4".repeat(32)}` }]);
  });

  test("cools a cell in the window's last column and its last row", () => {
    // Plenty on the east edge and the north edge, both cooled: the being forages some food
    // two steps south instead.
    const window = windowOf({
      radius: 6,
      cues: [
        [6, 0, 2],
        [0, 6, 2],
        [0, -2, 1],
      ],
    });
    const senses = sensesOf(window, {
      nutrition: 500_000,
      cooldowns: [
        { cell: [6, 0], until: 900 },
        { cell: [0, 6], until: 900 },
      ],
    });
    expect(decide(senses).steps[0]).toEqual({ kind: "walk", dirs: "66" });
  });
});
