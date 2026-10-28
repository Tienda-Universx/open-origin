import { type CanonicalValue, step, type World } from "../../src/index.ts";
import { type StepRuleset, stepRuleset, stepWorld, system, writable } from "./step-rulesets.ts";

/**
 * The worlds whose ticks the complexity test (step-cost.test.ts) and the benchmark (bench/step.ts)
 * time, shared so that both measure the same tick: D = 10 chunks changed per tick, in worlds of
 * any size; and the way the complexity tests (step-cost.test.ts, beings-cost.test.ts) time two
 * worlds against each other.
 */

/** The ten chunks that change every tick, present in every world of at least ten chunks. */
export const DIRTY_KEYS: readonly string[] = Array.from({ length: 10 }, (_, x) => `${x},0`);

/** A ruleset whose one system writes the counter `n` of every DIRTY_KEYS chunk every tick. */
export const dirtying: StepRuleset = stepRuleset([
  system("dirty", (ctx) => {
    for (const key of DIRTY_KEYS) writable(ctx, key).n = ctx.tick;
  }),
]);

/** A world of `count` chunks, keyed on rows of 1,000, each made by `chunk`, run by `ruleset`. */
export function sizedWorld(count: number, chunk: () => CanonicalValue, ruleset = dirtying): World {
  const chunks: { [key: string]: CanonicalValue } = {};
  for (let index = 0; index < count; index += 1) {
    chunks[`${index % 1000},${Math.floor(index / 1000)}`] = chunk();
  }
  return stepWorld(ruleset, { chunks });
}

/** The median of `values`: the middle one once sorted, or the upper of the two in the middle. */
export function median(values: readonly number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[sorted.length >> 1] ?? 0;
}

/** How many ticks of each world warm the JIT up, and how many are then timed. */
type Rounds = { readonly warmUp: number; readonly measured: number };

/**
 * The median duration of a tick of `small` and of `large`, in nanoseconds, and their ratio, large
 * over small. Both worlds step alternately, tick by tick, so that a drift of the machine or the JIT
 * affects them alike; `rounds.warmUp` ticks of each run before any is timed.
 */
export function alternatingMedians(small: World, large: World, rounds: Rounds) {
  const times: [number[], number[]] = [[], []];
  for (let round = 0; round < rounds.warmUp + rounds.measured; round += 1) {
    [small, large].forEach((world, index) => {
      const start = Bun.nanoseconds();
      step(world, []);
      if (round >= rounds.warmUp) times[index]?.push(Bun.nanoseconds() - start);
    });
  }
  const [smallMedian, largeMedian] = times.map(median) as [number, number];
  return { smallMedian, largeMedian, ratio: largeMedian / smallMedian };
}
