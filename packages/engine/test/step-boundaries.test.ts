import { describe, expect, test } from "bun:test";
import {
  type Command,
  chunkHashes,
  EngineError,
  encodeSnapshot,
  fullChecksum,
  readView,
  snapshotBytes,
  stateRoot,
  step,
  versionDifferences,
  type World,
  type WorldStatus,
  worldStatus,
} from "../src/index.ts";
import { CHANGED_WHILE_READING } from "../src/step/step.ts";
import { poison, worldState } from "../src/world/world.ts";
import { engineErrorOf } from "./support/engine-error.ts";
import {
  type Ctx,
  command,
  type Data,
  handler,
  type StepRuleset,
  stepRuleset,
  stepWorld,
  system,
  writable,
} from "./support/step-rulesets.ts";

/**
 * What no code may do around a step (ADR 0020, ownership and failures): use a world while it steps,
 * whether from ruleset code during the tick or from a host Proxy while step reads the commands;
 * and what a Proxy written into the state can still do, which is detected, not prevented.
 */

const busy = (api: string) =>
  `${api} was called during a step of this world: no function may use a world while it steps`;
const inTick = (api: string) =>
  `${api} was called during a tick of this world: ruleset code cannot use the world it runs in`;

/** A ruleset whose `put` command writes its payload into chunk 0,0. */
const putting = (systems = stepRuleset().systems): StepRuleset =>
  stepRuleset([...systems], {
    put: handler((ctx, cmd) => {
      writable(ctx, "0,0").last = cmd.payload;
    }),
  });

/** A `put` command for tick 1 whose first descriptor read runs `onRead`, as a host Proxy can. */
function trapCommand(onRead: () => void): Command {
  let fired = false;
  return new Proxy(command(1, 0, "put", 1), {
    getOwnPropertyDescriptor(target, key) {
      if (!fired) {
        fired = true;
        onRead();
      }
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
}

const observe = (world: World) => ({
  status: worldStatus(world),
  root: stateRoot(world),
  full: fullChecksum(world),
});

describe("a step of a world refuses a second use of that world while it reads the commands", () => {
  test("a trap that steps the world is refused, and the outer step applies at its own tick", () => {
    const world = stepWorld(putting());
    let inner: unknown;
    const commands = [
      trapCommand(() => {
        try {
          step(world, []);
        } catch (error) {
          inner = error;
        }
      }),
    ];
    const result = step(world, commands);
    expect(inner).toMatchObject({
      code: "world_busy",
      issues: [{ path: "", message: busy("step") }],
    });
    expect(result.tick).toBe(1);
    expect(worldStatus(world)).toEqual({ kind: "ok", tick: 1 });
    expect(readView(world).readChunk("0,0")).toEqual({ grass: 1, last: 1 });
  });

  test("a trap whose step would fault leaves the world healthy, and the outer step rejects it", () => {
    const faulty = putting([
      system("boom", () => {
        throw new Error("boom");
      }),
    ]);
    const world = stepWorld(faulty);
    const before = observe(world);
    const error = engineErrorOf(() => step(world, [trapCommand(() => step(world, []))]));
    expect(error.code).toBe("invalid_input");
    // The trap fires on the first member step reads through a descriptor.
    expect(error.issues.map(({ path }) => path)).toEqual(["/commands/0/applyTick"]);
    expect(error.issues[0]?.message).toStartWith("the object threw while being read: EngineError");
    expect((error.cause as EngineError).code).toBe("world_busy");
    expect(observe(world)).toEqual(before);
  });

  test("a trap that reads the world is refused too", () => {
    const world = stepWorld(putting());
    let inner: unknown;
    step(world, [
      trapCommand(() => {
        try {
          stateRoot(world);
        } catch (error) {
          inner = error;
        }
      }),
    ]);
    expect(inner).toMatchObject({ code: "world_busy", issues: [{ message: busy("stateRoot") }] });
  });

  /**
   * Every engine function refuses a world while it steps, so nothing can change one while step
   * reads its commands. These traps reach the state through the engine's internals, as an engine
   * function that skipped the busy guard would: step must refuse to advance the changed world and
   * poison it, but a world that is already poisoned keeps its first fault.
   */
  const ELSEWHERE = new EngineError("system_fault", [{ path: "", message: "elsewhere" }]);
  const defect = (tick: number): WorldStatus => ({
    kind: "faulted",
    tick,
    code: "world_busy",
    issues: [{ path: "", message: CHANGED_WHILE_READING }],
  });
  const first: WorldStatus = {
    kind: "faulted",
    tick: 0,
    code: "system_fault",
    issues: ELSEWHERE.issues,
  };

  test.each([
    ["moves its tick", 1, (world: World) => (worldState(world).kernel.tick += 1), defect(1)],
    ["poisons it", 0, (world: World) => poison(worldState(world), ELSEWHERE), first],
  ])("a defect that %s while the commands are read stops the step", (_, tick, change, status) => {
    const world = stepWorld(putting());
    const state = worldState(world);
    const error = engineErrorOf(() => step(world, [trapCommand(() => change(world))]));
    expect({ code: error.code, issues: error.issues }).toEqual({
      code: "world_busy",
      issues: [{ path: "", message: CHANGED_WHILE_READING }],
    });
    expect(state.kernel.tick).toBe(tick);
    expect(state.chunks.get("0,0")?.value).toEqual({ grass: 1 });
    expect(state.active).toBeUndefined();
    expect(worldStatus(world)).toEqual(status);
  });
});

/** Every function that reads or steps a world, by the name its error gives. */
const USES: [string, (world: World) => unknown][] = [
  ["step", (world) => step(world, [])],
  ["readView", (world) => readView(world)],
  ["fullChecksum", (world) => fullChecksum(world)],
  ["stateRoot", (world) => stateRoot(world)],
  ["chunkHashes", (world) => chunkHashes(world)],
  ["worldStatus", (world) => worldStatus(world)],
  ["encodeSnapshot", (world) => encodeSnapshot(world)],
  ["snapshotBytes", (world) => snapshotBytes(world)],
  ["versionDifferences", (world) => versionDifferences(world)],
];

describe("ruleset code cannot use the world it runs in", () => {
  /** Steps a world whose ruleset calls `use` from `where`, and returns what it saw and threw. */
  function misuse(where: "system" | "handler", use: (world: World) => unknown) {
    let world: World | undefined;
    let inner: unknown;
    const attempt = () => {
      try {
        use(world as World);
      } catch (error) {
        inner = error;
      }
    };
    const ruleset =
      where === "system"
        ? stepRuleset([system("peek", attempt)])
        : stepRuleset([], { peek: handler(attempt) });
    world = stepWorld(ruleset);
    const commands = where === "system" ? [] : [command(1, 4, "peek")];
    const error = engineErrorOf(() => step(world as World, commands));
    return { world, inner, error };
  }

  test.each(USES)("%s, from a system: refused, and the tick faults", (api, use) => {
    const { world, inner, error } = misuse("system", use);
    expect(inner).toMatchObject({ code: "world_busy", issues: [{ path: "", message: busy(api) }] });
    expect({ code: error.code, issues: error.issues }).toEqual({
      code: "system_fault",
      issues: [{ path: "/systems/0", message: `system "peek": ${inTick(api)}` }],
    });
    expect(worldStatus(world)).toMatchObject({ kind: "faulted", tick: 1 });
  });

  test.each(USES)("%s, from a command handler: refused, and the tick faults", (api, use) => {
    const { inner, error } = misuse("handler", use);
    expect(inner).toMatchObject({ code: "world_busy" });
    expect(error.issues).toEqual([
      { path: "/commands/0", message: `command 4 ("peek"): ${inTick(api)}` },
    ]);
  });

  test.each<[string, (view: ReturnType<typeof readView>) => unknown]>([
    ["view.readChunk", (view) => view.readChunk("0,0")],
    ["view.simSecondsPerTick", (view) => view.simSecondsPerTick],
  ])("%s, on a view the host read before the step: refused during it", (api, use) => {
    let view: ReturnType<typeof readView> | undefined;
    let inner: unknown;
    const world = stepWorld(
      stepRuleset([
        system("peek", () => {
          try {
            if (view !== undefined) use(view);
          } catch (error) {
            inner = error;
          }
        }),
      ]),
    );
    view = readView(world);
    engineErrorOf(() => step(world, []));
    expect(inner).toMatchObject({ code: "world_busy", issues: [{ message: busy(api) }] });
  });
});

describe("a Proxy in the state is detected only when its answers change", () => {
  test("one that answers as a plain record passes the commit, and its traps run on host reads", () => {
    let reads = 0;
    const target: Data = { a: 1 };
    const world = stepWorld(
      stepRuleset([
        system("smuggle", (ctx) => {
          if (ctx.tick !== 1) return;
          writable(ctx, "0,0").inner = new Proxy(target, {
            getOwnPropertyDescriptor(target, key) {
              reads += 1;
              return Reflect.getOwnPropertyDescriptor(target, key);
            },
          });
        }),
      ]),
    );
    step(world, []);
    expect(fullChecksum(world)).toBe(stateRoot(world));
    const before = reads;
    const copy = readView(world).readChunk("0,0");
    expect(reads).toBeGreaterThan(before);
    // The host gets a plain copy: what the traps answered, detached from the Proxy.
    target.a = 2;
    expect(copy).toEqual({ grass: 1, inner: { a: 1 } });
  });

  test("one whose answers change is found by audit at the tick of the change", () => {
    let answer = 0;
    const world = stepWorld(
      stepRuleset([
        system("smuggle", (ctx) => {
          if (ctx.tick !== 2) return;
          const target: Data = { a: 0 };
          writable(ctx, "0,0").inner = new Proxy(target, {
            getOwnPropertyDescriptor: () => {
              answer += 1;
              return { value: answer, writable: true, enumerable: true, configurable: true };
            },
          });
        }),
      ]),
      {},
      true,
    );
    step(world, []);
    const error = engineErrorOf(() => step(world, []));
    expect({ code: error.code, issues: error.issues }).toEqual({
      code: "integrity_violation",
      issues: [
        {
          path: "/chunks/0,0",
          message: "the chunk changed without writeChunk: its cached term no longer matches it",
        },
      ],
    });
    expect(worldStatus(world)).toMatchObject({ kind: "faulted", tick: 2 });
  });
});

describe("a fault recorded outside every system and handler still poisons the world", () => {
  const OUTSIDE =
    "the tick context was used outside every system and command handler: only they may use it";
  const outside = [{ path: "", message: OUTSIDE }];

  /** Uses of a context that a validator keeps from the tick's system, each of which must fault. */
  const KEPT_USES: [string, (ctx: Ctx) => unknown][] = [
    ["writeGlobal", (ctx) => ctx.writeGlobal()],
    ["emit", (ctx) => ctx.emit("x", 1)],
    ["readChunk", (ctx) => ctx.readChunk("0,0")],
    ["random.u32", (ctx) => ctx.random.u32("keep", 1)],
    ["newEntityId", (ctx) => ctx.newEntityId()],
    ["createChunk", (ctx) => ctx.createChunk("7,7", 1)],
  ];
  const VALIDATORS = ["validateChunk", "validateGlobal"] as const;
  const CASES = VALIDATORS.flatMap((validator) =>
    KEPT_USES.map(([name, use]) => [validator, name, use] as const),
  );

  /**
   * A world whose system keeps its context and writes chunk 0,0 and the global value, and whose
   * `validator` uses the kept context at the commit and swallows what it throws.
   */
  function swallowing(validator: (typeof VALIDATORS)[number], use: (ctx: Ctx) => unknown) {
    let kept: Ctx | undefined;
    const keeper = system(
      "keeper",
      (ctx) => {
        kept = ctx;
        writable(ctx, "0,0").n = ctx.tick;
        (ctx.writeGlobal() as Data).n = ctx.tick;
      },
      ["keep"],
    );
    const ruleset: StepRuleset = {
      ...stepRuleset([keeper]),
      [validator]: () => {
        try {
          if (kept !== undefined) use(kept);
        } catch {
          // Swallowed on purpose: the session recorded the fault all the same.
        }
        return [];
      },
    };
    return stepWorld(ruleset);
  }

  test.each(CASES)(
    "%s swallowing %s: no result, and only worldStatus answers",
    (validator, _, use) => {
      const world = swallowing(validator, use);
      const error = engineErrorOf(() => step(world, []));
      expect({ code: error.code, issues: error.issues }).toEqual({
        code: "system_fault",
        issues: outside,
      });
      expect(worldStatus(world)).toEqual({
        kind: "faulted",
        tick: 1,
        code: "system_fault",
        issues: outside,
      });
      for (const read of [readView, fullChecksum, stateRoot, chunkHashes] as ((
        w: World,
      ) => unknown)[]) {
        expect(engineErrorOf(() => read(world)).code).toBe("world_faulted");
      }
    },
  );

  test("the commit stops at the validator that recorded the fault", () => {
    let kept: Ctx | undefined;
    const validated: string[] = [];
    const ruleset: StepRuleset = {
      ...stepRuleset([
        system("keeper", (ctx) => {
          kept = ctx;
          writable(ctx, "0,0").n = 1;
          writable(ctx, "1,0").n = 1;
        }),
      ]),
      validateChunk: (key) => {
        if (kept === undefined) return [];
        validated.push(key);
        try {
          kept.emit("x", 1);
        } catch {
          // Swallowed on purpose.
        }
        return [];
      },
    };
    const world = stepWorld(ruleset);
    expect(engineErrorOf(() => step(world, [])).issues).toEqual(outside);
    expect(validated).toEqual(["0,0"]);
  });

  /** A Proxy whose trap, from its `from`-th call on, uses `kept()` and swallows what it throws. */
  function trapUsing(kept: () => Ctx | undefined, from: number): Data {
    let calls = 0;
    return new Proxy({ a: 1 } as Data, {
      getOwnPropertyDescriptor(target, key) {
        calls += 1;
        try {
          if (calls >= from) kept()?.readGlobal();
        } catch {
          // Swallowed on purpose.
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
  }

  test("a Proxy in the state whose trap swallows a fault at the commit or the audit", () => {
    for (const [from, audit] of [
      [1, false],
      [2, true],
    ] as const) {
      let kept: Ctx | undefined;
      const world = stepWorld(
        stepRuleset([
          system("smuggle", (ctx) => {
            kept = ctx;
            writable(ctx, "0,0").inner = trapUsing(() => kept, from);
          }),
        ]),
        {},
        audit,
      );
      expect(engineErrorOf(() => step(world, [])).issues).toEqual(outside);
      expect(worldStatus(world)).toMatchObject({ kind: "faulted", tick: 1 });
    }
  });

  test("createWorld's validators run outside every tick: a kept context throws, records nothing", () => {
    let kept: Ctx | undefined;
    const first = stepWorld(
      stepRuleset([
        system("keeper", (ctx) => {
          kept = ctx;
        }),
      ]),
    );
    step(first, []);
    const before = stateRoot(first);
    let thrown: unknown;
    const ruleset: StepRuleset = {
      ...stepRuleset(),
      validateGlobal: () => {
        try {
          kept?.writeGlobal();
        } catch (error) {
          thrown = error;
        }
        return [];
      },
    };
    const second = stepWorld(ruleset);
    expect((thrown as EngineError).code).toBe("context_expired");
    expect(worldStatus(second)).toEqual({ kind: "ok", tick: 0 });
    expect(worldStatus(first)).toEqual({ kind: "ok", tick: 1 });
    expect(stateRoot(first)).toBe(before);
  });
});
