/**
 * The brains of the negative controls and of the soak's baseline (support/brains.ts), on senses
 * built by hand: what each proposes, by its rule, and that the engine accepts all of it.
 */
import { describe, expect, test } from "bun:test";
import { beings } from "@open-origin/engine";
import { Sfc32 } from "../../engine/test/support/sfc32.ts";
import { utilityController } from "../src/index.ts";
import { neverEats, neverSleeps, randomWalker, stationary } from "./support/brains.ts";
import { NIGHT, NOON, sensesOf, walkEnd, windowOf } from "./support/senses.ts";

/** An open window of radius 6, with some food where the being stands when `fed` is true. */
const open = (fed: boolean) => windowOf({ radius: 6, cues: fed ? [[0, 0, 1]] : [] });

/** Whether the engine accepts `intention` in `window`. */
function accepted(intention: beings.Intention, window: beings.SensedWindow): boolean {
  return beings.acceptIntention(intention, { tick: 9, window }).kind === "accepted";
}

describe("never-eats", () => {
  test("idles as long as a brain may, hungry on food or not", () => {
    for (const fed of [true, false]) {
      const window = open(fed);
      const intention = neverEats().decide(sensesOf(window, { nutrition: 10_000, rest: 10_000 }));
      expect(intention.steps).toEqual([{ kind: "idle", ms: 2 ** 32 }]);
      expect(intention.wakeWhen).toEqual({});
      expect(accepted(intention, window)).toBe(true);
    }
  });
});

describe("never-sleeps", () => {
  const inner = utilityController();
  const brain = neverSleeps(inner);

  test("idles an hour where utility@1 sleeps, and keeps the rest of its intention", () => {
    const window = open(false);
    const senses = sensesOf(window, { rest: 400_000, light: NIGHT });
    const planned = inner.decide(senses);
    expect(planned.steps.map(({ kind }) => kind)).toContain("sleep");
    const intention = brain.decide(senses);
    expect(intention).toEqual({
      ...planned,
      steps: planned.steps.map((step) =>
        step.kind === "sleep" ? { kind: "idle", ms: 3_600_000 } : step,
      ),
    });
    expect(accepted(intention, window)).toBe(true);
  });

  test("proposes what utility@1 proposes when it does not sleep", () => {
    const senses = sensesOf(open(true), { nutrition: 450_000, light: NOON });
    expect(brain.decide(senses)).toEqual(inner.decide(senses));
    expect(brain.brain).toBe("never-sleeps(utility@1)");
  });
});

describe("stationary", () => {
  const brain = stationary();

  test.each([
    {
      what: "sleeps to full rest once rest falls to 300,000, even when hungry on food",
      being: { nutrition: 100_000, rest: 300_000 },
      fed: true,
      steps: [{ kind: "sleep", untilRest: 1_000_000 }],
      wakeWhen: {},
    },
    {
      what: "eats to full when its own cell cues food and it is not full",
      being: { nutrition: 999_999, rest: 300_001 },
      fed: true,
      steps: [{ kind: "eat", untilNutrition: 1_000_000 }],
      wakeWhen: { restBelow: 300_000 },
    },
    {
      what: "waits six hours when it is full",
      being: { nutrition: 1_000_000 },
      fed: true,
      steps: [{ kind: "idle", ms: 21_600_000 }],
      wakeWhen: { restBelow: 300_000 },
    },
    {
      what: "waits six hours, hungry, when its cell cues no food, whatever lies around it",
      being: { nutrition: 100_000 },
      fed: false,
      steps: [{ kind: "idle", ms: 21_600_000 }],
      wakeWhen: { restBelow: 300_000 },
    },
  ])("$what", ({ being, fed, steps, wakeWhen }) => {
    const window = windowOf({ radius: 6, cues: fed ? [[0, 0, 1]] : [[1, 0, 2]] });
    const intention = brain.decide(sensesOf(window, being));
    expect(intention.steps).toEqual(steps);
    expect(intention.wakeWhen).toEqual(wakeWhen);
    expect(accepted(intention, window)).toBe(true);
  });
});

describe("random-walk", () => {
  const brain = randomWalker();

  test("sleeps once tired, and eats when hungry on food", () => {
    const tired = sensesOf(open(true), { nutrition: 100_000, rest: 300_000 });
    expect(brain.decide(tired).steps).toEqual([{ kind: "sleep", untilRest: 1_000_000 }]);
    const hungry = sensesOf(open(true), { nutrition: 600_000 });
    expect(brain.decide(hungry).steps).toEqual([{ kind: "eat", untilNutrition: 1_000_000 }]);
    expect(brain.decide(hungry).wakeWhen).toEqual({ restBelow: 300_000 });
  });

  test("otherwise walks up to 12 open steps drawn from its draws, the same from the same senses", () => {
    // Walls on both sides of a corridor north: every walk follows the open cells only.
    const walls: [number, number][] = [];
    for (let dy = -6; dy <= 6; dy += 1) walls.push([-1, dy], [1, dy]);
    const corridor = windowOf({ radius: 6, walls });
    const random = new Sfc32(17);
    const walks = new Set<string>();
    for (let round = 0; round < 40; round += 1) {
      const senses = sensesOf(corridor, { draws: [random.next(), random.next()] });
      const intention = brain.decide(senses);
      const [walk] = intention.steps;
      if (walk?.kind !== "walk") throw new Error("a sated being walks");
      expect(walk.dirs).toMatch(/^[26]{1,12}$/);
      expect(intention.wakeWhen).toEqual({ restBelow: 300_000, nutritionBelow: 600_000 });
      expect(brain.decide(senses)).toEqual(intention);
      expect(accepted(intention, corridor)).toBe(true);
      walks.add(walk.dirs);
    }
    expect(walks.size).toBeGreaterThan(10);
    // In an open window, it reaches past one step away.
    const far = brain.decide(sensesOf(open(false), { draws: [5, 9] })).steps[0];
    expect(far?.kind === "walk" && far.dirs.length).toBe(12);
    if (far?.kind === "walk") expect(walkEnd(far.dirs)).not.toEqual([0, 0]);
  });

  test("idles ten minutes when it cannot walk: walled in, or incapacitated", () => {
    const walled = windowOf({
      radius: 1,
      walls: [-1, 0, 1].flatMap((dx) => [-1, 0, 1].map((dy) => [dx, dy] as [number, number])),
    });
    const stuck = [sensesOf(walled, {}), sensesOf(open(false), { condition: "incapacitated" })];
    for (const senses of stuck) {
      expect(brain.decide(senses).steps).toEqual([{ kind: "idle", ms: 600_000 }]);
    }
  });
});
