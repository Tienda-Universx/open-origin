import { describe, expect, test } from "bun:test";
import { RECONNECT_BACKOFF, reconnectDelayMs } from "../src/public/index.ts";

/** The largest double below 1: the highest draw a uniform random number in [0, 1) can give. */
const TOP_DRAW = 1 - 2 ** -53;

/** Draws spread over [0, 1), both ends included. */
const DRAWS = [0, 0.001, 0.25, 0.5, 0.75, 0.999, TOP_DRAW];

describe("reconnectDelayMs", () => {
  test("the parameters are ADR 0026's: 0.5 s to 30 s, and 5 s after a 503", () => {
    expect(RECONNECT_BACKOFF).toEqual({ minMs: 500, maxMs: 30_000, afterUnavailableMs: 5000 });
  });

  test("the ceiling starts at 1 s and doubles with each attempt up to 30 s", () => {
    // Just below the ceiling: the lowest whole delay the top draw cannot exceed.
    const ceilings = Array.from({ length: 9 }, (_, attempt) => reconnectDelayMs(attempt, TOP_DRAW));
    expect(ceilings).toEqual([999, 1999, 3999, 7999, 15_999, 29_999, 29_999, 29_999, 29_999]);
  });

  test("the lowest draw waits the shortest delay at every attempt", () => {
    for (const attempt of [0, 1, 5, 40]) expect(reconnectDelayMs(attempt, 0)).toBe(500);
  });

  test("the delay is spread uniformly over [0.5 s, ceiling)", () => {
    expect(DRAWS.map((draw) => reconnectDelayMs(2, draw))).toEqual([
      500, 503, 1375, 2250, 3125, 3996, 3999,
    ]);
  });

  test("every delay is a whole number of milliseconds from 0.5 s to below 30 s", () => {
    for (let attempt = 0; attempt <= 64; attempt += 1) {
      for (const draw of DRAWS) {
        const delay = reconnectDelayMs(attempt, draw);
        expect(Number.isInteger(delay)).toBe(true);
        expect(delay).toBeGreaterThanOrEqual(500);
        expect(delay).toBeLessThan(30_000);
      }
    }
  });

  test("after a 503, the delay is spread over [5 s, the larger of the ceiling and 10 s)", () => {
    const after503 = (attempt: number) =>
      [0, 0.5, TOP_DRAW].map((draw) => reconnectDelayMs(attempt, draw, true));
    // Ceilings of 1, 2, 4, and 8 s: clients refused together do not all return at 5 s.
    for (const attempt of [0, 1, 2, 3]) expect(after503(attempt)).toEqual([5000, 7500, 9999]);
    // A ceiling of 16 s, then of 30 s.
    expect(after503(4)).toEqual([5000, 10_500, 15_999]);
    expect(after503(5)).toEqual([5000, 17_500, 29_999]);
    expect(reconnectDelayMs(5, TOP_DRAW, false)).toBe(29_999);
  });

  test("after a 503, every delay is a whole number of milliseconds from 5 s to below 30 s", () => {
    for (let attempt = 0; attempt <= 64; attempt += 1) {
      for (const draw of DRAWS) {
        const delay = reconnectDelayMs(attempt, draw, true);
        expect(Number.isInteger(delay)).toBe(true);
        expect(delay).toBeGreaterThanOrEqual(5000);
        expect(delay).toBeLessThan(30_000);
      }
    }
  });

  test("the largest attempt still caps at 30 s, without a long loop", () => {
    expect(reconnectDelayMs(Number.MAX_SAFE_INTEGER, TOP_DRAW)).toBe(29_999);
  });

  test("rejects an attempt that is not a non-negative safe integer", () => {
    for (const attempt of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => reconnectDelayMs(attempt, 0)).toThrow(RangeError);
    }
  });

  test("rejects a draw outside [0, 1)", () => {
    for (const draw of [1, -0.001, 1.5, Number.NaN, Number.NEGATIVE_INFINITY]) {
      expect(() => reconnectDelayMs(0, draw)).toThrow(RangeError);
    }
  });
});
