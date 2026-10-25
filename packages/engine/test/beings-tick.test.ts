/**
 * The tick of the beings system (ADR 0023, docs/architecture/beings.md): walks that arrive at the
 * exact tick their milliseconds give, across chunks; needs in closed form that do not depend on how
 * often a being is processed; meals, depletion, and regrowth; forced sleep; wake conditions on
 * needs and on the light; refused intentions and brains that throw; the daily prune of the
 * occupancy index; and a resumed world that continues exactly as the original.
 */
import { describe, expect, test } from "bun:test";
import {
  beings,
  decodeSnapshot,
  encodeSnapshot,
  readView,
  step,
  worldgen,
  worldStatus,
} from "../src/index.ts";
import {
  type BeingsWorld,
  baseFood,
  behavior,
  beingOf,
  beingsOf,
  beingsWorld,
  brain,
  centerEdge,
  chunkOf,
  cumulative,
  findCell,
  idler,
  lifeWith,
  lightAt,
  runTo,
  type Senses,
  SPECIES,
  spawn,
  walkMs,
  windowAt,
} from "./support/beings-world.ts";
import { engineErrorOf } from "./support/engine-error.ts";

/** An intention that idles for `ms`, with `wakeWhen`, remembering `kind`. */
function idleFor(
  ms: number,
  wakeWhen: beings.WakeConditions = {},
  kind = "rest",
): beings.Intention {
  return { steps: [{ kind: "idle", ms }], wakeWhen, behavior: behavior(kind) };
}

/** A brain that walks `dirs` at its first decision, then idles for a long time. */
function walker(dirs: string): beings.Controller {
  return brain((senses) =>
    senses.self.outcome.result === "none"
      ? { steps: [{ kind: "walk", dirs }], wakeWhen: {}, behavior: behavior("travel") }
      : idleFor(6_000_000),
  );
}

/** A start cell at x = −3 from which `steps` steps east are passable, and their durations. */
function eastWalk(steps: number): { start: [number, number]; ms: number[] } {
  for (let y = -64; y < 0; y += 1) {
    const ms = walkMs(windowAt([-3, y]), "0".repeat(steps));
    if (ms !== undefined) return { start: [-3, y], ms };
  }
  throw new Error("the test terrain has a passable walk east from x = -3");
}

/** The ids of the beings `world` holds, from every chunk of its occupancy index. */
function heldIds(world: BeingsWorld): number[] {
  return beingsOf(world).map(({ id }) => id);
}

/** The body of being `id` of `world` at its tick, in closed form. */
function bodyOf(world: BeingsWorld, id: number): beings.Body {
  const view = readView(world);
  return beings.bodyAt(SPECIES, beingOf(world, id), view.tick, view.simSecondsPerTick);
}

describe("walks", () => {
  test("arrive at the exact ticks of their milliseconds, across a chunk edge at negative x", () => {
    const { start, ms } = eastWalk(6);
    const arrivals = cumulative(ms).map((total) => 2 + Math.ceil(total / 12_000));
    const world = beingsWorld({ controllers: { [SPECIES.id]: walker("000000") } });
    runTo(world, 1, [spawn(1, { species: SPECIES.id, cell: start })]);
    const last = arrivals.at(-1) as number;
    for (let tick = 2; tick <= last + 1; tick += 1) {
      const events = runTo(world, tick);
      const being = beingOf(world, 1);
      const arrived = arrivals.filter((arrival) => arrival <= tick).length;
      expect(being.cell).toEqual([start[0] + arrived, start[1]]);
      expect(
        readView(world)
          .readChunk(chunkOf(being.cell))
          ?.beings.map(({ id }) => id),
      ).toEqual([1]);
      expect(heldIds(world)).toEqual([1]);
      if (tick === 2) {
        expect(being.activity).toEqual({
          kind: "walk",
          start: 2,
          dirs: "000000",
          ms: cumulative(ms),
          done: 0,
        });
      }
      if (tick < last) expect(being.wake).toBe(arrivals[arrived] as number);
      const finished = events.filter((event) => event.type === "being.finished");
      expect(finished.map(({ payload }) => payload)).toEqual(
        tick === last ? [{ id: 1, activity: "walk", result: "done", reason: "" }] : [],
      );
    }
    expect(chunkOf(start)).not.toBe(chunkOf(beingOf(world, 1).cell));
  });

  test("keep their schedule in milliseconds at any pace, each arrival at the first tick past it", () => {
    const { start, ms } = eastWalk(6);
    for (const sps of [12, 6]) {
      const world = beingsWorld({
        controllers: { [SPECIES.id]: walker("000000") },
        simSecondsPerTick: sps,
      });
      runTo(world, 2, [spawn(1, { species: SPECIES.id, cell: start })]);
      expect(beingOf(world, 1).activity).toEqual({
        kind: "walk",
        start: 2,
        dirs: "000000",
        ms: cumulative(ms),
        done: 0,
      });
      const arrivals = cumulative(ms).map((total) => 2 + Math.ceil(total / (sps * 1000)));
      for (const [index, arrival] of arrivals.entries()) {
        runTo(world, arrival - 1);
        expect(beingOf(world, 1).cell[0]).toBe(start[0] + index);
        runTo(world, arrival);
        expect(beingOf(world, 1).cell[0]).toBeGreaterThanOrEqual(start[0] + index + 1);
      }
      expect(beingOf(world, 1).cell).toEqual([start[0] + 6, start[1]]);
    }
  });

  test("leave the chunk they left in the occupancy index until the next day's prune", () => {
    const { start } = eastWalk(6);
    const world = beingsWorld({ controllers: { [SPECIES.id]: walker("000000") } });
    runTo(world, 40, [spawn(1, { species: SPECIES.id, cell: start })]);
    const [from, to] = [chunkOf(start), chunkOf(beingOf(world, 1).cell)];
    expect(readView(world).readGlobal().occupancy).toEqual([from, to]);
    expect(readView(world).readChunk(from)?.beings).toEqual([]);
    // A day of the test genesis is 100 ticks: day 1 starts at tick 100.
    runTo(world, 99);
    expect(readView(world).readGlobal()).toMatchObject({ occupancy: [from, to], prunedDay: 0 });
    runTo(world, 100);
    expect(readView(world).readGlobal()).toMatchObject({ occupancy: [to], prunedDay: 1 });
    expect(readView(world).chunkKeys()).toEqual([from, to]);
  });
});

describe("needs", () => {
  test("follow their closed form whatever the processing frequency, and re-anchor at crossings", () => {
    // Being 1 decides every 50 ticks and being 2 every tick; nutrition crosses recoverAbove.
    const controller = brain((senses) => idleFor(senses.self.id === 1 ? 600_000 : 12_000));
    // A small radius keeps 300 decisions cheap; the needs do not depend on it.
    const life = lifeWith((species) => ({ ...species, senses: { radius: 4 } }));
    const world = beingsWorld({ controllers: { [SPECIES.id]: controller }, life });
    const needs = { nutrition: SPECIES.health.recoverAbove + 10_000, rest: 900_000 };
    runTo(world, 1, [
      spawn(1, { species: SPECIES.id, cell: [5, 5], needs }, 0),
      spawn(1, { species: SPECIES.id, cell: [9, 5], needs }, 1),
    ]);
    const { awake } = SPECIES.needs.nutrition;
    let crossed = 0;
    for (let tick = 2; tick <= 300; tick += 1) {
      runTo(world, tick);
      const [first, second] = [bodyOf(world, 1), bodyOf(world, 2)];
      expect(second).toEqual(first);
      // The oracle: exact integer arithmetic on the elapsed seconds since the spawn at tick 1.
      const seconds = BigInt((tick - 1) * 12);
      const fallen = (BigInt(awake.num) * seconds) / BigInt(awake.den);
      expect(first.nutrition).toBe(needs.nutrition - Number(fallen));
      if (crossed === 0 && first.nutrition <= SPECIES.health.recoverAbove) crossed = tick;
    }
    expect(crossed).toBeGreaterThan(2);
    expect([beingOf(world, 1).anchor, beingOf(world, 2).anchor]).toEqual([crossed, crossed]);
  });

  test("are read without writing: an idle being keeps its anchor and stored needs", () => {
    const world = beingsWorld({ controllers: { [SPECIES.id]: idler(600_000) } });
    runTo(world, 1, [spawn(1, { species: SPECIES.id, cell: [5, 5] })]);
    const stored = beingOf(world, 1);
    runTo(world, 200);
    const later = beingOf(world, 1);
    expect([later.anchor, later.needs, later.health]).toEqual([1, stored.needs, stored.health]);
    expect(bodyOf(world, 1).nutrition).toBeLessThan(stored.needs.nutrition);
  });
});

describe("meals", () => {
  /** A brain that eats where it stands while it senses food and is hungry, and idles otherwise. */
  const eater = brain((senses: Senses) => {
    const radius = (senses.window.side - 1) / 2;
    const cue = senses.window.foodCue[radius * senses.window.side + radius] ?? 0;
    if (cue > 0 && senses.self.needs.nutrition < 900_000) {
      const steps = [{ kind: "eat", untilNutrition: 900_000 }] as const;
      return { steps, wakeWhen: {}, behavior: behavior("eat") };
    }
    return idleFor(120_000);
  });

  /** A hungry being at the first cell with at least two bites of food, and that food. */
  function meal(nutrition: number, life?: beings.LifeConfig) {
    const cell = findCell([-128, -128], 256, { food: 2 * SPECIES.diet.biteUnits });
    const world = beingsWorld({ controllers: { [SPECIES.id]: eater }, ...(life && { life }) });
    const needs = { nutrition, rest: 900_000 };
    return {
      cell,
      food: baseFood(cell),
      world,
      spawned: spawn(1, { species: SPECIES.id, cell, needs }),
    };
  }

  /** The bites of a meal started at tick 2 on `food` units: each one's tick and units. */
  function bitesOf(food: number): [number, number][] {
    const { biteUnits, biteMs } = SPECIES.diet;
    const takes = Array.from({ length: Math.floor(food / biteUnits) }, () => biteUnits);
    if (food % biteUnits > 0) takes.push(food % biteUnits);
    return takes.map((units, k) => [2 + ((k + 1) * biteMs) / 12_000, units]);
  }

  /** The tick at which that meal ends: at a partial last bite, or at the bite that finds nothing. */
  function mealEnd(food: number): number {
    const bites = bitesOf(food);
    if (food % SPECIES.diet.biteUnits > 0) return bites.at(-1)?.[0] as number;
    return 2 + ((bites.length + 1) * SPECIES.diet.biteMs) / 12_000;
  }

  test("take a bite at each bite time, deplete the cell, and end when it has nothing left", () => {
    const { cell, food, world, spawned } = meal(500_000);
    const events = runTo(world, 40, [spawned]);
    const bites = bitesOf(food);
    const ate = events.filter((event) => event.type === "being.ate");
    expect(ate.map(({ tick, payload }) => [tick, payload])).toEqual(
      bites.map(([tick, units]) => [tick, { id: 1, units }]),
    );
    // A full last bite leaves nothing for the next one, which fails; a partial one ends the meal.
    const partial = food % SPECIES.diet.biteUnits > 0;
    const endTick = mealEnd(food);
    const finished = events.filter((event) => event.type === "being.finished");
    expect(finished.map(({ tick, payload }) => [tick, payload])).toEqual([
      [
        endTick,
        { id: 1, activity: "eat", result: partial ? "done" : "failed", reason: "food_gone" },
      ],
    ]);
    const index = worldgen.cellOffset(cell[1]) * 32 + worldgen.cellOffset(cell[0]);
    const lastTake = bites.at(-1)?.[0] as number;
    expect(readView(world).readChunk(chunkOf(cell))?.depletion).toEqual([
      { cell: index, taken: food, since: lastTake },
    ]);
    // The oracle: nutrition falls in closed form from each anchor, and each bite adds its units.
    const { awake } = SPECIES.needs.nutrition;
    const fall = (from: number, to: number) =>
      Math.floor((awake.num * (to - from) * 12) / awake.den);
    let [nutrition, anchor] = [500_000, 1];
    for (const [tick, units] of bites) {
      nutrition += units * SPECIES.diet.nutritionPerUnit - fall(anchor, tick);
      anchor = tick;
    }
    expect(beingOf(world, 1).anchor).toBe(anchor);
    expect(bodyOf(world, 1).nutrition).toBe(nutrition - fall(anchor, 40));
  });

  test("find the cell regrown at the law's rate at a later decision, and eat it again", () => {
    // One unit regrows per tick, so a shift of one tick in regrowth shows in what is left.
    const perTick = lifeWith((species) => ({ ...species, regrowth: { num: 1, den: 12 } }));
    const { cell, food, world, spawned } = meal(100_000, perTick);
    const index = worldgen.cellOffset(cell[1]) * 32 + worldgen.cellOffset(cell[0]);
    // The first meal, which regrowth lengthens, ends when the cell runs out.
    let ended = 0;
    for (let tick = 1; ended === 0; tick += 1) {
      const events = runTo(world, tick, [spawned]);
      if (events.some((event) => event.type === "being.finished")) ended = tick;
    }
    const entry = readView(world)
      .readChunk(chunkOf(cell))
      ?.depletion.find((e) => e.cell === index);
    if (entry === undefined) throw new Error("the first meal left a depletion entry");
    // The food at a tick: the deposit less what was taken and has not regrown since.
    const foodAt = (tick: number) => food - Math.max(0, entry.taken - (tick - entry.since));
    // The being idles from the next tick, deciding every 10 ticks, and eats again at the first
    // decision whose senses show `some` food.
    let again = ended + 1;
    while (foodAt(again) < SPECIES.diet.cue.some) again += 10;
    const bite = again + SPECIES.diet.biteMs / 12_000;
    const events = runTo(world, bite);
    const meals = events.filter(
      (event) =>
        event.type === "being.started" &&
        (event.payload as { activity: string }).activity === "eat",
    );
    expect(meals.map(({ tick }) => tick)).toEqual([again]);
    // The entry re-anchors at the new bite: what had not regrown, plus what it took.
    const units = Math.min(SPECIES.diet.biteUnits, foodAt(bite));
    expect(readView(world).readChunk(chunkOf(cell))?.depletion).toEqual([
      { cell: index, taken: food - foodAt(bite) + units, since: bite },
    ]);
  });

  test("fail to start where the cell has no food", () => {
    const empty = findCell([-128, -128], 64, { food: 0, accept: (cell) => baseFood(cell) === 0 });
    const hungry = brain(() => ({
      steps: [{ kind: "eat", untilNutrition: 900_000 }],
      wakeWhen: {},
      behavior: behavior("eat"),
    }));
    const world = beingsWorld({ controllers: { [SPECIES.id]: hungry } });
    runTo(world, 2, [spawn(1, { species: SPECIES.id, cell: empty })]);
    expect(beingOf(world, 1)).toMatchObject({
      activity: { kind: "idle", start: 2, ms: beings.REFUSED_IDLE_MS },
      outcome: { result: "failed", tick: 2, reason: "no_food" },
    });
  });
});

describe("sleep", () => {
  test("is forced at exhaustion, without asking the brain until rest is full", () => {
    let decisions = 0;
    // It idles long, so only the level of rest 0 wakes it, and asks for a condition that the
    // forced sleep must drop.
    const tireless = brain(() => {
      decisions += 1;
      return idleFor(6_000_000, { nutritionBelow: 10 });
    });
    const quickSleep = lifeWith((species) => ({
      ...species,
      sleep: { recover: { num: 50_000, den: 1 } },
    }));
    const world = beingsWorld({ controllers: { [SPECIES.id]: tireless }, life: quickSleep });
    const needs = { nutrition: 900_000, rest: 1000 };
    // Rest falls from 1000 at 3125/378 per second: it reaches 0 after ⌈1000·378/3125⌉ = 121 s,
    // at tick 1 + ⌈121/12⌉ = 12. From 0 at 50,000 per second it is full 20 s later, at tick 14.
    const events = runTo(world, 12, [spawn(1, { species: SPECIES.id, cell: [5, 5], needs })]);
    expect(
      events.filter((event) => event.type === "being.exhausted").map(({ tick }) => tick),
    ).toEqual([12]);
    // toMatchObject would accept any conditions for {}: they are compared whole.
    expect(beingOf(world, 1).wakeWhen).toEqual({});
    expect(beingOf(world, 1)).toMatchObject({
      activity: { kind: "sleep", untilRest: 1_000_000, forced: true },
      anchor: 12,
      needs: { rest: 0 },
      // 6 s into its sleep, rest passes recoverAbove and the health rate changes: tick 13.
      wake: 13,
    });
    const before = decisions;
    expect(runTo(world, 13)).toEqual([]);
    expect(beingOf(world, 1)).toMatchObject({ anchor: 13, wake: 14 });
    expect(decisions).toBe(before);
    const woke = runTo(world, 14);
    expect(woke.map(({ type, payload }) => [type, payload]).slice(0, 1)).toEqual([
      ["being.finished", { id: 1, activity: "sleep", result: "done", reason: "" }],
    ]);
    expect(decisions).toBe(before + 1);
    expect(bodyOf(world, 1).rest).toBe(1_000_000);
  });
});

describe("wake conditions", () => {
  test("interrupt an idle being at the tick the light falls to a threshold, at or below it", () => {
    // The day of the test world is 100 ticks, light from tick 0 to 55: past noon the light falls,
    // so a threshold equal to the light of tick 40 is first reached exactly at tick 40.
    const threshold = lightAt(40);
    expect(lightAt(39)).toBeGreaterThan(threshold);
    const watcher = brain((senses) =>
      senses.self.outcome.reason === "wake_condition"
        ? idleFor(6_000_000)
        : idleFor(6_000_000, { lightBelow: threshold }),
    );
    const world = beingsWorld({ controllers: { [SPECIES.id]: watcher } });
    // Spawned near noon, the being decides at tick 26, while the light is above the threshold.
    const events = runTo(world, 120, [spawn(25, { species: SPECIES.id, cell: [5, 5] })]);
    expect(lightAt(26)).toBeGreaterThan(threshold);
    const finished = events.filter((event) => event.type === "being.finished");
    expect(finished.map(({ tick, payload }) => [tick, payload])).toEqual([
      [40, { id: 1, activity: "idle", result: "interrupted", reason: "wake_condition" }],
    ]);
  });

  test("interrupt at the exact tick a need falls to a threshold, and are dropped when already met", () => {
    const threshold = 950_000;
    const watcher = brain((senses) =>
      senses.self.outcome.reason === "wake_condition"
        ? idleFor(6_000_000, { nutritionBelow: 990_000 })
        : idleFor(6_000_000, { nutritionBelow: threshold }),
    );
    const world = beingsWorld({ controllers: { [SPECIES.id]: watcher } });
    const events = runTo(world, 900, [spawn(1, { species: SPECIES.id, cell: [5, 5] })]);
    const { awake } = SPECIES.needs.nutrition;
    // Nutrition falls from 1,000,000 by ⌊num·s/den⌋: it reaches the threshold after
    // ⌈50,000·den/num⌉ seconds.
    const seconds = Math.ceil((50_000 * awake.den) / awake.num);
    const expected = 1 + Math.ceil(seconds / 12);
    const finished = events.filter((event) => event.type === "being.finished");
    expect(finished.map(({ tick }) => tick)).toEqual([expected]);
    // The second condition, 990,000, already held when the brain asked for it: it was dropped.
    expect(beingOf(world, 1).wakeWhen).toEqual({});
  });
});

describe("behavior", () => {
  test("is stamped by the engine: since is the tick a behavior of a new kind began", () => {
    const switcher = brain((senses) =>
      idleFor(
        120_000,
        {},
        senses.self.activity.kind === "idle" && senses.self.behavior.kind === "rest"
          ? "watch"
          : "rest",
      ),
    );
    const world = beingsWorld({ controllers: { [SPECIES.id]: switcher } });
    runTo(world, 2, [spawn(1, { species: SPECIES.id, cell: [5, 5] })]);
    expect(beingOf(world, 1).behavior).toEqual({ kind: "rest", since: 2, heading: 0 });
    runTo(world, 12);
    expect(beingOf(world, 1).behavior).toEqual({ kind: "watch", since: 12, heading: 0 });
    const steady = beingsWorld({ controllers: { [SPECIES.id]: idler(120_000) } });
    runTo(steady, 60, [spawn(1, { species: SPECIES.id, cell: [5, 5] })]);
    expect(beingOf(steady, 1).behavior).toEqual({ kind: "rest", since: 2, heading: 0 });
  });
});

describe("refused intentions and faulty brains", () => {
  test.each([
    [
      "a walk after another step",
      {
        steps: [
          { kind: "idle", ms: 1 },
          { kind: "walk", dirs: "0" },
        ],
        wakeWhen: {},
        behavior: behavior("x"),
      },
      "walk_not_first",
    ],
    [
      "a value that is not canonical",
      { steps: [{ kind: "idle", ms: 1 }], wakeWhen: {}, behavior: () => 0 },
      "malformed",
    ],
    [
      "a walk off the senses",
      { steps: [{ kind: "walk", dirs: "0".repeat(64) }], wakeWhen: {}, behavior: behavior("x") },
      "walk_blocked",
    ],
  ])("rejects %s: the being idles briefly and remembers why", (_name, intention, reason) => {
    const world = beingsWorld({ controllers: { [SPECIES.id]: brain(() => intention as never) } });
    const events = runTo(world, 2, [spawn(1, { species: SPECIES.id, cell: [5, 5] })]);
    expect(
      events.filter(({ tick }) => tick === 2).map(({ type, payload }) => [type, payload]),
    ).toEqual([["being.intention_rejected", { id: 1, reason }]]);
    expect(beingOf(world, 1)).toMatchObject({
      activity: { kind: "idle", start: 2, ms: beings.REFUSED_IDLE_MS },
      outcome: { result: "rejected", tick: 2, reason },
      wake: 2 + beings.REFUSED_IDLE_MS / 12_000,
    });
  });

  test("poison the world when a brain throws", () => {
    const thrower = brain(() => {
      throw new Error("a broken brain");
    });
    const world = beingsWorld({ controllers: { [SPECIES.id]: thrower } });
    runTo(world, 1, [spawn(1, { species: SPECIES.id, cell: [5, 5] })]);
    const error = engineErrorOf(() => step(world, []));
    expect(error.code).toBe("system_fault");
    expect(error.issues[0]?.message).toContain("a broken brain");
    expect(worldStatus(world).kind).toBe("faulted");
  });
});

describe("resumed worlds", () => {
  test("continue exactly as the original, tick by tick", () => {
    const { start } = eastWalk(6);
    const controller = brain((senses) =>
      senses.self.outcome.result === "none" && senses.self.id === 1
        ? { steps: [{ kind: "walk", dirs: "000000" }], wakeWhen: {}, behavior: behavior("travel") }
        : idleFor(36_000 + ((senses.draws[0] ?? 0) % 7) * 12_000),
    );
    const controllers = { [SPECIES.id]: controller };
    const original = beingsWorld({ controllers });
    runTo(original, 10, [
      spawn(1, { species: SPECIES.id, cell: start }, 0),
      spawn(1, { species: SPECIES.id, cell: [start[0] + 2, start[1]] }, 1),
    ]);
    const resumed = decodeSnapshot(
      encodeSnapshot(original),
      beings.createBeingsRuleset({ controllers }),
      { audit: true },
    );
    for (let tick = 11; tick <= 160; tick += 1) {
      expect(step(resumed, []).checksum).toBe(step(original, []).checksum);
    }
    expect(beingsOf(resumed)).toEqual(beingsOf(original));
  });
});

describe("the edges of the tick", () => {
  /** A brain that writes over the window it senses, then walks one step east. */
  const forger = brain((senses) => {
    (senses.window.edgeMs as unknown as Int32Array).fill(1);
    return { steps: [{ kind: "walk", dirs: "0" }], wakeWhen: {}, behavior: behavior("travel") };
  });

  test("judge a walk against the engine's own window, whatever the brain writes to its copy", () => {
    const open = findCell([0, 0], 32, {
      food: 0,
      accept: (_cell, window) => centerEdge(window, 0) > 0,
    });
    const world = beingsWorld({ controllers: { [SPECIES.id]: forger } });
    runTo(world, 2, [spawn(1, { species: SPECIES.id, cell: open })]);
    expect(beingOf(world, 1).activity).toMatchObject({
      kind: "walk",
      ms: [centerEdge(windowAt(open), 0)],
    });
    // A species that climbs nothing: its east step from `closed` is blocked, forged or not.
    const flatFooted = lifeWith((species) => ({
      ...species,
      locomotion: { ...species.locomotion, maxRise: 0 },
    }));
    const species = flatFooted.species[0] as beings.Species;
    const closed = findCell([0, 0], 32, {
      food: 0,
      accept: (cell) => centerEdge(windowAt(cell, species), 0) < 0,
    });
    const strict = beingsWorld({ controllers: { [SPECIES.id]: forger }, life: flatFooted });
    const events = runTo(strict, 2, [spawn(1, { species: SPECIES.id, cell: closed })]);
    expect(
      events.filter(({ tick }) => tick === 2).map(({ type, payload }) => [type, payload]),
    ).toEqual([["being.intention_rejected", { id: 1, reason: "walk_blocked" }]]);
    expect(beingOf(strict, 1).cell).toEqual(closed);
  });

  test("ask the brain when a wake condition holds, even with planned steps left", () => {
    let decisions = 0;
    const planner = brain((senses) => {
      decisions += 1;
      if (senses.self.outcome.reason === "wake_condition") return idleFor(6_000_000);
      const steps = [
        { kind: "idle", ms: 6_000_000 },
        { kind: "sleep", untilRest: 1_000_000 },
      ] as const;
      return { steps, wakeWhen: { nutritionBelow: 899_000 }, behavior: behavior("wait") };
    });
    const world = beingsWorld({ controllers: { [SPECIES.id]: planner } });
    const needs = { nutrition: 900_000, rest: 900_000 };
    // Nutrition falls 1000 after ⌈1000·189/1250⌉ = 152 s, at tick 1 + ⌈152/12⌉ = 14.
    const events = runTo(world, 20, [spawn(1, { species: SPECIES.id, cell: [5, 5], needs })]);
    const at14 = events
      .filter(({ tick }) => tick === 14)
      .map(({ type, payload }) => [type, payload]);
    expect(at14).toEqual([
      [
        "being.finished",
        { id: 1, activity: "idle", result: "interrupted", reason: "wake_condition" },
      ],
      ["being.started", { id: 1, activity: "idle" }],
    ]);
    expect(decisions).toBe(2);
    const being = beingOf(world, 1);
    expect([being.activity, being.plan, being.wakeWhen]).toEqual([
      { kind: "idle", start: 14, ms: 6_000_000 },
      [],
      {},
    ]);
  });

  test("end a sleep whose target is already met at the next tick", () => {
    const sleeper = brain((senses) =>
      senses.self.outcome.result === "none"
        ? {
            steps: [{ kind: "sleep", untilRest: 500_000 }],
            wakeWhen: {},
            behavior: behavior("sleep"),
          }
        : idleFor(6_000_000),
    );
    const world = beingsWorld({ controllers: { [SPECIES.id]: sleeper } });
    const needs = { nutrition: 900_000, rest: 900_000 };
    const events = runTo(world, 3, [spawn(1, { species: SPECIES.id, cell: [5, 5], needs })]);
    expect(
      events
        .filter((event) => event.type === "being.finished")
        .map(({ tick, payload }) => [tick, payload]),
    ).toEqual([[3, { id: 1, activity: "sleep", result: "done", reason: "" }]]);
  });

  test("move the steps due at the tick of exhaustion, and pair the events of the forced sleep", () => {
    const dirs = "04".repeat(32);
    let start: [number, number] = [0, 0];
    let ms: number[] | undefined;
    for (let x = 0; ms === undefined; x += 1) {
      start = [x, 3];
      ms = walkMs(windowAt(start), dirs);
    }
    const arrivals = cumulative(ms).map((total) => 2 + Math.ceil(total / 12_000));
    // Rest falls idle from tick 1 to 2, by ⌊3125·12/378⌋ = 99, then walking at 15625/1512 per
    // second: the first rest whose exhaustion falls on an arrival other than the last.
    const { walking } = SPECIES.needs.rest;
    const exhaustion = (rest: number) =>
      2 + Math.ceil(Math.ceil(((rest - 99) * walking.den) / walking.num) / 12);
    let rest = 300;
    while (!arrivals.slice(0, -1).includes(exhaustion(rest))) rest += 1;
    const tick = exhaustion(rest);
    const world = beingsWorld({ controllers: { [SPECIES.id]: walker(dirs) } });
    const events = runTo(world, tick, [
      spawn(1, { species: SPECIES.id, cell: start, needs: { nutrition: 900_000, rest } }),
    ]);
    const arrived = arrivals.filter((arrival) => arrival <= tick).length;
    expect(beingOf(world, 1).cell).toEqual([start[0] + (arrived % 2), start[1]]);
    expect(
      events.filter((event) => event.tick === tick).map(({ type, payload }) => [type, payload]),
    ).toEqual([
      ["being.exhausted", { id: 1 }],
      ["being.finished", { id: 1, activity: "walk", result: "interrupted", reason: "exhausted" }],
      ["being.started", { id: 1, activity: "sleep" }],
    ]);
  });

  test("interrupt a meal at once when a wake condition holds at a bite, without that bite", () => {
    const cell = findCell([-128, -128], 256, { food: 2 * SPECIES.diet.biteUnits });
    // The light falls past noon: a threshold equal to the light of tick 36 is first met there,
    // at the second bite of a meal that starts at tick 26.
    const threshold = lightAt(36);
    expect(lightAt(35)).toBeGreaterThan(threshold);
    const diner = brain((senses) =>
      senses.self.outcome.result === "none"
        ? {
            steps: [{ kind: "eat", untilNutrition: 1_000_000 }],
            wakeWhen: { lightBelow: threshold },
            behavior: behavior("eat"),
          }
        : idleFor(6_000_000),
    );
    const world = beingsWorld({ controllers: { [SPECIES.id]: diner } });
    const needs = { nutrition: 500_000, rest: 900_000 };
    const events = runTo(world, 40, [spawn(25, { species: SPECIES.id, cell, needs })]);
    expect(events.filter((event) => event.type === "being.ate").map(({ tick }) => tick)).toEqual([
      31,
    ]);
    expect(
      events
        .filter((event) => event.type === "being.finished")
        .map(({ tick, payload }) => [tick, payload]),
    ).toEqual([[36, { id: 1, activity: "eat", result: "interrupted", reason: "wake_condition" }]]);
    // The cell gave only the first bite: none was taken, or lost, at the interruption.
    const index = worldgen.cellOffset(cell[1]) * 32 + worldgen.cellOffset(cell[0]);
    expect(readView(world).readChunk(chunkOf(cell))?.depletion).toEqual([
      { cell: index, taken: SPECIES.diet.biteUnits, since: 31 },
    ]);
  });

  test("clear the wake conditions of a refused intention", () => {
    // The first decision waits with a condition; the next one, after the wait, is malformed.
    const fickle = brain((senses) =>
      senses.self.behavior.kind === "none"
        ? { ...idleFor(120_000, { nutritionBelow: 1 }), behavior: behavior("wait") }
        : ({ steps: [], wakeWhen: {}, behavior: behavior("x") } as never),
    );
    const world = beingsWorld({ controllers: { [SPECIES.id]: fickle } });
    runTo(world, 2, [spawn(1, { species: SPECIES.id, cell: [5, 5] })]);
    expect(beingOf(world, 1).wakeWhen).toEqual({ nutritionBelow: 1 });
    runTo(world, 12);
    expect(beingOf(world, 1).outcome).toMatchObject({ result: "rejected", tick: 12 });
    expect(beingOf(world, 1).wakeWhen).toEqual({});
  });

  test("drop a wake condition already met exactly when the brain asks for it", () => {
    const exact = brain((senses) =>
      idleFor(6_000_000, { nutritionBelow: senses.self.needs.nutrition }),
    );
    const world = beingsWorld({ controllers: { [SPECIES.id]: exact } });
    runTo(world, 2, [spawn(1, { species: SPECIES.id, cell: [5, 5] })]);
    expect(beingOf(world, 1).wakeWhen).toEqual({});
  });

  test("re-anchor at the tick rest passes recoverAbove while it rises, not at the tick it reaches it", () => {
    // Rest rises from 0 at 25,000 per second in a forced sleep from tick 2: it is exactly
    // recoverAbove at tick 3, which changes nothing, and passes it at tick 4, where health starts
    // to rise.
    const slowSleep = lifeWith((species) => ({
      ...species,
      sleep: { recover: { num: 25_000, den: 1 } },
    }));
    expect(SPECIES.health.recoverAbove).toBe(300_000);
    const world = beingsWorld({ controllers: { [SPECIES.id]: idler(6_000_000) }, life: slowSleep });
    runTo(world, 2, [
      spawn(1, { species: SPECIES.id, cell: [5, 5], needs: { nutrition: 900_000, rest: 0 } }),
    ]);
    expect(beingOf(world, 1)).toMatchObject({ anchor: 2, wake: 3 });
    runTo(world, 3);
    expect(beingOf(world, 1)).toMatchObject({ anchor: 2, wake: 4 });
    runTo(world, 4);
    expect(beingOf(world, 1).anchor).toBe(4);
  });

  test("drop a cell's depletion once it fully regrew, when its chunk is written again", () => {
    const cell = findCell([-128, -128], 256, { food: 2 * SPECIES.diet.biteUnits });
    const quickGrowth = lifeWith((species) => ({ ...species, regrowth: { num: 1, den: 1 } }));
    const snack = brain((senses) =>
      senses.self.outcome.result === "none"
        ? {
            steps: [{ kind: "eat", untilNutrition: 900_000 }],
            wakeWhen: {},
            behavior: behavior("eat"),
          }
        : idleFor(600_000),
    );
    const world = beingsWorld({ controllers: { [SPECIES.id]: snack }, life: quickGrowth });
    const needs = { nutrition: 850_000, rest: 900_000 };
    // The bites at ticks 7 and 12 sate the being, which decides at tick 13 to idle 50 ticks. At
    // one unit per second, the cell has regrown long before tick 63, when its chunk is written.
    runTo(world, 62, [spawn(1, { species: SPECIES.id, cell, needs })]);
    expect(readView(world).readChunk(chunkOf(cell))?.depletion).toHaveLength(1);
    runTo(world, 63);
    expect(readView(world).readChunk(chunkOf(cell))?.depletion).toEqual([]);
  });

  test("recover from incapacity at the tick health passes recoverAbove, however often processed", () => {
    // Health falls and recovers at 5,000 per second, and one bite feeds 500,000.
    const fast = lifeWith((species) => ({
      ...species,
      diet: { ...species.diet, nutritionPerUnit: 20_000 },
      health: { ...species.health, starve: { num: 5000, den: 1 }, recover: { num: 5000, den: 1 } },
    }));
    const patient = brain((senses) => {
      const radius = (senses.window.side - 1) / 2;
      const cue = senses.window.foodCue[radius * senses.window.side + radius] ?? 0;
      const { condition, needs, id } = senses.self;
      if (condition === "incapacitated" && needs.nutrition < 400_000 && cue > 0) {
        return {
          steps: [{ kind: "eat", untilNutrition: 400_000 }],
          wakeWhen: {},
          behavior: behavior("eat"),
        };
      }
      // Fed, being 1 decides every tick and being 2 every 500 ticks.
      return idleFor(needs.nutrition >= 400_000 && id === 2 ? 6_000_000 : 12_000);
    });
    const first = findCell([-128, -128], 256, { food: SPECIES.diet.biteUnits });
    const second = findCell([first[0] + 1, first[1]], 128, { food: SPECIES.diet.biteUnits });
    const world = beingsWorld({ controllers: { [SPECIES.id]: patient }, life: fast });
    const needs = { nutrition: 0, rest: 900_000 };
    const events = runTo(world, 140, [
      spawn(1, { species: SPECIES.id, cell: first, needs }, 0),
      spawn(1, { species: SPECIES.id, cell: second, needs }, 1),
    ]);
    // Health is 0 after 200 s, at tick 18, where both start to eat; the bite at tick 23 lifts
    // nutrition, and health passes recoverAbove ⌈300,001 / 5000⌉ = 61 s later, at tick 29.
    const recovery = 23 + Math.ceil(Math.ceil((SPECIES.health.recoverAbove + 1) / 5000) / 12);
    const recovered = events.filter((event) => event.type === "being.recovered");
    expect(recovered.map(({ tick, payload }) => [tick, payload])).toEqual([
      [recovery, { id: 1 }],
      [recovery, { id: 2 }],
    ]);
  });

  test("process a being at least once a simulated day", () => {
    const world = beingsWorld({ controllers: { [SPECIES.id]: idler(6_000_000) } });
    runTo(world, 2, [spawn(1, { species: SPECIES.id, cell: [5, 5] })]);
    expect(beingOf(world, 1).wake).toBe(2 + 100);
  });
});
