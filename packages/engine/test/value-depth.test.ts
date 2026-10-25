import { describe, expect, test } from "bun:test";
import {
  canonicalize,
  createWorld,
  decodeSnapshot,
  encodeSnapshot,
  fullChecksum,
  parseCanonical,
  stateRoot,
  step,
  worldStatus,
} from "../src/index.ts";
import { STALE_CHUNK } from "./support/barrier-rulesets.ts";
import { engineErrorOf } from "./support/engine-error.ts";
import {
  type Ctx,
  type Data,
  handler,
  stepRuleset,
  stepWorld,
  system,
  type Value,
} from "./support/step-rulesets.ts";

/**
 * Nesting depth (ADR 0020, canonical values): a value nests at most 64 arrays and records,
 * counted from its own root. The engine's envelopes never consume that budget: the digest tags,
 * the events list and event records, and the snapshot document. So a value that createWorld or a
 * step accepts is one that encodeSnapshot writes and decodeSnapshot restores, wherever it lives.
 */

/** `n` records `{ k: ... }` around 1: a value that nests exactly `n` levels. */
function nest(n: number): Value {
  let value: Value = 1;
  for (let level = 0; level < n; level += 1) value = { k: value };
  return value;
}

/** The canonical text of `nest(n)`, written by hand because canonicalize refuses more than 64. */
const nestText = (n: number) => `${'{"k":'.repeat(n)}1${"}".repeat(n)}`;

/** The path of the first container that is too deep, in a value whose every key is "k". */
const TOO_DEEP = "/k".repeat(64);
const TOO_DEEP_MESSAGE = "the value nests deeper than 64 arrays and records";

/** A chunk 0,0 that nests `n` levels. */
const chunkOf = (n: number): Data => ({ grass: 1, k: nest(n - 1) });
const globalOf = (n: number): Data => ({ population: 0, k: nest(n - 1) });

const init = (global: Value, chunk: Value) => ({
  seed: [1, 2] as [number, number],
  simSecondsPerTick: 60,
  global,
  chunks: { "0,0": chunk },
  ruleset: stepRuleset(),
});

/** A ruleset whose system `deepener` writes a chunk and the global value `levels` levels deep. */
function deepening(levels: number) {
  return stepRuleset([
    system("deepener", (ctx) => {
      (ctx.writeChunk("0,0") as Data).k = nest(levels - 1);
      (ctx.writeGlobal() as Data).k = nest(levels - 1);
    }),
  ]);
}

describe("createWorld", () => {
  test("accepts a global value and a chunk of 64 levels", () => {
    const world = createWorld(init(globalOf(64), chunkOf(64)));
    expect(stateRoot(world)).toBe(fullChecksum(world));
  });

  test("refuses a global value of 65 levels at its own path", () => {
    const error = engineErrorOf(() => createWorld(init(globalOf(65), chunkOf(1))));
    expect(error.code).toBe("invalid_input");
    expect(error.issues).toEqual([{ path: `/init/global${TOO_DEEP}`, message: TOO_DEEP_MESSAGE }]);
  });

  test("refuses a chunk of 65 levels at its own path", () => {
    const error = engineErrorOf(() => createWorld(init(globalOf(1), chunkOf(65))));
    expect(error.code).toBe("invalid_input");
    expect(error.issues).toEqual([
      { path: `/init/chunks/0,0${TOO_DEEP}`, message: TOO_DEEP_MESSAGE },
    ]);
  });
});

describe("a step that writes values of 64 levels", () => {
  test("commits them, and the snapshot restores the same world", () => {
    const world = stepWorld(deepening(64));
    step(world, []);
    expect(stateRoot(world)).toBe(fullChecksum(world));
    const text = encodeSnapshot(world);
    const restored = decodeSnapshot(text, deepening(64));
    expect(stateRoot(restored)).toBe(stateRoot(world));
    expect(encodeSnapshot(restored)).toBe(text);
  });

  test("a world made of values of 64 levels restores too", () => {
    const world = createWorld(init(globalOf(64), chunkOf(64)));
    const text = encodeSnapshot(world);
    const restored = decodeSnapshot(text, stepRuleset());
    expect(stateRoot(restored)).toBe(stateRoot(world));
    expect(encodeSnapshot(restored)).toBe(text);
  });

  test.each([
    ["chunk", "/chunks/0,0", (ctx: Ctx) => ((ctx.writeChunk("0,0") as Data).k = nest(64))],
    ["global value", "/global", (ctx: Ctx) => ((ctx.writeGlobal() as Data).k = nest(64))],
  ])("faults when the %s has 65 levels", (_name, path, write) => {
    const world = stepWorld(stepRuleset([system("deepener", (ctx) => void write(ctx))]));
    const error = engineErrorOf(() => step(world, []));
    expect(error.code).toBe("system_fault");
    expect(error.issues).toEqual([{ path: `${path}${TOO_DEEP}`, message: TOO_DEEP_MESSAGE }]);
    expect(worldStatus(world)).toMatchObject({ kind: "faulted", code: "system_fault" });
  });
});

describe("decodeSnapshot", () => {
  const text = encodeSnapshot(stepWorld(stepRuleset()));

  test.each([
    ["chunk", '"0,0":{"grass":1}', "/world/chunks/0,0", '"0,0":'],
    ["global value", '"global":{"population":0}', "/world/global", '"global":'],
  ])("refuses a %s of 65 levels at its own path", (_name, original, path, member) => {
    expect(text).toContain(original);
    const broken = text.replace(original, `${member}${nestText(65)}`);
    const error = engineErrorOf(() => decodeSnapshot(broken, stepRuleset()));
    expect(error.code).toBe("invalid_snapshot");
    expect(error.issues).toEqual([{ path: `${path}${TOO_DEEP}`, message: TOO_DEEP_MESSAGE }]);
  });

  test("accepts a chunk of 64 levels beside a global value that is too deep, and reports only it", () => {
    const broken = text
      .replace('"0,0":{"grass":1}', `"0,0":${nestText(64)}`)
      .replace('"global":{"population":0}', `"global":${nestText(65)}`);
    const { issues } = engineErrorOf(() => decodeSnapshot(broken, stepRuleset()));
    expect(issues.map((issue) => issue.path)).toEqual([`/world/global${TOO_DEEP}`]);
  });
});

describe("events", () => {
  const emitting = (levels: number) =>
    stepRuleset([system("talker", (ctx) => ctx.emit("said", nest(levels)))]);

  test("a payload of 64 levels is committed and comes back equal", () => {
    const { events } = step(stepWorld(emitting(64)), []);
    expect(events[0]?.payload).toEqual(nest(64));
  });

  test("a payload of 65 levels is a fault of the system", () => {
    const world = stepWorld(emitting(65));
    const error = engineErrorOf(() => step(world, []));
    expect(error.code).toBe("system_fault");
    expect(error.issues).toEqual([
      {
        path: "/systems/0",
        message: `system "talker": emit: the payload is not canonical: at ${TOO_DEEP}: ${TOO_DEEP_MESSAGE}`,
      },
    ]);
  });

  test("a rejection with details of 63 levels is committed, with its event", () => {
    const ruleset = stepRuleset([], {
      odd: {
        check: () => ({ reason: "no", details: nest(63) }),
        apply: () => undefined,
      },
    });
    const { events } = step(stepWorld(ruleset), [
      { applyTick: 1, seq: 0, type: "odd", origin: { kind: "admin" }, payload: {} },
    ]);
    expect(events[0]).toMatchObject({
      type: "engine.command_rejected",
      payload: { reason: "no", details: nest(63) },
    });
  });

  test("a command payload of 64 levels is accepted", () => {
    const ruleset = stepRuleset([], { put: handler(() => undefined) });
    const result = step(stepWorld(ruleset), [
      { applyTick: 1, seq: 0, type: "put", origin: { kind: "admin" }, payload: nest(64) },
    ]);
    expect(result.events).toEqual([]);
  });
});

describe("integrity", () => {
  test("a valid chunk of 64 levels written behind the barrier is stale, not non-canonical", () => {
    const ruleset = stepRuleset([
      system("sneaky", (ctx) => {
        (ctx.readChunk("0,0") as Data).k = nest(63);
      }),
    ]);
    const error = engineErrorOf(() => step(stepWorld(ruleset, {}, true), []));
    expect(error.code).toBe("integrity_violation");
    expect(error.issues).toEqual([{ path: "/chunks/0,0", message: STALE_CHUNK }]);
  });
});

describe("the public canonical functions", () => {
  test("accept 64 levels and refuse 65", () => {
    expect(parseCanonical(nestText(64))).toEqual(nest(64));
    expect(canonicalize(nest(64))).toBe(nestText(64));
    const issues = [{ path: TOO_DEEP, message: TOO_DEEP_MESSAGE }];
    expect(engineErrorOf(() => canonicalize(nest(65))).issues).toEqual(issues);
    expect(engineErrorOf(() => parseCanonical(nestText(65))).issues).toEqual(issues);
  });
});
