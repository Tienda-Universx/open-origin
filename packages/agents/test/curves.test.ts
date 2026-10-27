/**
 * The arithmetic of utility (plan §5.3): response curves, the compensated product of
 * considerations, and traits that scale a need, all in integer permille.
 */
import { describe, expect, test } from "bun:test";
import { compensated, felt, respond } from "../src/brain/curves.ts";

describe("respond", () => {
  const rising = [100, 0, 200, 1000, 400, 1000];

  test("holds the first and the last value outside its points", () => {
    expect(respond(rising, -5)).toBe(0);
    expect(respond(rising, 100)).toBe(0);
    expect(respond(rising, 400)).toBe(1000);
    expect(respond(rising, 10_000)).toBe(1000);
  });

  test("follows the line between two points, rounded down, and passes through each point", () => {
    expect(respond(rising, 150)).toBe(500);
    expect(respond(rising, 101)).toBe(10);
    expect(respond(rising, 199)).toBe(990);
    expect(respond(rising, 200)).toBe(1000);
    expect(respond(rising, 300)).toBe(1000);
    // A third of the way: 1000/3 rounds down to 333.
    expect(respond([0, 0, 3, 1000], 1)).toBe(333);
  });

  test("falls along a falling curve, rounding toward minus infinity", () => {
    const falling = [100, 1000, 200, 0];
    expect(respond(falling, 100)).toBe(1000);
    expect(respond(falling, 101)).toBe(990);
    expect(respond(falling, 199)).toBe(10);
    expect(respond(falling, 200)).toBe(0);
    // 1000 − 1000/3: the slope's −333.3… rounds down to −334.
    expect(respond([0, 1000, 3, 0], 1)).toBe(666);
  });

  test("steps where two points are one unit apart", () => {
    const step = [400, 0, 401, 700, 700, 1000];
    expect(respond(step, 400)).toBe(0);
    expect(respond(step, 401)).toBe(700);
    expect(respond(step, 550)).toBe(849);
  });
});

describe("compensated", () => {
  test("multiplies considerations, each lifted by (1 − c)·(1 − 1/n)·c", () => {
    // n = 2: 500 + 500·500·500/10^6 = 625, and 625·625/1000 = 390.
    expect(compensated([500, 500])).toBe(390);
    // n = 1 lifts nothing.
    expect(compensated([500])).toBe(500);
    // n = 4: 500 + ⌊500·750·500/10^6⌋ = 687, then 687, 471, 323, 221, rounded down at each step.
    expect(compensated([500, 500, 500, 500])).toBe(221);
  });

  test("lets a zero veto the behavior and a full consideration leave the rest whole", () => {
    expect(compensated([0, 1000, 1000])).toBe(0);
    expect(compensated([1000, 1000])).toBe(1000);
    expect(compensated([1000, 700])).toBe(805);
    expect(compensated([])).toBe(0);
  });

  test("rises with every consideration", () => {
    let previous = -1;
    for (let value = 0; value <= 1000; value += 50) {
      const score = compensated([value, 800]);
      expect(score).toBeGreaterThan(previous);
      previous = score;
    }
  });
});

describe("felt", () => {
  test("scales a need by a trait in permille, at most fully", () => {
    expect(felt(500, 1200)).toBe(600);
    expect(felt(500, 800)).toBe(400);
    expect(felt(999, 1001)).toBe(999);
    expect(felt(999, 1002)).toBe(1000);
    expect(felt(900, 1200)).toBe(1000);
    expect(felt(333, 1000)).toBe(333);
  });
});
