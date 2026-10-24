import { describe, expect, test } from "bun:test";
import {
  type Command,
  chunkHashes,
  type EngineErrorCode,
  encodeSnapshot,
  fullChecksum,
  type Issue,
  type ReadView,
  readView,
  snapshotBytes,
  stateRoot,
  step,
  versionDifferences,
  type World,
  worldStatus,
} from "../src/index.ts";
import { worldState } from "../src/world/world.ts";
import { BARRIER_ROWS } from "./support/barrier-rulesets.ts";
import { engineErrorOf } from "./support/engine-error.ts";
import {
  type Ctx,
  command,
  type Data,
  type Handler,
  handler,
  type StepRuleset,
  stepRuleset,
  stepWorld,
  system,
  type Value,
  writing,
} from "./support/step-rulesets.ts";

/**
 * Faults (ADR 0020, failures; plan §2.3, §8 "Fallas", "Barrera"): anything that fails after a tick
 * began to change the world poisons it. Its events are discarded, step throws, every function
 * but worldStatus throws world_faulted, and worldStatus gives the diagnosis. Writes that bypass
 * the barrier are detected by audit at the tick they happen.
 */

const MAX = Number.MAX_SAFE_INTEGER;
const BOOM = "Error: boom";
const NOT_PLAIN =
  "the object is not a plain array or record: a record's prototype must be Object.prototype or null";
const RETURNED = "returned a value of type object: systems and handlers must return undefined";

const boom = (): never => {
  throw new Error("boom");
};

/** A handler that throws from `check` or from `apply`. */
const throwing = (where: "check" | "apply"): Handler =>
  where === "check"
    ? { check: boom, apply: () => undefined }
    : { check: () => undefined, apply: boom };

/** Three systems; the one at `index` throws at tick `at`. */
function systemsThrowingAt(index: number, at: number): StepRuleset {
  const names = ["first", "middle", "last"];
  return stepRuleset(
    names.map((name, position) =>
      system(name, (ctx) => {
        ctx.emit("ran", name);
        if (position === index && ctx.tick === at) boom();
      }),
    ),
  );
}

type FaultCase = {
  readonly name: string;
  readonly ruleset: (at: number) => StepRuleset;
  /** The commands of the tick `tick`; none unless given. */
  readonly commands?: (tick: number, at: number) => Command[];
  readonly prepare?: (world: World, at: number) => void;
  readonly code: EngineErrorCode;
  readonly issues: readonly Issue[];
};

/** The commands of tick `at`: ok commands, with "boom" at the positions in `booms`. */
const commandsWithBoomAt =
  (booms: readonly number[], count: number) =>
  (tick: number, at: number): Command[] =>
    tick !== at
      ? []
      : Array.from({ length: count }, (_, seq) =>
          command(tick, seq, booms.includes(seq) ? "boom" : "ok"),
        );

const okHandler = handler((ctx) => ctx.emit("ok", 1));

const FAULTS: readonly FaultCase[] = [
  {
    name: "check throws",
    ruleset: () => stepRuleset([], { boom: throwing("check"), ok: okHandler }),
    commands: commandsWithBoomAt([0], 1),
    code: "system_fault",
    issues: [{ path: "/commands/0", message: `command 0 ("boom"): check threw: ${BOOM}` }],
  },
  {
    name: "apply throws in the first command",
    ruleset: () => stepRuleset([], { boom: throwing("apply"), ok: okHandler }),
    commands: commandsWithBoomAt([0], 3),
    code: "system_fault",
    issues: [{ path: "/commands/0", message: `command 0 ("boom"): apply threw: ${BOOM}` }],
  },
  {
    name: "apply throws in the last command",
    ruleset: () => stepRuleset([], { boom: throwing("apply"), ok: okHandler }),
    commands: commandsWithBoomAt([2], 3),
    code: "system_fault",
    issues: [{ path: "/commands/2", message: `command 2 ("boom"): apply threw: ${BOOM}` }],
  },
  ...["first", "middle", "last"].map(
    (name, index): FaultCase => ({
      name: `the ${name} system throws`,
      ruleset: (at) => systemsThrowingAt(index, at),
      code: "system_fault",
      issues: [{ path: `/systems/${index}`, message: `system "${name}": run threw: ${BOOM}` }],
    }),
  ),
  {
    name: "validateChunk rejects a chunk at commit",
    ruleset: (at) => ({
      ...writing(at, 101),
      validateChunk: (_key, chunk) =>
        (chunk as Data).grass === 101 ? [{ path: "/grass", message: "too much grass" }] : [],
    }),
    code: "system_fault",
    issues: [{ path: "/chunks/0,0/grass", message: "too much grass" }],
  },
  ...(
    [
      ["NaN", Number.NaN, "NaN is not a safe integer"],
      ["1.5", 1.5, "1.5 is not a safe integer"],
      ["undefined", undefined, "undefined is not a canonical type"],
      ["a Map", new Map(), NOT_PLAIN],
      ["-0", -0, "-0 is not canonical: use 0"],
    ] as const
  ).map(
    ([name, value, message]): FaultCase => ({
      name: `a system writes ${name}`,
      ruleset: (at) => writing(at, value),
      code: "system_fault",
      issues: [{ path: "/chunks/0,0/grass", message }],
    }),
  ),
  {
    name: "run returns a Promise",
    ruleset: (at) =>
      stepRuleset([
        {
          name: "async",
          streams: [],
          run: (ctx) => (ctx.tick === at ? Promise.resolve() : undefined) as undefined,
        },
      ]),
    code: "system_fault",
    issues: [{ path: "/systems/0", message: `system "async": run ${RETURNED}` }],
  },
  {
    name: "apply returns a Promise",
    ruleset: () =>
      stepRuleset([], {
        boom: { check: () => undefined, apply: () => Promise.resolve() as unknown as undefined },
        ok: okHandler,
      }),
    commands: commandsWithBoomAt([1], 2),
    code: "system_fault",
    issues: [{ path: "/commands/1", message: `command 1 ("boom"): apply ${RETURNED}` }],
  },
  {
    name: "a system draws from a stream it did not declare",
    ruleset: (at) =>
      stepRuleset([
        system(
          "dice",
          (ctx) => {
            ctx.random.u32("dice", 1);
            if (ctx.tick === at) ctx.random.u32("rain", 1);
          },
          ["dice"],
        ),
        system("weather", () => undefined, ["rain"]),
      ]),
    code: "system_fault",
    issues: [
      {
        path: "/systems/0",
        message: 'system "dice": random.u32 drew from "rain", a stream it did not declare',
      },
    ],
  },
  {
    name: "the entity ids run out",
    ruleset: () => stepRuleset([system("birth", (ctx) => ctx.newEntityId())]),
    prepare: (world, at) => {
      worldState(world).kernel.nextEntityId = MAX - at + 1;
    },
    code: "id_exhausted",
    issues: [
      {
        path: "/systems/0",
        message: `system "birth": newEntityId: the entity ids are exhausted: nextEntityId is ${MAX}, the largest safe integer`,
      },
    ],
  },
];

/** Asserts that `world` is poisoned with this fault, and that only worldStatus still reads it. */
function expectPoisoned(
  world: World,
  tick: number,
  code: EngineErrorCode,
  issues: readonly Issue[],
) {
  expect(worldStatus(world)).toEqual({ kind: "faulted", tick, code, issues });
  const uses: (() => unknown)[] = [
    () => step(world, []),
    () => readView(world),
    () => chunkHashes(world),
    () => fullChecksum(world),
    () => stateRoot(world),
    () => encodeSnapshot(world),
    () => snapshotBytes(world),
    () => versionDifferences(world),
  ];
  for (const use of uses) {
    const error = engineErrorOf(use);
    expect(error.code).toBe("world_faulted");
    expect(error.issues).toEqual([
      {
        path: "",
        message: `the world faulted at tick ${tick} with ${code}: only worldStatus reads it; recover from the last snapshot`,
      },
    ]);
  }
}

describe.each([1, 4])("a fault at tick %d poisons the world", (at) => {
  test.each(FAULTS)("$name", ({ ruleset, commands, prepare, code, issues }) => {
    const world = stepWorld(ruleset(at));
    prepare?.(world, at);
    for (let tick = 1; tick < at; tick += 1) step(world, commands?.(tick, at) ?? []);
    const view = readView(world);
    const error = engineErrorOf(() => step(world, commands?.(at, at) ?? []));
    expect({ code: error.code, issues: error.issues }).toEqual({ code, issues });
    expect(Object.hasOwn(error, "events")).toBe(false);
    expectPoisoned(world, at, code, issues);
    expect(engineErrorOf(() => view.readGlobal()).code).toBe("world_faulted");
  });
});

describe("poisoning", () => {
  test("the last tick: step throws tick_overflow and the world reports the tick it ran out at", () => {
    const world = stepWorld(stepRuleset([system("noop", () => undefined)]));
    worldState(world).kernel.tick = MAX;
    const issues = [
      { path: "", message: `the tick ${MAX} is the last one: the next is not a safe integer` },
    ];
    const error = engineErrorOf(() => step(world, []));
    expect({ code: error.code, issues: error.issues }).toEqual({ code: "tick_overflow", issues });
    expectPoisoned(world, MAX, "tick_overflow", issues);
  });

  test("a fault the ruleset catches still poisons the world", () => {
    let caught: unknown;
    const ruleset = stepRuleset([
      system("sly", (ctx) => {
        try {
          ctx.random.u32("undeclared", 1);
        } catch (error) {
          caught = error;
        }
        ctx.emit("fine", 1);
      }),
    ]);
    const world = stepWorld(ruleset);
    const error = engineErrorOf(() => step(world, []));
    expect(caught).toBe(error);
    expect(error.issues).toEqual([
      {
        path: "/systems/0",
        message: 'system "sly": random.u32 drew from "undeclared", a stream it did not declare',
      },
    ]);
    expect(worldStatus(world).kind).toBe("faulted");
  });

  test("a fault the ruleset catches poisons the world even if the context is not used again", () => {
    const ruleset = stepRuleset([
      system("quiet", (ctx) => {
        try {
          ctx.newEntityId();
          ctx.writeChunk("9,9");
        } catch {
          // Swallowed on purpose: the fault is recorded all the same.
        }
      }),
    ]);
    const world = stepWorld(ruleset);
    const error = engineErrorOf(() => step(world, []));
    expect(error.issues).toEqual([
      { path: "/systems/0", message: 'system "quiet": writeChunk: there is no chunk "9,9"' },
    ]);
    expect(worldStatus(world)).toMatchObject({ kind: "faulted", tick: 1, code: "system_fault" });
  });

  test("a fault names the command by its index in the list, and by its seq in the message", () => {
    const ruleset = stepRuleset([], { boom: throwing("apply"), ok: okHandler });
    const world = stepWorld(ruleset);
    const error = engineErrorOf(() => step(world, [command(1, 5, "ok"), command(1, 9, "boom")]));
    expect(error.issues).toEqual([
      { path: "/commands/1", message: `command 9 ("boom"): apply threw: ${BOOM}` },
    ]);
  });

  test("the cause of a throw is the thrown value", () => {
    const thrown = new RangeError("deep");
    const world = stepWorld(
      stepRuleset([
        system("deep", () => {
          throw thrown;
        }),
      ]),
    );
    expect(engineErrorOf(() => step(world, [])).cause).toBe(thrown);
  });

  test("ruleset code that calls step on its own world is a fault", () => {
    let world: World | undefined;
    const ruleset = stepRuleset([
      system("recursive", () => {
        if (world !== undefined) step(world, []);
      }),
    ]);
    world = stepWorld(ruleset);
    const message =
      'system "recursive": step was called during a tick of this world: ruleset code cannot use the world it runs in';
    const error = engineErrorOf(() => step(world as World, []));
    expect(error.issues).toEqual([{ path: "/systems/0", message }]);
    expect(worldStatus(world)).toMatchObject({ kind: "faulted", tick: 1, code: "system_fault" });
  });

  test("check must return undefined or a rejection { reason, details? }", () => {
    const ruleset = stepRuleset([], {
      odd: { check: () => ({ reason: "" }) as never, apply: () => undefined },
    });
    const world = stepWorld(ruleset);
    expect(engineErrorOf(() => step(world, [command(1, 0, "odd")])).issues).toEqual([
      {
        path: "/commands/0",
        message:
          'command 0 ("odd"): check returned a value that is not undefined or a rejection { reason, details? }, reason a non-empty string',
      },
    ]);
  });

  test("worldStatus gives a fresh copy of the diagnosis", () => {
    const world = stepWorld(systemsThrowingAt(0, 1));
    engineErrorOf(() => step(world, []));
    const status = worldStatus(world) as unknown as { issues: Issue[] };
    status.issues.length = 0;
    expect(worldStatus(world)).toMatchObject({ issues: [{ path: "/systems/0" }] });
  });

  test("misusing the context is a fault at the system that did it", () => {
    const misuses: [string, (ctx: Ctx) => unknown, string][] = [
      ["writeChunk", (ctx) => ctx.writeChunk("9,9"), 'writeChunk: there is no chunk "9,9"'],
      [
        "readChunk",
        (ctx) => ctx.readChunk("x"),
        'readChunk: the chunk key must be two integers joined by one comma, as in "-1,0"',
      ],
      [
        "createChunk",
        (ctx) => ctx.createChunk("0,0", 1),
        'createChunk: the chunk "0,0" already exists',
      ],
      [
        "createChunk",
        (ctx) => ctx.createChunk("2,2", { a: Number.NaN }),
        'createChunk("2,2"): the initial value is not canonical: at /a: NaN is not a safe integer',
      ],
      [
        "emit",
        (ctx) => ctx.emit("engine.fake", 1),
        'emit: the event type "engine.fake" starts with "engine.", which is reserved for the kernel',
      ],
      ["emit", (ctx) => ctx.emit("", 1), "emit: the event type must not be empty"],
      [
        "emit",
        (ctx) => ctx.emit("said", [1.5]),
        "emit: the payload is not canonical: at /0: 1.5 is not a safe integer",
      ],
      [
        "random.int",
        (ctx) => ctx.random.int("dice", 1, 0),
        "random.int: invalid_value at /bound: 0 is not an integer in [1, 4294967296]",
      ],
      [
        "random.u32",
        (ctx) => ctx.random.u32("dice", 0.5),
        "random.u32: invalid_value at /entity: 0.5 is not a safe integer",
      ],
    ];
    for (const [, misuse, message] of misuses) {
      const world = stepWorld(stepRuleset([system("clumsy", (ctx) => misuse(ctx), ["dice"])]));
      const error = engineErrorOf(() => step(world, []));
      expect({ code: error.code, issues: error.issues }).toEqual({
        code: "system_fault",
        issues: [{ path: "/systems/0", message: `system "clumsy": ${message}` }],
      });
    }
  });
});

describe("audit detects writes that bypass the barrier, at the tick they happen", () => {
  test.each(BARRIER_ROWS)("%s, as integrity_violation", (_name, { ruleset, lag, issues }) => {
    const at = 3;
    const world = stepWorld(ruleset(at), {}, true);
    const tick = at + lag;
    for (let ticks = 1; ticks < tick; ticks += 1) step(world, []);
    const error = engineErrorOf(() => step(world, []));
    expect({ code: error.code, issues: error.issues }).toEqual({
      code: "integrity_violation",
      issues,
    });
    expectPoisoned(world, tick, "integrity_violation", issues);
  });

  test.each(BARRIER_ROWS)(
    "%s, undetected without audit until a full checksum",
    (_name, { ruleset, lag, notCanonical }) => {
      const at = 3;
      const world = stepWorld(ruleset(at));
      const tick = at + lag;
      for (let ticks = 1; ticks <= tick; ticks += 1) step(world, []);
      expect(worldStatus(world)).toEqual({ kind: "ok", tick });
      if (notCanonical !== undefined) {
        const error = engineErrorOf(() => fullChecksum(world));
        expect({ code: error.code, issues: error.issues }).toEqual({
          code: "invalid_value",
          issues: [notCanonical],
        });
      } else expect(fullChecksum(world)).not.toBe(stateRoot(world));
    },
  );

  test("fullChecksum names the global value when it is not canonical", () => {
    const world = stepWorld(
      stepRuleset([
        system("sneaky", (ctx) => {
          (ctx.readGlobal() as Data).population = 0.5;
        }),
      ]),
    );
    step(world, []);
    const error = engineErrorOf(() => fullChecksum(world));
    expect(error.issues).toEqual([
      { path: "/global/population", message: "0.5 is not a safe integer" },
    ]);
  });

  test("an audited world that writes only through the barrier steps on", () => {
    const world = stepWorld(writing(0, 0), {}, true);
    for (let tick = 1; tick <= 5; tick += 1) step(world, []);
    expect(stateRoot(world)).toBe(fullChecksum(world));
  });
});

describe("the tick context is revoked when step returns", () => {
  const EXPIRED = "the tick context was used after its step returned: keep no reference to it";

  test("every method of a kept context or view throws context_expired", () => {
    let kept: Ctx | undefined;
    let keptView: ReadView<Value, Value> | undefined;
    const ruleset = stepRuleset(
      [
        system(
          "keeper",
          (ctx) => {
            kept = ctx;
          },
          ["dice"],
        ),
      ],
      {
        look: {
          check: (view) => {
            keptView = view;
            return undefined;
          },
          apply: () => undefined,
        },
      },
    );
    step(stepWorld(ruleset), [command(1, 0, "look")]);
    if (kept === undefined || keptView === undefined) throw new Error("nothing was kept");
    const ctx = kept;
    const view = keptView;
    const uses: (() => unknown)[] = [
      () => ctx.tick,
      () => ctx.chunkKeys(),
      () => ctx.readChunk("0,0"),
      () => ctx.readGlobal(),
      () => ctx.writeChunk("0,0"),
      () => ctx.writeGlobal(),
      () => ctx.createChunk("3,3", 1),
      () => ctx.newEntityId(),
      () => ctx.random.u32("dice", 1),
      () => ctx.random.int("dice", 1, 6),
      () => ctx.random.permutation("dice", 1, 3),
      () => ctx.rejectedCommands(),
      () => ctx.emit("late", 1),
      () => view.tick,
      () => view.chunkKeys(),
      () => view.readChunk("0,0"),
      () => view.readGlobal(),
    ];
    for (const use of uses) {
      const error = engineErrorOf(use);
      expect({ code: error.code, issues: error.issues }).toEqual({
        code: "context_expired",
        issues: [{ path: "", message: EXPIRED }],
      });
    }
  });

  test("a context kept from a tick that faulted is revoked too", () => {
    let kept: Ctx | undefined;
    const world = stepWorld(
      stepRuleset([
        system("doomed", (ctx) => {
          kept = ctx;
          boom();
        }),
      ]),
    );
    engineErrorOf(() => step(world, []));
    const error = engineErrorOf(() => kept?.readChunk("0,0"));
    expect({ code: error.code, issues: error.issues }).toEqual({
      code: "context_expired",
      issues: [{ path: "", message: EXPIRED }],
    });
  });

  test("a context kept from an earlier tick faults the tick that uses it", () => {
    let kept: Ctx | undefined;
    const world = stepWorld(
      stepRuleset([
        system("late", (ctx) => {
          if (kept !== undefined) kept.emit("late", 1);
          kept = ctx;
        }),
      ]),
    );
    step(world, []);
    const error = engineErrorOf(() => step(world, []));
    expect(error.code).toBe("system_fault");
    expect(error.issues[0]?.path).toBe("/systems/0");
    expect((error.cause as { code?: string }).code).toBe("context_expired");
  });
});
