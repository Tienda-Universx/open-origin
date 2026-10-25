import { describe, expect, test } from "bun:test";
import {
  type Command,
  canonicalize,
  createWorld,
  digest,
  type EngineEvent,
  fullChecksum,
  type ReadView,
  type Rejected,
  readView,
  stateRoot,
  step,
  worldStatus,
} from "../src/index.ts";
import { worldState } from "../src/world/world.ts";
import {
  type Ctx,
  command,
  type Data,
  from,
  handler,
  stepRuleset,
  stepWorld,
  system,
  type Value,
  writable,
} from "./support/step-rulesets.ts";

/**
 * step (ADR 0020; plan §2.1, §4): commands in seq order, then systems in their declared order,
 * then the commit, which hashes what changed. These tests cover the pipeline, rejections, the
 * tick context's reads and writes, the result, and host isolation.
 */

describe("step runs one tick", () => {
  test("commands in seq order, each checked then applied, then systems in declared order", () => {
    const trace: string[] = [];
    const traced = (name: string) => ({
      check: (_view: ReadView<Value, Value>, cmd: Command) => {
        trace.push(`check ${name} ${cmd.seq}`);
        return undefined;
      },
      apply: (_ctx: Ctx, cmd: Command) => {
        trace.push(`apply ${name} ${cmd.seq}`);
        return undefined;
      },
    });
    const ruleset = stepRuleset(
      ["first", "second", "third"].map((name) => system(name, () => trace.push(name))),
      { b: traced("b"), a: traced("a") },
    );
    const world = stepWorld(ruleset);
    step(world, [command(1, 3, "b"), command(1, 7, "a"), command(1, 8, "b")]);
    expect(trace).toEqual([
      "check b 3",
      "apply b 3",
      "check a 7",
      "apply a 7",
      "check b 8",
      "apply b 8",
      "first",
      "second",
      "third",
    ]);
  });

  test("numbers events in emission order and gives each its cause", () => {
    const ruleset = stepRuleset(
      [
        system("growth", (ctx) => ctx.emit("grew", { by: 1 })),
        system("weather", (ctx) => ctx.emit("rained", [ctx.tick])),
      ],
      { say: handler((ctx, cmd) => ctx.emit("said", cmd.payload)) },
    );
    const world = stepWorld(ruleset);
    const { events } = step(world, [command(1, 4, "say", "hi"), command(1, 9, "say", "bye")]);
    expect(events).toEqual([
      { tick: 1, seq: 0, type: "said", payload: "hi", cause: { kind: "command", seq: 4 } },
      { tick: 1, seq: 1, type: "said", payload: "bye", cause: { kind: "command", seq: 9 } },
      {
        tick: 1,
        seq: 2,
        type: "grew",
        payload: { by: 1 },
        cause: { kind: "system", name: "growth" },
      },
      { tick: 1, seq: 3, type: "rained", payload: [1], cause: { kind: "system", name: "weather" } },
    ]);
  });

  test("advances the tick by one, and the context reads the tick it computes", () => {
    const seen: number[] = [];
    const world = stepWorld(stepRuleset([system("clock", (ctx) => seen.push(ctx.tick))]));
    expect(step(world, []).tick).toBe(1);
    expect(step(world, []).tick).toBe(2);
    expect(seen).toEqual([1, 2]);
    expect(worldStatus(world)).toEqual({ kind: "ok", tick: 2 });
    expect(readView(world).tick).toBe(2);
  });

  test("returns the checksum of the state root and the events", () => {
    const ruleset = stepRuleset([
      system("growth", (ctx) => {
        writable(ctx, "0,0").grass = 5;
        ctx.emit("grew", 5);
      }),
    ]);
    const world = stepWorld(ruleset);
    const { checksum, events } = step(world, []);
    expect(checksum).toBe(digest(["tick", stateRoot(world), digest(["events", events])]));
    expect(stateRoot(world)).toBe(fullChecksum(world));
  });

  test("the checksum covers the events: equal states with different events differ", () => {
    const quiet = stepWorld(stepRuleset([system("noop", () => undefined)]));
    const loud = stepWorld(stepRuleset([system("noop", (ctx) => ctx.emit("noise", 1))]));
    const a = step(quiet, []);
    const b = step(loud, []);
    expect(stateRoot(quiet)).toBe(stateRoot(loud));
    expect(a.checksum).not.toBe(b.checksum);
  });
});

describe("step rejects commands", () => {
  const origin = { kind: "inhabitant", actor: 5 } as const;

  test("of an unknown type, with an engine.command_rejected event", () => {
    const world = stepWorld(stepRuleset());
    const { events, stats } = step(world, [from(origin, command(1, 2, "fly", { to: 1 }))]);
    expect(events).toEqual([
      {
        tick: 1,
        seq: 0,
        type: "engine.command_rejected",
        payload: { seq: 2, type: "fly", reason: "unknown_type", origin },
        cause: { kind: "command", seq: 2 },
      },
    ]);
    expect(stats.rejected).toBe(1);
  });

  test("that check refuses: apply does not run, and the event carries the details", () => {
    let applied = 0;
    const ruleset = stepRuleset([], {
      dig: {
        check: (_view, cmd) =>
          cmd.payload === "rock" ? { reason: "too_hard", details: { needs: ["pick"] } } : undefined,
        apply: () => {
          applied += 1;
          return undefined;
        },
      },
    });
    const world = stepWorld(ruleset);
    const { events } = step(world, [command(1, 0, "dig", "rock"), command(1, 1, "dig", "sand")]);
    expect(applied).toBe(1);
    expect(events).toEqual([
      {
        tick: 1,
        seq: 0,
        type: "engine.command_rejected",
        payload: {
          seq: 0,
          type: "dig",
          reason: "too_hard",
          origin: { kind: "admin" },
          details: { needs: ["pick"] },
        },
        cause: { kind: "command", seq: 0 },
      },
    ]);
  });

  test("the event takes the origin before check runs, so check cannot change it", () => {
    const ruleset = stepRuleset([], {
      dig: {
        check: (_view, cmd) => {
          const origin = cmd.origin as { kind: string; actor?: number };
          origin.kind = "admin";
          origin.actor = 99;
          return { reason: "no" };
        },
        apply: () => undefined,
      },
    });
    const sent = { kind: "inhabitant", actor: 5 } as const;
    const { events } = step(stepWorld(ruleset), [from(sent, command(1, 0, "dig"))]);
    expect(events[0]?.payload).toEqual({ seq: 0, type: "dig", reason: "no", origin: sent });
  });

  test("rejectedCommands lists this tick's rejections, in a fresh array each call", () => {
    const seen: Rejected[][] = [];
    const lists: (readonly Rejected[])[] = [];
    const ruleset = stepRuleset(
      [
        system("reader", (ctx) => {
          lists.push(ctx.rejectedCommands(), ctx.rejectedCommands());
          seen.push([...ctx.rejectedCommands()]);
        }),
      ],
      { no: { check: () => ({ reason: "never" }), apply: () => undefined } },
    );
    const world = stepWorld(ruleset);
    step(world, [command(1, 0, "no", 1), command(1, 1, "unknown", 2)]);
    step(world, []);
    expect(seen).toEqual([
      [
        { command: command(1, 0, "no", 1), rejection: { reason: "never" } },
        { command: command(1, 1, "unknown", 2), rejection: { reason: "unknown_type" } },
      ],
      [],
    ]);
    expect(lists[0]).not.toBe(lists[1]);
  });

  test("check gets a view without write methods, which sees earlier commands' writes", () => {
    const seen: unknown[] = [];
    const ruleset = stepRuleset([], {
      grow: handler((ctx) => {
        writable(ctx, "0,0").grass = 9;
      }),
      look: {
        check: (view) => {
          seen.push(view.readChunk("0,0"), "writeChunk" in view, "emit" in view, view.tick);
          return undefined;
        },
        apply: () => undefined,
      },
    });
    step(stepWorld(ruleset), [command(1, 0, "grow"), command(1, 1, "look")]);
    expect(seen).toEqual([{ grass: 9 }, false, false, 1]);
  });
});

describe("ruleset functions", () => {
  test("are called without a receiver, so they cannot reach the captured ruleset", () => {
    const receivers: unknown[] = [];
    const ruleset = stepRuleset(
      [
        {
          name: "growth",
          streams: [],
          run(this: unknown) {
            receivers.push(["run", this]);
            return undefined;
          },
        },
      ],
      {
        dig: {
          check(this: unknown) {
            receivers.push(["check", this]);
            return undefined;
          },
          apply(this: unknown) {
            receivers.push(["apply", this]);
            return undefined;
          },
        },
      },
    );
    step(stepWorld(ruleset), [command(1, 0, "dig")]);
    expect(receivers).toEqual([
      ["check", undefined],
      ["apply", undefined],
      ["run", undefined],
    ]);
  });
});

describe("the tick context", () => {
  test("reads return the live values; writes mark them changed", () => {
    const ruleset = stepRuleset([
      system("growth", (ctx) => {
        const chunk = writable(ctx, "1,0");
        chunk.grass = 3;
        expect(ctx.readChunk("1,0")).toBe(chunk);
        expect(ctx.readChunk("9,9")).toBeUndefined();
        (ctx.writeGlobal() as Data).population = 7;
        expect(ctx.readGlobal()).toEqual({ population: 7 });
      }),
    ]);
    const world = stepWorld(ruleset);
    const { changedChunks, stats } = step(world, []);
    expect(changedChunks).toEqual(["1,0"]);
    expect(stats.dirtyChunks).toBe(1);
    expect(readView(world).readChunk("1,0")).toEqual({ grass: 3 });
    expect(readView(world).readGlobal()).toEqual({ population: 7 });
    expect(stateRoot(world)).toBe(fullChecksum(world));
  });

  test("a created chunk is readable and writable at once, and listed from the next tick on", () => {
    const keys: string[][] = [];
    const ruleset = stepRuleset([
      system("settle", (ctx) => {
        keys.push(ctx.chunkKeys());
        if (ctx.tick !== 1) return;
        ctx.createChunk("-1,0", { grass: 0 });
        writable(ctx, "-1,0").grass = 4;
        expect(ctx.readChunk("-1,0")).toEqual({ grass: 4 });
        keys.push(ctx.chunkKeys());
      }),
    ]);
    const world = stepWorld(ruleset);
    const { changedChunks, stats } = step(world, []);
    step(world, []);
    expect(keys).toEqual([
      ["0,0", "1,0"],
      ["0,0", "1,0"],
      ["-1,0", "0,0", "1,0"],
    ]);
    expect(changedChunks).toEqual(["-1,0"]);
    expect(stats).toMatchObject({ createdChunks: 1, dirtyChunks: 0 });
    expect(readView(world).readChunk("-1,0")).toEqual({ grass: 4 });
    expect(stateRoot(world)).toBe(fullChecksum(world));
  });

  test("createChunk copies its initial value", () => {
    const initial = { grass: [1] };
    const world = stepWorld(
      stepRuleset([
        system("settle", (ctx) => {
          if (ctx.tick !== 1) return;
          ctx.createChunk("5,5", initial);
          initial.grass.push(2);
        }),
      ]),
    );
    step(world, []);
    expect(readView(world).readChunk("5,5")).toEqual({ grass: [1] });
  });

  test("changedChunks is sorted and lists each changed chunk once", () => {
    const chunks = { "10,0": { n: 0 }, "2,0": { n: 0 }, "-3,0": { n: 0 }, "0,0": { n: 0 } };
    const ruleset = stepRuleset([
      system("touch", (ctx) => {
        for (const key of ["2,0", "10,0", "2,0", "-3,0"]) writable(ctx, key).n = ctx.tick;
        ctx.createChunk("1,1", { n: 0 });
        writable(ctx, "1,1").n = 1;
      }),
    ]);
    const { changedChunks, stats } = step(stepWorld(ruleset, { chunks }), []);
    expect(changedChunks).toEqual(["-3,0", "1,1", "10,0", "2,0"]);
    expect(stats).toMatchObject({ dirtyChunks: 3, createdChunks: 1 });
  });

  test("newEntityId hands out ids from 1, across ticks", () => {
    const ids: number[] = [];
    const world = stepWorld(
      stepRuleset([system("birth", (ctx) => ids.push(ctx.newEntityId(), ctx.newEntityId()))]),
    );
    step(world, []);
    step(world, []);
    expect(ids).toEqual([1, 2, 3, 4]);
    expect(worldState(world).kernel.nextEntityId).toBe(5);
  });

  test("each event has a cause of its own", () => {
    const world = stepWorld(
      stepRuleset([
        system("talk", (ctx) => {
          ctx.emit("a", 1);
          ctx.emit("b", 2);
        }),
      ]),
    );
    const { events } = step(world, []);
    expect(events[0]?.cause).not.toBe(events[1]?.cause);
    (events[0]?.cause as { name: string }).name = "changed";
    expect(events[1]?.cause).toEqual({ kind: "system", name: "talk" });
  });

  test("emit copies its payload", () => {
    const payload = { list: [1] };
    const world = stepWorld(
      stepRuleset([
        system("talk", (ctx) => {
          ctx.emit("said", payload);
          payload.list.push(2);
        }),
      ]),
    );
    expect(step(world, []).events[0]?.payload).toEqual({ list: [1] });
  });

  test("a system, a check, and an apply read the world's seconds per tick", () => {
    const seen: [string, number][] = [];
    const ruleset = stepRuleset(
      [system("clock", (ctx) => seen.push(["run", ctx.simSecondsPerTick]))],
      {
        look: {
          check: (view) => {
            seen.push(["check", view.simSecondsPerTick]);
            return undefined;
          },
          apply: (ctx) => {
            seen.push(["apply", ctx.simSecondsPerTick]);
            return undefined;
          },
        },
      },
    );
    const world = createWorld({
      seed: [1, 2],
      simSecondsPerTick: 7,
      global: { population: 0 },
      chunks: {},
      ruleset,
    });
    step(world, [command(1, 0, "look")]);
    expect(seen).toEqual([
      ["check", 7],
      ["apply", 7],
      ["run", 7],
    ]);
  });
});

describe("step results", () => {
  test("count every rejection", () => {
    const ruleset = stepRuleset([], {
      no: { check: () => ({ reason: "never" }), apply: () => undefined },
    });
    const commands = [command(1, 0, "no"), command(1, 1, "nope"), command(1, 2, "no")];
    expect(step(stepWorld(ruleset), commands).stats).toMatchObject({ rejected: 3, events: 3 });
  });

  test("count commands, rejections, events, and changed chunks", () => {
    const ruleset = stepRuleset([system("talk", (ctx) => ctx.emit("said", 1))], {
      dig: handler((ctx) => {
        writable(ctx, "0,0").grass = 0;
      }),
    });
    const { stats } = step(stepWorld(ruleset), [command(1, 0, "dig"), command(1, 1, "nope")]);
    expect(stats).toMatchObject({
      commands: 2,
      rejected: 1,
      events: 2,
      dirtyChunks: 1,
      createdChunks: 0,
    });
  });
});

describe("the host never holds live state through step", () => {
  /** A ruleset that writes the payload of each command into chunk 0,0 and emits it. */
  const copying = () =>
    stepRuleset([], {
      put: handler((ctx, cmd) => {
        writable(ctx, "0,0").last = cmd.payload;
        ctx.emit("put", cmd.payload);
      }),
    });

  test("changing the commands, the events, changedChunks, and stats changes nothing", () => {
    const world = stepWorld(copying());
    const control = stepWorld(copying());
    const commands = [command(1, 0, "put", { items: [1, 2] })];
    const result = step(world, commands);
    const controlResult = step(control, [command(1, 0, "put", { items: [1, 2] })]);
    // The host's own objects and the result, which it may change however it likes.
    type Items = { payload: { items: number[] } };
    (commands[0] as unknown as Items).payload.items.push(3);
    (result.events as EngineEvent[]).push(result.events[0] as EngineEvent);
    (result.events[0] as unknown as Items).payload.items.length = 0;
    (result.changedChunks as string[]).push("9,9");
    (result.stats as { commands: number }).commands = 99;
    expect(stateRoot(world)).toBe(stateRoot(control));
    expect(fullChecksum(world)).toBe(fullChecksum(control));
    expect(readView(world).readChunk("0,0")).toEqual({ grass: 1, last: { items: [1, 2] } });
    expect(step(world, [command(2, 0, "put", 1)])).toEqual(
      step(control, [command(2, 0, "put", 1)]),
    );
    expect(controlResult.events).toHaveLength(1);
  });

  test("a result's events are canonical values", () => {
    const world = stepWorld(copying());
    const { events } = step(world, [command(1, 0, "put", { b: 1, a: [true] })]);
    expect(canonicalize(events)).toBe(
      '[{"cause":{"kind":"command","seq":0},"payload":{"a":[true],"b":1},"seq":0,"tick":1,"type":"put"}]',
    );
  });
});
