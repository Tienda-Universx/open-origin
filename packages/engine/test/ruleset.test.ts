import { describe, expect, test } from "bun:test";
import { murmur3x86_32 } from "../src/digest/murmur3.ts";
import { streamId } from "../src/index.ts";
import { type CapturedRuleset, captureRuleset } from "../src/world/ruleset.ts";
import { engineErrorOf } from "./support/engine-error.ts";
import { revokedProxy } from "./support/revoked.ts";
import { rulesetWith, type TestRuleset, testRuleset } from "./support/rulesets.ts";

/**
 * Capturing a ruleset (ADR 0020, kernel and ruleset; plan §2.2): captureRuleset validates the
 * ruleset and copies its lists and records into structures of its own, keeping its functions as
 * references, and reports every problem at once as invalid_ruleset.
 */

const noop = () => undefined;
const reserved = (what: string) =>
  `${what} starts with "engine.", which is reserved for the kernel`;

/** The data of a captured ruleset, without its functions. */
function shape(captured: CapturedRuleset) {
  return {
    versions: { ...captured.versions },
    systems: captured.systems.map(({ name, streams }) => ({ name, streams: { ...streams } })),
    commandTypes: [...captured.commandTypes],
    commands: captured.commandTypes.map((type) => {
      const handler = captured.commands[type];
      return { type: handler?.type, streams: { ...handler?.streams } };
    }),
  };
}

function rulesetIssues(ruleset: unknown) {
  const error = engineErrorOf(() => captureRuleset(ruleset));
  expect(error.code).toBe("invalid_ruleset");
  return error.issues;
}

describe("captureRuleset", () => {
  test("captures the versions, the systems in order, and the commands by type, sorted", () => {
    expect(shape(captureRuleset(testRuleset()))).toEqual({
      versions: { ruleset: "test@1", generator: "flat@1", brain: "none@1" },
      systems: [
        { name: "growth", streams: { growth: streamId("growth") } },
        {
          name: "weather",
          streams: {
            "weather.rain": streamId("weather.rain"),
            "weather.wind": streamId("weather.wind"),
          },
        },
      ],
      commandTypes: ["move", "say"],
      commands: [
        { type: "move", streams: { conflicts: streamId("conflicts") } },
        { type: "say", streams: {} },
      ],
    });
  });

  test("keeps the functions as references", () => {
    const ruleset = testRuleset();
    const captured = captureRuleset(ruleset);
    expect(captured.systems[1]?.run).toBe(ruleset.systems[1]?.run);
    expect(captured.commands.move?.check).toBe(ruleset.commands.move?.check);
    expect(captured.commands.move?.apply).toBe(ruleset.commands.move?.apply);
    expect(captured.validateGlobal).toBe(ruleset.validateGlobal);
    expect(captured.validateChunk).toBe(ruleset.validateChunk);
  });

  test("copies everything else, so changing the ruleset afterwards changes nothing", () => {
    const ruleset = testRuleset();
    const captured = captureRuleset(ruleset);
    const before = shape(captured);
    const systems = ruleset.systems as { name: string; streams: string[]; run: unknown }[];
    const commands = ruleset.commands as Record<string, unknown>;
    const versions = ruleset.versions as { ruleset: string };
    versions.ruleset = "other@2";
    systems.push({ name: "late", streams: ["late"], run: noop });
    systems[0] = { name: "replaced", streams: [], run: noop };
    (systems[1] as { streams: string[] }).streams.push("weather.snow");
    commands.dig = { check: noop, apply: noop };
    delete commands.say;
    (commands.move as Record<string, unknown>).apply = noop;
    expect(shape(captured)).toEqual(before);
    expect(captured.commands.move?.apply).not.toBe(noop);
  });

  test("enumerates the commands in canonical order, whatever their insertion order", () => {
    const say = testRuleset().commands.say;
    const commands = { b: say, a: say };
    expect(captureRuleset(rulesetWith({ commands })).commandTypes).toEqual(["a", "b"]);
  });

  test("gives the captured records no prototype, so no type reaches an inherited property", () => {
    const captured = captureRuleset(testRuleset());
    for (const name of ["constructor", "toString", "__proto__"]) {
      expect(captured.commands[name]).toBeUndefined();
    }
  });
});

describe("captureRuleset reports every problem at once", () => {
  test("in the versions, the systems, the commands, and the validators", () => {
    const ruleset = {
      versions: { ruleset: "", generator: "Cafe\u0301", brain: 1, extra: "x" },
      systems: [
        { name: "growth", streams: ["growth", ""], run: noop },
        { name: "growth", streams: [7], run: "run" },
        { name: "", streams: "growth", run: noop },
      ],
      commands: {
        "": { check: noop, apply: noop },
        "engine.tick": { check: noop, apply: noop },
        move: { streams: ["engine.rng"], check: 1, apply: undefined },
        say: "handler",
      },
      validateGlobal: undefined,
      validateChunk: {},
    };
    expect(rulesetIssues(ruleset)).toEqual([
      { path: "/versions/brain", message: "the version must be a string, not number" },
      {
        path: "/versions/extra",
        message: "not a version: the versions are ruleset, generator, and brain",
      },
      {
        path: "/versions/generator",
        message: "the string is not in Unicode Normalization Form C (NFC)",
      },
      { path: "/versions/ruleset", message: "the version must not be empty" },
      { path: "/systems/0/streams/1", message: "the stream name must not be empty" },
      {
        path: "/systems/1/name",
        message: 'the system "growth" is declared twice: system names must be unique',
      },
      { path: "/systems/1/streams/0", message: "the stream name must be a string, not number" },
      { path: "/systems/1/run", message: "run must be a function, not string" },
      { path: "/systems/2/name", message: "the system name must not be empty" },
      { path: "/systems/2/streams", message: "the streams must be an array of names" },
      { path: "/commands/", message: "the command type must not be empty" },
      { path: "/commands/engine.tick", message: reserved("the command type") },
      { path: "/commands/move/streams/0", message: reserved("the stream name") },
      { path: "/commands/move/check", message: "check must be a function, not number" },
      { path: "/commands/move/apply", message: "apply must be a function, not undefined" },
      { path: "/commands/say", message: "a command handler must be a record" },
      { path: "/validateGlobal", message: "validateGlobal must be a function, not undefined" },
      { path: "/validateChunk", message: "validateChunk must be a function, not object" },
    ]);
  });

  test("for a ruleset that is not a record, and for parts of the wrong kind", () => {
    expect(rulesetIssues(null)).toEqual([{ path: "", message: "the ruleset must be a record" }]);
    const parts = { versions: [], systems: {}, commands: [] };
    expect(rulesetIssues(rulesetWith(parts))).toEqual([
      { path: "/versions", message: "the versions must be a record of strings" },
      { path: "/systems", message: "the systems must be an array" },
      { path: "/commands", message: "the commands must be a record of handlers" },
    ]);
  });
});

describe("captureRuleset gives each stream one owner", () => {
  const system = (name: string, streams: string[]) => ({ name, streams, run: noop });
  const handler = (streams?: string[]) => ({ streams, check: noop, apply: noop });

  test("rejects a stream shared by two systems, or by a system and a command", () => {
    const ruleset = rulesetWith({
      systems: [system("a", ["rain"]), system("b", ["rain", "wind"])],
      commands: { dig: handler(["wind"]) },
    });
    expect(rulesetIssues(ruleset)).toEqual([
      {
        path: "/systems/1/streams/0",
        message:
          'the stream "rain" already belongs to system "a" at /systems/0: a stream has one owner',
      },
      {
        path: "/commands/dig/streams/0",
        message:
          'the stream "wind" already belongs to system "b" at /systems/1: a stream has one owner',
      },
    ]);
  });

  test("tells apart two systems with the same name that share a stream", () => {
    const ruleset = rulesetWith({ systems: [system("a", ["rain"]), system("a", ["rain"])] });
    expect(rulesetIssues(ruleset)).toEqual([
      {
        path: "/systems/1/name",
        message: 'the system "a" is declared twice: system names must be unique',
      },
      {
        path: "/systems/1/streams/0",
        message:
          'the stream "rain" already belongs to system "a" at /systems/0: a stream has one owner',
      },
    ]);
  });

  test("rejects a stream declared twice by one owner", () => {
    const ruleset = rulesetWith({ systems: [], commands: { dig: handler(["rain", "rain"]) } });
    expect(rulesetIssues(ruleset)).toEqual([
      {
        path: "/commands/dig/streams/1",
        message: 'command "dig" declares the stream "rain" twice',
      },
    ]);
  });

  test("rejects the reserved prefix in stream names only at the start", () => {
    const ruleset = rulesetWith({ systems: [system("a", ["engine.", "my.engine.x"])] });
    expect(rulesetIssues(ruleset)).toEqual([
      { path: "/systems/0/streams/0", message: reserved("the stream name") },
    ]);
  });

  test("rejects two names with the same stream id", () => {
    // Found by hashing "rain.0", "rain.1", ... in order until two names shared an id: these are
    // the first such pair, and the id is MurmurHash3 x86_32 of each name with seed 0.
    const [first, second] = ["rain.114406", "rain.155046"];
    const encoder = new TextEncoder();
    expect([streamId(first), streamId(second)]).toEqual([3416425785, 3416425785]);
    expect(murmur3x86_32(encoder.encode(second), 0)).toBe(3416425785);
    const ruleset = rulesetWith({ systems: [system("a", [first]), system("b", [second])] });
    expect(rulesetIssues(ruleset)).toEqual([
      {
        path: "/systems/1/streams/0",
        message:
          'the stream "rain.155046" has the id 3416425785 of the stream "rain.114406": rename one',
      },
    ]);
  });
});

describe("captureRuleset reads each member once, through its descriptor", () => {
  test("rejects an accessor without running it", () => {
    let calls = 0;
    const ruleset: TestRuleset = Object.defineProperty(testRuleset(), "validateChunk", {
      get: () => {
        calls += 1;
        return noop;
      },
      enumerable: true,
    });
    expect(rulesetIssues(ruleset)).toEqual([
      {
        path: "/validateChunk",
        message: "the property is an accessor: only data properties are read",
      },
    ]);
    expect(calls).toBe(0);
  });

  test("reports a Proxy that throws, with the thrown value as the cause", () => {
    const boom = new Error("boom");
    const systems = new Proxy([], {
      getOwnPropertyDescriptor: () => {
        throw boom;
      },
    });
    const error = engineErrorOf(() => captureRuleset(rulesetWith({ systems })));
    expect(error.issues).toEqual([
      { path: "/systems", message: "the object threw while being read: Error: boom" },
    ]);
    expect(error.cause).toBe(boom);
  });

  test("rejects a sparse list without walking its length", () => {
    const systems: unknown[] = [];
    systems.length = 0xffffffff;
    expect(rulesetIssues(rulesetWith({ systems }))).toEqual([
      {
        path: "/systems",
        message:
          "the array is sparse: its length is 4294967295, but it has only 0 other own properties",
      },
    ]);
  });
});

describe("captureRuleset reports every missing version", () => {
  test("each at its own path", () => {
    const ruleset = rulesetWith({ versions: { ruleset: "test@1" } });
    expect(rulesetIssues(ruleset)).toEqual([
      { path: "/versions/brain", message: "the version is missing" },
      { path: "/versions/generator", message: "the version is missing" },
    ]);
    expect(rulesetIssues(rulesetWith({ versions: {} })).map(({ path }) => path)).toEqual([
      "/versions/brain",
      "/versions/generator",
      "/versions/ruleset",
    ]);
  });
});

describe("captureRuleset reads its records as canonical records are read", () => {
  const handler = { check: noop, apply: noop };
  const NOT_ENUMERABLE = "the property is not enumerable: only enumerable data properties are read";

  test("rejects commands and versions that are class instances", () => {
    class Commands {
      dig = handler;
    }
    class Versions {
      ruleset = "r";
      generator = "g";
      brain = "b";
    }
    expect(
      rulesetIssues(rulesetWith({ commands: new Commands(), versions: new Versions() })),
    ).toEqual([
      { path: "/versions", message: "the versions must be a record of strings" },
      { path: "/commands", message: "the commands must be a record of handlers" },
    ]);
  });

  test("reports symbol keys and keys that are not enumerable", () => {
    const commands = Object.defineProperty({ [Symbol("dig")]: handler }, "hide", {
      value: handler,
      enumerable: false,
    });
    expect(rulesetIssues(rulesetWith({ commands }))).toEqual([
      { path: "/commands", message: "the object has symbol keys (1): keys must be strings" },
      { path: "/commands/hide", message: NOT_ENUMERABLE },
    ]);
  });

  test("escapes command types in issue paths, as JSON Pointers require", () => {
    expect(rulesetIssues(rulesetWith({ commands: { "a/b~c": 1 } }))).toEqual([
      { path: "/commands/a~1b~0c", message: "a command handler must be a record" },
    ]);
  });
});

describe("captureRuleset reports an object that throws while read, with its cause", () => {
  test.each<[string, unknown, string]>([
    ["the ruleset", revokedProxy(), ""],
    ["the versions", rulesetWith({ versions: revokedProxy() }), "/versions"],
    ["the systems", rulesetWith({ systems: revokedProxy() }), "/systems"],
    ["a system", rulesetWith({ systems: [revokedProxy()] }), "/systems/0"],
    ["the commands", rulesetWith({ commands: revokedProxy() }), "/commands"],
    ["a handler", rulesetWith({ commands: { dig: revokedProxy() } }), "/commands/dig"],
    [
      "a list of streams",
      rulesetWith({ commands: { dig: { streams: revokedProxy(), check: noop, apply: noop } } }),
      "/commands/dig/streams",
    ],
  ])("%s", (_name, ruleset, path) => {
    const error = engineErrorOf(() => captureRuleset(ruleset));
    expect(error.code).toBe("invalid_ruleset");
    expect(error.issues.map((issue) => issue.path)).toEqual([path]);
    expect(error.issues[0]?.message).toStartWith("the object threw while being read: TypeError");
    expect(error.cause).toBeInstanceOf(TypeError);
  });
});
