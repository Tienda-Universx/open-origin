/**
 * Arithmetic modulo 2^128 over four u32 lanes, most significant first, the order in which a
 * digest writes h1 to h4 (ADR 0020: the state root sums chunk digests this way). Each lane holds
 * at most 2^32 - 1, so every intermediate sum or difference is an exact integer below 2^33 in
 * magnitude, and `>>> 0` reduces it modulo 2^32.
 */

/** A 128-bit integer as four u32 lanes, most significant first. */
export type Lanes = readonly [number, number, number, number];

const carryOf = (sum: number): number => (sum > 0xffffffff ? 1 : 0);
const borrowOf = (difference: number): number => (difference < 0 ? 1 : 0);

/** `a + b` modulo 2^128. */
export function addLanes([a0, a1, a2, a3]: Lanes, [b0, b1, b2, b3]: Lanes): Lanes {
  const s3 = a3 + b3;
  const s2 = a2 + b2 + carryOf(s3);
  const s1 = a1 + b1 + carryOf(s2);
  const s0 = a0 + b0 + carryOf(s1);
  return [s0 >>> 0, s1 >>> 0, s2 >>> 0, s3 >>> 0];
}

/** `a - b` modulo 2^128. */
export function subtractLanes([a0, a1, a2, a3]: Lanes, [b0, b1, b2, b3]: Lanes): Lanes {
  const d3 = a3 - b3;
  const d2 = a2 - b2 - borrowOf(d3);
  const d1 = a1 - b1 - borrowOf(d2);
  const d0 = a0 - b0 - borrowOf(d1);
  return [d0 >>> 0, d1 >>> 0, d2 >>> 0, d3 >>> 0];
}
