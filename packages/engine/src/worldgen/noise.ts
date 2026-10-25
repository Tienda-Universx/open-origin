/**
 * Integer gradient noise (ADR 0021, noise): 2D gradient noise summed over octaves (fBm), in exact
 * arithmetic on safe-integer doubles. Floors go through floorDiv and floorMod (int.ts), never `|0`,
 * `>>`, `imul`, or `%`, which overflow or round toward zero; values become u32 words only as inputs
 * of the pseudorandom function (lattice.ts).
 *
 * One octave of wavelength W, a power of two from 8 to 2^16, shifts a cell by its offset (o_x, o_y),
 * drawn from the block of the offset purpose, and splits it into a lattice cell ⌊p / W⌋ and a Q16
 * fraction ⌊(p mod W)·S / W⌋, with S = 2^16. Each corner of the lattice cell has one of the 8
 * gradients (±1, ±2) and (±2, ±1), chosen by the low 3 bits of word 0 of its block; the noise n
 * interpolates the corners' dot products with the fade of each fraction, in Q16 units. Octave o has
 * wavelength W0 / 2^o and amplitude A_o = ⌊A / 2^o⌋, and the fBm is Σ_o ⌊n_o·A_o / S⌋; an octave
 * whose amplitude is 0 adds 0 and is skipped.
 *
 * Bounds, for the bounds of NOISE_BOUNDS:
 *
 * - **One octave's noise**: |n| ≤ NOISE_PEAK = ⌊73·S / 48⌋ + 2. A corner's dot product is at most
 *   M(|dx|, |dy|) = |dx| + |dy| + max(|dx|, |dy|) in magnitude, in lattice units. With the weights
 *   u/S of the fade, which lies below the identity on [0, S/2] and above it on [S/2, S] (the tests
 *   check all 65,537 inputs), reflections and the swap of x and y reduce the weighted sum of the
 *   four M to fractions s ≤ t ≤ 1/2, where it is at most 1 + 5s/2 − 3s², whose maximum on
 *   [0, 1/2] is 73/48; the real noise reaches about 1.511. The floors of the interpolations lower
 *   n by less than 2.
 * - **The fBm**: |v| ≤ noiseBound(spec) = Σ_o ⌈NOISE_PEAK·A_o / S⌉ ≤ 4·A (K = 4), since
 *   Σ_o A_o ≤ 2A − 1, at most ⌊log2 A⌋ + 1 octaves have A_o > 0, and
 *   1.53·(2A − 1) + ⌊log2 A⌋ + 1 ≤ 4A. With A ≤ 2^29 the bound is below 2^31, so every output
 *   fits an Int32Array; at 2^30, the genesis's former bound, it does not.
 * - **Intermediates**, all below 2^53: the fade's Horner steps at most 15·2^48; a dot product 3·S;
 *   an interpolation's (b − a)·u at most 6·S²; n·A_o at most NOISE_PEAK·2^30 < 2^47; positions
 *   below 2^31 + 2^16.
 * - **Lipschitz**: neighbors differ by at most Σ_o (137·A_o / (16·W_o) + 28·A_o / S + 1). The real
 *   noise's slope is at most 15/8·(2 + 3/2) + 2 = 137/16 lattice units per lattice unit: the fade's
 *   slope, at most 15/8, times the change of the corners' dot products along x, at most 2 + 3·1/2,
 *   plus the interpolated gradient's x, at most 2. The integer noise stays within 14 Q16 units of
 *   the real noise, 12 from the fade's error of at most 1 and 2 from the floors, which adds 28 to a
 *   difference of neighbors; each octave's floor adds 1.
 *
 * sampleNoiseRegion evaluates any rectangle of up to 256×256 cells, with a cache of the lattice
 * points it touches, valid for that call only. A chunk is a 32×32 region and a cell a 1×1 region:
 * the noise of a cell depends only on the cell, so any region equals the composition of its cells.
 */
import { type IssueSink, numberProblem } from "../canonical/value.ts";
import { describeValue, IssueList } from "../errors.ts";
import { floorDiv, floorMod } from "../int.ts";
import { CHACHA20_BLOCK_WORDS, CHACHA20_INPUT_WORDS, ChaCha20Key } from "../rng/chacha.ts";
import { expectRecord, readMember, UNREAD } from "../world/members.ts";
import { type IntRange, PreparedGenesis, sharedGenesis } from "./genesis.ts";
import { NOISE_PURPOSES, setLatticeField, setLatticePoint, setOffsetInput } from "./lattice.ts";
import { MAX_CELL, MIN_CELL, readCell } from "./space.ts";

/** S, one lattice unit in Q16 fixed point: fractions, fades, and noise are counted in 1/S. */
export const Q16 = 0x1_0000;

/** S², one lattice unit in Q32, the precision of the fade's Horner steps. */
const Q32 = Q16 * Q16;

/** The bound on |n| for one octave's noise, in Q16 units: ⌊73·S / 48⌋ + 2 (see above). */
export const NOISE_PEAK = 99_671;

function range(min: number, max: number): IntRange {
  return Object.freeze({ min, max });
}

/**
 * The bounds of a noise spec and of a region. A wavelength is also at least 8·2^(octaves − 1), so
 * the finest octave spans 8 cells or more; its `min` here is for one octave. The amplitude stops
 * at 2^29 so that every output fits an Int32Array. Frozen at every level.
 */
export const NOISE_BOUNDS = Object.freeze({
  octaves: range(1, 12),
  wavelength: range(8, 0x1_0000),
  amplitude: range(1, 0x2000_0000),
  regionSide: range(1, 256),
});

/** A noise field: its purpose (lattice.ts), its coarsest wavelength in cells, octaves, amplitude. */
export type NoiseSpec = {
  readonly purpose: number;
  readonly wavelength: number;
  readonly octaves: number;
  readonly amplitude: number;
};

/** A rectangle of cells: its first cell, and how many cells it spans along x and along y. */
export type CellRect = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

/** A field at one octave, as the pseudorandom function's input names it. */
export type LatticeField = { readonly purpose: number; readonly octave: number };

/**
 * The quintic fade 6t⁵ − 15t⁴ + 10t³ of the Q16 fraction `t`, in [0, S], as a Q16 value. Horner's
 * form runs in Q32 and rounds to the nearest Q16 unit once, at the end: it is within 1/2 + 2^−16
 * of the exact value, never decreases, and gives 0, S/2, and S exactly at 0, S/2, and S. Every
 * step stays below 15·2^48. Precondition: `t` is an integer in [0, S].
 */
export function fade(t: number): number {
  let value = 6 * t * Q16 - 15 * Q32;
  value = floorDiv(value * t, Q16) + 10 * Q32;
  value = floorDiv(value * t, Q16);
  value = floorDiv(value * t, Q16);
  value = floorDiv(value * t, Q16);
  return floorDiv(value + Q16 / 2, Q16);
}

/**
 * a + ⌊(b − a)·t / S⌋: `a` at t = 0, `b` at t = S, and always between them, since the floor of a
 * value between two integers lies between them. Precondition: |b − a|·t is a safe integer.
 */
export function interpolate(a: number, b: number, t: number): number {
  return a + floorDiv((b - a) * t, Q16);
}

/** The bits of a block's word 0 that choose a gradient. */
const GRADIENT_BITS = 0b111;

/**
 * The dot product of the gradient `gradient`, from 0 to 7, with the offset (`dx`, `dy`) of a cell
 * from the lattice point, in Q16 units. The index's bit 0 negates x, bit 1 negates y, and bit 2
 * puts the 2 on x, so the indexes 0 to 7 give (1, 2), (−1, 2), (1, −2), (−1, −2), (2, 1), (−2, 1),
 * (2, −1), and (−2, −1). The index is a small integer, not a noise value, so its bits may be
 * tested; a table would be module state, and reading a frozen one cost about 20 ns on Bun 1.4.4.
 * Precondition: `gradient` is an index from gradientAt.
 */
export function gradientDot(gradient: number, dx: number, dy: number): number {
  // 0 − d, not −d, which would give −0 for 0.
  const x = (gradient & 1) === 0 ? dx : 0 - dx;
  const y = (gradient & 2) === 0 ? dy : 0 - dy;
  return (gradient & 4) === 0 ? x + 2 * y : 2 * x + y;
}

/**
 * The gradient of the lattice point whose input words `input` holds: the low 3 bits of word 0 of
 * its block, which it writes to `block`, without allocating.
 */
export function gradientAt(key: ChaCha20Key, input: Uint32Array, block: Uint32Array): number {
  key.blockInto(input, block);
  // A u32 word of the block, not a noise value: its low bits choose among 8 gradients.
  return (block[0] as number) & GRADIENT_BITS;
}

/**
 * The lattice cell of `position`, ⌊position / wavelength⌋. Precondition: `position` is a safe
 * integer and `wavelength` a power of two from 8 to 2^16.
 */
export function latticeCell(position: number, wavelength: number): number {
  return floorDiv(position, wavelength);
}

/**
 * The Q16 fraction of `position` inside its lattice cell, ⌊(position mod W)·S / W⌋, in [0, S):
 * exact, since W divides S. Precondition: as latticeCell.
 */
export function latticeFraction(position: number, wavelength: number): number {
  return floorDiv(floorMod(position, wavelength) * Q16, wavelength);
}

/**
 * The x and y offsets of `field`, each in [0, wavelength): words 0 and 1 of the block that the
 * offset purpose names for the field (lattice.ts). Each octave has its own, so octaves never share
 * lattice origins. Precondition: `wavelength` is a power of two from 8 to 2^16.
 */
export function octaveOffsets(
  key: ChaCha20Key,
  field: LatticeField,
  wavelength: number,
): readonly [number, number] {
  const input = new Uint32Array(CHACHA20_INPUT_WORDS);
  const block = new Uint32Array(CHACHA20_BLOCK_WORDS);
  setOffsetInput(input, field.purpose, field.octave);
  key.blockInto(input, block);
  return [floorMod(block[0] as number, wavelength), floorMod(block[1] as number, wavelength)];
}

/**
 * The exact bound on |v| for every output v of `spec`: Σ_o ⌈NOISE_PEAK·A_o / S⌉ over the octaves
 * whose amplitude is not 0. It is at most 4·amplitude. Precondition: `spec` is within NOISE_BOUNDS.
 */
export function noiseBound(spec: NoiseSpec): number {
  let bound = 0;
  let amplitude = spec.amplitude;
  for (let octave = 0; octave < spec.octaves && amplitude > 0; octave += 1) {
    // ⌈x / S⌉ is −⌊−x / S⌋.
    bound -= floorDiv(-NOISE_PEAK * amplitude, Q16);
    amplitude = floorDiv(amplitude, 2);
  }
  return bound;
}

/** One axis of a region at one octave. */
type Axis = {
  /** The lowest lattice coordinate the axis touches. */
  readonly first: number;
  /** How many lattice points the axis touches: its lattice cells, plus 1. */
  readonly points: number;
  /** For each sample, its lattice cell minus `first`. */
  readonly cells: Int32Array;
  /** For each sample, its Q16 fraction. */
  readonly fractions: Int32Array;
  /** For each sample, the fade of its fraction. */
  readonly fades: Int32Array;
};

/** The `length` samples of an axis from the cell `start`, shifted by `offset`. */
function sampleAxis(start: number, length: number, offset: number, wavelength: number): Axis {
  const first = latticeCell(start + offset, wavelength);
  const last = latticeCell(start + length - 1 + offset, wavelength);
  const cells = new Int32Array(length);
  const fractions = new Int32Array(length);
  const fades = new Int32Array(length);
  for (let index = 0; index < length; index += 1) {
    // A double: near the top edge, the shifted cell passes 2^31 − 1 without wrapping.
    const position = start + index + offset;
    const fraction = latticeFraction(position, wavelength);
    cells[index] = latticeCell(position, wavelength) - first;
    fractions[index] = fraction;
    fades[index] = fade(fraction);
  }
  return { first, points: last - first + 2, cells, fractions, fades };
}

/** One octave of a region: its axes, the gradient of each lattice point, and its amplitude. */
type OctaveGrid = {
  readonly xs: Axis;
  readonly ys: Axis;
  /** The gradient of each lattice point the region touches, row by row. */
  readonly gradients: Uint8Array;
  readonly amplitude: number;
};

/** The gradient of every lattice point that the axes `xs` and `ys` touch, row by row. */
function latticeGradients(key: ChaCha20Key, field: LatticeField, xs: Axis, ys: Axis): Uint8Array {
  const input = new Uint32Array(CHACHA20_INPUT_WORDS);
  const block = new Uint32Array(CHACHA20_BLOCK_WORDS);
  const gradients = new Uint8Array(xs.points * ys.points);
  setLatticeField(input, field.purpose, field.octave);
  for (let row = 0; row < ys.points; row += 1) {
    for (let column = 0; column < xs.points; column += 1) {
      setLatticePoint(input, xs.first + column, ys.first + row);
      gradients[row * xs.points + column] = gradientAt(key, input, block);
    }
  }
  return gradients;
}

/**
 * Adds ⌊n·A_o / S⌋ of `grid` to each cell's sum in `sums`, row by row. For each cell, n
 * interpolates the dot products at the four corners of its lattice cell, (0, 0), (1, 0), (0, 1),
 * and (1, 1), along x with the fade u, then along y with the fade v. One loop reads each row's
 * values once; a function per cell measured about twice as slow on Bun 1.4.4.
 */
function addOctave(sums: Float64Array, grid: OctaveGrid): void {
  const { xs, ys, gradients, amplitude } = grid;
  const width = xs.cells.length;
  const height = ys.cells.length;
  const stride = xs.points;
  for (let row = 0; row < height; row += 1) {
    const fy = ys.fractions[row] as number;
    const v = ys.fades[row] as number;
    const rowCorner = (ys.cells[row] as number) * stride;
    for (let column = 0; column < width; column += 1) {
      const fx = xs.fractions[column] as number;
      const u = xs.fades[column] as number;
      // The gradient index of the corner (0, 0); (1, 0) follows it, and (0, 1) is a row later.
      const corner = rowCorner + (xs.cells[column] as number);
      const n00 = gradientDot(gradients[corner] as number, fx, fy);
      const n10 = gradientDot(gradients[corner + 1] as number, fx - Q16, fy);
      const n01 = gradientDot(gradients[corner + stride] as number, fx, fy - Q16);
      const n11 = gradientDot(gradients[corner + stride + 1] as number, fx - Q16, fy - Q16);
      const noise = interpolate(interpolate(n00, n10, u), interpolate(n01, n11, u), v);
      const index = row * width + column;
      sums[index] = (sums[index] as number) + floorDiv(noise * amplitude, Q16);
    }
  }
}

/**
 * Not for hosts: the fBm of `spec` over `rect`, row by row, in a fresh array, as
 * sampleNoiseRegion returns it, without validating anything. Worldgen's own modules call it after
 * validating their inputs once, so that one call can sample several fields under one key.
 * Precondition: `key` is the terrain seed's, `spec` is within NOISE_BOUNDS, and `rect` passed
 * readRegion.
 */
export function noiseRegion(key: ChaCha20Key, spec: NoiseSpec, rect: CellRect): Int32Array {
  const sums = new Float64Array(rect.width * rect.height);
  let wavelength = spec.wavelength;
  let amplitude = spec.amplitude;
  for (let octave = 0; octave < spec.octaves && amplitude > 0; octave += 1) {
    const field = { purpose: spec.purpose, octave };
    const [offsetX, offsetY] = octaveOffsets(key, field, wavelength);
    const xs = sampleAxis(rect.x, rect.width, offsetX, wavelength);
    const ys = sampleAxis(rect.y, rect.height, offsetY, wavelength);
    addOctave(sums, { xs, ys, gradients: latticeGradients(key, field, xs, ys), amplitude });
    wavelength /= 2;
    amplitude = floorDiv(amplitude, 2);
  }
  // Every sum lies within ±noiseBound(spec), below 2^31, so the conversion is exact.
  return Int32Array.from(sums);
}

const MISSING = "the member is missing";
const WORLD_CELLS = `cell coordinates lie from ${MIN_CELL} to ${MAX_CELL}`;

/** Whether the positive integer `value` is a power of two; it loops once per bit of `value`. */
function isPowerOfTwo(value: number): boolean {
  let power = 1;
  while (power < value) power *= 2;
  return power === value;
}

/** The shortest coarsest wavelength for `octaves`: 8·2^(octaves − 1). */
function shortestWavelength(octaves: number): number {
  let wavelength = NOISE_BOUNDS.wavelength.min;
  for (let octave = 1; octave < octaves; octave += 1) wavelength *= 2;
  return wavelength;
}

/** Reads the integer members of a host record, each once, reporting problems under `path`. */
class MemberReader {
  readonly #record: object;
  readonly #path: string;
  readonly #sink: IssueSink;

  constructor(record: object, path: string, sink: IssueSink) {
    this.#record = record;
    this.#path = path;
    this.#sink = sink;
  }

  /** The member `name` if it is a safe integer, not −0; undefined after an issue. */
  integer(name: string): number | undefined {
    const path = `${this.#path}/${name}`;
    const value = readMember(this.#record, name, path, this.#sink);
    if (value === UNREAD) return undefined;
    if (value === undefined) {
      this.#sink.report(path, MISSING);
      return undefined;
    }
    if (typeof value !== "number") {
      this.#sink.report(path, `${describeValue(value)} is not a safe integer`);
      return undefined;
    }
    const problem = numberProblem(value);
    if (problem !== undefined) this.#sink.report(path, problem);
    return problem === undefined ? value : undefined;
  }

  /** The member `name` if it is an integer within `bounds`; undefined after an issue. */
  bounded(name: string, bounds: IntRange): number | undefined {
    const value = this.integer(name);
    if (value === undefined || (value >= bounds.min && value <= bounds.max)) return value;
    this.#sink.report(
      `${this.#path}/${name}`,
      `${value} is out of bounds: it must be from ${bounds.min} to ${bounds.max}`,
    );
    return undefined;
  }

  /** The member `name` if it is a power of two within `bounds`; undefined after an issue. */
  powerOfTwo(name: string, bounds: IntRange): number | undefined {
    const value = this.integer(name);
    if (value === undefined) return undefined;
    if (value >= bounds.min && value <= bounds.max && isPowerOfTwo(value)) return value;
    this.#sink.report(
      `${this.#path}/${name}`,
      `${value} is not a power of two from ${bounds.min} to ${bounds.max}`,
    );
    return undefined;
  }

  /** The member `name` if it is a noise purpose; undefined after an issue. */
  purpose(name: string): number | undefined {
    const value = this.integer(name);
    if (value === undefined || NOISE_PURPOSES.includes(value)) return value;
    this.#sink.report(
      `${this.#path}/${name}`,
      `${value} is not a noise purpose: the noise purposes are ${NOISE_PURPOSES.join(", ")}`,
    );
    return undefined;
  }
}

/**
 * The host value `value` as a noise spec, a fresh record; undefined after every problem is
 * reported under /spec. Only the four members are read, each once (world/members.ts). Problems
 * come in the order purpose, octaves, wavelength, amplitude: the wavelength's lower bound depends
 * on the octaves, and is checked for one octave when they are invalid.
 */
function readNoiseSpec(value: unknown, sink: IssueSink): NoiseSpec | undefined {
  const shape = "the noise spec must be a record { purpose, wavelength, octaves, amplitude }";
  if (!expectRecord(value, "/spec", shape, sink)) return undefined;
  const members = new MemberReader(value, "/spec", sink);
  const purpose = members.purpose("purpose");
  const octaves = members.bounded("octaves", NOISE_BOUNDS.octaves);
  const shortest = shortestWavelength(octaves ?? 1);
  const wavelength = members.powerOfTwo("wavelength", range(shortest, NOISE_BOUNDS.wavelength.max));
  const amplitude = members.bounded("amplitude", NOISE_BOUNDS.amplitude);
  if (purpose === undefined || octaves === undefined || wavelength === undefined) return undefined;
  return amplitude === undefined ? undefined : { purpose, wavelength, octaves, amplitude };
}

/** Whether a region from the cell `start` spanning `length` cells ends inside the world. */
function endsInside(start: number, length: number, path: string, sink: IssueSink): boolean {
  const end = start + length - 1;
  if (end <= MAX_CELL) return true;
  sink.report(path, `the region ends at the cell ${end}, outside the world: ${WORLD_CELLS}`);
  return false;
}

/**
 * The host value `value` as a region, a fresh record; undefined after every problem is reported
 * under /rect. Its first cell is read as readCell reads a cell (space.ts), its width and height
 * are integers from 1 to 256, and its last cell must lie in the world, which is checked once the
 * first cell, the width, and the height are valid. Worldgen's regions share these rules, so
 * terrain reads its regions here too.
 */
export function readRegion(value: unknown, sink: IssueSink): CellRect | undefined {
  const shape = "the region must be a record { x, y, width, height }";
  if (!expectRecord(value, "/rect", shape, sink)) return undefined;
  const first = readCell(value, "/rect", sink);
  const members = new MemberReader(value, "/rect", sink);
  const width = members.bounded("width", NOISE_BOUNDS.regionSide);
  const height = members.bounded("height", NOISE_BOUNDS.regionSide);
  if (first === undefined || width === undefined || height === undefined) return undefined;
  const across = endsInside(first.x, width, "/rect/width", sink);
  const down = endsInside(first.y, height, "/rect/height", sink);
  return across && down ? { x: first.x, y: first.y, width, height } : undefined;
}

/**
 * The noise `spec` of `prepared`'s terrain over the cells of `rect`, as `rect.width ×
 * rect.height` values, row by row: the value of the cell (rect.x + i, rect.y + j) at index
 * j·width + i. Every value lies within ±noiseBound(spec).
 *
 * It validates its inputs once and throws EngineError("invalid_value") with every problem: at
 * /prepared, a value prepareGenesis did not make; under /spec, a purpose that is not a noise
 * purpose or a value outside NOISE_BOUNDS; under /rect, a first cell outside the world, a side
 * outside [1, 256], or a last cell outside the world. Host objects are read once, member by member,
 * and never again. Its key comes from the terrain seed, which no message prints; it keeps no state
 * between calls, so the result depends only on the genesis, the spec, and the cells.
 */
export function sampleNoiseRegion(
  prepared: PreparedGenesis,
  spec: NoiseSpec,
  rect: CellRect,
): Int32Array {
  const issues = new IssueList();
  const isPrepared = PreparedGenesis.isPreparedGenesis(prepared);
  if (!isPrepared) {
    issues.report("/prepared", "the value is not a prepared genesis: prepareGenesis makes them");
  }
  const noise = readNoiseSpec(spec, issues);
  const region = readRegion(rect, issues);
  if (!isPrepared || noise === undefined || region === undefined || issues.count > 0) {
    throw issues.toError("invalid_value");
  }
  return noiseRegion(new ChaCha20Key(sharedGenesis(prepared).terrainSeed), noise, region);
}
