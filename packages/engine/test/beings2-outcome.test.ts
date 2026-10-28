/**
 * The units a meal ate, in the outcome of beings@2 (ADR 0024, docs/architecture/mind.md "Perception"
 * and "The mind of a being"): when the activity that ended was `eat`, `outcome.units` holds the
 * units it ate in total, 0 when it ate nothing, and a decision senses it as its own experience; any
 * other outcome has no `units`, and beings@1 keeps the outcome of T4.
 */
import { describe, expect, test } from "bun:test";
import { beings } from "../src/index.ts";
import {
  baseFood,
  behavior,
  beingOf,
  beingsWorld,
  brain,
  findCell,
  runTo,
  SPECIES,
  spawn,
} from "./support/beings-world.ts";
import { being2, beings2World, brain2, type Senses2 } from "./support/beings2-world.ts";

const BITE = SPECIES.diet.biteUnits;

/** A cell with two bites of food and a part of one more: a meal there ends with the food gone. */
const PARTIAL_CELL = findCell([-128, -128], 256, {
  food: 2 * BITE + 1,
  accept: (cell) => baseFood(cell) < 3 * BITE && baseFood(cell) % BITE !== 0,
});

/** The ticks of the first and second bites of a meal started at tick 2: one every 60 s. */
const FIRST_BITE = 2 + SPECIES.diet.biteMs / 12_000;
const SECOND_BITE = FIRST_BITE + SPECIES.diet.biteMs / 12_000;

/** A brain of beings@2 that eats once with `meal`, records what it senses, then idles. */
function eatOnce(meal: (senses: Senses2) => beings.Intention, sink: Senses2[]) {
  return brain2((senses) => {
    sink.push(senses);
    if (senses.self.outcome.result === "none") return meal(senses);
    return { steps: [{ kind: "idle", ms: 6_000_000 }], wakeWhen: {}, behavior: behavior("rest") };
  });
}

const eat = (untilNutrition: number, wakeWhen: beings.WakeConditions = {}): beings.Intention => ({
  steps: [{ kind: "eat", untilNutrition }],
  wakeWhen,
  behavior: behavior("eat"),
});

/** Spawns one hungry being on `cell` at tick 1. */
const hungry = (cell: readonly [number, number]) => [
  spawn(1, {
    species: "s1",
    cell: [cell[0], cell[1]],
    needs: { nutrition: 500_000, rest: 900_000 },
  }),
];

describe("the units a meal ate", () => {
  test("are the bites of a meal that ends sated, in the outcome and in the next senses", () => {
    const sink: Senses2[] = [];
    // Two bites of 25 units, 200,000 of nutrition each, reach 800,000 from about 500,000.
    const world = beings2World({ controllers: { s1: eatOnce(() => eat(800_000), sink) } });
    runTo(world, SECOND_BITE + 1, hungry(PARTIAL_CELL));
    const outcome = { result: "done", tick: SECOND_BITE, reason: "", units: 2 * BITE };
    expect(sink.at(-1)?.self.outcome).toEqual(outcome);
    expect(beingOf(world, 1).outcome).toEqual(outcome);
  });

  test("are every unit of a meal that ends because the food is gone", () => {
    const sink: Senses2[] = [];
    const world = beings2World({ controllers: { s1: eatOnce(() => eat(beings.NEED_MAX), sink) } });
    runTo(world, SECOND_BITE + SPECIES.diet.biteMs / 12_000 + 1, hungry(PARTIAL_CELL));
    expect(beingOf(world, 1).outcome).toMatchObject({
      reason: "food_gone",
      units: baseFood(PARTIAL_CELL),
    });
    expect(sink.at(-1)?.self.outcome.units).toBe(baseFood(PARTIAL_CELL));
  });

  test("are 0 for a meal interrupted before its first bite, and the bites of one interrupted later", () => {
    const sink: Senses2[] = [];
    // Rest falls about 99 a tick: a threshold 50 below it wakes the being at the next tick.
    const early = eatOnce(
      (senses) => eat(beings.NEED_MAX, { restBelow: senses.self.needs.rest - 50 }),
      sink,
    );
    const world = beings2World({ controllers: { s1: early } });
    runTo(world, 4, hungry(PARTIAL_CELL));
    expect(beingOf(world, 1).outcome).toEqual({
      result: "interrupted",
      tick: 3,
      reason: "wake_condition",
      units: 0,
    });
    const later: Senses2[] = [];
    const threshold = (senses: Senses2) => senses.self.needs.rest - 99 * (FIRST_BITE - 1);
    const late = eatOnce((senses) => eat(beings.NEED_MAX, { restBelow: threshold(senses) }), later);
    const after = beings2World({ controllers: { s1: late } });
    runTo(after, SECOND_BITE, hungry(PARTIAL_CELL));
    const ended = beingOf(after, 1).outcome;
    expect(ended).toMatchObject({ result: "interrupted", reason: "wake_condition" });
    expect(ended.tick).toBeGreaterThan(FIRST_BITE);
    expect(ended.tick).toBeLessThan(SECOND_BITE);
    expect((ended as { units?: number }).units).toBe(BITE);
  });

  test("are absent from the outcome of any other activity, and from every outcome of beings@1", () => {
    const sink: Senses2[] = [];
    const idler = eatOnce(
      (senses) => ({
        steps: [{ kind: "sleep", untilRest: senses.self.needs.rest + 1 }],
        wakeWhen: {},
        behavior: behavior("sleep"),
      }),
      sink,
    );
    const world = beings2World({ controllers: { s1: idler } });
    runTo(world, 4, hungry(PARTIAL_CELL));
    expect(beingOf(world, 1).outcome).toEqual({ result: "done", tick: 3, reason: "" });
    const one = beingsWorld({
      controllers: {
        s1: brain((senses) =>
          senses.self.outcome.result === "none"
            ? eat(800_000)
            : {
                steps: [{ kind: "idle", ms: 6_000_000 }],
                wakeWhen: {},
                behavior: behavior("rest"),
              },
        ),
      },
    });
    runTo(one, SECOND_BITE + 1, hungry(PARTIAL_CELL));
    expect(beingOf(one, 1).outcome).toEqual({ result: "done", tick: SECOND_BITE, reason: "" });
  });

  test("are a member of the outcome that beings@2 validates as a count, and beings@1 refuses", () => {
    const at = (outcome: unknown, version: beings.BeingsVersion = "beings@2") =>
      beings.beingIssues({ ...being2(1, [0, 0]), outcome }, "/being", version);
    expect(at({ result: "done", tick: 3, reason: "", units: 25 })).toEqual([]);
    expect(at({ result: "done", tick: 3, reason: "", units: 0 })).toEqual([]);
    expect(at({ result: "done", tick: 3, reason: "", units: -1 })).toEqual([
      {
        path: "/being/outcome/units",
        message: "-1 is out of bounds: it must be from 0 to 1099511627776",
      },
    ]);
    const { mind: _mind, ...one } = being2(1, [0, 0]);
    const traits = { appetite: 1000, sleepiness: 1000, curiosity: 1000 };
    const outcome = { result: "done", tick: 3, reason: "", units: 25 };
    expect(beings.beingIssues({ ...one, traits, outcome }, "/being")).toEqual([
      {
        path: "/being/outcome/units",
        message: "unknown member: the members here are reason, result, tick",
      },
    ]);
  });
});
