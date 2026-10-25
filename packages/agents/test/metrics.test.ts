/**
 * The metrics of a run (support/metrics.ts), each against a tiny run checked by hand: scripted
 * brains on the engine's test terrain, whose outcomes follow from the laws. Rejections, exhaustion,
 * incapacity, and death; meals and those that raise nutrition by at least 300,000, at the boundary;
 * sleeps and rested wakes; distinct meal cells and one outside the birth window; walked cells,
 * whole walks and an interrupted one; and a cell emptied, regrown to half, and eaten again.
 */
import { describe, expect, test } from "bun:test";
import { beings } from "@open-origin/engine";
import {
  baseFood,
  behavior,
  beingsWorld,
  brain,
  findCell,
  idler,
  lifeWith,
  PREPARED,
  SPECIES,
  walkMs,
  windowAt,
} from "../../engine/test/support/beings-world.ts";
import {
  ACCEPTANCE,
  type BeingRecord,
  misses,
  type RunInput,
  runScenario,
} from "./support/metrics.ts";
import { spawnCommand } from "./support/scenario.ts";

/** A being to spawn at tick 1: its cell and needs, with neutral traits. */
type Born = {
  readonly cell: readonly [number, number];
  readonly nutrition: number;
  readonly rest?: number;
};

/** A run of `born` under `controller` and `life`, on the engine's test terrain. */
function tinyRun(
  controller: beings.Controller,
  born: readonly Born[],
  life = beings.defaultLife(),
): RunInput {
  const world = beingsWorld({ controllers: { [SPECIES.id]: controller }, life, audit: false });
  const traits = { appetite: 1000, sleepiness: 1000, curiosity: 1000 };
  const payloads = born.map(({ cell, nutrition, rest }) => ({
    species: SPECIES.id,
    cell,
    needs: { nutrition, rest: rest ?? 950_000 },
    traits,
  }));
  return { world, spawns: payloads.map(spawnCommand), payloads, prepared: PREPARED };
}

/** The records of `run` after `ticks`, by being id. */
function recordsOf(run: RunInput, ticks: number): BeingRecord[] {
  return [...runScenario(run, ticks, { decisions: () => 0 }).beings];
}

/** An intention of `steps`, remembering `kind`. */
function plan(kind: string, steps: beings.PlanStep[], wakeWhen = {}): beings.Intention {
  return { steps, wakeWhen, behavior: behavior(kind) };
}

/** A long idle, which ends a script. */
const DONE: beings.PlanStep = { kind: "idle", ms: 60_000_000 };

/** The fall of nutrition over one tick of 12 s awake, as the closed form floors it. */
const AWAKE = SPECIES.needs.nutrition.awake;
const FALL = Math.floor((12 * AWAKE.num) / AWAKE.den);

/** The first cell of the test terrain with at least `food` units, other than `others`. */
function foodCell(food: number, others: readonly (readonly [number, number])[] = []) {
  return findCell([-128, -128], 256, {
    food,
    accept: (cell) => !others.some(([x, y]) => cell[0] === x && cell[1] === y),
  });
}

describe("the count of events", () => {
  test("counts every rejection, also one after an idle that ran out, alone in its tick", () => {
    // Refused at tick 2, then idling REFUSED_IDLE_MS (5 ticks) and refused again: 2, 7, ..., 27.
    const refuses = brain(() => ({ steps: [], wakeWhen: {}, behavior: behavior("x") }) as never);
    const [record] = recordsOf(tinyRun(refuses, [{ cell: [5, 5], nutrition: 900_000 }]), 30);
    const every = beings.REFUSED_IDLE_MS / 12_000;
    expect(record?.rejected).toBe(Math.floor((30 - 2) / every) + 1);
    expect(record?.rejected).toBe(6);
  });

  test("counts an exhaustion and the forced sleep it starts", () => {
    // Rest 1,000 falls to 0 after ⌈1,000·378/3,125⌉ = 121 s awake, at tick 1 + ⌈121/12⌉ = 12.
    const [record] = recordsOf(
      tinyRun(idler(6_000_000), [{ cell: [5, 5], nutrition: 900_000, rest: 1_000 }]),
      40,
    );
    expect(record).toMatchObject({ exhausted: 1, sleeps: 1, restedWakes: 0, rejected: 0 });
  });

  test("counts an incapacity, and a death when death is enabled", () => {
    // Health falls 100,000 a second at nutrition 0: it reaches 0 in 10 s, at tick 2.
    const starving = lifeWith((species) => ({
      ...species,
      health: { ...species.health, starve: { num: 100_000, den: 1 } },
    }));
    const born = [{ cell: [5, 5] as const, nutrition: 0 }];
    const [kept] = recordsOf(tinyRun(idler(6_000_000), born, starving), 10);
    expect(kept).toMatchObject({ incapacitated: 1, died: 0, lowestHealth: 0, lowestNutrition: 0 });
    const deadly = { ...starving, deathEnabled: true };
    const [dead] = recordsOf(tinyRun(idler(6_000_000), born, deadly), 10);
    expect(dead).toMatchObject({ incapacitated: 0, died: 1 });
  });
});

describe("meals", () => {
  test("count a meal as big when its nutrition rose by at least 300,000, exactly at the bound", () => {
    // A bite of 25 units feeds 500,000, and a meal ends sated at 900,000: from a start of
    // 700,000, the bite tops nutrition at 1,000,000, a rise of exactly 300,000; from 700,001, of
    // 299,999. The start is read at tick 2, one tick of fall after the spawn.
    const rich = lifeWith((species) => ({
      ...species,
      diet: { ...species.diet, nutritionPerUnit: 20_000 },
    }));
    const eater = brain((senses) =>
      senses.self.needs.nutrition < 890_000
        ? plan("eat", [{ kind: "eat", untilNutrition: 900_000 }])
        : plan("rest", [DONE]),
    );
    // Three cells, one for each being, so that no two contest a bite.
    const first = foodCell(2 * SPECIES.diet.biteUnits);
    const second = foodCell(SPECIES.diet.biteUnits, [first]);
    const third = foodCell(SPECIES.diet.biteUnits, [first, second]);
    const records = recordsOf(
      tinyRun(
        eater,
        [
          { cell: first, nutrition: 400_000 },
          { cell: second, nutrition: 700_000 + FALL },
          { cell: third, nutrition: 700_001 + FALL },
        ],
        rich,
      ),
      40,
    );
    expect(records.map(({ meals, bigMeals }) => [meals, bigMeals])).toEqual([
      [1, 1],
      [1, 1],
      [1, 0],
    ]);
    expect(records[0]?.mealCells).toEqual([`${first[0]},${first[1]}`]);
  });

  test("count the distinct cells of meals, and one outside the window the being was born in", () => {
    // Three meals, three cells east of each other: the third lies 6 cells east of the birth
    // cell, outside a window of radius 4 and inside one of radius 8.
    const start = findCell([-128, -128], 256, {
      food: SPECIES.diet.biteUnits,
      accept: (cell, window) =>
        walkMs(window, "000000") !== undefined &&
        baseFood([cell[0] + 3, cell[1]]) >= SPECIES.diet.biteUnits &&
        baseFood([cell[0] + 6, cell[1]]) >= SPECIES.diet.biteUnits,
    });
    const meal: beings.PlanStep = { kind: "eat", untilNutrition: 1_000_000 };
    const hop: beings.PlanStep = { kind: "walk", dirs: "000" };
    const script = brain((senses) => {
      const stage = senses.self.behavior.kind;
      if (stage === "none") return plan("s1", [meal]);
      if (stage === "s1") return plan("s2", [hop, meal]);
      if (stage === "s2") return plan("s3", [hop, meal]);
      return plan("s4", [DONE]);
    });
    const sighted = (radius: number) => lifeWith((species) => ({ ...species, senses: { radius } }));
    const born = [{ cell: start, nutrition: 600_000 }];
    const [near] = recordsOf(tinyRun(script, born, sighted(4)), 200);
    expect(near?.mealCells).toEqual([0, 3, 6].map((dx) => `${start[0] + dx},${start[1]}`));
    expect(near).toMatchObject({ meals: 3, walked: 6, ateOutsideBirthWindow: true });
    const [far] = recordsOf(tinyRun(script, born, sighted(8)), 200);
    expect(far).toMatchObject({ meals: 3, walked: 6, ateOutsideBirthWindow: false });
  });
});

describe("sleeps", () => {
  test("count each sleep, and as rested only one that ends with rest at least 900,000", () => {
    // From rest 800,000: a sleep to 850,000, which ends below 900,000, then one to 900,000,
    // which ends at the first tick it reaches it, within one tick's rise of 453 above it.
    const sleeper = brain((senses) => {
      const { rest } = senses.self.needs;
      if (rest < 840_000) return plan("sleep", [{ kind: "sleep", untilRest: 850_000 }]);
      if (rest < 890_000) return plan("sleep", [{ kind: "sleep", untilRest: 900_000 }]);
      return plan("rest", [DONE]);
    });
    const [record] = recordsOf(
      tinyRun(sleeper, [{ cell: [5, 5], nutrition: 900_000, rest: 800_000 }]),
      300,
    );
    expect(record).toMatchObject({ sleeps: 2, restedWakes: 1, exhausted: 0 });
  });
});

describe("walked cells", () => {
  test("count the steps that arrived, also of a walk a wake condition interrupts", () => {
    const start = findCell([-128, -128], 256, {
      food: 0,
      accept: (_cell, window) => walkMs(window, "0".repeat(10)) !== undefined,
    });
    // Nutrition is 900,000 − FALL at tick 2, where the walk starts and re-anchors it; walking,
    // it reaches 899,000 at ⌈921·den/num⌉ s, and the condition interrupts the walk at that tick.
    const walking = SPECIES.needs.nutrition.walking;
    const level = 900_000 - FALL - 921;
    const interrupted = 2 + Math.ceil(Math.ceil((921 * walking.den) / walking.num) / 12);
    let total = 0;
    const arrivals = (walkMs(windowAt(start), "0".repeat(10)) ?? []).map((ms) => {
      total += ms;
      return 2 + Math.ceil(total / 12_000);
    });
    const expected = arrivals.filter((tick) => tick <= interrupted).length;
    expect(expected).toBeWithin(1, 10);
    const walker = brain((senses) =>
      senses.self.behavior.kind === "none"
        ? plan("w", [{ kind: "walk", dirs: "0".repeat(10) }], { nutritionBelow: level })
        : plan("rest", [DONE]),
    );
    const [record] = recordsOf(tinyRun(walker, [{ cell: start, nutrition: 900_000 }]), 60);
    expect(record?.walked).toBe(expected);
  });
});

describe("a cell emptied, regrown, and eaten again", () => {
  /** Whether a being that empties a cell, idles `idleMs`, and eats there again finds it regrown. */
  function regrewAfter(idleMs: number): boolean {
    // One unit regrows each tick; the cell holds 30 to 110 units, which a being at 100,000
    // nutrition empties without being sated.
    const slow = lifeWith((species) => ({ ...species, regrowth: { num: 1, den: 12 } }));
    const cell = findCell([-128, -128], 256, {
      food: 30,
      accept: (candidate) => baseFood(candidate) <= 110,
    });
    const meal: beings.PlanStep = { kind: "eat", untilNutrition: 1_000_000 };
    const script = brain((senses) => {
      const stage = senses.self.behavior.kind;
      if (stage === "none") return plan("s1", [meal]);
      if (stage === "s1") return plan("s2", [{ kind: "idle", ms: idleMs }]);
      if (stage === "s2") return plan("s3", [meal]);
      return plan("s4", [DONE]);
    });
    const run = tinyRun(script, [{ cell, nutrition: 100_000 }], slow);
    return runScenario(run, 300, { decisions: () => 0 }).regrewAndEaten;
  }

  test("is found when the cell regrew to at least half its deposit before it was eaten again", () => {
    // 120 ticks regrow at least 110 units: the cell is full again.
    expect(regrewAfter(120 * 12_000)).toBe(true);
    // One tick of idling, and five more to the first bite, regrow 7 units: less than half of 30.
    expect(regrewAfter(12_000)).toBe(false);
  });
});

describe("the acceptance of a record", () => {
  const met: BeingRecord = {
    id: 1,
    born: [0, 0],
    incapacitated: 0,
    died: 0,
    exhausted: 0,
    rejected: 0,
    mealCells: ["0,0", "1,0", "2,0", "3,0", "40,0"],
    ateOutsideBirthWindow: true,
    meals: 5,
    bigMeals: ACCEPTANCE.bigMeals,
    sleeps: ACCEPTANCE.sleeps,
    restedWakes: ACCEPTANCE.restedWakes,
    walked: ACCEPTANCE.walked,
    lowestNutrition: 1,
    lowestHealth: 1_000_000,
  };

  test("is met at every threshold, and each item is missed one short of it", () => {
    expect(misses(met)).toEqual([]);
    const short: BeingRecord = {
      ...met,
      incapacitated: 1,
      died: 1,
      exhausted: 1,
      rejected: 1,
      mealCells: met.mealCells.slice(1),
      ateOutsideBirthWindow: false,
      bigMeals: ACCEPTANCE.bigMeals - 1,
      sleeps: ACCEPTANCE.sleeps - 1,
      restedWakes: ACCEPTANCE.restedWakes - 1,
      walked: ACCEPTANCE.walked - 1,
    };
    expect(misses(short)).toEqual([
      "incapacitated",
      "died",
      "rest 0",
      "rejected",
      "meal cells",
      "outside birth window",
      "big meals",
      "sleeps",
      "rested wakes",
      "walked",
    ]);
  });
});
