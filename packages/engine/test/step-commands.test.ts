import { describe, expect, test } from "bun:test";
import {
  type Command,
  chunkHashes,
  fullChecksum,
  type Issue,
  stateRoot,
  step,
  type World,
  worldStatus,
} from "../src/index.ts";
import { engineErrorOf } from "./support/engine-error.ts";
import { revokedProxy } from "./support/revoked.ts";
import {
  command,
  from,
  handler,
  stepRuleset,
  stepWorld,
  writable,
} from "./support/step-rulesets.ts";

/**
 * Input atomicity (ADR 0020, failures; plan §8 "Atomicidad de entradas"): step validates and
 * copies every command before it changes anything. An invalid list is one invalid_input with
 * every problem, at its path into `{ commands }`, and leaves the world exactly as it was.
 */

/** A ruleset whose `put` command writes its payload into chunk 0,0. */
const putting = () =>
  stepRuleset([], {
    put: handler((ctx, cmd) => {
      writable(ctx, "0,0").last = cmd.payload;
    }),
  });

/** Everything observable about `world`, to compare before and after. */
const observe = (world: World) => ({
  status: worldStatus(world),
  root: stateRoot(world),
  full: fullChecksum(world),
  chunks: chunkHashes(world),
});

const valid = (seq: number) => command(1, seq, "put", seq);
const ORIGIN = 'the origin must be { kind: "admin" } or { kind: "inhabitant", actor }';
const NOT_COMMAND = "a command must be a record { applyTick, seq, type, origin, payload }";
const NOT_ENVELOPE =
  "not part of a command: a command has applyTick, seq, type, origin, and payload";

/** `base` with `parts` replaced, for commands a type would reject. */
function commandWith(base: Command, parts: Record<string, unknown>): Command {
  // Deliberately ill-typed, as a JavaScript host can be.
  return { ...base, ...parts } as unknown as Command;
}

/** A string whose canonical text takes exactly `bytes` bytes of UTF-8: `bytes - 2` ASCII letters. */
const asciiOf = (bytes: number) => "a".repeat(bytes - 2);

const cases: [string, unknown, Issue[]][] = [
  [
    "an invalid command first",
    [commandWith(valid(0), { seq: -1 }), valid(1)],
    [
      {
        path: "/commands/0/seq",
        message: "-1 is not a sequence number: seq is a safe integer from 0",
      },
    ],
  ],
  [
    "an invalid command last",
    [valid(0), valid(1), commandWith(valid(2), { type: "" })],
    [{ path: "/commands/2/type", message: "the command type must not be empty" }],
  ],
  [
    "an applyTick that is not the next tick",
    [valid(0), command(2, 1, "put")],
    [
      {
        path: "/commands/1/applyTick",
        message: "applyTick must be 1, the tick this step computes, not 2",
      },
    ],
  ],
  [
    "seqs out of order",
    [valid(5), valid(3), valid(4)],
    [
      {
        path: "/commands/1/seq",
        message: "seq 3 is not greater than 5, the largest before it: seqs strictly increase",
      },
      {
        path: "/commands/2/seq",
        message: "seq 4 is not greater than 5, the largest before it: seqs strictly increase",
      },
    ],
  ],
  [
    "a duplicate seq",
    [valid(2), valid(2)],
    [
      {
        path: "/commands/1/seq",
        message: "seq 2 is not greater than 2, the largest before it: seqs strictly increase",
      },
    ],
  ],
  [
    "a payload over 8 KiB of canonical UTF-8",
    [command(1, 0, "put", asciiOf(8193))],
    [
      {
        path: "/commands/0/payload",
        message: "the payload takes 8193 bytes of canonical UTF-8, more than the 8192 allowed",
      },
    ],
  ],
  [
    "a payload that is not canonical",
    [command(1, 0, "put", { a: [Number.NaN], b: -0 } as never)],
    [
      { path: "/commands/0/payload/a/0", message: "NaN is not a safe integer" },
      { path: "/commands/0/payload/b", message: "-0 is not canonical: use 0" },
    ],
  ],
  [
    "a type that is not a string or not in NFC",
    [
      commandWith(valid(0), { type: 7 }),
      commandWith(valid(1), { type: `e${String.fromCharCode(0x301)}` }),
    ],
    [
      { path: "/commands/0/type", message: "the command type must be a string, not number" },
      {
        path: "/commands/1/type",
        message: "the string is not in Unicode Normalization Form C (NFC)",
      },
    ],
  ],
  [
    "origins that are not admin or an inhabitant",
    [
      commandWith(valid(0), { origin: { kind: "god" } }),
      commandWith(valid(1), { origin: { kind: "admin", actor: 1 } }),
      from({ kind: "inhabitant", actor: 0 }, valid(2)),
      commandWith(valid(3), { origin: { kind: "inhabitant" } }),
      commandWith(valid(4), { origin: "admin" }),
    ],
    [
      { path: "/commands/0/origin", message: ORIGIN },
      { path: "/commands/1/origin", message: ORIGIN },
      {
        path: "/commands/2/origin/actor",
        message: "0 is not an entity id: entity ids are safe integers from 1",
      },
      { path: "/commands/3/origin", message: ORIGIN },
      { path: "/commands/4/origin", message: ORIGIN },
    ],
  ],
  [
    "a command with a missing member and an extra one",
    [{ applyTick: 1, seq: 0, type: "put", payload: 1, extra: true }],
    [
      { path: "/commands/0/extra", message: NOT_ENVELOPE },
      { path: "/commands/0/origin", message: "the command has no origin" },
    ],
  ],
  [
    "a command that is not a record",
    [7, valid(1)],
    [{ path: "/commands/0", message: NOT_COMMAND }],
  ],
  [
    "commands that are not an array",
    { 0: valid(0) },
    [{ path: "/commands", message: "the commands must be an array of commands" }],
  ],
];

describe("step rejects invalid commands before changing anything", () => {
  test.each(cases)("%s: one invalid_input, the world unchanged", (_name, commands, issues) => {
    const world = stepWorld(putting());
    const control = stepWorld(putting());
    const before = observe(world);
    const error = engineErrorOf(() => step(world, commands as Command[]));
    expect(error.code).toBe("invalid_input");
    expect(error.issues).toEqual(issues);
    expect(observe(world)).toEqual(before);
    expect(step(world, [valid(0)])).toEqual(step(control, [valid(0)]));
    expect(observe(world)).toEqual(observe(control));
  });

  test("an invalid command applies none of the valid ones before it", () => {
    let applied = 0;
    const ruleset = stepRuleset([], { put: handler(() => (applied += 1)) });
    const world = stepWorld(ruleset);
    engineErrorOf(() => step(world, [valid(0), valid(1), command(1, 2, "")]));
    expect(applied).toBe(0);
  });

  test("accepts a payload of exactly 8 KiB, counting bytes and not UTF-16 code units", () => {
    const twoBytes = String.fromCharCode(0xe9);
    const world = stepWorld(putting());
    expect(() => step(world, [command(1, 0, "put", asciiOf(8192))])).not.toThrow();
    expect(() => step(world, [command(2, 0, "put", `${twoBytes.repeat(4095)}`)])).not.toThrow();
    const error = engineErrorOf(() => step(world, [command(3, 0, "put", twoBytes.repeat(4096))]));
    expect(error.issues).toEqual([
      {
        path: "/commands/0/payload",
        message: "the payload takes 8194 bytes of canonical UTF-8, more than the 8192 allowed",
      },
    ]);
  });

  test("accepts seq 0 and an inhabitant origin", () => {
    const world = stepWorld(putting());
    const origin = { kind: "inhabitant", actor: Number.MAX_SAFE_INTEGER } as const;
    expect(step(world, [from(origin, valid(0))]).stats.commands).toBe(1);
  });
});

describe("step reads each command once, through its own descriptors", () => {
  test("a command that throws while read is an issue with the thrown value as the cause", () => {
    const error = engineErrorOf(() =>
      step(stepWorld(putting()), [valid(0), revokedProxy() as Command]),
    );
    expect(error.code).toBe("invalid_input");
    expect(error.issues.map(({ path }) => path)).toEqual(["/commands/1"]);
    expect(error.issues[0]?.message).toStartWith("the object threw while being read: TypeError");
    expect(error.cause).toBeInstanceOf(TypeError);
  });

  test("an accessor in a command is an issue, and it never runs", () => {
    let calls = 0;
    const accessor = Object.defineProperty({ ...valid(0) }, "payload", {
      get: () => {
        calls += 1;
        return 1;
      },
      enumerable: true,
    });
    const error = engineErrorOf(() => step(stepWorld(putting()), [accessor as unknown as Command]));
    expect(error.issues).toEqual([
      {
        path: "/commands/0/payload",
        message: "the property is an accessor: only data properties are read",
      },
    ]);
    expect(calls).toBe(0);
  });
});
