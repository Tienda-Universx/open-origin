/**
 * The ruleset beings@2 beside beings@1 (ADR 0024, docs/architecture/mind.md "Versions and
 * compatibility", "The mind of a being", "Commands and faults"): the option that selects it, the
 * laws each version requires, the being it spawns with six traits and an empty mind, the
 * validation of its chunks with the mind's invariants and its capacity, and a spawn into a chunk at
 * capacity, same-tick spawns included.
 */
import { describe, expect, test } from "bun:test";
import {
  beings,
  canonicalize,
  createWorld,
  type EngineEvent,
  type Issue,
  mind,
  readView,
  step,
  worldgen,
} from "../src/index.ts";
import {
  beingOf,
  beingsOf,
  beingsWorld,
  chunkOf,
  idler,
  SPECIES,
  spawn,
  testGenesis,
} from "./support/beings-world.ts";
import {
  BEHAVIORS,
  being2,
  beings2World,
  gateMind,
  idler2,
  life2With,
  NEUTRAL_TRAITS,
  SPECIES2,
} from "./support/beings2-world.ts";
import { engineErrorOf } from "./support/engine-error.ts";

/** The paths and messages of every issue of the error `action` throws. */
function issuesOf(action: () => unknown): Issue[] {
  return engineErrorOf(action).issues.map(({ path, message }) => ({ path, message }));
}

describe("createBeingsRuleset with rules", () => {
  test('"beings@2" is the ruleset beings@2, with the streams beings.crowd and beings.speech', () => {
    const ruleset = beings.createBeingsRuleset({
      controllers: { s1: idler2(1000) },
      rules: "beings@2",
    });
    expect(ruleset.versions).toEqual({
      ruleset: "beings@2",
      generator: worldgen.WORLDGEN_VERSION,
      brain: "s1:script@2",
    });
    expect(ruleset.systems.map((system) => [system.name, system.streams])).toEqual([
      ["beings", ["beings.brain", "beings.contest", "beings.crowd", "beings.speech"]],
    ]);
    expect(Object.keys(ruleset.commands)).toEqual(["beings.spawn", "mind.inject"]);
  });

  test("without rules it stays beings@1", () => {
    const ruleset = beings.createBeingsRuleset({ controllers: { s1: idler(1000) } });
    expect(ruleset.versions.ruleset).toBe("beings@1");
    expect(ruleset.systems[0]?.streams).toEqual(["beings.brain", "beings.contest"]);
    expect(Object.keys(ruleset.commands)).toEqual(["beings.spawn"]);
  });

  test('an explicit "beings@1" is beings@1, as when rules is absent', () => {
    const ruleset = beings.createBeingsRuleset({
      controllers: { s1: idler(1000) },
      rules: "beings@1",
    });
    expect(ruleset.versions.ruleset).toBe("beings@1");
    expect(ruleset.systems[0]?.streams).toEqual(["beings.brain", "beings.contest"]);
    expect(Object.keys(ruleset.commands)).toEqual(["beings.spawn"]);
  });

  test.each([["beings@3"], ["beings@01"], [2], [null], [""]])(
    "refuses rules %p with invalid_ruleset",
    (rules) => {
      const error = engineErrorOf(() =>
        beings.createBeingsRuleset({ controllers: { s1: idler2(1) }, rules } as never),
      );
      expect(error.code).toBe("invalid_ruleset");
      expect(error.issues.map(({ path, message }) => ({ path, message }))).toEqual([
        {
          path: "/rules",
          message: 'the rules are "beings@1", the same as absent, or "beings@2"',
        },
      ]);
    },
  );
});

describe("the laws each version requires", () => {
  test("beings@2 refuses the laws of life@1, and beings@1 those of life@2", () => {
    const two = () =>
      createWorld({
        seed: [1, 2],
        simSecondsPerTick: 12,
        global: beings.beingsGlobal(testGenesis(), beings.defaultLife()),
        chunks: {},
        ruleset: beings.createBeingsRuleset({ controllers: { s1: idler2(1) }, rules: "beings@2" }),
      });
    expect(issuesOf(two).map(({ path }) => path)).toContain("/init/global/life/version");
    const one = () =>
      createWorld({
        seed: [1, 2],
        simSecondsPerTick: 12,
        global: beings.beingsGlobal(testGenesis(), beings.defaultLife2()),
        chunks: {},
        ruleset: beings.createBeingsRuleset({ controllers: { s1: idler(1) } }),
      });
    expect(issuesOf(one).map(({ path }) => path)).toContain("/init/global/life/version");
  });

  test("beingsGlobal seals each version of the laws with its own seal", () => {
    const genesis = testGenesis();
    expect(beings.beingsGlobal(genesis, beings.defaultLife2()).lifeSeal).toBe(
      beings.lifeSeal2(beings.defaultLife2()),
    );
    expect(beings.beingsGlobal(genesis, beings.defaultLife()).lifeSeal).toBe(
      beings.lifeSeal(beings.defaultLife()),
    );
  });
});

/** The rejection of the one command that the step to the next tick of `world` emits. */
function rejectionOf(world: ReturnType<typeof beings2World>, payload: unknown): unknown {
  const tick = readView(world).tick + 1;
  const events = step(world, [spawn(tick, payload as never)]).events;
  const rejected = events.filter((event) => event.type === "engine.command_rejected");
  expect(rejected).toHaveLength(1);
  const found = rejected[0]?.payload as { reason: unknown; details: unknown } | undefined;
  return { reason: found?.reason, details: found?.details };
}

describe("a spawn of beings@2", () => {
  test("makes the being of beings@1 with the six traits, neutral when omitted, and an empty mind", () => {
    const world = beings2World({ controllers: { s1: idler2(60_000) } });
    step(world, [spawn(1, { species: "s1", cell: [5, 5] })]);
    const [being] = beingsOf(world) as beings.Being2[];
    expect(being).toEqual({ ...being2(1, [5, 5], { born: 1 }), mind: mind.newMind(0) });
    expect(being?.traits).toEqual(NEUTRAL_TRAITS);
  });

  test("accepts the six traits within the species' bounds", () => {
    const world = beings2World({ controllers: { s1: idler2(60_000) } });
    const traits = {
      appetite: 800,
      sleepiness: 900,
      curiosity: 1000,
      sociability: 1100,
      credulity: 1200,
      retention: 801,
    };
    step(world, [spawn(1, { species: "s1", cell: [5, 5], traits })]);
    expect((beingOf(world, 1) as beings.Being2).traits).toEqual(traits);
  });

  test("refuses traits of beings@1 alone, a trait out of bounds, and any mental content", () => {
    const world = beings2World({ controllers: { s1: idler2(60_000) } });
    const traits = { appetite: 1000, sleepiness: 1000, curiosity: 1000 };
    expect(rejectionOf(world, { species: "s1", cell: [5, 5], traits })).toEqual({
      reason: "invalid_spawn",
      details: {
        issues: ["credulity", "retention", "sociability"].map((name) => ({
          path: `/traits/${name}`,
          message: "the member is missing",
        })),
      },
    });
    const far = { ...NEUTRAL_TRAITS, retention: 1201 };
    expect(rejectionOf(world, { species: "s1", cell: [5, 5], traits: far })).toEqual({
      reason: "invalid_spawn",
      details: {
        issues: [
          {
            path: "/traits/retention",
            message: "1201 is out of bounds: it must be from 800 to 1200",
          },
        ],
      },
    });
    const mindful = { species: "s1", cell: [5, 5], mind: gateMind() };
    expect(rejectionOf(world, mindful)).toEqual({
      reason: "invalid_spawn",
      details: {
        issues: [
          {
            path: "/mind",
            message: "unknown member: the members here are cell, species, needs, traits",
          },
        ],
      },
    });
    expect(beingsOf(world)).toEqual([]);
  });

  test("dates the quota of its mind by the simulated day of its tick", () => {
    // The test genesis' day lasts 100 ticks: tick 250 lies in day 2.
    const world = beings2World({ controllers: { s1: idler2(60_000) } });
    for (let tick = 1; tick < 250; tick += 1) step(world, []);
    step(world, [spawn(250, { species: "s1", cell: [5, 5] })]);
    expect((beingOf(world, 1) as beings.Being2).mind).toEqual(mind.newMind(2));
  });
});

describe("the capacity of a chunk", () => {
  test("refuses a spawn into a chunk at capacity, also among the spawns of one tick", () => {
    const world = beings2World({
      controllers: { s1: idler2(600_000) },
      life: life2With(undefined, 2),
    });
    const spawns = [
      spawn(1, { species: "s1", cell: [5, 5] }, 0),
      spawn(1, { species: "s1", cell: [6, 5] }, 1),
      spawn(1, { species: "s1", cell: [7, 5] }, 2),
      spawn(1, { species: "s1", cell: [40, 5] }, 3),
    ];
    const { events } = step(world, spawns);
    const rejected = events.filter((event) => event.type === "engine.command_rejected");
    expect(rejected.map(({ payload }) => payload)).toEqual([
      {
        seq: 2,
        type: "beings.spawn",
        origin: { kind: "admin" },
        reason: "invalid_spawn",
        details: {
          issues: [
            { path: "/cell", message: "the chunk of the cell holds its capacity, 2 beings" },
          ],
        },
      },
    ]);
    expect(beingsOf(world).map(({ id, cell }) => [id, chunkOf(cell)])).toEqual([
      [1, "0,0"],
      [2, "0,0"],
      [3, "1,0"],
    ]);
    // A chunk at capacity stays full at the next tick, after its beings decided.
    step(world, []);
    expect(rejectionOf(world, { species: "s1", cell: [8, 8] })).toMatchObject({
      reason: "invalid_spawn",
    });
  });

  test("bounds a chunk of beings@2 by the largest capacity a law allows, 1,024", () => {
    const many = Array.from({ length: 1025 }, (_, index) => being2(index + 1, [index % 32, 0]));
    const value = { beings: many, depletion: [], due: 1 };
    expect(beings.beingsChunkIssues("0,0", value, "beings@2")).toEqual([
      { path: "/beings", message: "the array has 1025 entries: it must have from 0 to 1024" },
    ]);
    expect(
      beings.beingsChunkIssues("0,0", { ...value, beings: many.slice(0, 1024) }, "beings@2"),
    ).toEqual([]);
  });
});

describe("a being of beings@2 in a chunk", () => {
  test("may hold the gate's mind of the support, the 2,680 bytes mind-size.test.ts pins", () => {
    let issues = 0;
    mind.checkMind(gateMind(), "", { report: () => (issues += 1) });
    expect(issues).toBe(0);
    expect(new TextEncoder().encode(canonicalize(gateMind())).length).toBe(2680);
  });

  test("is valid with an empty mind and with the gate's mind", () => {
    expect(beings.beingIssues(being2(1, [0, 0]), "/being", "beings@2")).toEqual([]);
    expect(
      beings.beingIssues(being2(1, [0, 0], { mind: gateMind() }), "/being", "beings@2"),
    ).toEqual([]);
  });

  test("needs its mind and its six traits; beings@1 refuses both", () => {
    const { mind: _held, ...mindless } = being2(1, [0, 0]);
    expect(beings.beingIssues(mindless, "/being", "beings@2")).toEqual([
      { path: "/being/mind", message: "the member is missing" },
    ]);
    const { retention: _r, ...five } = NEUTRAL_TRAITS;
    expect(
      beings.beingIssues({ ...being2(1, [0, 0]), traits: five }, "/being", "beings@2"),
    ).toEqual([{ path: "/being/traits/retention", message: "the member is missing" }]);
    expect(beings.beingIssues(being2(1, [0, 0]), "/being").map(({ path }) => path)).toEqual([
      "/being/mind",
      "/being/traits/credulity",
      "/being/traits/retention",
      "/being/traits/sociability",
    ]);
  });

  test("reports the shape of its mind, then every invariant the mind layer finds", () => {
    const at = (held: unknown) =>
      beings.beingIssues({ ...being2(1, [0, 0]), mind: held }, "/being", "beings@2");
    const gate = gateMind();
    expect(at({ ...gate, next: "999" })).toEqual([
      { path: "/being/mind/next", message: "the value must be an integer, not a string" },
    ]);
    const broken = {
      ...gate,
      beliefs: [{ ...gate.beliefs[0], ev: [990] }, ...gate.beliefs.slice(1)],
    };
    const expected: Issue[] = [];
    mind.checkMind(broken as mind.Mind, "/being/mind", {
      report: (path, message) => expected.push({ path, message }),
    });
    expect(expected.length).toBeGreaterThan(0);
    expect(at(broken)).toEqual(expected);
    const unknownKind = { ...gate, episodes: [{ ...gate.episodes[0], kind: "dream" }] };
    expect(at(unknownKind)).toEqual([
      {
        path: "/being/mind/episodes/0/kind",
        message: "the kind must be one of food, being, ate, failed, heard, external",
      },
    ]);
    const badConcept = {
      ...gate,
      beliefs: [{ ...gate.beliefs[0], p: { p: "Food", a: [{ n: 1 }] } }],
    };
    expect(at(badConcept).map(({ path }) => path)).toEqual(["/being/mind/beliefs/0/p/p"]);
    const extra = { ...gate, episodes: [{ ...gate.episodes[0], who: 3 }] };
    expect(at(extra).map(({ path }) => path)).toEqual(["/being/mind/episodes/0/who"]);
  });

  test("passes the chunk validator of a world under audit, which rejects a broken mind", () => {
    const world = beings2World({
      controllers: { s1: idler2(60_000) },
      chunks: {
        "0,0": { beings: [being2(1, [3, 3], { mind: gateMind() })], depletion: [], due: 1 },
      },
    });
    step(world, []);
    expect((beingOf(world, 1) as beings.Being2).mind).toEqual(gateMind());
    const broken = { ...gateMind(), next: 980 };
    const make = () =>
      beings2World({
        controllers: { s1: idler2(60_000) },
        chunks: { "0,0": { beings: [being2(1, [3, 3], { mind: broken })], depletion: [], due: 1 } },
      });
    expect(issuesOf(make).length).toBeGreaterThan(0);
    expect(issuesOf(make)[0]?.path).toStartWith("/init/chunks/0,0/beings/0/mind/");
  });
});

describe("the brain behaviors of these tests", () => {
  test("name every behavior their brains propose", () => {
    expect([...BEHAVIORS].sort()).toEqual(["eat", "rest", "roam", "sleep", "travel", "x"]);
    expect(SPECIES2.id).toBe(SPECIES.id);
  });
});

/** Every event of `events` of `type`, by payload. */
export function payloadsOf(events: readonly EngineEvent[], type: string): unknown[] {
  return events.filter((event) => event.type === type).map(({ payload }) => payload);
}

describe("beings@1 under the same tests", () => {
  test("keeps spawning into a chunk below 65,536 beings, with no capacity law", () => {
    const world = beingsWorld({ controllers: { s1: idler(600_000) } });
    const spawns = [0, 1, 2].map((seq) => spawn(1, { species: "s1", cell: [5 + seq, 5] }, seq));
    expect(payloadsOf(step(world, spawns).events, "being.spawned")).toHaveLength(3);
  });
});
