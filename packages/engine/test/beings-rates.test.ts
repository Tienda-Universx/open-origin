/**
 * The exact arithmetic of the beings layer (ADR 0023): rates per simulated second applied in closed
 * form, the crossing of a level, and regrowth. Each closed form is checked against an oracle that
 * accumulates the same rate tick by tick with an exact rational remainder, which shares no code with
 * it, and at the bounds where a naive product would leave the safe integers.
 */
import { describe, expect, test } from "bun:test";
import { beings } from "../src/index.ts";
import { Sfc32 } from "./support/sfc32.ts";

const { NEED_MAX, RATIO_BOUNDS, ceilDiv, levelAt, scaledFloor, secondsToReach, takenAt } = beings;

/** ⌊num·seconds/den⌋ by repeated exact accumulation, one second-step of `step` at a time. */
function accumulated(num: number, den: number, seconds: number, step: number): number {
  let whole = 0;
  let remainder = 0;
  for (let elapsed = 0; elapsed < seconds; elapsed += step) {
    remainder += num * Math.min(step, seconds - elapsed);
    const carried = Math.floor(remainder / den);
    whole += carried;
    remainder -= carried * den;
  }
  return whole;
}

describe("scaledFloor", () => {
  test("is ⌊num·seconds/den⌋ on exact cases", () => {
    expect(scaledFloor({ num: 7, den: 10 }, 12, NEED_MAX)).toBe(8);
    expect(scaledFloor({ num: 7, den: 10 }, 120, NEED_MAX)).toBe(84);
    expect(scaledFloor({ num: 1, den: 3 }, 2, NEED_MAX)).toBe(0);
    expect(scaledFloor({ num: 1, den: 3 }, 3, NEED_MAX)).toBe(1);
    expect(scaledFloor({ num: 0, den: 5 }, 1_000_000, NEED_MAX)).toBe(0);
    expect(scaledFloor({ num: 5, den: 1 }, 0, NEED_MAX)).toBe(0);
  });

  test("saturates at its cap instead of leaving the safe integers", () => {
    const fastest = { num: RATIO_BOUNDS.num.max, den: 1 };
    expect(scaledFloor(fastest, Number.MAX_SAFE_INTEGER, NEED_MAX)).toBe(NEED_MAX);
    expect(scaledFloor({ num: 3, den: 7 }, Number.MAX_SAFE_INTEGER, 1000)).toBe(1000);
    // Exactly at the cap, and one second before it.
    expect(scaledFloor({ num: 3, den: 7 }, 2334, 1000)).toBe(1000);
    expect(scaledFloor({ num: 3, den: 7 }, 2333, 1000)).toBe(999);
  });

  test("stays exact where computing num·seconds directly would round to the wrong integer", () => {
    // Constructed so that num·seconds ≡ den − 1 (mod den): the exact quotient lies just below an
    // integer, and the product, which needs more than 53 bits, rounds up past it.
    const ratio = { num: 0xf_ffff, den: 4_294_967_291 };
    const seconds = 70_371_128_322_271;
    expect(Math.floor((ratio.num * seconds) / ratio.den)).toBe(17_180_434_886);
    expect(Number((BigInt(ratio.num) * BigInt(seconds)) / BigInt(ratio.den))).toBe(17_180_434_885);
    expect(scaledFloor(ratio, seconds, Number.MAX_SAFE_INTEGER)).toBe(17_180_434_885);
  });

  test("equals tick-by-tick exact accumulation on random rates and durations", () => {
    const random = new Sfc32(4401);
    for (let round = 0; round < 2000; round += 1) {
      const num = random.between(0, 5000);
      const den = random.between(1, 100_000);
      const step = random.between(1, 600);
      const seconds = step * random.between(0, 400);
      const cap = random.between(0, NEED_MAX);
      const expected = Math.min(cap, accumulated(num, den, seconds, step));
      expect(scaledFloor({ num, den }, seconds, cap)).toBe(expected);
    }
  });
});

describe("levelAt and secondsToReach", () => {
  test("move a level down or up from its anchor, clamped to [0, NEED_MAX]", () => {
    const rate = { num: 25, den: 2 };
    expect(levelAt(800_000, { rate, sign: -1 }, 1000)).toBe(787_500);
    expect(levelAt(10, { rate, sign: -1 }, 1000)).toBe(0);
    expect(levelAt(990_000, { rate, sign: 1 }, 1000)).toBe(NEED_MAX);
    expect(levelAt(500_000, { rate: { num: 0, den: 1 }, sign: 1 }, 10_000)).toBe(500_000);
  });

  test("give the first second at which a level reaches its target, exactly", () => {
    const falling = { rate: { num: 7, den: 10 }, sign: -1 as const };
    const seconds = secondsToReach(1000, falling, 400);
    expect(seconds).toBe(858);
    expect(levelAt(1000, falling, 858)).toBe(400);
    expect(levelAt(1000, falling, 857)).toBe(401);
    const rising = { rate: { num: 3, den: 1 }, sign: 1 as const };
    expect(secondsToReach(10, rising, 100)).toBe(30);
    expect(levelAt(10, rising, 29)).toBe(97);
  });

  test("give 0 for a target already reached, and undefined for one never reached", () => {
    const falling = { rate: { num: 1, den: 1 }, sign: -1 as const };
    expect(secondsToReach(400, falling, 400)).toBe(0);
    expect(secondsToReach(300, falling, 400)).toBe(0);
    expect(secondsToReach(400, { rate: { num: 0, den: 1 }, sign: -1 }, 100)).toBeUndefined();
    expect(secondsToReach(400, { rate: { num: 2, den: 1 }, sign: 1 }, 100)).toBe(0);
  });

  test("secondsToReach is the least second whose level reaches the target, on random cases", () => {
    const random = new Sfc32(4402);
    for (let round = 0; round < 2000; round += 1) {
      const rate = { num: random.between(1, 3000), den: random.between(1, 50_000) };
      const sign = random.below(2) === 0 ? (-1 as const) : (1 as const);
      const from = random.between(0, NEED_MAX);
      const target = random.between(0, NEED_MAX);
      const seconds = secondsToReach(from, { rate, sign }, target);
      const reached = (level: number) => (sign < 0 ? level <= target : level >= target);
      if (seconds === undefined) {
        expect(reached(levelAt(from, { rate, sign }, Number.MAX_SAFE_INTEGER))).toBe(false);
        continue;
      }
      expect(reached(levelAt(from, { rate, sign }, seconds))).toBe(true);
      if (seconds > 0) expect(reached(levelAt(from, { rate, sign }, seconds - 1))).toBe(false);
    }
  });
});

describe("ceilDiv", () => {
  test("rounds a non-negative quotient up", () => {
    expect(ceilDiv(0, 12)).toBe(0);
    expect(ceilDiv(1, 12)).toBe(1);
    expect(ceilDiv(12, 12)).toBe(1);
    expect(ceilDiv(13, 12)).toBe(2);
    expect(ceilDiv(Number.MAX_SAFE_INTEGER, 1)).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("takenAt", () => {
  test("regrows what was taken at its rate, never below 0", () => {
    const regrowth = { num: 1, den: 100 };
    expect(takenAt({ cell: 0, taken: 500, since: 10 }, regrowth, 0)).toBe(500);
    expect(takenAt({ cell: 0, taken: 500, since: 10 }, regrowth, 1250)).toBe(488);
    expect(takenAt({ cell: 0, taken: 500, since: 10 }, regrowth, 50_000)).toBe(0);
    expect(takenAt({ cell: 0, taken: 500, since: 10 }, regrowth, Number.MAX_SAFE_INTEGER)).toBe(0);
  });
});
