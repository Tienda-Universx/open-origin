/**
 * The brain `utility@1` on senses built by hand (plan §9.2, test 5): which behavior it chooses
 * and the intention it proposes, from hunger, tiredness, darkness, food cues, routes, traits,
 * its heading, and its cooldowns; its hysteresis and its commitment, so that it never takes turns
 * between two behaviors; and the purity of its decision.
 */
import { describe, expect, test } from "bun:test";
import type { beings } from "@open-origin/engine";
import {
  COMMITMENT,
  EXHAUSTION_GUARD,
  MEAL_COOLDOWN_MS,
  NIGHT_REST_MS,
  REST_MS,
  REST_SCORE,
  ROUTE_COOLDOWN_MS,
  SEARCH_ANCHOR_MS,
  SEARCH_STEP,
  STARVING,
  SWITCH_MARGIN,
  WANDER_PAUSE_MS,
} from "../src/brain/parameters.ts";
import { choose } from "../src/brain/utility.ts";
import { UTILITY_BRAIN, utilityController } from "../src/index.ts";
import {
  at,
  NIGHT,
  NOON,
  type Offset,
  type Senses,
  sensesOf,
  walkEnd,
  windowOf,
} from "./support/senses.ts";

const brain = utilityController();
const decide = (senses: Senses) => brain.decide(senses);

/** The levels the default traits wake at: hunger, sleep in the dark, and sleep by day. */
const HUNGRY_AT = 599_000;
const SLEEPY_IN_THE_DARK = 899_000;
const SLEEPY_BY_DAY = 349_000;

/** A behavior record as the brain writes it: the engine stamps `since`. */
const behavior = (kind: string, heading = 0) => ({ kind, since: 0, heading });

describe("utility@1", () => {
  test("is a Controller of version utility@1", () => {
    expect(UTILITY_BRAIN).toBe("utility@1");
    expect(brain.brain).toBe("utility@1");
    expect(Object.isFrozen(brain)).toBe(true);
  });
});

describe("eating and foraging", () => {
  test("eats where it stands when hungry, until full", () => {
    const window = windowOf({ radius: 4, cues: [[0, 0, 2]] });
    expect(decide(sensesOf(window, { nutrition: 500_000 }))).toEqual({
      steps: [{ kind: "eat", untilNutrition: 1_000_000 }],
      wakeWhen: { restBelow: EXHAUSTION_GUARD },
      behavior: behavior("eat"),
    });
  });

  test("forages the cell whose cue and route time are worth most, and eats on arrival", () => {
    // Some food one step east, plenty three steps east: plenty is worth the two extra steps.
    const window = windowOf({
      radius: 6,
      cues: [
        [1, 0, 1],
        [3, 0, 2],
        [-5, 0, 2],
      ],
    });
    expect(decide(sensesOf(window, { nutrition: 500_000 }))).toEqual({
      steps: [
        { kind: "walk", dirs: "000" },
        { kind: "eat", untilNutrition: 1_000_000 },
      ],
      wakeWhen: { restBelow: EXHAUSTION_GUARD },
      behavior: behavior("forage"),
    });
    // With only some food in sight, the being goes for it.
    const some = windowOf({ radius: 6, cues: [[0, -2, 1]] });
    expect(decide(sensesOf(some, { nutrition: 500_000 })).steps[0]).toEqual({
      kind: "walk",
      dirs: "66",
    });
  });

  test("weighs route time: a slow route to plenty loses to some food close by", () => {
    // Plenty three steps east, but every step takes 50 minutes except the one north, to some food:
    // the route of 9,000,000 ms is worth half, and the plenty 500‰, below the some food's 597‰.
    const window = windowOf({
      radius: 6,
      cues: [
        [3, 0, 2],
        [0, 1, 1],
      ],
    });
    window.edgeMs.forEach((ms, entry) => {
      if (ms > 0 && entry !== at(6, [0, 0]) * 8 + 2) window.edgeMs[entry] = 3_000_000;
    });
    expect(decide(sensesOf(window, { nutrition: 500_000 })).steps[0]).toEqual({
      kind: "walk",
      dirs: "2",
    });
  });

  test("forages a little food rather than wander, once hungry", () => {
    // Just hungry, with only some food five steps west in sight, at noon.
    const window = windowOf({ radius: 6, cues: [[-5, 0, 1]] });
    expect(decide(sensesOf(window, { nutrition: HUNGRY_AT })).behavior.kind).toBe("forage");
  });

  test("breaks a tie in worth by the shorter route, whatever the cell index", () => {
    // Plenty one step west, at 46 s, and one step east, at 45 s: both are worth 996‰.
    const window = windowOf({
      radius: 6,
      cues: [
        [-1, 0, 2],
        [1, 0, 2],
      ],
    });
    window.edgeMs[at(6, [0, 0]) * 8 + 4] = 46_000;
    expect(at(6, [-1, 0])).toBeLessThan(at(6, [1, 0]));
    expect(decide(sensesOf(window, { nutrition: 500_000 })).steps[0]).toEqual({
      kind: "walk",
      dirs: "0",
    });
  });

  test("breaks a tie between routes of equal time by the lower cell index", () => {
    // (2, 0) has index 6·13 + 8 = 86 and (0, 2) has 8·13 + 6 = 110: both lie two steps away.
    const window = windowOf({
      radius: 6,
      cues: [
        [0, 2, 2],
        [2, 0, 2],
      ],
    });
    expect(at(6, [2, 0])).toBeLessThan(at(6, [0, 2]));
    expect(decide(sensesOf(window, { nutrition: 500_000 })).steps[0]).toEqual({
      kind: "walk",
      dirs: "00",
    });
  });

  test("leaves alone the cells it cools, even the one it stands on", () => {
    const window = windowOf({
      radius: 6,
      cues: [
        [0, 0, 2],
        [2, 0, 2],
        [0, 3, 2],
      ],
    });
    const cooldowns = [
      { cell: [0, 0] as const, until: 500 },
      { cell: [2, 0] as const, until: 500 },
    ];
    expect(decide(sensesOf(window, { nutrition: 500_000, cooldowns })).steps[0]).toEqual({
      kind: "walk",
      dirs: "222",
    });
  });

  test("walks a route longer than one walk in parts, deciding again at the end of each", () => {
    // A corridor: 30 cells east, 2 north, then 60 west to the food, 92 steps in all.
    const radius = 32;
    const open: string[] = [];
    for (let x = 0; x <= 30; x += 1) open.push(`${x},0`);
    for (let x = -30; x <= 30; x += 1) open.push(`${x},2`);
    open.push("30,1");
    const walls: Offset[] = [];
    for (let y = -radius; y <= radius; y += 1)
      for (let x = -radius; x <= radius; x += 1)
        if (!open.includes(`${x},${y}`)) walls.push([x, y]);
    const window = windowOf({ radius, walls, cues: [[-30, 2, 2]] });
    const intention = decide(sensesOf(window, { nutrition: 500_000 }));
    expect(intention.steps).toEqual([
      { kind: "walk", dirs: `${"0".repeat(30)}22${"4".repeat(32)}` },
    ]);
    expect(intention.behavior.kind).toBe("forage");
  });

  test("never walks while incapacitated, and eats where it stands if it can", () => {
    const window = windowOf({ radius: 6, cues: [[2, 0, 2]] });
    const away = decide(sensesOf(window, { nutrition: 400_000, condition: "incapacitated" }));
    expect(away.steps.some((step) => step.kind === "walk")).toBe(false);
    expect(away.behavior.kind).toBe("rest");
    const here = windowOf({ radius: 6, cues: [[0, 0, 1]] });
    expect(
      decide(sensesOf(here, { nutrition: 400_000, condition: "incapacitated" })).behavior.kind,
    ).toBe("eat");
  });

  test("remembers a meal that failed where it stands, and only a failed one", () => {
    const window = windowOf({ radius: 4 });
    for (const outcome of [
      { result: "failed", reason: "no_food" },
      { result: "failed", reason: "food_gone" },
      { result: "lost", reason: "food_gone" },
    ]) {
      expect(decide(sensesOf(window, { cell: [3, -4], outcome })).cooldowns).toEqual([
        { cell: [3, -4], ms: MEAL_COOLDOWN_MS },
      ]);
    }
    const ate = { result: "done", reason: "food_gone" };
    expect(decide(sensesOf(window, { cell: [3, -4], outcome: ate })).cooldowns).toBeUndefined();
  });
});

describe("sleeping and resting", () => {
  test("sleeps in the dark once a tenth of its rest is gone, woken only by starvation", () => {
    const window = windowOf({ radius: 4 });
    const sleep: beings.Intention = {
      steps: [{ kind: "sleep", untilRest: 1_000_000 }],
      wakeWhen: { nutritionBelow: STARVING },
      behavior: behavior("sleep"),
    };
    expect(decide(sensesOf(window, { light: NIGHT, rest: SLEEPY_IN_THE_DARK }))).toEqual(sleep);
    expect(
      decide(sensesOf(window, { light: NIGHT, rest: SLEEPY_IN_THE_DARK + 1 })).behavior.kind,
    ).toBe("rest");
  });

  test("sleeps by day only when exhausted", () => {
    const window = windowOf({ radius: 4 });
    expect(
      decide(sensesOf(window, { light: NOON, rest: SLEEPY_BY_DAY + 1 })).behavior.kind,
    ).not.toBe("sleep");
    expect(decide(sensesOf(window, { light: NOON, rest: SLEEPY_BY_DAY })).behavior.kind).toBe(
      "sleep",
    );
  });

  test("rests in the dark once rested, woken by hunger, by tiredness, and at dawn", () => {
    const window = windowOf({ radius: 4 });
    const woke = sensesOf(window, { light: NIGHT, rest: 1_000_000, behavior: behavior("sleep") });
    expect(decide(woke)).toEqual({
      steps: [{ kind: "idle", ms: NIGHT_REST_MS }],
      wakeWhen: { nutritionBelow: HUNGRY_AT, restBelow: SLEEPY_IN_THE_DARK, lightAbove: 200 },
      behavior: behavior("rest"),
    });
  });

  test("rests by day when no heading keeps food in sight, woken at dusk", () => {
    const window = windowOf({ radius: 24 });
    expect(decide(sensesOf(window))).toEqual({
      steps: [{ kind: "idle", ms: REST_MS }],
      wakeWhen: { nutritionBelow: HUNGRY_AT, restBelow: SLEEPY_BY_DAY, lightBelow: 100 },
      behavior: behavior("rest"),
    });
    // In the twilight it is woken at dusk and at dawn, whichever comes.
    expect(decide(sensesOf(windowOf({ radius: 4 }), { light: 150 })).wakeWhen).toEqual({
      nutritionBelow: HUNGRY_AT,
      restBelow: SLEEPY_IN_THE_DARK,
      lightBelow: 100,
      lightAbove: 200,
    });
  });

  test("feels its needs through its traits", () => {
    const window = windowOf({ radius: 4 });
    // Appetite 1200: hunger of 335‰ feels like 402‰, past the 400‰ that starts a meal.
    const traits = { appetite: 1200, sleepiness: 800, curiosity: 1000 };
    expect(decide(sensesOf(window, { light: NIGHT, rest: 1_000_000, traits })).wakeWhen).toEqual({
      nutritionBelow: 665_000,
      restBelow: 873_000,
      lightAbove: 200,
    });
  });
});

describe("exploring", () => {
  test("wanders by day toward food it can still see, pausing after each leg", () => {
    // Plenty of food lies 20 cells north only: east, north-east, and south-east lose sight of it.
    const window = windowOf({ radius: 24, cues: [[0, 20, 2]] });
    expect(decide(sensesOf(window))).toEqual({
      steps: [
        { kind: "walk", dirs: "2".repeat(16) },
        { kind: "idle", ms: WANDER_PAUSE_MS },
      ],
      wakeWhen: { nutritionBelow: HUNGRY_AT, restBelow: SLEEPY_BY_DAY, lightBelow: 100 },
      behavior: behavior("explore", 2),
    });
  });

  test("searches when hungry with nothing in sight, from a heading drawn at its first decision", () => {
    const window = windowOf({ radius: 24 });
    const first = sensesOf(window, {
      nutrition: 500_000,
      behavior: { kind: "none", heading: 0 },
      draws: [8 * 1234 + 5, 7],
    });
    expect(decide(first)).toEqual({
      steps: [{ kind: "walk", dirs: "5".repeat(SEARCH_STEP) }],
      wakeWhen: { restBelow: SLEEPY_BY_DAY },
      behavior: behavior("explore", 5),
      cooldowns: [{ cell: [0, 0], ms: SEARCH_ANCHOR_MS }],
    });
  });

  test("searches around the place where its search began, counterclockwise", () => {
    // 12 cells east of the anchor, the step around it leads 12 cells north.
    const window = windowOf({ radius: 24 }, [12, 0]);
    const senses = sensesOf(window, {
      cell: [12, 0],
      nutrition: 500_000,
      behavior: behavior("explore", 5),
      cooldowns: [{ cell: [0, 0], until: 900 }],
      draws: [3, 3],
    });
    expect(decide(senses)).toEqual({
      steps: [{ kind: "walk", dirs: "2".repeat(SEARCH_STEP) }],
      wakeWhen: { restBelow: SLEEPY_BY_DAY },
      behavior: behavior("explore", 2),
    });
  });

  test("walks a spiral whose turns lie about π·12 cells apart, and never comes back", () => {
    const anchor = { cell: [0, 0] as const, until: 9_999 };
    let cell: Offset = [0, 0];
    let heading = 0;
    const distances: number[] = [];
    const crossings: number[] = [];
    for (let leg = 0; leg < 120; leg += 1) {
      const senses = sensesOf(windowOf({ radius: 24 }, cell), {
        cell,
        nutrition: 500_000,
        behavior: behavior("explore", heading),
        cooldowns: [anchor],
      });
      const intention = decide(senses);
      const walk = intention.steps[0];
      if (walk?.kind !== "walk") throw new Error("a search walks");
      const [dx, dy] = walkEnd(walk.dirs);
      const next: Offset = [cell[0] + dx, cell[1] + dy];
      // Counted where the walk crosses the positive x axis, going north.
      if (next[0] > 0 && cell[1] < 0 && next[1] >= 0) crossings.push(next[0]);
      cell = next;
      heading = intention.behavior.heading;
      distances.push(Math.hypot(cell[0], cell[1]));
    }
    for (let leg = 1; leg < distances.length; leg += 1)
      expect(distances[leg] as number).toBeGreaterThan(distances[leg - 1] as number);
    expect(crossings.length).toBeGreaterThanOrEqual(3);
    for (let turn = 1; turn < crossings.length; turn += 1) {
      const gap = (crossings[turn] as number) - (crossings[turn - 1] as number);
      expect(gap).toBeWithin(30, 47);
    }
  });

  test("steps around and out of the way when the step around is blocked", () => {
    // The step around from (12, 0) ends on a wall at (12, 12): the next leg, around and out,
    // ends at (24, 12).
    const window = windowOf({ radius: 24, walls: [[0, 12]] }, [12, 0]);
    const senses = sensesOf(window, {
      cell: [12, 0],
      nutrition: 500_000,
      behavior: behavior("explore", 2),
      cooldowns: [{ cell: [0, 0], until: 900 }],
    });
    const intention = decide(senses);
    expect(intention.behavior).toEqual(behavior("explore", 1));
    expect(walkEnd((intention.steps[0] as { dirs: string }).dirs)).toEqual([12, 12]);
  });

  test("turns its first leg when its heading is blocked", () => {
    // A wall two cells east, the whole height of the window, cuts off the east.
    const walls: Offset[] = [];
    for (let y = -24; y <= 24; y += 1) walls.push([2, y]);
    const window = windowOf({ radius: 24, walls });
    const intention = decide(
      sensesOf(window, { nutrition: 500_000, behavior: behavior("explore", 0) }),
    );
    expect(intention).toEqual({
      steps: [{ kind: "walk", dirs: "2".repeat(SEARCH_STEP) }],
      wakeWhen: { restBelow: SLEEPY_BY_DAY },
      behavior: behavior("explore", 2),
      cooldowns: [{ cell: [0, 0], ms: SEARCH_ANCHOR_MS }],
    });
  });

  test("turns when its wandering heading is blocked, and cools the targets that had no route", () => {
    // Food lies beyond a wall two cells east, and north: the target east, near food, has no
    // route; north-east and south-east have no food near; north has both.
    const walls: Offset[] = [];
    for (let y = -24; y <= 24; y += 1) walls.push([2, y]);
    const window = windowOf({
      radius: 24,
      walls,
      cues: [
        [10, 0, 2],
        [0, 14, 2],
      ],
    });
    const intention = decide(sensesOf(window, { behavior: behavior("explore", 0) }));
    expect(intention.behavior).toEqual(behavior("explore", 2));
    expect(intention.cooldowns).toEqual([{ cell: [16, 0], ms: ROUTE_COOLDOWN_MS }]);
  });

  test("keeps its heading from one behavior to the next, and from one leg to the next", () => {
    const here = windowOf({ radius: 4, cues: [[0, 0, 2]] });
    const eating = sensesOf(here, {
      nutrition: 500_000,
      behavior: behavior("rest", 6),
      draws: [1, 1],
    });
    expect(decide(eating).behavior).toEqual(behavior("eat", 6));
    // Wandering on, whatever its draws: food lies all around, so heading 6 keeps food in sight.
    const cues: [number, number, number][] = [];
    for (let y = -24; y <= 24; y += 6) for (let x = -24; x <= 24; x += 6) cues.push([x, y, 2]);
    const around = windowOf({ radius: 24, cues });
    for (const draw of [0, 1, 2, 3]) {
      const senses = sensesOf(around, { behavior: behavior("explore", 6), draws: [draw, draw] });
      expect(decide(senses).behavior).toEqual(behavior("explore", 6));
    }
  });

  test("rests when walled in on every side", () => {
    const walls: Offset[] = [];
    for (let y = -4; y <= 4; y += 1)
      for (let x = -4; x <= 4; x += 1) if (x !== 0 || y !== 0) walls.push([x, y]);
    const window = windowOf({ radius: 4, walls });
    const intention = decide(
      sensesOf(window, { nutrition: 500_000, behavior: behavior("explore", 0) }),
    );
    expect(intention.behavior.kind).toBe("rest");
    expect(intention.steps).toEqual([{ kind: "idle", ms: REST_MS }]);
  });
});

describe("hysteresis and commitment", () => {
  /**
   * The behaviors chosen at night at each of `levels` of nutrition, each decision sensing the
   * behavior chosen at the one before it.
   */
  function sequence(
    window: beings.SensedWindow,
    levels: readonly number[],
    start: string,
  ): string[] {
    let current = start;
    return levels.map((nutrition) => {
      const senses = sensesOf(window, { nutrition, light: NIGHT, behavior: behavior(current) });
      current = decide(senses).behavior.kind;
      return current;
    });
  }

  test("starts eating below one level of nutrition and keeps eating up to a higher one", () => {
    const window = windowOf({ radius: 6, cues: [[0, 0, 2]] });
    expect(sequence(window, [HUNGRY_AT + 1, HUNGRY_AT], "rest")).toEqual(["rest", "eat"]);
    // Once eating, it keeps going until it has lost at most a tenth of its nutrition.
    expect(sequence(window, [HUNGRY_AT, 850_000, 899_000, 900_000], "rest")).toEqual([
      "eat",
      "eat",
      "eat",
      "rest",
    ]);
  });

  test("does not take turns when its nutrition wavers around either level", () => {
    const window = windowOf({ radius: 6, cues: [[0, 0, 2]] });
    const start = Array.from({ length: 12 }, (_, n) => HUNGRY_AT + (n % 2 === 0 ? -2000 : 2000));
    expect(new Set(sequence(window, start, "rest"))).toEqual(new Set(["eat"]));
    const stop = Array.from({ length: 12 }, (_, n) => 900_000 + (n % 2 === 0 ? -1000 : 1000));
    expect(sequence(window, stop, "eat")).toEqual(["eat", ...Array(11).fill("rest")]);
  });

  test("does not take turns between sleep and rest when its rest wavers at night", () => {
    const window = windowOf({ radius: 4 });
    let current = "rest";
    const chosen = Array.from({ length: 12 }, (_, n) => {
      const rest = SLEEPY_IN_THE_DARK + (n % 2 === 0 ? 0 : 2000);
      current = decide(sensesOf(window, { light: NIGHT, rest, behavior: behavior(current) }))
        .behavior.kind;
      return current;
    });
    expect(chosen).toEqual(Array(12).fill("sleep"));
  });

  test("switches only for a score that beats the committed one by the bonus and the margin", () => {
    const held = REST_SCORE + COMMITMENT + SWITCH_MARGIN;
    expect(choose([0, 0, 0, held - 1, REST_SCORE], "rest")).toBe(4);
    expect(choose([0, 0, 0, held, REST_SCORE], "rest")).toBe(3);
    // Without a commitment, the best score wins, and a tie goes to the earlier behavior.
    expect(choose([0, 0, 0, REST_SCORE + 1, REST_SCORE], "")).toBe(3);
    expect(choose([500, 500, 0, 0, REST_SCORE], "")).toBe(0);
    // A committed behavior it can no longer do holds nothing.
    expect(choose([0, 0, 0, REST_SCORE + 1, REST_SCORE], "forage")).toBe(3);
  });

  test("lets a wake condition it asked for release its commitment", () => {
    // Asleep at night and woken by starvation: committed, sleep would outweigh any meal.
    const window = windowOf({ radius: 4, cues: [[0, 0, 2]] });
    const woken = { result: "interrupted", reason: "wake_condition" };
    const senses = (outcome: { result: string; reason: string }) =>
      sensesOf(window, {
        light: NIGHT,
        nutrition: STARVING,
        rest: 700_000,
        behavior: behavior("sleep"),
        outcome,
      });
    expect(decide(senses(woken)).behavior.kind).toBe("eat");
    expect(decide(senses({ result: "done", reason: "" })).behavior.kind).toBe("sleep");
  });
});

describe("purity", () => {
  test("decides the same from the same senses, and never writes to them", () => {
    const window = windowOf({ radius: 8, cues: [[3, 1, 2]] });
    const senses = sensesOf(window, {
      nutrition: 500_000,
      outcome: { result: "failed", reason: "no_food" },
    });
    const before = {
      edgeMs: [...window.edgeMs],
      foodCue: [...window.foodCue],
      self: structuredClone(senses.self),
    };
    const first = decide(senses);
    expect(decide(senses)).toEqual(first);
    expect(
      decide(
        sensesOf(windowOf({ radius: 8, cues: [[3, 1, 2]] }), {
          nutrition: 500_000,
          outcome: { result: "failed", reason: "no_food" },
        }),
      ),
    ).toEqual(first);
    expect([...window.edgeMs]).toEqual(before.edgeMs);
    expect([...window.foodCue]).toEqual(before.foodCue);
    expect(senses.self).toEqual(before.self);
  });
});
