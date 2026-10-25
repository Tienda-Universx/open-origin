/**
 * The input words of terrain's pseudorandom function (ADR 0021, randomness for terrain). Every use
 * of the terrain seed's ChaCha20 block names its purpose, its octave, and its lattice point in the
 * block's 4 input words, so no two uses share a block:
 *
 * | Use | Word 0 | Word 1 | Word 2 | Word 3 |
 * |---|---|---|---|---|
 * | A lattice point of a field | purpose | octave | lattice x | lattice y |
 * | The offsets of a field's octave | `octaveOffset` | octave | the field's purpose | 0 |
 *
 * The packing is injective: word 0 tells a field's lattice point from an octave's offsets, since no
 * field has the purpose `octaveOffset`, and the other words hold each value whole. Purposes are
 * small integers from a fixed table, never hashed names, so two names can never collide.
 *
 * Lattice coordinates are int32 at every octave: cells lie in [−2^31, 2^31 − 1], an octave's
 * offset is below its wavelength, and wavelengths are at least 8, so a lattice coordinate, the
 * upper corner of a lattice cell included, lies in [−2^28, 2^28 + 1]. Each one becomes a u32 word,
 * its two's complement, with `>>> 0` here and only here; the arithmetic before it is exact, in
 * safe-integer doubles.
 */

/**
 * The purposes of terrain's draws, a table fixed for worldgen@1: `octaveOffset` for the offsets
 * of every field's octaves, `substrate` for the points of the substrate's Voronoi regions, and one
 * purpose for each noise field: `elevation`, `thermal`, and the 8 deposit kinds. Frozen at every
 * level.
 */
export const LATTICE_PURPOSES = Object.freeze({
  octaveOffset: 0,
  elevation: 1,
  thermal: 2,
  substrate: 3,
  deposits: Object.freeze([4, 5, 6, 7, 8, 9, 10, 11]),
});

/** The purposes of the noise fields, those sampleNoiseRegion accepts, in increasing order. */
export const NOISE_PURPOSES: readonly number[] = Object.freeze([
  LATTICE_PURPOSES.elevation,
  LATTICE_PURPOSES.thermal,
  ...LATTICE_PURPOSES.deposits,
]);

/**
 * Writes the words of the field `purpose` at `octave` to words 0 and 1 of `input`, which then
 * names a lattice point once setLatticePoint writes words 2 and 3. Precondition: `purpose` and
 * `octave` are u32 values, as the purpose table and the octave bounds make them.
 */
export function setLatticeField(input: Uint32Array, purpose: number, octave: number): void {
  input[0] = purpose;
  input[1] = octave;
}

/**
 * Writes the lattice point `x`, `y` to words 2 and 3 of `input`, as the u32 words of their two's
 * complements. Precondition: both are int32 values, as every lattice coordinate is; a value
 * outside int32 would share its word with another.
 */
export function setLatticePoint(input: Uint32Array, x: number, y: number): void {
  input[2] = x >>> 0;
  input[3] = y >>> 0;
}

/**
 * Writes to `input` the 4 words that name the offsets of the field `purpose` at `octave`: the
 * block's words 0 and 1 give the x and y offsets. Precondition: as setLatticeField.
 */
export function setOffsetInput(input: Uint32Array, purpose: number, octave: number): void {
  setLatticeField(input, LATTICE_PURPOSES.octaveOffset, octave);
  input[2] = purpose;
  input[3] = 0;
}
