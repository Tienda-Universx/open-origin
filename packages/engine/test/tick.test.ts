import { describe, expect, test } from "bun:test";
import { nextTick, simSeconds } from "../src/index.ts";
import { engineErrorOf } from "./support/engine-error.ts";

/**
 * Simulation time (ADR 0020, plan §5.2): the engine knows only ticks, safe integers from 0, and
 * simSeconds(tick) = tick * simSecondsPerTick. Overflow past Number.MAX_SAFE_INTEGER is
 * tick_overflow; anything that is not a tick, or not a positive number of seconds, is invalid_value.
 */

const MAX = Number.MAX_SAFE_INTEGER;

describe("nextTick", () => {
  test("adds one, up to the largest safe integer", () => {
    expect(nextTick(0)).toBe(1);
    expect(nextTick(41)).toBe(42);
    expect(nextTick(MAX - 1)).toBe(MAX);
  });

  test("throws tick_overflow at the largest safe integer, which has no safe successor", () => {
    const error = engineErrorOf(() => nextTick(MAX));
    expect(error.code).toBe("tick_overflow");
    expect(error.issues).toEqual([
      { path: "", message: `the tick ${MAX} is the last one: the next is not a safe integer` },
    ]);
  });

  test.each([
    ["-1", -1],
    ["-0", -0],
    ["1.5", 1.5],
    ["2^53", MAX + 1],
    ["NaN", Number.NaN],
  ])("rejects %s, which is not a tick", (_name, tick) => {
    const error = engineErrorOf(() => nextTick(tick));
    expect(error.code).toBe("invalid_value");
    expect(error.issues).toEqual([
      {
        path: "",
        message: `${Object.is(tick, -0) ? "-0" : tick} is not a tick: ticks are safe integers from 0`,
      },
    ]);
  });
});

describe("simSeconds", () => {
  test("multiplies the tick by the seconds per tick", () => {
    expect(simSeconds(0, 60)).toBe(0);
    expect(simSeconds(37, 60)).toBe(2_220);
    expect(simSeconds(MAX, 1)).toBe(MAX);
    // 3 * 3,002,399,751,580,330 = 9,007,199,254,740,990, one below the largest safe integer.
    expect(simSeconds(3_002_399_751_580_330, 3)).toBe(MAX - 1);
  });

  test("throws tick_overflow when the product is not a safe integer", () => {
    for (const [tick, perTick] of [
      [MAX, 2],
      [3_002_399_751_580_331, 3],
      [2 ** 26, 2 ** 27],
    ] as const) {
      const error = engineErrorOf(() => simSeconds(tick, perTick));
      expect(error.code).toBe("tick_overflow");
      expect(error.issues).toEqual([
        {
          path: "",
          message: `tick ${tick} at ${perTick} seconds per tick is beyond the largest safe integer`,
        },
      ]);
    }
  });

  test("reports an invalid tick and invalid seconds per tick together, as invalid_value", () => {
    const error = engineErrorOf(() => simSeconds(-1, 0));
    expect(error.code).toBe("invalid_value");
    expect(error.issues).toEqual([
      { path: "/tick", message: "-1 is not a tick: ticks are safe integers from 0" },
      {
        path: "/simSecondsPerTick",
        message: "0 seconds per tick is not a positive safe integer",
      },
    ]);
    expect(engineErrorOf(() => simSeconds(-0, 1)).issues).toEqual([
      { path: "/tick", message: "-0 is not a tick: ticks are safe integers from 0" },
    ]);
    for (const perTick of [1.5, -60, -0, MAX + 1, Number.NaN]) {
      expect(engineErrorOf(() => simSeconds(1, perTick)).issues.map(({ path }) => path)).toEqual([
        "/simSecondsPerTick",
      ]);
    }
  });
});
