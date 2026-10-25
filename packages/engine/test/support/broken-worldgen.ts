import { floorDiv, floorMod } from "../../src/int.ts";
import { CHACHA20_BLOCK_WORDS, CHACHA20_INPUT_WORDS, ChaCha20Key } from "../../src/rng/chacha.ts";
import { type PreparedGenesis, sharedGenesis } from "../../src/worldgen/genesis.ts";
import { setLatticeField, setLatticePoint, setOffsetInput } from "../../src/worldgen/lattice.ts";
import {
  type CellRect,
  fade,
  gradientAt,
  gradientDot,
  interpolate,
  type LatticeField,
  latticeCell,
  latticeFraction,
  type NoiseSpec,
  octaveOffsets,
  Q16,
} from "../../src/worldgen/noise.ts";
import { cellOffset } from "../../src/worldgen/space.ts";
import type { LatticePacker, LatticeUse, RegionSampler } from "./worldgen-checks.ts";

/**
 * Broken variants of the noise (plan §12, test 17), the permanent Phase B: each composes the
 * functions noise.ts and lattice.ts export as the real sampler does, except for one part, which
 * it replaces with a defect. composeSampler with FAITHFUL_PARTS must equal sampleNoiseRegion
 * exactly, which a test checks, so each variant is one defect away from the real code; the
 * property checks of worldgen-checks.ts must then catch every variant, never golden values.
 *
 * composeSampler evaluates each cell on its own, with a cache per call keyed by lattice point, not
 * by the region's layout, so its equality with sampleNoiseRegion also checks the real cache.
 */

/** The parts a sampler is composed of. */
export type NoiseParts = {
  /** The fade of a Q16 fraction. */
  readonly fade: (t: number) => number;
  /** Writes the input words of a use of the pseudorandom function. */
  readonly pack: LatticePacker;
  /** The position on an axis of the cell `cell`, shifted by an octave's offset. */
  readonly position: (cell: number, offset: number) => number;
  /** The lattice cell and the Q16 fraction of a position, for a wavelength. */
  readonly split: (position: number, wavelength: number) => { cell: number; fraction: number };
  /** The x and y offsets of `field`, below `wavelength`. */
  readonly offsets: (
    key: ChaCha20Key,
    field: LatticeField,
    wavelength: number,
  ) => readonly [number, number];
  /** The wavelength of `octave`, for the coarsest wavelength `base`. */
  readonly wavelength: (base: number, octave: number) => number;
};

/** lattice.ts's packing, as the real sampler uses it. */
const realPack: LatticePacker = (input: Uint32Array, use: LatticeUse) => {
  if (use.kind === "offset") {
    setOffsetInput(input, use.purpose, use.octave);
    return;
  }
  setLatticeField(input, use.purpose, use.octave);
  setLatticePoint(input, use.x, use.y);
};

/** The parts of the real sampler, from what noise.ts and lattice.ts export. */
export const FAITHFUL_PARTS: NoiseParts = Object.freeze({
  fade,
  pack: realPack,
  position: (cell: number, offset: number) => cell + offset,
  split: (position: number, wavelength: number) => ({
    cell: latticeCell(position, wavelength),
    fraction: latticeFraction(position, wavelength),
  }),
  offsets: octaveOffsets,
  wavelength: (base: number, octave: number) => base / 2 ** octave,
});

/** One octave of a composed sampler, with its gradients cached by lattice point. */
type ComposedOctave = {
  readonly parts: NoiseParts;
  readonly key: ChaCha20Key;
  readonly purpose: number;
  readonly octave: number;
  readonly wavelength: number;
  readonly amplitude: number;
  readonly offsetX: number;
  readonly offsetY: number;
  /** The gradient of each lattice point drawn so far, by x, then by y. */
  readonly gradients: Map<number, Map<number, number>>;
  readonly input: Uint32Array;
  readonly block: Uint32Array;
};

/** The gradient at the lattice point `x`, `y` of `layer`, packed with the layer's parts. */
function composedGradient(layer: ComposedOctave, x: number, y: number): number {
  let column = layer.gradients.get(x);
  if (column === undefined) {
    column = new Map<number, number>();
    layer.gradients.set(x, column);
  }
  const cached = column.get(y);
  if (cached !== undefined) return cached;
  layer.parts.pack(layer.input, {
    kind: "point",
    purpose: layer.purpose,
    octave: layer.octave,
    x,
    y,
  });
  const index = gradientAt(layer.key, layer.input, layer.block);
  column.set(y, index);
  return index;
}

/** The integer gradient noise of `layer` at the cell `x`, `y`, in Q16 units. */
function composedNoise(layer: ComposedOctave, x: number, y: number): number {
  const { parts, wavelength } = layer;
  const across = parts.split(parts.position(x, layer.offsetX), wavelength);
  const down = parts.split(parts.position(y, layer.offsetY), wavelength);
  const dot = (i: number, j: number) =>
    gradientDot(
      composedGradient(layer, across.cell + i, down.cell + j),
      across.fraction - i * Q16,
      down.fraction - j * Q16,
    );
  const u = parts.fade(across.fraction);
  const v = parts.fade(down.fraction);
  return interpolate(interpolate(dot(0, 0), dot(1, 0), u), interpolate(dot(0, 1), dot(1, 1), u), v);
}

/** The contributing octaves of `spec`, under `parts`. */
function composedOctaves(parts: NoiseParts, key: ChaCha20Key, spec: NoiseSpec): ComposedOctave[] {
  const layers: ComposedOctave[] = [];
  for (let octave = 0; octave < spec.octaves; octave += 1) {
    const amplitude = floorDiv(spec.amplitude, 2 ** octave);
    if (amplitude === 0) break;
    const wavelength = parts.wavelength(spec.wavelength, octave);
    const [offsetX, offsetY] = parts.offsets(key, { purpose: spec.purpose, octave }, wavelength);
    layers.push({
      parts,
      key,
      purpose: spec.purpose,
      octave,
      wavelength,
      amplitude,
      offsetX,
      offsetY,
      gradients: new Map(),
      input: new Uint32Array(CHACHA20_INPUT_WORDS),
      block: new Uint32Array(CHACHA20_BLOCK_WORDS),
    });
  }
  return layers;
}

/**
 * A sampler of `prepared`'s terrain composed of `parts`, cell by cell, without validating its
 * inputs: the variants break preconditions on purpose.
 */
export function composeSampler(prepared: PreparedGenesis, parts: NoiseParts): RegionSampler {
  const key = new ChaCha20Key(sharedGenesis(prepared).terrainSeed);
  return (spec: NoiseSpec, rect: CellRect) => {
    const layers = composedOctaves(parts, key, spec);
    const values = new Int32Array(rect.width * rect.height);
    for (let row = 0; row < rect.height; row += 1) {
      for (let column = 0; column < rect.width; column += 1) {
        let sum = 0;
        for (const layer of layers) {
          const noise = composedNoise(layer, rect.x + column, rect.y + row);
          sum += floorDiv(noise * layer.amplitude, Q16);
        }
        values[row * rect.width + column] = sum;
      }
    }
    return values;
  };
}

/** A fade written naively in Q16: each power of t floored on its own. Not monotonic. */
function naiveFade(t: number): number {
  const t2 = floorDiv(t * t, Q16);
  const t3 = floorDiv(t2 * t, Q16);
  const t4 = floorDiv(t3 * t, Q16);
  const t5 = floorDiv(t4 * t, Q16);
  return 6 * t5 - 15 * t4 + 10 * t3;
}

/**
 * A broken variant: its name, its parts, and the property check that must catch it, by the name
 * the sensitivity test gives that check.
 */
export type BrokenVariant = {
  readonly name: string;
  readonly parts: NoiseParts;
  readonly caughtBy: string;
};

/** The broken variants, each with the one part it replaces. */
export const BROKEN_VARIANTS: readonly BrokenVariant[] = [
  {
    // The lattice cell and fraction rounded toward zero, as `|0` and `%` would.
    name: "truncating division",
    caughtBy: "lipschitz",
    parts: {
      ...FAITHFUL_PARTS,
      split: (position, wavelength) => ({
        cell: Math.trunc(position / wavelength),
        fraction: Math.trunc(((position % wavelength) * Q16) / wavelength),
      }),
    },
  },
  {
    // Every chunk restarts the lattice at its own first cell.
    name: "lattice reset per chunk",
    caughtBy: "seams",
    parts: { ...FAITHFUL_PARTS, position: (cell, offset) => cellOffset(cell) + offset },
  },
  {
    // The offsets drawn without the octave, so every octave shares the coarsest one's origin.
    name: "wrong octave offset",
    caughtBy: "sharedOrigins",
    parts: {
      ...FAITHFUL_PARTS,
      offsets: (key, field, wavelength) => {
        const [x, y] = octaveOffsets(key, { purpose: field.purpose, octave: 0 }, Q16);
        return [floorMod(x, wavelength), floorMod(y, wavelength)];
      },
    },
  },
  {
    // The shifted position wrapped into int32, which breaks the chunks at the top edge.
    name: "int32 wrap at the top edge",
    caughtBy: "oracle",
    parts: { ...FAITHFUL_PARTS, position: (cell, offset) => (cell + offset) | 0 },
  },
  {
    name: "non-monotonic fade",
    caughtBy: "fade",
    parts: { ...FAITHFUL_PARTS, fade: naiveFade },
  },
  {
    // The purpose and the octave added into one word: elevation's octave 1 is thermal's octave 0.
    name: "purpose collision",
    caughtBy: "packing",
    parts: {
      ...FAITHFUL_PARTS,
      pack: (input, use) => {
        realPack(input, use);
        input[0] = use.purpose + use.octave;
        input[1] = use.kind === "offset" ? 0x8000_0000 : 0;
      },
    },
  },
  {
    // Wavelengths shrinking 4 times per octave: the fourth octave has wavelength 1, sampled only
    // at its lattice points, where gradient noise is 0.
    name: "degenerate octave",
    caughtBy: "octaveDetail",
    parts: { ...FAITHFUL_PARTS, wavelength: (base, octave) => base / 4 ** octave },
  },
];
