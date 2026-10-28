/**
 * `utility@1` on beings@2 as the mindless baseline (ADR 0024, docs/architecture/mind.md "Beliefs"
 * and "Verification plan"): wrapped with its five behaviors and a namespace of no concepts, it
 * lives on beings@2 the same life it lives on beings@1, over T4's short determinism subject: at
 * every tick the same events, and every being with the same cell, needs, activity, and every other
 * member of T4; only what beings@2 adds differs, the three traits, the mind, and the units a meal
 * ate in its outcome, which the test checks are there.
 */
import { describe, expect, test } from "bun:test";
import {
  beings,
  type EngineEvent,
  mind,
  readView,
  type Seed,
  step,
  type World,
} from "@open-origin/engine";
import { BEHAVIORS } from "../src/brain/parameters.ts";
import { utilityController } from "../src/index.ts";
import { MINDLESS_BRAIN, mindlessRuleset, mindlessUtility } from "./support/mindless.ts";
import {
  beingsIn,
  chunkIn,
  globalOf,
  patchWorld,
  patchWorld2,
  type Spawn,
  spawnsAt,
} from "./support/patch-world.ts";
import { utilityRuleset } from "./support/utility-ruleset.ts";

/**
 * T4's short determinism subject (beings-determinism.test.ts): five beings around the patch of
 * food, spawned at tick 1 in the dark, who contest a bite, cross a chunk edge, sleep and wake, and
 * see dawn and dusk within 120 ticks. Repeated here, as data, because a test file cannot import
 * another without running its tests.
 */
const SUBJECT: readonly Spawn[] = [
  { cell: [-52, -67], nutrition: 560_000, rest: 960_000 },
  { cell: [-52, -67], nutrition: 570_000, rest: 960_000 },
  { cell: [-49, -58], nutrition: 590_000, rest: 960_000 },
  { cell: [-56, -62], nutrition: 252_000, rest: 400_000 },
  { cell: [-46, -70], nutrition: 900_000, rest: 960_000 },
];
const TICKS = 120;
const SEED: Seed = [7, 7];

/** An outcome without the units of a meal, which only beings@2 records. */
function outcome1(outcome: beings.Outcome): beings.Outcome {
  const { units: _units, ...rest } = outcome;
  return rest;
}

/** A being of beings@2 without what beings@2 adds: its mind, three traits, and a meal's units. */
function asBeing1(being: beings.Being2): beings.Being {
  const { mind: _mind, traits, outcome, ...body } = being;
  const { appetite, sleepiness, curiosity } = traits;
  return { ...body, traits: { appetite, sleepiness, curiosity }, outcome: outcome1(outcome) };
}

/** What a tick shows of a world of beings: its events, its beings, and its other state. */
type Shown = {
  readonly events: readonly { readonly type: string; readonly payload: unknown }[];
  readonly beings: readonly beings.Being[];
  readonly occupancy: readonly string[];
  readonly depletion: readonly unknown[];
};

/** What `world` shows after a tick whose events were `events`; `strip` maps its beings to T4's. */
function shownOf(
  world: World,
  events: readonly EngineEvent[],
  strip: (being: beings.Being) => beings.Being,
): Shown {
  const { occupancy } = globalOf(world);
  return {
    events: events.map(({ type, payload }) => ({ type, payload })),
    beings: beingsIn(world).map(strip),
    occupancy: [...occupancy],
    depletion: occupancy.map((key) => chunkIn(world, key)?.depletion ?? []),
  };
}

/** Runs the subject in `world` for TICKS ticks; what every tick showed. */
function run(world: World, strip: (being: beings.Being) => beings.Being): Shown[] {
  const shown: Shown[] = [];
  for (let tick = 1; tick <= TICKS; tick += 1) {
    const { events } = step(world, tick === 1 ? spawnsAt(1, SUBJECT) : []);
    shown.push(shownOf(world, events, strip));
  }
  return shown;
}

/** What a brain sensed at a decision of T4's kind: the senses of beings@1, the arrays as lists. */
type Sensed = {
  readonly self: unknown;
  readonly light: number;
  readonly window: unknown;
  readonly draws: readonly number[];
};

/** The members of T4's senses of `senses`, with the three traits of T4 and plain lists. */
function sensedOf(senses: Parameters<beings.Controller["decide"]>[0]): Sensed {
  const { appetite, sleepiness, curiosity } = senses.self.traits;
  const { origin, side, edgeMs, foodCue } = senses.window;
  return {
    self: {
      ...senses.self,
      traits: { appetite, sleepiness, curiosity },
      outcome: outcome1(senses.self.outcome),
    },
    light: senses.light,
    window: { origin, side, edgeMs: [...edgeMs], foodCue: [...foodCue] },
    draws: [...senses.draws],
  };
}

/** `inner`, which records in `sink` what it senses at every decision, deciding unchanged. */
function recording<C extends beings.Controller | beings.Controller2>(inner: C, sink: Sensed[]): C {
  return {
    ...inner,
    decide: (senses: Parameters<beings.Controller2["decide"]>[0]) => {
      sink.push(sensedOf(senses));
      return inner.decide(senses);
    },
  };
}

/** Runs the subject under beings@2 and the baseline, or beings@1 and utility@1; what it sensed. */
function sensedRun(two: boolean): Sensed[] {
  const sink: Sensed[] = [];
  const world = two
    ? patchWorld2(
        SEED,
        beings.createBeingsRuleset({
          controllers: { s1: recording(mindlessUtility(), sink) },
          rules: "beings@2",
        }),
        false,
      )
    : patchWorld(
        SEED,
        beings.createBeingsRuleset({ controllers: { s1: recording(utilityController(), sink) } }),
        false,
      );
  for (let tick = 1; tick <= TICKS; tick += 1) step(world, tick === 1 ? spawnsAt(1, SUBJECT) : []);
  return sink;
}

describe("the mindless baseline", () => {
  test("is utility@1 under its own brain version, with its five behaviors", () => {
    const brain = mindlessUtility();
    expect(brain.brain).toBe(MINDLESS_BRAIN);
    expect(brain.brain).not.toBe("utility@1");
    expect(brain.behaviors).toEqual(BEHAVIORS);
    expect(BEHAVIORS).toHaveLength(5);
    expect(mindlessRuleset().versions).toMatchObject({
      ruleset: "beings@2",
      brain: `s1:${MINDLESS_BRAIN}`,
    });
  });

  test("lives on beings@2 the life utility@1 lives on beings@1, tick by tick", () => {
    const one = run(patchWorld(SEED, utilityRuleset(), false), (being) => being);
    const two = patchWorld2(SEED, mindlessRuleset(), false);
    const twice = run(two, (being) => asBeing1(being as beings.Being2));
    for (let tick = 0; tick < TICKS; tick += 1)
      expect([tick + 1, twice[tick]]).toEqual([tick + 1, one[tick]]);
    // Not vacuous: the beings ate, contested a bite, walked across a chunk, slept, and woke.
    const types = new Set(one.flatMap(({ events }) => events.map(({ type }) => type)));
    for (const type of ["being.ate", "being.contested", "being.started", "being.finished"])
      expect(types.has(type)).toBe(true);
    expect(one.at(-1)?.occupancy.length).toBeGreaterThan(1);
    // Meals ended in the run, so the outcomes the comparison set aside held their units.
    const meals = twice.flatMap(({ events }) =>
      events.filter(
        ({ type, payload }) =>
          type === "being.finished" && (payload as { activity: string }).activity === "eat",
      ),
    );
    expect(meals.length).toBeGreaterThan(0);
    // Only what beings@2 adds differs: neutral traits, and minds as empty as at their spawn.
    for (const being of beingsIn(two) as beings.Being2[]) {
      expect(being.traits).toMatchObject({ sociability: 1000, credulity: 1000, retention: 1000 });
      expect(being.mind).toEqual(mind.newMind(0));
    }
    expect(readView(two).tick).toBe(TICKS);
  });

  test("senses at every decision on beings@2 what it senses on beings@1, but the new traits", () => {
    const one = sensedRun(false);
    const twice = sensedRun(true);
    expect(one.length).toBeGreaterThan(20);
    expect(twice.length).toBe(one.length);
    for (const [index, sensed] of one.entries())
      expect([index, twice[index]]).toEqual([index, sensed]);
  });
});
