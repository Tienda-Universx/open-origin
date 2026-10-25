/**
 * Contests over food, incapacity, and death (ADR 0023, docs/architecture/beings.md, "The tick"):
 * rivals that claim more than a cell holds share it in an order drawn from `beings.contest`, which
 * favors no id, and the food is conserved in the world's state; a starving being is incapacitated
 * at the exact tick its health reaches 0, can eat but not walk, and recovers at the exact tick its
 * health passes `recoverAbove`; with death enabled, it dies and leaves its chunk.
 */
import { describe, expect, test } from "bun:test";
import { beings, type Command, readView, worldgen } from "../src/index.ts";
import {
  baseFood,
  behavior,
  beingOf,
  beingsOf,
  beingsWorld,
  brain,
  chunkOf,
  findCell,
  lifeWith,
  runTo,
  type Senses,
  SPECIES,
  spawn,
  walkMs,
  windowAt,
} from "./support/beings-world.ts";

/** The food cue of the cell a being stands on. */
function cueHere(senses: Senses): number {
  const radius = (senses.window.side - 1) / 2;
  return senses.window.foodCue[radius * senses.window.side + radius] ?? 0;
}

/** An intention that idles for `ms`. */
function idleFor(ms: number): beings.Intention {
  return { steps: [{ kind: "idle", ms }], wakeWhen: {}, behavior: behavior("rest") };
}

/** A brain that eats where it stands while it senses food and is hungry, and idles otherwise. */
const eater = brain((senses) =>
  cueHere(senses) > 0 && senses.self.needs.nutrition < 900_000
    ? { steps: [{ kind: "eat", untilNutrition: 900_000 }], wakeWhen: {}, behavior: behavior("eat") }
    : idleFor(600_000),
);

/** The first cell with at least two bites of food and less than three: three rivals contest it. */
const SHORT_CELL = findCell([-128, -128], 256, {
  food: 2 * SPECIES.diet.biteUnits,
  accept: (cell) => baseFood(cell) < 3 * SPECIES.diet.biteUnits,
});

/** The first such cell whose food is not a whole number of bites, so that one rival bites less. */
const PARTIAL_CELL = findCell([-128, -128], 256, {
  food: 2 * SPECIES.diet.biteUnits + 1,
  accept: (cell) =>
    baseFood(cell) < 3 * SPECIES.diet.biteUnits && baseFood(cell) % SPECIES.diet.biteUnits !== 0,
});

/** The default laws with a small radius, so that the many decisions of the fairness test stay cheap. */
const NEAR_SIGHTED = lifeWith((species) => ({ ...species, senses: { radius: 4 } }));

/** Spawns `count` hungry beings on `cell` at tick 1: they start eating at tick 2, biting at 7. */
function rivals(count: number, cell: readonly [number, number]) {
  const needs = { nutrition: 500_000, rest: 900_000 };
  return Array.from({ length: count }, (_, seq) =>
    spawn(1, { species: SPECIES.id, cell: [cell[0], cell[1]], needs }, seq),
  );
}

/** The tick of the first bite of a meal started at tick 2. */
const FIRST_BITE = 2 + SPECIES.diet.biteMs / 12_000;

/** What each being got at its first bite, from its contested event, by id. */
function grantsOf(events: readonly { type: string; payload: unknown }[]): Map<number, number> {
  const grants = new Map<number, number>();
  for (const event of events) {
    if (event.type !== "being.contested") continue;
    const { id, claimed, granted } = event.payload as {
      id: number;
      claimed: number;
      granted: number;
    };
    expect(claimed).toBe(SPECIES.diet.biteUnits);
    grants.set(id, granted);
  }
  return grants;
}

describe("contests", () => {
  test.each([
    ["two whole bites", SHORT_CELL],
    ["two bites and a part", PARTIAL_CELL],
  ])(
    "share %s among three rivals in a drawn order, and conserve it in the state",
    (_name, cell) => {
      const food = baseFood(cell);
      const world = beingsWorld({ controllers: { [SPECIES.id]: eater } });
      const events = runTo(world, FIRST_BITE, rivals(3, cell));
      const grants = grantsOf(events.filter(({ tick }) => tick === FIRST_BITE));
      const { biteUnits } = SPECIES.diet;
      // Whatever the order, two rivals take a full bite and the third takes what is left.
      expect([...grants.values()].sort((a, b) => b - a)).toEqual([
        biteUnits,
        biteUnits,
        food - 2 * biteUnits,
      ]);
      const ate = events
        .filter((event) => event.type === "being.ate")
        .map(({ payload }) => payload);
      // Both kinds of event follow the drawn order, in which the rivals took their bites.
      expect(ate).toEqual(
        [...grants].filter(([, units]) => units > 0).map(([id, units]) => ({ id, units })),
      );
      // Conservation, read from the state: the cell lost exactly what the beings gained.
      const index = worldgen.cellOffset(cell[1]) * 32 + worldgen.cellOffset(cell[0]);
      expect(readView(world).readChunk(chunkOf(cell))?.depletion).toEqual([
        { cell: index, taken: food, since: FIRST_BITE },
      ]);
      const { awake } = SPECIES.needs.nutrition;
      const fallen = Math.floor((awake.num * (FIRST_BITE - 1) * 12) / awake.den);
      for (const being of beingsOf(world)) {
        const units = grants.get(being.id) ?? -1;
        const { nutrition } = beings.bodyAt(SPECIES, being, FIRST_BITE, 12);
        expect(nutrition).toBe(500_000 - fallen + units * SPECIES.diet.nutritionPerUnit);
      }
      const loser = [...grants].find(([, units]) => units < biteUnits)?.[0] as number;
      expect(beingOf(world, loser).outcome).toEqual({
        result: food === 2 * biteUnits ? "lost" : "done",
        tick: FIRST_BITE,
        reason: "food_gone",
      });
    },
  );

  test("let rivals eat in full, without a contest, when the food covers every claim", () => {
    // Two bites of food or more for two rivals: exactly enough at the boundary.
    const world = beingsWorld({ controllers: { [SPECIES.id]: eater } });
    const events = runTo(world, FIRST_BITE, rivals(2, SHORT_CELL));
    expect(events.filter((event) => event.type === "being.contested")).toEqual([]);
    expect(
      events.filter((event) => event.type === "being.ate").map(({ payload }) => payload),
    ).toEqual([
      { id: 1, units: SPECIES.diet.biteUnits },
      { id: 2, units: SPECIES.diet.biteUnits },
    ]);
  });

  test("key the draw by the lowest claimant id, whatever the ids of the others", () => {
    // The same world seed and tick, and the same lowest id, give the same order of rivals: with
    // ids 1, 2, 3, and with ids 1, 2, 4 when being 3 stands elsewhere.
    const needs = { nutrition: 500_000, rest: 900_000 };
    const at = (cell: readonly [number, number], seq: number) =>
      spawn(1, { species: SPECIES.id, cell: [cell[0], cell[1]], needs }, seq);
    const ranks = (seed: number, spawns: Command[], ids: number[]) => {
      const world = beingsWorld({
        controllers: { [SPECIES.id]: eater },
        seed: [seed, 7],
        life: NEAR_SIGHTED,
        audit: false,
      });
      return [...grantsOf(runTo(world, FIRST_BITE, spawns)).keys()].map((id) => ids.indexOf(id));
    };
    const orders = new Set<string>();
    for (let seed = 0; seed < 8; seed += 1) {
      const plain = ranks(seed, rivals(3, SHORT_CELL), [1, 2, 3]);
      const gapped = [at(SHORT_CELL, 0), at(SHORT_CELL, 1), at([5, 5], 2), at(SHORT_CELL, 3)];
      expect(ranks(seed, gapped, [1, 2, 4])).toEqual(plain);
      orders.add(plain.join());
    }
    // Not vacuous: the seeds draw different orders.
    expect(orders.size).toBeGreaterThan(1);
  });

  test("favor no id: the rival left short is uniform across world seeds", () => {
    // 120 worlds, three rivals each: the one left short should be each id about 40 times. The
    // statistic has 2 degrees of freedom; 13.82 is its 0.999 quantile.
    const counts = [0, 0, 0];
    for (let k = 0; k < 120; k += 1) {
      const world = beingsWorld({
        controllers: { [SPECIES.id]: eater },
        seed: [k, 0x5eed],
        life: NEAR_SIGHTED,
        audit: false,
      });
      const grants = grantsOf(runTo(world, FIRST_BITE, rivals(3, SHORT_CELL)));
      for (const [id, units] of grants) {
        if (units < SPECIES.diet.biteUnits) counts[id - 1] = (counts[id - 1] ?? 0) + 1;
      }
    }
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(120);
    const chiSquare = counts.reduce((sum, count) => sum + (count - 40) ** 2 / 40, 0);
    expect(chiSquare).toBeLessThan(13.82);
  });
});

/** Laws under which health falls and recovers at 5,000 per second, and a bite feeds 500,000. */
function fastLife(deathEnabled: boolean): beings.LifeConfig {
  const life = lifeWith((species) => ({
    ...species,
    diet: { ...species.diet, nutritionPerUnit: 20_000 },
    health: { ...species.health, starve: { num: 5000, den: 1 }, recover: { num: 5000, den: 1 } },
  }));
  return { ...life, deathEnabled };
}

/** The tick a being spawned at tick 1 with nutrition 0 reaches health 0: ⌈10^6 / 5000⌉ = 200 s. */
const COLLAPSE = 1 + Math.ceil(200 / 12);

describe("incapacity and death", () => {
  test("incapacitate at health 0, refuse walks, allow meals, and recover at the exact tick", () => {
    const patient = brain((senses) => {
      if (senses.self.condition === "ok") return idleFor(12_000);
      if (senses.self.outcome.result === "none") {
        return { steps: [{ kind: "walk", dirs: "0" }], wakeWhen: {}, behavior: behavior("flee") };
      }
      if (senses.self.needs.nutrition < 400_000 && cueHere(senses) > 0) {
        return {
          steps: [{ kind: "eat", untilNutrition: 400_000 }],
          wakeWhen: {},
          behavior: behavior("eat"),
        };
      }
      return idleFor(6_000_000);
    });
    const world = beingsWorld({ controllers: { [SPECIES.id]: patient }, life: fastLife(false) });
    const needs = { nutrition: 0, rest: 900_000 };
    const events = runTo(world, 60, [spawn(1, { species: SPECIES.id, cell: SHORT_CELL, needs })]);
    // Refused at the collapse, the walk idles the being 60 s; then it eats, and one bite of
    // 500,000 lifts nutrition above recoverAbove, so health rises from 0 at 5,000 per second and
    // passes recoverAbove after ⌈300,001 / 5000⌉ = 61 s.
    const meal = COLLAPSE + beings.REFUSED_IDLE_MS / 12_000;
    const bite = meal + SPECIES.diet.biteMs / 12_000;
    const recovery = bite + Math.ceil(Math.ceil((SPECIES.health.recoverAbove + 1) / 5000) / 12);
    const kinds = new Set([
      "being.incapacitated",
      "being.intention_rejected",
      "being.started",
      "being.ate",
      "being.recovered",
    ]);
    expect(
      events
        .filter(
          ({ type, payload }) =>
            kinds.has(type) && (payload as { activity?: string }).activity !== "idle",
        )
        .map(({ tick, type, payload }) => [tick, type, payload]),
    ).toEqual([
      [COLLAPSE, "being.incapacitated", { id: 1 }],
      [COLLAPSE, "being.intention_rejected", { id: 1, reason: "incapacitated" }],
      [meal, "being.started", { id: 1, activity: "eat" }],
      [bite, "being.ate", { id: 1, units: SPECIES.diet.biteUnits }],
      [recovery, "being.recovered", { id: 1 }],
    ]);
    expect(beingOf(world, 1).condition).toBe("ok");
  });

  test("interrupt a walk at the collapse, where the being stands", () => {
    let start: [number, number] = [0, 0];
    let ms: number[] | undefined;
    for (let y = 0; ms === undefined; y += 1) {
      start = [0, y];
      ms = walkMs(windowAt(start), "0".repeat(12));
    }
    const runner = brain((senses) =>
      senses.self.outcome.result === "none"
        ? {
            steps: [{ kind: "walk", dirs: "0".repeat(12) }],
            wakeWhen: {},
            behavior: behavior("travel"),
          }
        : idleFor(6_000_000),
    );
    const world = beingsWorld({ controllers: { [SPECIES.id]: runner }, life: fastLife(false) });
    const needs = { nutrition: 0, rest: 900_000 };
    const events = runTo(world, COLLAPSE, [spawn(1, { species: SPECIES.id, cell: start, needs })]);
    let total = 0;
    const arrived = ms.filter((duration) => {
      total += duration;
      return 2 + Math.ceil(total / 12_000) <= COLLAPSE;
    }).length;
    expect(arrived).toBeLessThan(12);
    expect(
      events
        .filter((event) => event.type === "being.finished")
        .map(({ tick, payload }) => [tick, payload]),
    ).toEqual([
      [COLLAPSE, { id: 1, activity: "walk", result: "interrupted", reason: "incapacitated" }],
    ]);
    expect(beingOf(world, 1)).toMatchObject({
      cell: [start[0] + arrived, start[1]],
      condition: "incapacitated",
      activity: { kind: "idle", start: COLLAPSE },
    });
  });

  test("with death enabled, kill at health 0: the being leaves its chunk, then the index", () => {
    const world = beingsWorld({
      controllers: { [SPECIES.id]: brain(() => idleFor(12_000)) },
      life: fastLife(true),
    });
    const needs = { nutrition: 0, rest: 900_000 };
    const events = runTo(world, COLLAPSE, [spawn(1, { species: SPECIES.id, cell: [5, 5], needs })]);
    expect(
      events.filter(({ tick }) => tick === COLLAPSE).map(({ type, payload }) => [type, payload]),
    ).toEqual([["being.died", { id: 1, cell: [5, 5] }]]);
    expect(readView(world).readChunk("0,0")).toEqual({
      beings: [],
      depletion: [],
      due: Number.MAX_SAFE_INTEGER,
    });
    expect(readView(world).readGlobal().occupancy).toEqual(["0,0"]);
    expect(runTo(world, 99)).toEqual([]);
    runTo(world, 100);
    expect(readView(world).readGlobal().occupancy).toEqual([]);
  });
});
