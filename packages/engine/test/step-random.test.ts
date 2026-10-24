import { describe, expect, test } from "bun:test";
import { DrawSequence, mix32, type Seed, step, streamId, tickKey } from "../src/index.ts";
import { command, handler, stepRuleset, stepWorld, system } from "./support/step-rulesets.ts";

/**
 * Randomness during a tick (ADR 0020, randomness): draws for an entity use the key
 * tickKey(tick, entity) on the owner's own stream, with a counter per (stream, entity) that
 * continues across calls within a tick and restarts the next tick.
 */

const SEED: Seed = [1, 2];
const draw = (stream: string, tick: number, entity: number, n: number) =>
  mix32(SEED, streamId(stream), tickKey(tick, entity), n);

describe("tick randomness", () => {
  test("continues per (stream, entity) across calls within a tick, and restarts the next", () => {
    const draws: number[][] = [];
    const ruleset = stepRuleset([], {
      roll: handler(
        (ctx) => {
          draws.push([ctx.random.u32("dice", 1), ctx.random.u32("dice", 1)]);
        },
        ["dice"],
      ),
    });
    const world = stepWorld(ruleset);
    step(world, [command(1, 0, "roll"), command(1, 1, "roll")]);
    step(world, [command(2, 0, "roll")]);
    expect(draws).toEqual([
      [draw("dice", 1, 1, 0), draw("dice", 1, 1, 1)],
      [draw("dice", 1, 1, 2), draw("dice", 1, 1, 3)],
      [draw("dice", 2, 1, 0), draw("dice", 2, 1, 1)],
    ]);
  });

  test("an entity's draws depend neither on another entity's nor on another stream's", () => {
    /** Entity 2's draws in a tick where entity 1 draws `first` times and "other" `extra` times. */
    const entityTwo = (first: number, extra: number) => {
      let seen: number[] = [];
      const ruleset = stepRuleset([
        system(
          "other",
          (ctx) => {
            for (let n = 0; n < extra; n += 1) ctx.random.u32("other", 2);
          },
          ["other"],
        ),
        system(
          "dice",
          (ctx) => {
            for (let n = 0; n < first; n += 1) ctx.random.u32("dice", 1);
            seen = [ctx.random.u32("dice", 2), ctx.random.u32("dice", 2)];
          },
          ["dice"],
        ),
      ]);
      step(stepWorld(ruleset), []);
      return seen;
    };
    const control = [draw("dice", 1, 2, 0), draw("dice", 1, 2, 1)];
    expect(entityTwo(0, 0)).toEqual(control);
    expect(entityTwo(5, 0)).toEqual(control);
    expect(entityTwo(0, 7)).toEqual(control);
  });

  test("int and permutation are a DrawSequence keyed by the tick and the entity or resource", () => {
    const seen: unknown[] = [];
    const ruleset = stepRuleset([
      system(
        "conflicts",
        (ctx) => {
          seen.push(ctx.random.int("conflicts", 3, 6), ctx.random.permutation("conflicts", 42, 5));
        },
        ["conflicts"],
      ),
    ]);
    step(stepWorld(ruleset), []);
    const id = streamId("conflicts");
    expect(seen).toEqual([
      new DrawSequence(SEED, id, tickKey(1, 3)).int(6),
      new DrawSequence(SEED, id, tickKey(1, 42)).permutation(5),
    ]);
  });

  test("u32 and int for an entity share one sequence with permutation for the same id", () => {
    let seen: unknown[] = [];
    const ruleset = stepRuleset([
      system(
        "mixed",
        (ctx) => {
          seen = [
            ctx.random.u32("mixed", 7),
            ctx.random.int("mixed", 7, 10),
            ctx.random.permutation("mixed", 7, 4),
          ];
        },
        ["mixed"],
      ),
    ]);
    step(stepWorld(ruleset), []);
    const sequence = new DrawSequence(SEED, streamId("mixed"), tickKey(1, 7));
    expect(seen).toEqual([sequence.u32(), sequence.int(10), sequence.permutation(4)]);
  });

  test("separate streams keep an entity's draws and a resource's permutation independent", () => {
    /** The permutation for resource 7 after `draws` draws for entity 7 in another stream. */
    const permutationAfter = (draws: number) => {
      let seen: number[] = [];
      const ruleset = stepRuleset([
        system(
          "split",
          (ctx) => {
            for (let n = 0; n < draws; n += 1) ctx.random.u32("entities", 7);
            seen = ctx.random.permutation("resources", 7, 6);
          },
          ["entities", "resources"],
        ),
      ]);
      step(stepWorld(ruleset), []);
      return seen;
    };
    const control = new DrawSequence(SEED, streamId("resources"), tickKey(1, 7)).permutation(6);
    expect(permutationAfter(0)).toEqual(control);
    expect(permutationAfter(9)).toEqual(control);
  });
});
