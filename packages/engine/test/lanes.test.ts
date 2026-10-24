import { describe, expect, test } from "bun:test";
import { addLanes, type Lanes, subtractLanes } from "../src/digest/lanes.ts";
import { Sfc32 } from "./support/sfc32.ts";

/**
 * Arithmetic modulo 2^128 over four u32 lanes, most significant first (ADR 0020: chunk digests
 * are summed this way). BigInt, which tests may use, gives the expected values.
 */

const U32 = 2n ** 32n;
const U128 = 2n ** 128n;
const MAX = 0xffffffff;

function toBigInt(lanes: Lanes): bigint {
  return lanes.reduce((total, lane) => total * U32 + BigInt(lane), 0n);
}

function fromBigInt(value: bigint): Lanes {
  const lane = (index: bigint) => Number((value >> (32n * index)) % U32);
  return [lane(3n), lane(2n), lane(1n), lane(0n)];
}

/** Random lanes, half of them at 0 or 2^32 - 1 so that carries and borrows run far. */
function randomLanes(random: Sfc32): Lanes {
  const lane = () => random.pick([0, MAX, random.next(), random.next()]);
  return [lane(), lane(), lane(), lane()];
}

describe("addLanes and subtractLanes", () => {
  test("carry from the least significant lane through every lane", () => {
    expect(addLanes([MAX, MAX, MAX, MAX], [0, 0, 0, 1])).toEqual([0, 0, 0, 0]);
    expect(addLanes([0, 0, 0, MAX], [0, 0, 0, 1])).toEqual([0, 0, 1, 0]);
    expect(addLanes([0, MAX, MAX, 0], [0, 0, 1, 0])).toEqual([1, 0, 0, 0]);
  });

  test("borrow from the least significant lane through every lane", () => {
    expect(subtractLanes([0, 0, 0, 0], [0, 0, 0, 1])).toEqual([MAX, MAX, MAX, MAX]);
    expect(subtractLanes([0, 0, 1, 0], [0, 0, 0, 1])).toEqual([0, 0, 0, MAX]);
    expect(subtractLanes([1, 0, 0, 0], [0, 0, 1, 0])).toEqual([0, MAX, MAX, 0]);
  });

  test("agree with BigInt modulo 2^128, and subtracting undoes adding", () => {
    const random = new Sfc32(31);
    for (let sample = 0; sample < 2_000; sample += 1) {
      const a = randomLanes(random);
      const b = randomLanes(random);
      const sum = addLanes(a, b);
      expect(sum).toEqual(fromBigInt((toBigInt(a) + toBigInt(b)) % U128));
      expect(subtractLanes(a, b)).toEqual(fromBigInt((toBigInt(a) - toBigInt(b) + U128) % U128));
      expect(subtractLanes(sum, b)).toEqual(a);
    }
  });

  test("a sum does not depend on the order of its terms", () => {
    const random = new Sfc32(32);
    const terms = Array.from({ length: 50 }, () => randomLanes(random));
    const zero: Lanes = [0, 0, 0, 0];
    const forward = terms.reduce(addLanes, zero);
    const backward = [...terms].reverse().reduce(addLanes, zero);
    expect(backward).toEqual(forward);
    expect(toBigInt(forward)).toBe(
      terms.reduce((total, term) => total + toBigInt(term), 0n) % U128,
    );
  });
});
