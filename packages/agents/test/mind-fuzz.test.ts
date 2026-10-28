/**
 * The fuzz of the minds of beings@2 with `mind@1` (docs/architecture/mind.md, "Verification plan";
 * plan §6, "Ocultar la premisa citando otra", and §11.2, test 13): every belief operation `mind@1`
 * makes equals its exported rule applied to what it cites, every invariant of the minds holds after
 * every tick, and the ledger oracle rebuilds every mind from the events alone.
 *
 * - Among chaotic brains: beings of `mind@1` share a chunk border with beings of the chaotic brain
 *   of the engine's fuzz, which greet, ask, and tell them at random, claims of food among what they
 *   tell, while research injects claims at random ticks, some refused; the engine refuses no
 *   intention of `mind@1`.
 * - On a scenario's terrain: the first ticks of calibration/1, its eight beings deciding with
 *   `mind@1`, under the invariants whose oracle of food reads that terrain, not the engine's test
 *   genesis; the same run checked against the test genesis instead finds observations that its
 *   food contradicts, which shows that the oracle reads the terrain it is given.
 */
import { describe, expect, test } from "bun:test";
import { type beings, readView, step } from "@open-origin/engine";
import {
  beingsById,
  cellsNear,
  chaosBrain,
  chunksById,
  type FoodTerrain,
  injectionsAt,
  LedgerOracle,
  MindInvariants,
  TEST_TERRAIN,
} from "../../engine/test/support/beings2-fuzz.ts";
import {
  being2,
  beings2World,
  BEHAVIORS as CHAOS_BEHAVIORS,
  chunksOf,
  life2With,
} from "../../engine/test/support/beings2-world.ts";
import { Sfc32 } from "../../engine/test/support/sfc32.ts";
import { MIND_BEHAVIORS } from "../src/brain/mind/parameters.ts";
import { mindController } from "../src/index.ts";
import { MindObserver } from "./support/mind-metrics.ts";
import { LABELS2, scenario2From } from "./support/mind-scenario.ts";
import { type Terrain, terrainOf } from "./support/scenario.ts";

/** The border between chunks (2, −1) and (3, −1), with food around it, where the beings crowd. */
const HOME = [96, -28] as const;
const BEINGS = 8;
const TICKS = 100;
const DAY = 1200;

/**
 * Small minds that fill, evict, and forget within the run, few acts and wakes a day, and room for
 * the four beings each side of the border holds, so that a crossing loses the contest for room.
 */
const LAWS = life2With(
  (species) => ({
    ...species,
    mind: {
      ...species.mind,
      episodes: 4,
      beliefs: 4,
      relations: 3,
      inbox: 1,
      halfLife: { episode: 240, belief: 1200 },
    },
    speech: { ...species.speech, perDay: 6, wakesPerDay: 2, cooldown: 240 },
  }),
  4,
);

/**
 * The chaotic brain's proposals with its concepts in `mind@1`'s namespace, which the one brain of
 * the species declares: it believes, and tells, `m1.food` and `m1.kin`, and the claims of food it
 * hears, `m1.food-at`, which `mind@1` may believe from it.
 */
function inMindNamespace(intention: beings.Intention2): beings.Intention2 {
  return JSON.parse(JSON.stringify(intention).replaceAll('"t1.', '"m1.')) as beings.Intention2;
}

/**
 * The species' one brain: `mind@1`, through `observer`, for the beings of odd id, and the chaotic
 * brain for the others, with the behaviors of both.
 */
function mixedBrain(observer: MindObserver): beings.Controller2 {
  const species = LAWS.species[0] as beings.Species2;
  const mind = observer.controller(mindController({ species, dayLength: DAY }));
  const chaos = chaosBrain(HOME);
  return {
    brain: "mixed@1",
    behaviors: [...new Set([...MIND_BEHAVIORS, ...CHAOS_BEHAVIORS])],
    concepts: mind.concepts,
    decide: (senses) =>
      senses.self.id % 2 === 1 ? mind.decide(senses) : inMindNamespace(chaos.decide(senses)),
  };
}

/** The ids of the beings of `mind@1` an event names as refused. */
function refusedMinds(events: readonly { type: string; payload: unknown }[]): number[] {
  return events
    .filter(({ type }) => type === "being.intention_rejected")
    .map(({ payload }) => (payload as { id: number }).id)
    .filter((id) => id % 2 === 1);
}

describe("mind@1 among chaotic brains, with injections", () => {
  test("is never refused, makes only operations its rules give, and keeps every invariant", () => {
    const observer = new MindObserver();
    const placed = cellsNear(HOME, BEINGS).map((cell, index) => being2(index + 1, cell));
    const world = beings2World({
      controllers: { s1: mixedBrain(observer) },
      seed: [3, 93],
      life: LAWS,
      chunks: chunksOf(placed),
      audit: false,
    });
    observer.start(world, [1, 3, 5, 7]);
    const random = new Sfc32(0xf022_0008);
    const invariants = new MindInvariants(LAWS);
    const oracle = new LedgerOracle();
    const problems: string[] = [];
    const refused: string[] = [];
    let before = beingsById(world);
    let chunks = chunksById(world);
    for (let tick = 1; tick <= TICKS; tick += 1) {
      const commands = injectionsAt(tick, before, random);
      const result = step(world, commands);
      observer.observe(result);
      const after = beingsById(world);
      const record = { tick, before, after, chunks, commands, events: result.events };
      problems.push(
        ...invariants.check(record),
        ...oracle.read(result.events),
        ...oracle.compare(after, tick),
      );
      refused.push(...refusedMinds(result.events).map((id) => `tick ${tick}: ${id}`));
      before = after;
      chunks = chunksById(world);
    }
    const run = observer.finish(TICKS);
    expect(problems.slice(0, 5)).toEqual([]);
    expect(refused).toEqual([]);
    expect(run.ruleProblems).toEqual([]);
    // Not vacuous: mind@1 believed what it saw and what it was told or injected, and revised.
    const tallies = [...run.tallies.values()];
    const total = (pick: (tally: (typeof tallies)[number]) => number) =>
      tallies.reduce((sum, tally) => sum + pick(tally), 0);
    expect(total((tally) => tally.seenBeliefs)).toBeGreaterThan(0);
    expect(total((tally) => tally.toldBeliefs)).toBeGreaterThan(0);
    expect(total((tally) => tally.revisedDown)).toBeGreaterThan(0);
    for (const name of ["external", "heard", "delivered", "injected", "told"] as const)
      expect(invariants.seen[name]).toBeGreaterThan(0);
  }, 30_000);
});

/** The ticks of calibration/1 the invariants follow, and those its control against another terrain does. */
const SCENARIO_TICKS = 300;
const CONTROL_TICKS = 20;

/** The terrain of calibration/1, built once: building it samples a million cells. */
let terrain1: Terrain | undefined;

/**
 * A run of calibration/1 under `mind@1`, whose minds the invariants check after every tick with
 * the food of `terrain`: the scenario's own, or the engine's test genesis.
 */
function scenarioRun(terrain: "scenario" | "test", ticks: number) {
  const observer = new MindObserver();
  terrain1 ??= terrainOf(LABELS2.calibration[0] as string);
  const scenario = scenario2From(terrain1, {
    controller: (species, dayLength) => observer.controller(mindController({ species, dayLength })),
  });
  const { world } = scenario;
  observer.start(
    world,
    scenario.payloads.map((_, index) => index + 1),
  );
  const laws = readView(world).readGlobal().life as beings.LifeConfig2;
  const food: FoodTerrain =
    terrain === "scenario" ? { prepared: scenario.prepared, simSecondsPerTick: 12 } : TEST_TERRAIN;
  const invariants = new MindInvariants(laws, food);
  const oracle = new LedgerOracle();
  const problems: string[] = [];
  let before = beingsById(world);
  let chunks = chunksById(world);
  for (let tick = 1; tick <= ticks; tick += 1) {
    const commands = tick === 1 ? scenario.spawns : [];
    const result = step(world, commands);
    observer.observe(result);
    const after = beingsById(world);
    const record = { tick, before, after, chunks, commands, events: result.events };
    problems.push(...invariants.check(record), ...oracle.read(result.events));
    before = after;
    chunks = chunksById(world);
  }
  problems.push(...oracle.compare(before, ticks));
  return { problems, run: observer.finish(ticks), seen: invariants.seen };
}

describe("mind@1 on the terrain of calibration/1", () => {
  test("keeps every invariant, whose oracle of food reads the scenario's terrain", () => {
    const { problems, run, seen } = scenarioRun("scenario", SCENARIO_TICKS);
    expect(problems.slice(0, 5)).toEqual([]);
    expect(run.ruleProblems).toEqual([]);
    expect(run.priorSuspect).toBe(0);
    // Not vacuous: the beings remembered and believed food they saw.
    const seenBeliefs = [...run.tallies.values()].reduce((sum, t) => sum + t.seenBeliefs, 0);
    expect(seenBeliefs).toBeGreaterThan(0);
    expect(seen.beliefs).toBeGreaterThanOrEqual(seenBeliefs);
  });

  test("checked against another terrain, finds food episodes that its food contradicts", () => {
    const { problems } = scenarioRun("test", CONTROL_TICKS);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.every((problem) => /episode \d+ has the band \d, not \d$/.test(problem))).toBe(
      true,
    );
  });
});
