/**
 * The beings ruleset (ADR 0023, docs/architecture/beings.md): how it captures its brains, what its
 * global validator refuses, and the admin command `beings.spawn`, with every problem of a refused
 * spawn reported at once and the world unchanged.
 */
import { describe, expect, test } from "bun:test";
import {
  beings,
  createWorld,
  readView,
  step,
  type World,
  worldgen,
  worldStatus,
} from "../src/index.ts";
import {
  type BeingsWorld,
  behavior,
  beingOf,
  beingsWorld,
  brain,
  idler,
  lifeWith,
  runTo,
  SPECIES,
  spawn,
  testGenesis,
} from "./support/beings-world.ts";
import { engineErrorOf } from "./support/engine-error.ts";

/** The paths and messages of every issue of an error, sorted by path. */
function issuesOf(action: () => unknown): { path: string; message: string }[] {
  const error = engineErrorOf(action);
  return error.issues
    .map(({ path, message }) => ({ path, message }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** The details of the one rejection that the step to the next tick of `world` emits. */
function rejectionOf(world: BeingsWorld, payload: unknown): unknown {
  const tick = readView(world).tick + 1;
  const events = step(world, [spawn(tick, payload as never)]).events;
  const rejected = events.filter((event) => event.type === "engine.command_rejected");
  expect(rejected).toHaveLength(1);
  return rejected[0]?.payload;
}

describe("createBeingsRuleset", () => {
  test("composes its brain version from each species and its brain, in species order", () => {
    const ruleset = beings.createBeingsRuleset({
      controllers: { s2: idler(1000), s1: brain(() => idleIntention(), "first@2") },
    });
    expect(ruleset.versions).toEqual({
      ruleset: "beings@1",
      generator: worldgen.WORLDGEN_VERSION,
      brain: "s1:first@2,s2:script@1",
    });
    expect(ruleset.systems.map((system) => [system.name, system.streams])).toEqual([
      ["beings", ["beings.brain", "beings.contest"]],
    ]);
    expect(Object.keys(ruleset.commands)).toEqual(["beings.spawn"]);
  });

  test("refuses brains that are not one brain per species, with every problem", () => {
    const getter = {};
    Object.defineProperty(getter, "s4", { enumerable: true, get: () => idler(1) });
    expect(
      issuesOf(() =>
        beings.createBeingsRuleset({
          controllers: {
            S1: idler(1),
            s2: { brain: "", decide: 3 },
            s3: { decide: () => idleIntention() },
            s5: 7,
          } as never,
        }),
      ),
    ).toEqual([
      {
        path: "/controllers/S1",
        message:
          'a value of type string is not an identifier: 1 to 32 characters, a lowercase letter first, then lowercase letters, digits, ".", "_", or "-"',
      },
      { path: "/controllers/s2/brain", message: "a brain's version must be a non-empty string" },
      { path: "/controllers/s2/decide", message: "a brain must have a decide function" },
      { path: "/controllers/s3/brain", message: "a brain's version must be a non-empty string" },
      {
        path: "/controllers/s5",
        message: "a brain must be an object with a brain version and a decide function",
      },
    ]);
    expect(issuesOf(() => beings.createBeingsRuleset({ controllers: {} }))).toEqual([
      { path: "/controllers", message: "the ruleset needs a brain for at least one species" },
    ]);
    const accessor = issuesOf(() => beings.createBeingsRuleset({ controllers: getter as never }));
    expect(accessor.map(({ path }) => path)).toEqual(["/controllers/s4"]);
    expect(engineErrorOf(() => beings.createBeingsRuleset({} as never)).code).toBe(
      "invalid_ruleset",
    );
  });

  test("captures each brain once, so that changing the options later changes nothing", () => {
    const controller = { brain: "script@1", decide: (_senses: unknown) => idleIntention() };
    const options: { controllers: { [species: string]: beings.Controller } } = {
      controllers: { [SPECIES.id]: controller },
    };
    const world = worldFrom(beings.createBeingsRuleset(options));
    controller.decide = () => {
      throw new Error("a brain changed after the ruleset captured it");
    };
    options.controllers[SPECIES.id] = idler(5);
    runTo(world, 4, [spawn(1, { species: SPECIES.id, cell: [3, 4] })]);
    expect(worldStatus(world)).toEqual({ kind: "ok", tick: 4 });
    expect(beingOf(world, 1).activity).toEqual({ kind: "idle", start: 2, ms: 600_000 });
  });
});

describe("the global value of a world of beings", () => {
  test("names each species of the laws of life that has no brain", () => {
    const ruleset = beings.createBeingsRuleset({ controllers: { s9: idler(1) } });
    const issues = issuesOf(() => worldFrom(ruleset));
    expect(issues).toEqual([
      {
        path: "/init/global/life/species/0/id",
        message: `the ruleset has no brain for the species "${SPECIES.id}"`,
      },
    ]);
  });

  test("faults the tick when the occupancy index lists a chunk that is not materialized", () => {
    const ruleset = beings.createBeingsRuleset({ controllers: { [SPECIES.id]: idler(1) } });
    const genesis = testGenesis();
    const global = { ...beings.beingsGlobal(genesis, beings.defaultLife()), occupancy: ["0,0"] };
    const world = createWorld({ seed: [1, 2], simSecondsPerTick: 12, global, chunks: {}, ruleset });
    const error = engineErrorOf(() => step(world, []));
    expect(error.code).toBe("system_fault");
    expect(error.issues.map(({ path, message }) => [path, message])).toEqual([
      [
        "/systems/0",
        'system "beings": run threw: EngineError: integrity_violation at the root: the occupancy index lists the chunk 0,0, which is not materialized',
      ],
    ]);
    expect(worldStatus(world).kind).toBe("faulted");
  });
});

describe("beings.spawn", () => {
  test("puts the being in the chunk of its cell, negative coordinates included", () => {
    const world = beingsWorld({ controllers: { [SPECIES.id]: idler(600_000) } });
    const events = step(world, [
      spawn(1, {
        species: SPECIES.id,
        cell: [-1, -33],
        needs: { nutrition: 600_000, rest: 700_000 },
        traits: { appetite: 800, curiosity: 1200, sleepiness: 1000 },
      }),
    ]).events;
    expect(events.map(({ type, payload }) => [type, payload])).toEqual([
      ["being.spawned", { id: 1, species: SPECIES.id, cell: [-1, -33] }],
    ]);
    const view = readView(world);
    expect(view.readGlobal().occupancy).toEqual(["-1,-2"]);
    expect(view.readChunk("-1,-2")).toEqual({
      beings: [
        {
          id: 1,
          species: SPECIES.id,
          stage: "adult",
          born: 1,
          cell: [-1, -33],
          needs: { nutrition: 600_000, rest: 700_000 },
          health: 1_000_000,
          anchor: 1,
          traits: { appetite: 800, sleepiness: 1000, curiosity: 1200 },
          condition: "ok",
          activity: { kind: "idle", start: 1, ms: 1 },
          plan: [],
          behavior: { kind: "none", since: 1, heading: 0 },
          wakeWhen: {},
          wake: 2,
          outcome: { result: "none", tick: 1, reason: "" },
          cooldowns: [],
        },
      ],
      depletion: [],
      due: 2,
    });
  });

  test("fills omitted needs and traits, and keeps beings and occupancy sorted", () => {
    const world = beingsWorld({ controllers: { [SPECIES.id]: idler(600_000) } });
    step(world, [
      spawn(1, { species: SPECIES.id, cell: [40, 0] }, 0),
      spawn(1, { species: SPECIES.id, cell: [-40, 0] }, 1),
      spawn(1, { species: SPECIES.id, cell: [41, 1] }, 2),
    ]);
    const view = readView(world);
    expect(view.readGlobal().occupancy).toEqual(["-2,0", "1,0"]);
    expect(view.readChunk("1,0")?.beings.map(({ id }) => id)).toEqual([1, 3]);
    const first = beingOf(world, 1);
    expect(first.needs).toEqual({ nutrition: 1_000_000, rest: 1_000_000 });
    expect(first.traits).toEqual({ appetite: 1000, sleepiness: 1000, curiosity: 1000 });
  });

  test("rejects a malformed spawn with every problem, and changes nothing", () => {
    const world = beingsWorld({ controllers: { [SPECIES.id]: idler(600_000) } });
    const rejection = rejectionOf(world, {
      species: "nobody",
      cell: [2 ** 31, "north"],
      needs: { nutrition: -1, rest: 1_000_001 },
      traits: { appetite: 0, curiosity: 5000, sleepiness: 1000 },
      extra: true,
    }) as { reason: string; details: { issues: { path: string }[] } };
    expect(rejection.reason).toBe("invalid_spawn");
    expect(rejection.details.issues.map(({ path }) => path).sort()).toEqual([
      "/cell/0",
      "/cell/1",
      "/extra",
      "/needs/nutrition",
      "/needs/rest",
      "/species",
      "/traits/appetite",
    ]);
    expect(readView(world).chunkKeys()).toEqual([]);
    expect(readView(world).readGlobal().occupancy).toEqual([]);
  });

  test("bounds traits by the species, and reports missing members", () => {
    const world = beingsWorld({ controllers: { [SPECIES.id]: idler(600_000) } });
    const rejection = rejectionOf(world, {
      species: SPECIES.id,
      cell: [0, 0],
      needs: { nutrition: 5 },
      traits: { appetite: 799, curiosity: 1201, sleepiness: 800 },
    });
    expect(rejection).toMatchObject({
      reason: "invalid_spawn",
      details: {
        issues: [
          { path: "/needs/rest", message: "the member is missing" },
          {
            path: "/traits/appetite",
            message: "799 is out of bounds: it must be from 800 to 1200",
          },
          {
            path: "/traits/curiosity",
            message: "1201 is out of bounds: it must be from 800 to 1200",
          },
        ],
      },
    });
    expect(readView(world).chunkKeys()).toEqual([]);
  });

  test("rejects a cell under liquid deeper than the species may wade", () => {
    // A basin of the test terrain, far below the liquid level, and a cell on dry land.
    const genesis = testGenesis();
    const level = worldgen.liquidLevel(genesis);
    const row = { x: -57_344, y: -32_768, width: 32, height: 1 };
    const { elevation } = worldgen.sampleSurface(worldgen.prepareGenesis(genesis), row, 0);
    const deep = elevation.findIndex((e) => level - e > SPECIES.locomotion.maxWade);
    expect(deep).toBeGreaterThanOrEqual(0);
    const world = beingsWorld({ controllers: { [SPECIES.id]: idler(600_000) } });
    expect(rejectionOf(world, { species: SPECIES.id, cell: [row.x + deep, row.y] })).toMatchObject({
      reason: "invalid_spawn",
      details: {
        issues: [
          { path: "/cell", message: "the cell lies under liquid deeper than the species may wade" },
        ],
      },
    });
    expect(readView(world).chunkKeys()).toEqual([]);
    const events = step(world, [spawn(2, { species: SPECIES.id, cell: [0, 0] })]).events;
    expect(events.map(({ type }) => type)).toEqual(["being.spawned"]);
  });

  test("accepts a cell exactly as deep as the species may wade, and refuses one deeper", () => {
    // A cell on the rim of the basin, 12 below the liquid level.
    const cell = [-57_702, -33_601];
    const wading = (maxWade: number) =>
      lifeWith((species) => ({ ...species, locomotion: { ...species.locomotion, maxWade } }));
    const exact = beingsWorld({ controllers: { [SPECIES.id]: idler(600_000) }, life: wading(12) });
    const accepted = step(exact, [spawn(1, { species: SPECIES.id, cell })]).events;
    expect(accepted.map(({ type }) => type)).toEqual(["being.spawned"]);
    const shallower = beingsWorld({
      controllers: { [SPECIES.id]: idler(600_000) },
      life: wading(11),
    });
    expect(rejectionOf(shallower, { species: SPECIES.id, cell })).toMatchObject({
      reason: "invalid_spawn",
    });
  });
});

/** An intention that idles for ten minutes. */
function idleIntention(): beings.Intention {
  return { steps: [{ kind: "idle", ms: 600_000 }], wakeWhen: {}, behavior: behavior("rest") };
}

/** A world of the default laws over the test genesis, running `ruleset`. */
function worldFrom(
  ruleset: ReturnType<typeof beings.createBeingsRuleset>,
): World<beings.BeingsGlobal, beings.BeingsChunk> {
  return createWorld(
    {
      seed: [1, 2],
      simSecondsPerTick: 12,
      global: beings.beingsGlobal(testGenesis(), beings.defaultLife()),
      chunks: {},
      ruleset,
    },
    { audit: true },
  );
}
