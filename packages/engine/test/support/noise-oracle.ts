import { CHACHA20_BLOCK_WORDS, CHACHA20_INPUT_WORDS, ChaCha20Key } from "../../src/rng/chacha.ts";
import { type PreparedGenesis, sharedGenesis } from "../../src/worldgen/genesis.ts";
import { setLatticeField, setLatticePoint, setOffsetInput } from "../../src/worldgen/lattice.ts";
import type { CellRect, NoiseSpec } from "../../src/worldgen/noise.ts";

/**
 * A floating-point Perlin noise for tests only (plan §12, test 7): it draws the same gradients and
 * offsets from the same pseudorandom inputs as noise.ts, through lattice.ts and ChaCha20, but
 * computes everything else on its own, in doubles: the lattice cell with Math.floor, the fraction
 * as a real number, the quintic fade, the dot products, and the interpolation, with no rounding.
 * Its gradient table is its own copy of the 8 vectors (±1, ±2) and (±2, ±1), indexed by the low 3
 * bits of a block's word 0, so a change to noise.ts's table shows as a disagreement.
 *
 * It returns Σ_o A_o · n_o, the real fBm whose integer version noise.ts computes, up to the
 * rounding of doubles; noise.ts stays within 14 Q16 units of each octave's real noise, plus 1 for
 * each octave's floor (oracleTolerance).
 */

/** The 8 gradients, indexed by 3 bits of a block's word 0. */
const GRADIENTS: readonly (readonly [number, number])[] = [
  [1, 2],
  [-1, 2],
  [1, -2],
  [-1, -2],
  [2, 1],
  [-2, 1],
  [2, -1],
  [-2, -1],
];

/** The quintic fade 6s⁵ − 15s⁴ + 10s³ of a real s in [0, 1]. */
function realFade(s: number): number {
  return s * s * s * (s * (s * 6 - 15) + 10);
}

/** One octave of the oracle: its key, field, wavelength, and offsets. */
type OracleOctave = {
  readonly key: ChaCha20Key;
  readonly purpose: number;
  readonly octave: number;
  readonly wavelength: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly input: Uint32Array;
  readonly block: Uint32Array;
};

/** The octave `octave` of `spec`, with its offsets drawn from the offset purpose's block. */
function oracleOctave(key: ChaCha20Key, spec: NoiseSpec, octave: number): OracleOctave {
  const wavelength = spec.wavelength / 2 ** octave;
  const input = new Uint32Array(CHACHA20_INPUT_WORDS);
  const block = new Uint32Array(CHACHA20_BLOCK_WORDS);
  setOffsetInput(input, spec.purpose, octave);
  key.blockInto(input, block);
  const offsetX = (block[0] as number) % wavelength;
  const offsetY = (block[1] as number) % wavelength;
  return { key, purpose: spec.purpose, octave, wavelength, offsetX, offsetY, input, block };
}

/** The gradient at the lattice point `x`, `y` of `octave`. */
function gradient(octave: OracleOctave, x: number, y: number): readonly [number, number] {
  setLatticeField(octave.input, octave.purpose, octave.octave);
  setLatticePoint(octave.input, x, y);
  octave.key.blockInto(octave.input, octave.block);
  return GRADIENTS[(octave.block[0] as number) % 8] as readonly [number, number];
}

/** The real gradient noise of `octave` at the cell `x`, `y`, in lattice units. */
function realNoise(octave: OracleOctave, x: number, y: number): number {
  const px = x + octave.offsetX;
  const py = y + octave.offsetY;
  const cellX = Math.floor(px / octave.wavelength);
  const cellY = Math.floor(py / octave.wavelength);
  const s = (px - cellX * octave.wavelength) / octave.wavelength;
  const t = (py - cellY * octave.wavelength) / octave.wavelength;
  const dot = (i: number, j: number) => {
    const [gx, gy] = gradient(octave, cellX + i, cellY + j);
    return gx * (s - i) + gy * (t - j);
  };
  const u = realFade(s);
  const v = realFade(t);
  const bottom = dot(0, 0) + (dot(1, 0) - dot(0, 0)) * u;
  const top = dot(0, 1) + (dot(1, 1) - dot(0, 1)) * u;
  return bottom + (top - bottom) * v;
}

/** The real fBm Σ_o A_o · n_o of `spec` over `rect`, row by row, with no floor of its own. */
export function oracleNoise(
  prepared: PreparedGenesis,
  spec: NoiseSpec,
  rect: CellRect,
): Float64Array {
  const key = new ChaCha20Key(sharedGenesis(prepared).terrainSeed);
  const values = new Float64Array(rect.width * rect.height);
  for (let octave = 0; octave < spec.octaves; octave += 1) {
    const amplitude = Math.floor(spec.amplitude / 2 ** octave);
    if (amplitude === 0) break;
    const layer = oracleOctave(key, spec, octave);
    for (let row = 0; row < rect.height; row += 1) {
      for (let column = 0; column < rect.width; column += 1) {
        const noise = realNoise(layer, rect.x + column, rect.y + row);
        values[row * rect.width + column] =
          (values[row * rect.width + column] as number) + amplitude * noise;
      }
    }
  }
  return values;
}

/**
 * How far one octave's integer noise may lie from its real noise, in Q16 units: the bound noise.ts
 * documents with its Lipschitz bound. Each of the two levels of interpolation multiplies the fade's
 * error, at most 1, by a difference of at most 6·S, which gives 12, and their floors add 2.
 */
const INTEGER_ERROR = 14;

/**
 * An allowance for the oracle's own rounding, in output units. The fractions and dot products are
 * exact in doubles, as dyadic values of at most 19 bits; the fade rounds once, and the
 * interpolations, on values below 8, a few times, so each octave's noise is within 74·2^−53 of
 * the real one, and its product with A_o within 76·A_o·2^−53 < A_o·2^−46. The sum of at most 12
 * octaves, whose partial sums stay below 2^31, rounds by at most 2^−22 per addition. With
 * A ≤ 2^29 the total is below 2A·2^−46 + 12·2^−22 < 2^−15, and the allowance is 32 times that.
 */
const ORACLE_ROUNDING = 2 ** -10;

/**
 * The largest difference between noise.ts and the oracle that the error analysis allows for
 * `spec`: Σ_o (INTEGER_ERROR·A_o / S + 1) over the octaves whose amplitude is not 0, since the
 * floor of n·A_o / S lowers each octave by less than 1, plus ORACLE_ROUNDING. Every partial sum
 * is a multiple of 2^−16 below 2^18, so the tolerance itself is exact.
 */
export function oracleTolerance(spec: NoiseSpec): number {
  let tolerance = ORACLE_ROUNDING;
  for (let octave = 0; octave < spec.octaves; octave += 1) {
    const amplitude = Math.floor(spec.amplitude / 2 ** octave);
    if (amplitude === 0) break;
    tolerance += (INTEGER_ERROR * amplitude) / 2 ** 16 + 1;
  }
  return tolerance;
}
