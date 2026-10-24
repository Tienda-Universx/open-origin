import {
  type CanonicalValue,
  type Command,
  type CommandHandler,
  type CommandOrigin,
  createWorld,
  type Ruleset,
  type RulesetSystem,
  type TickContext,
  type World,
} from "../../src/index.ts";

/**
 * Small rulesets for the step tests (plan §8): each test builds the systems and handlers it needs,
 * and every part returns fresh objects, so a test can change them freely.
 */

export type Value = CanonicalValue;
export type Ctx = TickContext<Value, Value>;
export type StepRuleset = Ruleset<Value, Value>;
export type System = RulesetSystem<Value, Value>;
export type Handler = CommandHandler<Value, Value>;

/** A mutable record, as ruleset code sees a chunk or the global value it writes. */
export type Data = { [key: string]: Value };

/** A ruleset with these systems and handlers, whose validators accept everything. */
export function stepRuleset(
  systems: readonly System[] = [],
  commands: { readonly [type: string]: Handler } = {},
): StepRuleset {
  return {
    versions: { ruleset: "step-test@1", generator: "flat@1", brain: "none@1" },
    systems,
    commands,
    validateGlobal: () => [],
    validateChunk: () => [],
  };
}

/** A system named `name` that runs `body` and returns undefined, drawing from `streams`. */
export function system(name: string, body: (ctx: Ctx) => void, streams: string[] = []): System {
  return {
    name,
    streams,
    run: (ctx) => {
      body(ctx);
      return undefined;
    },
  };
}

/** A handler whose `check` accepts every command and whose `apply` runs `body`. */
export function handler(body: (ctx: Ctx, command: Command) => void, streams?: string[]): Handler {
  const apply = (ctx: Ctx, command: Command) => {
    body(ctx, command);
    return undefined;
  };
  return streams === undefined
    ? { check: () => undefined, apply }
    : { streams, check: () => undefined, apply };
}

/** The data of a world for the step tests: two chunks and a global record. */
export type WorldData = { readonly global?: Value; readonly chunks?: { [key: string]: Value } };

/** A world at tick 0 with seed [1, 2] and `ruleset`. */
export function stepWorld(ruleset: StepRuleset, data: WorldData = {}, audit = false): World {
  return createWorld(
    {
      seed: [1, 2],
      simSecondsPerTick: 60,
      global: data.global ?? { population: 0 },
      chunks: data.chunks ?? { "0,0": { grass: 1 }, "1,0": { grass: 2 } },
      ruleset,
    },
    { audit },
  );
}

/** A command from the admin plane, with `payload` or an empty record. */
export function command(
  applyTick: number,
  seq: number,
  type: string,
  payload: Value = {},
): Command {
  return { applyTick, seq, type, origin: { kind: "admin" }, payload };
}

/** `base` sent by `origin`. */
export function from(origin: CommandOrigin, base: Command): Command {
  return { ...base, origin };
}

/** The chunk `key` of `ctx`, to write into. */
export function writable(ctx: Ctx, key: string): Data {
  return ctx.writeChunk(key) as Data;
}
