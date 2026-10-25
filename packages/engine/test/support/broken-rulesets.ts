import type { Seed, World } from "../../src/index.ts";
import { createWorld } from "../../src/index.ts";
import type { SuiteRuleset } from "./determinism-records.ts";
import type { DeterminismSubject } from "./determinism-suite.ts";
import { type Ctx, type Data, stepRuleset, system, writable } from "./step-rulesets.ts";

/**
 * Negative controls of the determinism suite (plan §8 "Controles negativos"): rulesets broken on
 * purpose, each in a way one property of the suite must catch. Each export is a factory, as
 * DeterminismSubject.ruleset names one, so the child process can import it by name.
 *
 * The state some of them keep outside the world is the defect under test. This module is
 * imported by the suite's tests and by the child process only.
 */

/** A system that counts in chunk 0,0 every tick, so that every run has something to compare. */
const counting = system("counting", (ctx) => {
  writable(ctx, "0,0").count = ctx.tick;
});

/** The tick at which writesThroughReadChunk bypasses the barrier. */
export const BYPASS_TICK = 5;

/** Writes through readChunk at BYPASS_TICK: audit, and encoding without it, must find it. */
export function writesThroughReadChunk(): SuiteRuleset {
  return stepRuleset([
    counting,
    system("sneaky", (ctx) => {
      if (ctx.tick === BYPASS_TICK) (ctx.readChunk("1,0") as Data).grass = 99;
    }),
  ]);
}

/**
 * Remembers in chunk 0,0 the first key of a record, in insertion order (Object.keys), where it
 * adds one key every tick. A fresh world inserts k2, k4, k1, k3, k0; a decoded one has its keys
 * in canonical order, as JSON.parse inserts them. So the first key changes only after a resume
 * from a tick with two keys or more, which no run from tick 0 reaches.
 */
export function dependsOnInsertionOrder(): SuiteRuleset {
  return stepRuleset([
    system("ordering", (ctx) => {
      const chunk = writable(ctx, "0,0");
      const order = (chunk.order ?? {}) as Data;
      order[`k${(ctx.tick * 7) % 5}`] = ctx.tick;
      chunk.order = order;
      chunk.first = Object.keys(order)[0] ?? "";
    }),
  ]);
}

/**
 * The tick at which each chunk was first written, kept in the module: every run in one process
 * finds the ticks of the first run, which are the ticks it would have set itself, while a fresh
 * process starts empty and sets them at the tick it resumes from.
 */
const firstWritten = new Map<string, number>();

/** Writes into chunk 0,0 its age, from a module-level cache: only a fresh process sees it. */
export function keepsModuleCache(): SuiteRuleset {
  return stepRuleset([
    system("aging", (ctx) => {
      if (!firstWritten.has("0,0")) firstWritten.set("0,0", ctx.tick);
      writable(ctx, "0,0").age = ctx.tick - (firstWritten.get("0,0") ?? 0);
    }),
  ]);
}

/** The same cache, kept by each ruleset object: only a resume with a fresh ruleset sees it. */
export function keepsRulesetCache(): SuiteRuleset {
  const seen = new Map<string, number>();
  return stepRuleset([
    system("aging", (ctx: Ctx) => {
      if (!seen.has("0,0")) seen.set("0,0", ctx.tick);
      writable(ctx, "0,0").age = ctx.tick - (seen.get("0,0") ?? 0);
    }),
  ]);
}

/** A system that returns a Promise, as an `async` one would: a fault at tick 1. */
export function returnsPromise(): SuiteRuleset {
  return stepRuleset([
    counting,
    {
      name: "eager",
      streams: [],
      run: () => Promise.resolve() as unknown as undefined,
    },
  ]);
}

/** How many times sharesCounter's system has run, in this process: state shared between runs. */
let calls = 0;

/** Writes into chunk 0,0 a counter that every run in this process shares. */
export function sharesCounter(): SuiteRuleset {
  return stepRuleset([
    system("counter", (ctx) => {
      calls += 1;
      writable(ctx, "0,0").calls = calls;
    }),
  ]);
}

/** A world of two chunks for the controls. */
function controlWorld(seed: Seed, ruleset: SuiteRuleset, audit: boolean): World {
  return createWorld(
    {
      seed,
      simSecondsPerTick: 60,
      global: { population: 0 },
      chunks: { "0,0": { grass: 1 }, "1,0": { grass: 2 } },
      ruleset,
    },
    { audit },
  );
}

/** How many ticks each control runs. */
export const CONTROL_TICKS = 12;

/** The subject that runs the control `name` for CONTROL_TICKS ticks, with these cuts. */
export function controlSubject(
  name: string,
  cuts: readonly number[],
  childCuts: readonly number[] = [],
): DeterminismSubject {
  return {
    ruleset: { module: import.meta.url, name },
    world: controlWorld,
    seeds: [
      [1, 2],
      [3, 4],
    ],
    ticks: CONTROL_TICKS,
    commands: () => [],
    cuts,
    childCuts,
  };
}
