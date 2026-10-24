import { describe, expect, test } from "bun:test";
import {
  type Command,
  chunkHashes,
  type EngineError,
  fullChecksum,
  readView,
  stateRoot,
  step,
  type World,
  worldStatus,
} from "../src/index.ts";
import { engineErrorOf } from "./support/engine-error.ts";
import {
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
});

/** Every function that reads or steps a world, by the name its error gives. */
const USES: [string, (world: World) => unknown][] = [
  ["step", (world) => step(world, [])],
  ["readView", (world) => readView(world)],
  ["fullChecksum", (world) => fullChecksum(world)],
  ["stateRoot", (world) => stateRoot(world)],
  ["chunkHashes", (world) => chunkHashes(world)],
  ["worldStatus", (world) => worldStatus(world)],
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

  test("a view the host read before the step is refused during it", () => {
    let view: ReturnType<typeof readView> | undefined;
    let inner: unknown;
    const world = stepWorld(
      stepRuleset([
        system("peek", () => {
          try {
            view?.readChunk("0,0");
          } catch (error) {
            inner = error;
          }
        }),
      ]),
    );
    view = readView(world);
    engineErrorOf(() => step(world, []));
    expect(inner).toMatchObject({
      code: "world_busy",
      issues: [{ message: busy("view.readChunk") }],
    });
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
