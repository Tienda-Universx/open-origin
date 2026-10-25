import { CHACHA20_INPUT_WORDS } from "../../src/rng/chacha.ts";
import { LATTICE_PURPOSES, NOISE_PURPOSES } from "../../src/worldgen/lattice.ts";
import { type CellRect, type NoiseSpec, noiseBound, Q16 } from "../../src/worldgen/noise.ts";
import { CHUNK_CELLS } from "../../src/worldgen/space.ts";
import { oracleTolerance } from "./noise-oracle.ts";

/**
 * Property checks of worldgen's noise (plan §12, tests 4–7, 9, and 17): each takes what it checks,
 * a region sampler, a fade, or a lattice packer, and returns its problems, empty when there are
 * none. They never compare against golden values, so a broken variant (broken-worldgen.ts) fails
 * them by breaking a property, and the real code passes them by keeping it.
 */

/** Samples the noise `spec` over the cells of `rect`, row by row, as sampleNoiseRegion does. */
export type RegionSampler = (spec: NoiseSpec, rect: CellRect) => Int32Array;

/** One use of terrain's pseudorandom function: a lattice point of a field, or an octave's offsets. */
export type LatticeUse =
  | {
      readonly kind: "point";
      readonly purpose: number;
      readonly octave: number;
      readonly x: number;
      readonly y: number;
    }
  | { readonly kind: "offset"; readonly purpose: number; readonly octave: number };

/** Writes the 4 input words of `use` to `input`. */
export type LatticePacker = (input: Uint32Array, use: LatticeUse) => void;

/** How many problems a check lists before it summarizes the rest. */
const LISTED = 5;

/** `problems`, at most LISTED of them, then how many more there were. */
function listed(problems: string[]): string[] {
  if (problems.length <= LISTED) return problems;
  return [...problems.slice(0, LISTED), `and ${problems.length - LISTED} more`];
}

/** The value of the cell `x`, `y` in `values`, sampled over `rect`. */
export function valueAt(values: Int32Array, rect: CellRect, x: number, y: number): number {
  const column = x - rect.x;
  const row = y - rect.y;
  const value = values[row * rect.width + column];
  if (column < 0 || column >= rect.width || row < 0 || value === undefined) {
    throw new RangeError(`the cell ${x},${y} is outside the region`);
  }
  return value;
}

/** The amplitude of each octave of `spec` that contributes, with its wavelength, coarsest first. */
function contributingOctaves(spec: NoiseSpec): { amplitude: number; wavelength: number }[] {
  const result: { amplitude: number; wavelength: number }[] = [];
  for (let octave = 0; octave < spec.octaves; octave += 1) {
    const amplitude = Math.floor(spec.amplitude / 2 ** octave);
    if (amplitude === 0) break;
    result.push({ amplitude, wavelength: spec.wavelength / 2 ** octave });
  }
  return result;
}

/**
 * The analytic bound on |v(x + 1) − v(x)| for adjacent cells along either axis (noise.ts, the
 * Lipschitz bound): Σ over the contributing octaves of 137·A_o / (16·W_o) + 28·A_o / 2^16 + 1.
 */
export function lipschitzBound(spec: NoiseSpec): number {
  let bound = 0;
  for (const { amplitude, wavelength } of contributingOctaves(spec)) {
    bound += (137 * amplitude) / (16 * wavelength) + (28 * amplitude) / Q16 + 1;
  }
  return bound;
}

/** An adjacent pair of cells: the first cell, the axis to the second, and |Δ| between them. */
type Pair = {
  readonly x: number;
  readonly y: number;
  readonly axis: "x" | "y";
  readonly delta: number;
};

/** Calls `visit` with every adjacent pair of cells of `rect`, row by row, along x then along y. */
function forEachPair(values: Int32Array, rect: CellRect, visit: (pair: Pair) => void): void {
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      const here = valueAt(values, rect, x, y);
      if (x + 1 < rect.x + rect.width) {
        visit({ x, y, axis: "x", delta: Math.abs(valueAt(values, rect, x + 1, y) - here) });
      }
      if (y + 1 < rect.y + rect.height) {
        visit({ x, y, axis: "y", delta: Math.abs(valueAt(values, rect, x, y + 1) - here) });
      }
    }
  }
}

/** Adjacent cells of `rect` that differ by more than the Lipschitz bound of `spec`. */
export function lipschitzProblems(
  sampler: RegionSampler,
  spec: NoiseSpec,
  rect: CellRect,
): string[] {
  const bound = lipschitzBound(spec);
  const problems: string[] = [];
  forEachPair(sampler(spec, rect), rect, ({ x, y, axis, delta }) => {
    if (delta > bound) problems.push(`at ${x},${y} along ${axis}: |Δ| = ${delta} > ${bound}`);
  });
  return listed(problems);
}

/** Cells of `rect` whose value lies outside ±noiseBound(spec), or the bound beyond 4·amplitude. */
export function rangeProblems(sampler: RegionSampler, spec: NoiseSpec, rect: CellRect): string[] {
  const bound = noiseBound(spec);
  const problems: string[] = [];
  if (bound > 4 * spec.amplitude) problems.push(`noiseBound ${bound} exceeds 4·${spec.amplitude}`);
  const values = sampler(spec, rect);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] as number;
    if (Math.abs(value) > bound) problems.push(`cell ${index}: ${value} is beyond ±${bound}`);
  }
  return listed(problems);
}

/**
 * Cells where a sample of a part differs from the sample of `region`, over the cells they share:
 * a region must equal the composition of its chunks, and a chunk the composition of its cells.
 */
export function compositionProblems(
  sampler: RegionSampler,
  spec: NoiseSpec,
  region: CellRect,
  parts: readonly CellRect[],
): string[] {
  const whole = sampler(spec, region);
  const problems: string[] = [];
  for (const part of parts) {
    const values = sampler(spec, part);
    const left = Math.max(part.x, region.x);
    const right = Math.min(part.x + part.width, region.x + region.width);
    const bottom = Math.max(part.y, region.y);
    const top = Math.min(part.y + part.height, region.y + region.height);
    if (left >= right || bottom >= top)
      problems.push(`the part ${JSON.stringify(part)} is outside`);
    for (let y = bottom; y < top; y += 1) {
      for (let x = left; x < right; x += 1) {
        const value = valueAt(values, part, x, y);
        const expected = valueAt(whole, region, x, y);
        if (value !== expected)
          problems.push(`at ${x},${y}: the part gives ${value}, the region ${expected}`);
      }
    }
  }
  return listed(problems);
}

/** The mean and the maximum |Δ| of adjacent pairs inside chunks and across chunk seams. */
export type SeamStatistics = {
  readonly interiorMean: number;
  readonly seamMean: number;
  readonly seamMax: number;
  readonly seamPairs: number;
};

/** A block of 2×2 chunks to sample: its sampler, and the first cell of its first chunk. */
export type SeamSample = {
  readonly sampler: RegionSampler;
  readonly x: number;
  readonly y: number;
};

/**
 * The seam statistics of `spec` over each sample's 2×2 chunks: a pair is across a seam when its
 * first cell is the last of its chunk along the pair's axis.
 */
export function seamStatistics(spec: NoiseSpec, samples: readonly SeamSample[]): SeamStatistics {
  let interior = 0;
  let interiorPairs = 0;
  let seam = 0;
  let seamPairs = 0;
  let seamMax = 0;
  for (const { sampler, x, y } of samples) {
    const rect = { x, y, width: 2 * CHUNK_CELLS, height: 2 * CHUNK_CELLS };
    forEachPair(sampler(spec, rect), rect, (pair) => {
      const offset = pair.axis === "x" ? pair.x - rect.x : pair.y - rect.y;
      if (offset === CHUNK_CELLS - 1) {
        seam += pair.delta;
        seamPairs += 1;
        seamMax = Math.max(seamMax, pair.delta);
      } else {
        interior += pair.delta;
        interiorPairs += 1;
      }
    });
  }
  return { interiorMean: interior / interiorPairs, seamMean: seam / seamPairs, seamMax, seamPairs };
}

/**
 * Seams unlike the interior: the mean |Δ| across chunk seams must lie within ±10% of the mean
 * inside chunks, and the largest |Δ| across a seam within the Lipschitz bound.
 *
 * Within one world every seam sits at the same phase of each octave whose wavelength divides 64,
 * as chunks start at multiples of 32 and the octave's offset is fixed, and |Δ| depends on that
 * phase: one world's seams can differ from its interior by about 10% without any defect. Samples
 * from many worlds, each with its own offsets, average the phase out; for one world, a field
 * whose wavelengths are all far above 64 varies too little across a block for the phase to show.
 */
export function seamProblems(spec: NoiseSpec, samples: readonly SeamSample[]): string[] {
  const { interiorMean, seamMean, seamMax } = seamStatistics(spec, samples);
  const problems: string[] = [];
  const ratio = seamMean / interiorMean;
  if (ratio < 0.9 || ratio > 1.1) {
    problems.push(`the mean |Δ| across seams is ${ratio.toFixed(3)} times the interior's`);
  }
  const bound = lipschitzBound(spec);
  if (seamMax > bound) problems.push(`a seam |Δ| of ${seamMax} exceeds the bound ${bound}`);
  return problems;
}

/**
 * Octaves that share lattice origins: where every octave has a lattice point, gradient noise is
 * exactly 0 in each, so a field whose octaves share origins is 0 on the coarsest lattice. With
 * independent offsets an exact 0 is rare; more than `allowed` of them in `rect` is a problem.
 */
export function sharedOriginProblems(
  sampler: RegionSampler,
  spec: NoiseSpec,
  rect: CellRect,
  allowed = 2,
): string[] {
  const zeros = sampler(spec, rect).filter((value) => value === 0).length;
  return zeros > allowed ? [`${zeros} cells are exactly 0, more than ${allowed}`] : [];
}

/**
 * Octaves that add nothing: each octave of `spec` past the first must change most cells of `rect`,
 * compared with the same spec without it. An octave sampled only at its lattice points, as one of
 * wavelength 1 is, adds exactly 0.
 */
export function octaveDetailProblems(
  sampler: RegionSampler,
  spec: NoiseSpec,
  rect: CellRect,
): string[] {
  const problems: string[] = [];
  let previous = sampler({ ...spec, octaves: 1 }, rect);
  for (let count = 2; count <= spec.octaves; count += 1) {
    const current = sampler({ ...spec, octaves: count }, rect);
    const changed = current.filter((value, index) => value !== previous[index]).length;
    if (2 * changed <= current.length) {
      problems.push(`octave ${count - 1} changes ${changed} of ${current.length} cells`);
    }
    previous = current;
  }
  return problems;
}

/**
 * Cells where the sampler and `oracle`, real-valued, differ by more than the tolerance that the
 * error analysis allows for `spec` (noise-oracle.ts).
 */
export function oracleProblems(
  sampler: RegionSampler,
  oracle: (spec: NoiseSpec, rect: CellRect) => Float64Array,
  spec: NoiseSpec,
  rect: CellRect,
): string[] {
  const tolerance = oracleTolerance(spec);
  const values = sampler(spec, rect);
  const expected = oracle(spec, rect);
  const problems: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const difference = Math.abs((values[index] as number) - (expected[index] as number));
    if (difference > tolerance) {
      problems.push(
        `cell ${index}: ${values[index]} differs from the oracle's ${expected[index]} by ${difference}`,
      );
    }
  }
  return listed(problems);
}

/**
 * Departures of `fade` from the fade's contract, over all 65,537 inputs of [0, 2^16]: it starts at
 * 0 and ends at 2^16 exactly, never decreases, stays within 1 of the exact rational value
 * t³(6t² − 15t·S + 10S²) / S⁴, and lies below the identity on [0, S/2] and above it on [S/2, S].
 * The exact value is computed with BigInt.
 */
export function fadeProblems(fade: (t: number) => number): string[] {
  const problems: string[] = [];
  const S = BigInt(Q16);
  const S4 = S ** 4n;
  if (fade(0) !== 0) problems.push(`fade(0) is ${fade(0)}, not 0`);
  if (fade(Q16) !== Q16) problems.push(`fade(2^16) is ${fade(Q16)}, not 2^16`);
  let previous = fade(0);
  for (let t = 0; t <= Q16; t += 1) {
    const value = fade(t);
    if (value < previous) problems.push(`fade decreases at ${t}: ${previous} then ${value}`);
    const T = BigInt(t);
    const exact = T * T * T * (6n * T * T - 15n * T * S + 10n * S * S);
    const error = BigInt(value) * S4 - exact;
    if (error > S4 || error < -S4) problems.push(`fade(${t}) = ${value} is more than 1 from exact`);
    if (2 * t <= Q16 ? value > t : value < t)
      problems.push(`fade(${t}) = ${value} crosses the identity`);
    previous = value;
  }
  return listed(problems);
}

/** Lattice coordinates at the edges of int32 and around 0, where a packing would break first. */
const EDGE_COORDINATES = [-(2 ** 31), -(2 ** 28), -1, 0, 1, 2 ** 28 + 1, 2 ** 31 - 1];

/** Every use of terrain's pseudorandom function in a domain that holds the edge cases. */
export function* latticeUses(): Generator<LatticeUse> {
  const purposes = [...NOISE_PURPOSES, LATTICE_PURPOSES.substrate];
  for (const purpose of purposes) {
    for (let octave = 0; octave < 12; octave += 1) {
      yield { kind: "offset", purpose, octave };
      for (const x of EDGE_COORDINATES) {
        for (const y of EDGE_COORDINATES) yield { kind: "point", purpose, octave, x, y };
      }
    }
  }
}

/** Two uses that `packer` gives the same input words, so that they would share a block. */
export function packingCollisions(packer: LatticePacker): string[] {
  const seen = new Map<string, LatticeUse>();
  const problems: string[] = [];
  const input = new Uint32Array(CHACHA20_INPUT_WORDS);
  for (const use of latticeUses()) {
    input.fill(0);
    packer(input, use);
    const words = input.join(",");
    const other = seen.get(words);
    if (other === undefined) seen.set(words, use);
    else
      problems.push(`${JSON.stringify(use)} and ${JSON.stringify(other)} share the words ${words}`);
  }
  return listed(problems);
}
