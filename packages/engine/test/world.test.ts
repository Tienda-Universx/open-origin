import { describe, expect, test } from "bun:test";
import {
  type CanonicalValue,
  chunkHashes,
  createWorld,
  type EngineErrorCode,
  encodeSnapshot,
  fullChecksum,
  readView,
  snapshotBytes,
  stateRoot,
  versionDifferences,
  World,
  type WorldInit,
  worldStatus,
} from "../src/index.ts";
import { worldState } from "../src/world/world.ts";
import { engineErrorOf } from "./support/engine-error.ts";
import { revokedProxy } from "./support/revoked.ts";
import { rulesetWith, testRuleset } from "./support/rulesets.ts";

/**
 * Worlds (ADR 0020, ownership; plan §2.2, §8 "Aislamiento del host"): createWorld validates and
 * copies its definition, reporting every problem at once; the host's reads return detached
 * copies; and every function rejects a value that is not a world the engine made.
 */

type Init = WorldInit<CanonicalValue, CanonicalValue>;

function definition(): Init {
  return {
    seed: [1, 2],
    simSecondsPerTick: 60,
    global: { population: 3, names: ["Ana", "Zoe"] },
    chunks: { "1,0": { grass: 4 }, "-1,0": { grass: 1 }, "0,0": { grass: [1, 2] } },
    ruleset: testRuleset(),
  };
}

/** `definition()` with `parts` replaced, for definitions a type would reject. */
function definitionWith(parts: Record<string, unknown>): Init {
  // Deliberately ill-typed, as a JavaScript host can be.
  return { ...definition(), ...parts } as unknown as Init;
}

function inputIssues(action: () => unknown) {
  const error = engineErrorOf(action);
  expect(error.code).toBe("invalid_input");
  return error.issues;
}

/** Every digest of `world`, to compare before and after. */
const digests = (world: World) => ({
  root: stateRoot(world),
  full: fullChecksum(world),
  chunks: chunkHashes(world),
});

describe("createWorld", () => {
  test("starts at epoch 0, tick 0, and entity id 1, with the definition's data", () => {
    const world = createWorld(definition());
    expect(worldStatus(world)).toEqual({ kind: "ok", tick: 0 });
    const view = readView(world);
    expect(view.tick).toBe(0);
    expect(view.chunkKeys()).toEqual(["-1,0", "0,0", "1,0"]);
    expect(view.readChunk("0,0")).toEqual({ grass: [1, 2] });
    expect(view.readGlobal()).toEqual({ population: 3, names: ["Ana", "Zoe"] });
    const { kernel, header, audit } = worldState(world);
    expect({ ...kernel, rng: { ...kernel.rng }, config: { ...kernel.config } }).toEqual({
      epoch: 0,
      tick: 0,
      nextEntityId: 1,
      rng: { algorithm: "ctr-mix32@1", seed: [1, 2] },
      config: { simSecondsPerTick: 60 },
    });
    expect({ ...header }).toEqual({
      engineVersion: "0.1.0",
      rulesetVersion: "test@1",
      generatorVersion: "flat@1",
      brainVersion: "none@1",
    });
    expect(audit).toBe(false);
  });

  test("takes audit from the options", () => {
    expect(worldState(createWorld(definition(), { audit: true })).audit).toBe(true);
    expect(worldState(createWorld(definition(), {})).audit).toBe(false);
  });

  test("accepts a world without chunks", () => {
    const world = createWorld(definitionWith({ chunks: {} }));
    expect(readView(world).chunkKeys()).toEqual([]);
    expect(stateRoot(world)).toBe(fullChecksum(world));
  });
});

describe("createWorld reports every problem in one invalid_input", () => {
  test("in the seed, the seconds per tick, the data, the validators, and the options", () => {
    const ruleset = rulesetWith({
      validateGlobal: (global: { population: number }) =>
        global.population < 0
          ? [{ path: "/population", message: "the population is negative" }]
          : [],
      validateChunk: (key: string, chunk: { grass: number }) =>
        chunk.grass > 100 ? [{ path: "/grass", message: `too much grass in ${key}` }] : [],
    });
    const init = definitionWith({
      seed: [1, -1],
      simSecondsPerTick: 0,
      global: { population: -1 },
      chunks: {
        "01,0": { grass: 1 },
        "0,0": { grass: Number.NaN },
        "1,1": { grass: 101 },
        "2,2": { grass: 1 },
      },
      ruleset,
    });
    // Deliberately ill-typed, as a JavaScript host can be.
    const options = { audit: "yes" } as unknown as { audit: boolean };
    expect(inputIssues(() => createWorld(init, options))).toEqual([
      { path: "/init/seed/1", message: "-1 is not an integer in [0, 4294967295]" },
      {
        path: "/init/simSecondsPerTick",
        message: "0 seconds per tick is not a positive safe integer",
      },
      { path: "/init/global/population", message: "the population is negative" },
      { path: "/init/chunks/0,0/grass", message: "NaN is not a safe integer" },
      {
        path: "/init/chunks/01,0",
        message: "the x of the chunk key is not a safe integer in canonical decimal",
      },
      { path: "/init/chunks/1,1/grass", message: "too much grass in 1,1" },
      { path: "/options/audit", message: "audit must be a boolean, not string" },
    ]);
  });

  test("for a seed that is not two words and data that is missing", () => {
    const init = definitionWith({ seed: [1], simSecondsPerTick: undefined, global: undefined });
    expect(inputIssues(() => createWorld(init))).toEqual([
      { path: "/init/seed", message: "the seed must be an array of two words" },
      {
        path: "/init/simSecondsPerTick",
        message: "a value of type undefined seconds per tick is not a positive safe integer",
      },
      { path: "/init/global", message: "undefined is not a canonical type" },
    ]);
  });

  test("for chunks that are not a plain record", () => {
    const notRecord = "the chunks must be a record of chunks by chunk key";
    for (const chunks of [[], 7, new Map(), Object.create({ "0,0": 1 })]) {
      expect(inputIssues(() => createWorld(definitionWith({ chunks })))).toEqual([
        { path: "/init/chunks", message: notRecord },
      ]);
    }
    const symbols = { "0,0": 1, [Symbol("x")]: 2 };
    expect(inputIssues(() => createWorld(definitionWith({ chunks: symbols })))).toEqual([
      { path: "/init/chunks", message: "the object has symbol keys (1): keys must be strings" },
    ]);
  });

  test("for options that are not a record", () => {
    // Deliberately ill-typed, as a JavaScript host can be.
    const options = 1 as unknown as { audit: boolean };
    expect(inputIssues(() => createWorld(definition(), options))).toEqual([
      { path: "/options", message: "the options must be a record" },
    ]);
  });

  test("for a definition that is not a record, alone", () => {
    // Deliberately ill-typed, as a JavaScript host can be.
    const init = null as unknown as Init;
    expect(inputIssues(() => createWorld(init, { audit: 1 as unknown as boolean }))).toEqual([
      { path: "/init", message: "the world definition must be a record" },
    ]);
  });

  test("for an accessor in the definition, without running it", () => {
    let calls = 0;
    const init = Object.defineProperty(definition(), "global", {
      get: () => {
        calls += 1;
        return 1;
      },
    });
    expect(inputIssues(() => createWorld(init))).toEqual([
      {
        path: "/init/global",
        message: "the property is an accessor: only data properties are read",
      },
    ]);
    expect(calls).toBe(0);
  });
});

describe("createWorld reports an object that throws while read, with its cause", () => {
  const THREW = "the object threw while being read: TypeError";

  test.each<[string, () => unknown, EngineErrorCode, string]>([
    ["the definition", () => createWorld(revokedProxy() as Init), "invalid_input", "/init"],
    [
      "the options",
      () => createWorld(definition(), revokedProxy() as { audit: boolean }),
      "invalid_input",
      "/options",
    ],
    [
      "the ruleset",
      () => createWorld(definitionWith({ ruleset: revokedProxy() })),
      "invalid_ruleset",
      "",
    ],
    [
      "the chunks",
      () => createWorld(definitionWith({ chunks: revokedProxy() })),
      "invalid_input",
      "/init/chunks",
    ],
    [
      "a chunk",
      () => createWorld(definitionWith({ chunks: { "0,0": revokedProxy() } })),
      "invalid_input",
      "/init/chunks/0,0",
    ],
    [
      "the global value",
      () => createWorld(definitionWith({ global: revokedProxy() })),
      "invalid_input",
      "/init/global",
    ],
    [
      "the seed",
      () => createWorld(definitionWith({ seed: revokedProxy() })),
      "invalid_input",
      "/init/seed",
    ],
  ])("%s", (_name, action, code, path) => {
    const error = engineErrorOf(action);
    expect(error.code).toBe(code);
    expect(error.issues.map((issue) => issue.path)).toEqual([path]);
    expect(error.issues[0]?.message).toStartWith(THREW);
    expect(error.cause).toBeInstanceOf(TypeError);
  });
});

describe("createWorld rejects members that canonical records reject", () => {
  test("a chunk that is not enumerable", () => {
    const chunks = Object.defineProperty({ "0,0": 1 }, "1,0", { value: 2, enumerable: false });
    expect(inputIssues(() => createWorld(definitionWith({ chunks })))).toEqual([
      {
        path: "/init/chunks/1,0",
        message: "the property is not enumerable: only enumerable data properties are read",
      },
    ]);
  });

  test("escapes chunk keys in issue paths, as JSON Pointers require", () => {
    const chunks = { "a/b": 1, "x~1,0": 2 };
    expect(inputIssues(() => createWorld(definitionWith({ chunks })))).toEqual([
      {
        path: "/init/chunks/a~1b",
        message: 'the chunk key must be two integers joined by one comma, as in "-1,0"',
      },
      {
        path: "/init/chunks/x~01,0",
        message: "the x of the chunk key is not a safe integer in canonical decimal",
      },
    ]);
  });
});

describe("createWorld and the ruleset", () => {
  test("a broken ruleset is reported first, as invalid_ruleset", () => {
    const ruleset = rulesetWith({ validateChunk: undefined });
    const error = engineErrorOf(() => createWorld(definitionWith({ ruleset, seed: [] })));
    expect(error.code).toBe("invalid_ruleset");
    expect(error.issues).toEqual([
      { path: "/validateChunk", message: "validateChunk must be a function, not undefined" },
    ]);
  });

  test("a ruleset that cannot be read is invalid_input", () => {
    const init = Object.defineProperty(definition(), "ruleset", { get: testRuleset });
    expect(inputIssues(() => createWorld(init))).toEqual([
      {
        path: "/init/ruleset",
        message: "the property is an accessor: only data properties are read",
      },
    ]);
  });

  test("a validator that throws is an issue at its value, with the thrown value as the cause", () => {
    const boom = new Error("boom");
    const ruleset = rulesetWith({
      validateGlobal: () => {
        throw boom;
      },
    });
    const error = engineErrorOf(() => createWorld(definitionWith({ ruleset })));
    expect(error.issues).toEqual([
      { path: "/init/global", message: "validateGlobal threw: Error: boom" },
    ]);
    expect(error.cause).toBe(boom);
  });

  test.each([
    ["not a list", 7],
    ["a list with a path that is not a JSON Pointer", [{ path: "grass", message: "x" }]],
    ["a list with a message that is not a string", [{ path: "", message: 1 }]],
    ["a list with something that is not canonical", [{ path: "", message: "x", extra: null }]],
  ])("a validator that returns %s is one issue at its value", (_name, result) => {
    const ruleset = rulesetWith({ validateChunk: () => result });
    expect(
      inputIssues(() => createWorld(definitionWith({ ruleset, chunks: { "0,0": 1 } }))),
    ).toEqual([
      {
        path: "/init/chunks/0,0",
        message:
          "validateChunk must return a list of issues, each a record { path, message } of strings",
      },
    ]);
  });

  test("validators run without a receiver, so they cannot reach the captured ruleset", () => {
    const receivers: unknown[] = [];
    const ruleset = rulesetWith({
      validateGlobal(this: unknown) {
        receivers.push(this);
        return [];
      },
      validateChunk(this: unknown) {
        receivers.push(this);
        return [];
      },
    });
    createWorld(definitionWith({ ruleset }));
    expect(receivers).toEqual([undefined, undefined, undefined, undefined]);
  });

  test("validators see the copies the world keeps, each chunk with its key", () => {
    const seen: unknown[] = [];
    const ruleset = rulesetWith({
      validateGlobal: (global: unknown) => {
        seen.push(global);
        return [];
      },
      validateChunk: (key: string, chunk: unknown) => {
        seen.push([key, chunk]);
        return [];
      },
    });
    const init = definitionWith({ ruleset });
    createWorld(init);
    expect(seen).toEqual([
      init.global,
      ["-1,0", { grass: 1 }],
      ["0,0", { grass: [1, 2] }],
      ["1,0", { grass: 4 }],
    ]);
    expect(seen[0]).not.toBe(init.global);
  });
});

describe("validators receive the values the world keeps: a change is detected, not prevented", () => {
  test("a validateChunk that changes its chunk leaves a root that fullChecksum disagrees with", () => {
    const ruleset = rulesetWith({
      validateChunk: (_key: string, chunk: { grass: unknown }) => {
        chunk.grass = 0;
        return [];
      },
    });
    const world = createWorld(definitionWith({ ruleset }));
    expect(readView(world).readChunk("1,0")).toEqual({ grass: 0 });
    expect(fullChecksum(world)).not.toBe(stateRoot(world));
  });

  test("so does a validateGlobal that changes the global value", () => {
    const ruleset = rulesetWith({
      validateGlobal: (global: { population: number }) => {
        global.population += 1;
        return [];
      },
    });
    const world = createWorld(definitionWith({ ruleset }));
    expect(readView(world).readGlobal()).toEqual({ population: 4, names: ["Ana", "Zoe"] });
    expect(fullChecksum(world)).not.toBe(stateRoot(world));
  });

  test("and a validator that keeps its value and changes it after createWorld", () => {
    let kept: { population: number } | undefined;
    const ruleset = rulesetWith({
      validateGlobal: (global: { population: number }) => {
        kept = global;
        return [];
      },
    });
    const world = createWorld(definitionWith({ ruleset }));
    expect(fullChecksum(world)).toBe(stateRoot(world));
    if (kept === undefined) throw new Error("validateGlobal did not run");
    kept.population = 7;
    expect(fullChecksum(world)).not.toBe(stateRoot(world));
  });
});

describe("createWorld reports each member that is not enumerable once", () => {
  const NOT_ENUMERABLE = "the property is not enumerable: only enumerable data properties are read";

  test.each(["ruleset", "seed", "simSecondsPerTick", "global", "chunks"])(
    "/init/%s, and no second issue for the value it did not read",
    (key) => {
      const init = Object.defineProperty(definition(), key, { enumerable: false });
      expect(inputIssues(() => createWorld(init))).toEqual([
        { path: `/init/${key}`, message: NOT_ENUMERABLE },
      ]);
    },
  );

  test("/options/audit", () => {
    const options = Object.defineProperty({}, "audit", { value: true, enumerable: false });
    expect(inputIssues(() => createWorld(definition(), options))).toEqual([
      { path: "/options/audit", message: NOT_ENUMERABLE },
    ]);
  });
});

describe("the host never holds live state", () => {
  test("changing the definition after createWorld changes nothing", () => {
    const init = definition();
    const world = createWorld(init);
    const before = digests(world);
    // The host's own objects, which it may change however it likes.
    const mutable = init as unknown as {
      seed: number[];
      simSecondsPerTick: number;
      global: { population: number; names: string[] };
      chunks: Record<string, { grass: unknown }>;
    };
    mutable.seed[0] = 9;
    mutable.simSecondsPerTick = 1;
    mutable.global.population = 99;
    mutable.global.names.push("Eve");
    (mutable.chunks["0,0"] as { grass: number[] }).grass.push(3);
    mutable.chunks["5,5"] = { grass: 0 };
    delete mutable.chunks["1,0"];
    expect(digests(world)).toEqual(before);
    expect(readView(world).readGlobal()).toEqual({ population: 3, names: ["Ana", "Zoe"] });
    expect(readView(world).chunkKeys()).toEqual(["-1,0", "0,0", "1,0"]);
  });

  test("changing the ruleset after createWorld changes nothing", () => {
    const init = definition();
    const world = createWorld(init);
    const before = digests(world);
    const ruleset = init.ruleset as unknown as {
      versions: Record<string, string>;
      systems: unknown[];
      commands: Record<string, unknown>;
      validateChunk: unknown;
    };
    ruleset.versions.ruleset = "other@2";
    ruleset.systems.length = 0;
    ruleset.commands.dig = {};
    ruleset.validateChunk = () => [{ path: "", message: "late" }];
    expect(digests(world)).toEqual(before);
    expect(worldState(world).header.rulesetVersion).toBe("test@1");
    expect(worldState(world).ruleset.systems.map(({ name }) => name)).toEqual([
      "growth",
      "weather",
    ]);
  });

  test("changing what readView returned changes nothing", () => {
    const world = createWorld(definition());
    const before = digests(world);
    const view = readView(world);
    const keys = view.chunkKeys();
    keys.reverse();
    keys.push("9,9");
    const chunk = view.readChunk("0,0") as { grass: number[] };
    chunk.grass.push(3);
    const global = view.readGlobal() as { population: number; names: string[] };
    global.population = 0;
    global.names.length = 0;
    expect(digests(world)).toEqual(before);
    expect(view.chunkKeys()).toEqual(["-1,0", "0,0", "1,0"]);
    expect(view.readChunk("0,0")).toEqual({ grass: [1, 2] });
    expect(view.readGlobal()).toEqual({ population: 3, names: ["Ana", "Zoe"] });
    expect(view.readChunk("0,0")).not.toBe(view.readChunk("0,0"));
  });

  test("changing what worldStatus and chunkHashes returned changes nothing", () => {
    const world = createWorld(definition());
    const before = digests(world);
    const status = worldStatus(world) as { tick: number };
    status.tick = 5;
    const hashes = chunkHashes(world);
    hashes["0,0"] = "0".repeat(32);
    expect(digests(world)).toEqual(before);
    expect(worldStatus(world)).toEqual({ kind: "ok", tick: 0 });
  });
});

describe("readView", () => {
  test("returns undefined for a chunk key without a chunk", () => {
    expect(readView(createWorld(definition())).readChunk("7,7")).toBeUndefined();
  });

  test("rejects a key that is not a chunk key, with invalid_value", () => {
    const view = readView(createWorld(definition()));
    const error = engineErrorOf(() => view.readChunk("00,0"));
    expect(error.code).toBe("invalid_value");
    expect(error.issues).toEqual([
      { path: "", message: "the x of the chunk key is not a safe integer in canonical decimal" },
    ]);
  });
});

describe("a value that is not a world the engine made", () => {
  const world = createWorld(definition());
  const throwing = new Proxy(world, {
    get: () => {
      throw new Error("a trap ran");
    },
    has: () => {
      throw new Error("a trap ran");
    },
    getPrototypeOf: () => {
      throw new Error("a trap ran");
    },
  });
  const forgeries: [string, unknown][] = [
    ["a plain record", {}],
    ["null", null],
    ["a number", 7],
    ["a Proxy of a world, whose traps throw", throwing],
    ["an object whose prototype is a world", Object.create(world)],
    ["a revoked Proxy", revokedProxy()],
  ];
  const calls: [string, (value: never) => unknown][] = [
    ["worldStatus", worldStatus],
    ["readView", readView],
    ["stateRoot", stateRoot],
    ["fullChecksum", fullChecksum],
    ["chunkHashes", chunkHashes],
    ["encodeSnapshot", encodeSnapshot],
    ["snapshotBytes", snapshotBytes],
    ["versionDifferences", versionDifferences],
  ];

  test.each(forgeries)("%s is rejected by every function with invalid_input", (_name, forged) => {
    for (const [, call] of calls) {
      expect(inputIssues(() => call(forged as never))).toEqual([
        { path: "", message: "the value is not a world: worlds are made by createWorld" },
      ]);
    }
    expect(World.isWorld(forged)).toBe(false);
  });

  test("a world is a world", () => {
    expect(World.isWorld(world)).toBe(true);
  });

  test("the World constructor, reached through .constructor, makes no world", () => {
    const Constructor = Object.getPrototypeOf(world).constructor as new (
      key: symbol,
      state: object,
    ) => World;
    expect(inputIssues(() => new Constructor(Symbol("World"), {}))).toEqual([
      { path: "", message: "worlds are made by createWorld, not by the World constructor" },
    ]);
  });
});
