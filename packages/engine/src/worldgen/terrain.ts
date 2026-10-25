/**
 * Terrain (ADR 0021, permanent and temporal layers): the permanent primary fields of a cell. Each
 * is a pure function of WORLDGEN_VERSION, the genesis, and the cell, never of time, and every draw
 * is a ChaCha20 block of the terrain seed (lattice.ts names its inputs).
 *
 * | Field | Rule | Range |
 * |---|---|---|
 * | `elevation` | the relief noise, purpose `elevation` | ±noiseBound(relief) |
 * | `thermalBase` | `base` + thermal noise + lapse term | base ± the noise's bound, + the lapse |
 * | `substrate` | the class of the nearest Voronoi point | [0, weights.length − 1] |
 * | `deposits[k]` | the noise's excess over a threshold, scaled | [0, peak] |
 *
 * **thermalBase.** The thermal noise has purpose `thermal`, amplitude `laws.thermal.spread`, and
 * THERMAL_NOISE's wavelength and octaves; with a spread of 0 it is 0 and is never sampled. The
 * level of liquid is `L = ⌊A × (2·level − 1000) / 1000⌋`, with A the relief's amplitude, as
 * `liquid.level` is in ‰ of [−A, A]. The lapse term is `⌊num × max(0, elevation − L) / den⌋`:
 * 0 at or below the level, with the sign of `lapse.num` above it. The default lapse is positive,
 * so the thermal level rises with elevation, against Earth (plan O-13).
 *
 * **substrate.** The plane is split into squares of `substrate.cell` cells, C, a power of two. The
 * square (sx, sy) holds one point, from the block (`substrate`, 0, sx, sy): word 0 mod C and word 1
 * mod C place it inside the square, and word 2 draws its class by weight, as the class k with
 * `Σ_{i<k} w_i ≤ ⌊word × W / 2^32⌋ < Σ_{i≤k} w_i` for the total weight W. That draw favors no class
 * by more than W / 2^32 < 2^−18. A cell takes the class of its nearest point by squared integer
 * distance; of points at the same distance, the one whose square has the lowest y, then the lowest
 * x, wins, which depends on the points alone, never on the region. The search covers the 5 × 5
 * squares around the cell's own, without the 4 corners, and that is exact. The point of the cell's
 * own square lies within a squared distance of 2(C − 1)²; a square 3 or more squares away along an
 * axis lies at least 2C + 1 cells away along it, and a corner square of the 5 × 5 at least C + 1
 * along both, and (2C + 1)² and 2(C + 1)² both exceed 2(C − 1)², so no point outside the search
 * can be nearer, or tie. A 3 × 3 search is not enough: a point 2 squares away lies only C + 1
 * cells away, and (C + 1)² < 2(C − 1)² for C ≥ 8. A region draws each point it needs once.
 *
 * **deposits.** Deposit k is noise of purpose `deposits[k]` with the deposit's wavelength and
 * octaves and amplitude DEPOSIT_AMPLITUDE. With B = noiseBound of that noise and the threshold
 * `t = ⌊threshold × B / 1000⌋`, in ‰ of the noise's own bound, a cell holds
 * `⌊(n − t) × peak / (B − t)⌋` where n > t, and 0 elsewhere. Since n ≤ B, the value is at most
 * `peak`, the largest abundance, in `qu`, which only n = B would reach. B bounds every alignment
 * of the octaves, so the noise stays well inside it: over 1.3 million cells of each default
 * deposit, n stayed below 0.74·B with a standard deviation near 0.24·B, and the default thresholds
 * left 11% of the cells above 300‰ and 4.7% above 450‰ (indicative). Thresholds of 600‰ and more
 * leave well under 1%.
 *
 * **Bounds.** Within GENESIS_BOUNDS every intermediate stays below 2^53:
 *
 * - elevation is the noise, whose intermediates noise.ts bounds; |elevation| ≤ noiseBound(relief),
 *   at most 1,632,610,980 < 2^31 for the largest relief, so it fits an Int32Array.
 * - `A × (2·level − 1000)` is at most 2^29 × 800 < 2^39 in magnitude, and L lies in [−0.8A, 0.8A].
 *   `elevation − L` is below 1,632,610,980 + 429,496,730 < 2^31, and `num × (elevation − L)` below
 *   2^20 × 2^31 = 2^51; with |base| ≤ 2^20 and the thermal noise at most noiseBound ≤ 4 × 2^20,
 *   the sum is exact. The genesis requires |lapse.num| × A ≤ 2^28 × lapse.den (genesis.ts), so
 *   |lapse term| ≤ 2^28 × (noiseBound(relief) + 0.8A + 1) / A + 1 ≤ 2^28 × 5.8 + 1 < 1.56 × 10^9,
 *   and |thermalBase| < 1.56 × 10^9 + 5 × 2^20 < 2^31, so it fits an Int32Array; without that
 *   rule the lapse term could reach 2^51.
 * - substrate: a point lies at most 3C − 1 ≤ 3 × 2^12 cells from a cell it is compared with along
 *   each axis, so a squared distance is below 2^29; `word × W` is below 2^32 × 16,000 < 2^46. A
 *   class is below 16, so it fits a Uint8Array.
 * - deposits: B ≤ 196,229 for 6 octaves of amplitude 2^16, so `threshold × B` < 2^28 and
 *   `(n − t) × peak` ≤ 2B × 2^20 < 2^39. B − t ≥ B / 1000 > 0, so the division is defined, and
 *   the value lies in [0, peak] ⊂ [0, 2^20], so it fits an Int32Array.
 *
 * sampleRegion evaluates any rectangle of up to 256 × 256 cells under the rules of
 * sampleNoiseRegion; a chunk is a 32 × 32 region and a cell a 1 × 1 region, so every region equals
 * the composition of its cells. Each call builds one key from the terrain seed and keeps nothing.
 */
import { utf8Encode } from "../canonical/utf8.ts";
import type { IssueSink } from "../canonical/value.ts";
import { type Digest, hexOf } from "../digest/digest.ts";
import { murmur3x86_128 } from "../digest/murmur3.ts";
import { IssueList } from "../errors.ts";
import { floorDiv, floorMod, U32_COUNT } from "../int.ts";
import { CHACHA20_BLOCK_WORDS, CHACHA20_INPUT_WORDS, ChaCha20Key } from "../rng/chacha.ts";
import type { ChunkKey } from "../world/chunk.ts";
import { expectRecord, readElements, readMember, UNREAD } from "../world/members.ts";
import {
  type Deposit,
  type Genesis,
  type PreparedGenesis,
  readPreparedGenesis,
} from "./genesis.ts";
import { LATTICE_PURPOSES, setLatticeField, setLatticePoint } from "./lattice.ts";
import { type CellRect, type NoiseSpec, noiseBound, noiseRegion, readRegion } from "./noise.ts";
import { CHUNK_CELLS, chunkFirstCell, readWorldChunkKey } from "./space.ts";
import { WORLDGEN_VERSION } from "./version.ts";

/**
 * The wavelength and octaves of the thermal noise, constants of worldgen@1, as the genesis gives
 * only its amplitude, `spread`. A coarsest wavelength of 4096 cells, twice the default relief's,
 * makes thermal noise a regional trend: over the few hundred cells an inhabitant explores it
 * changes little, so the lapse term, which follows elevation, dominates the differences between
 * nearby cells, and the lapse law stays discoverable. Three octaves, down to 1024 cells, keep the
 * trend from looking like one smooth wave, and cost a little over a third of the default relief.
 */
export const THERMAL_NOISE = Object.freeze({ wavelength: 4096, octaves: 3 });

/** The amplitude of every deposit's noise, 2^16: thresholds are ‰ of its own bound. */
export const DEPOSIT_AMPLITUDE = 0x1_0000;

/** The permanent primary fields of a region, row by row: cell (x + i, y + j) at j·width + i. */
export type TerrainRegion = {
  readonly elevation: Int32Array;
  readonly substrate: Uint8Array;
  readonly thermalBase: Int32Array;
  /** One field per deposit of the genesis, in its order. */
  readonly deposits: readonly Int32Array[];
};

/** A generated chunk: the 32 × 32 region of its key, indexed y·32 + x, with that key. */
export type TerrainChunk = TerrainRegion & { readonly key: ChunkKey };

/** How many cells a chunk has. */
const CHUNK_AREA = CHUNK_CELLS * CHUNK_CELLS;

/** How many squares the substrate search reaches from the cell's own along each axis. */
const REACH = 2;

/**
 * The level of liquid of `genesis`, in elevation units: ⌊A × (2·level − 1000) / 1000⌋, with A the
 * relief's amplitude. A cell is under liquid when its elevation is below it.
 */
export function liquidLevel(genesis: Genesis): number {
  return floorDiv(genesis.terrain.relief.amplitude * (2 * genesis.laws.liquid.level - 1000), 1000);
}

/** The thermal base of each cell of `rect`, given its elevation. */
function thermalField(
  key: ChaCha20Key,
  genesis: Genesis,
  elevation: Int32Array,
  rect: CellRect,
): Int32Array {
  const { base, spread, lapse } = genesis.laws.thermal;
  const spec = { purpose: LATTICE_PURPOSES.thermal, ...THERMAL_NOISE, amplitude: spread };
  // A spread of 0 adds 0; the noise's precondition asks for an amplitude of at least 1.
  const field = spread === 0 ? new Int32Array(elevation.length) : noiseRegion(key, spec, rect);
  const level = liquidLevel(genesis);
  const { num, den } = lapse;
  for (let index = 0; index < field.length; index += 1) {
    const above = (elevation[index] as number) - level;
    const lapseTerm = above > 0 ? floorDiv(num * above, den) : 0;
    field[index] = base + (field[index] as number) + lapseTerm;
  }
  return field;
}

/** The points of the substrate squares a region needs: their cells and classes, row by row. */
type SubstratePoints = {
  /** The size of a square, in cells. */
  readonly size: number;
  /** The coordinates of the first square. */
  readonly firstX: number;
  readonly firstY: number;
  /** How many squares each row holds. */
  readonly columns: number;
  readonly xs: Float64Array;
  readonly ys: Float64Array;
  readonly classes: Uint8Array;
};

/** The class that `word` draws by `weights`, whose sum is `total`: see the module comment. */
function drawClass(word: number, weights: Float64Array, total: number): number {
  let draw = floorDiv(word * total, U32_COUNT);
  for (let substrate = 0; substrate < weights.length - 1; substrate += 1) {
    draw -= weights[substrate] as number;
    if (draw < 0) return substrate;
  }
  return weights.length - 1;
}

/** The point of every square within REACH squares of a cell of `rect`. */
function substratePoints(key: ChaCha20Key, genesis: Genesis, rect: CellRect): SubstratePoints {
  const size = genesis.terrain.substrate.cell;
  // A plain copy: reading a frozen array costs about 20 ns per read on Bun.
  const weights = Float64Array.from(genesis.terrain.substrate.weights);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const firstX = floorDiv(rect.x, size) - REACH;
  const firstY = floorDiv(rect.y, size) - REACH;
  const columns = floorDiv(rect.x + rect.width - 1, size) + REACH - firstX + 1;
  const rows = floorDiv(rect.y + rect.height - 1, size) + REACH - firstY + 1;
  const points = { size, firstX, firstY, columns };
  const xs = new Float64Array(columns * rows);
  const ys = new Float64Array(columns * rows);
  const classes = new Uint8Array(columns * rows);
  const input = new Uint32Array(CHACHA20_INPUT_WORDS);
  const block = new Uint32Array(CHACHA20_BLOCK_WORDS);
  setLatticeField(input, LATTICE_PURPOSES.substrate, 0);
  for (let index = 0; index < xs.length; index += 1) {
    const sx = firstX + floorMod(index, columns);
    const sy = firstY + floorDiv(index, columns);
    setLatticePoint(input, sx, sy);
    key.blockInto(input, block);
    xs[index] = sx * size + floorMod(block[0] as number, size);
    ys[index] = sy * size + floorMod(block[1] as number, size);
    classes[index] = drawClass(block[2] as number, weights, total);
  }
  return { ...points, xs, ys, classes };
}

/**
 * The class of the nearest point to the cell `x`, `y`: the squares are visited row by row, lowest
 * y first, then lowest x, and only a strictly nearer point replaces the best, so ties go to the
 * lowest square y, then x.
 */
function nearestClass(points: SubstratePoints, x: number, y: number): number {
  const column = floorDiv(x, points.size) - points.firstX;
  const row = floorDiv(y, points.size) - points.firstY;
  let best = Number.MAX_SAFE_INTEGER;
  let found = 0;
  for (let b = -REACH; b <= REACH; b += 1) {
    // The corner squares of the 5 × 5 cannot hold the nearest point: see the module comment.
    const reach = b === -REACH || b === REACH ? REACH - 1 : REACH;
    const start = (row + b) * points.columns + column;
    for (let index = start - reach; index <= start + reach; index += 1) {
      const dx = (points.xs[index] as number) - x;
      const dy = (points.ys[index] as number) - y;
      const distance = dx * dx + dy * dy;
      if (distance < best) {
        best = distance;
        found = points.classes[index] as number;
      }
    }
  }
  return found;
}

/** The substrate class of each cell of `rect`. */
function substrateField(key: ChaCha20Key, genesis: Genesis, rect: CellRect): Uint8Array {
  const points = substratePoints(key, genesis, rect);
  const field = new Uint8Array(rect.width * rect.height);
  for (let row = 0; row < rect.height; row += 1) {
    for (let column = 0; column < rect.width; column += 1) {
      field[row * rect.width + column] = nearestClass(points, rect.x + column, rect.y + row);
    }
  }
  return field;
}

/** The abundance of `deposit`, the deposit of purpose `purpose`, in each cell of `rect`. */
function depositField(
  key: ChaCha20Key,
  deposit: Deposit,
  purpose: number,
  rect: CellRect,
): Int32Array {
  const spec: NoiseSpec = {
    purpose,
    wavelength: deposit.wavelength,
    octaves: deposit.octaves,
    amplitude: DEPOSIT_AMPLITUDE,
  };
  const field = noiseRegion(key, spec, rect);
  const bound = noiseBound(spec);
  const threshold = floorDiv(deposit.threshold * bound, 1000);
  const span = bound - threshold;
  const peak = deposit.peak;
  for (let index = 0; index < field.length; index += 1) {
    const noise = field[index] as number;
    field[index] = noise > threshold ? floorDiv((noise - threshold) * peak, span) : 0;
  }
  return field;
}

/**
 * Not for hosts: the fields of `genesis` over `rect` under `key`, without validating anything.
 * sampleRegion calls it with the terrain seed's key; the tests' broken variants call it with
 * another key. Precondition: `genesis` was prepared and `rect` passed readRegion.
 */
export function terrainRegion(key: ChaCha20Key, genesis: Genesis, rect: CellRect): TerrainRegion {
  const relief = { purpose: LATTICE_PURPOSES.elevation, ...genesis.terrain.relief };
  const elevation = noiseRegion(key, relief, rect);
  const thermalBase = thermalField(key, genesis, elevation, rect);
  const substrate = substrateField(key, genesis, rect);
  const deposits = genesis.terrain.deposits.map((deposit, k) =>
    depositField(key, deposit, LATTICE_PURPOSES.deposits[k] as number, rect),
  );
  return { elevation, substrate, thermalBase, deposits };
}

/**
 * The permanent primary fields of `prepared`'s terrain over the cells of `rect`, each in a fresh
 * typed array of `rect.width × rect.height` cells, row by row. It never takes an instant: these
 * fields do not depend on time.
 *
 * It validates its inputs once and throws EngineError("invalid_value") with every problem: at
 * /prepared, a value prepareGenesis did not make; under /rect, what sampleNoiseRegion rejects,
 * a first cell outside the world, a side outside [1, 256], or a last cell outside the world.
 */
export function sampleRegion(prepared: PreparedGenesis, rect: CellRect): TerrainRegion {
  const issues = new IssueList();
  const genesis = readPreparedGenesis(prepared, issues);
  const region = readRegion(rect, issues);
  if (genesis === undefined || region === undefined || issues.count > 0) {
    throw issues.toError("invalid_value");
  }
  return terrainRegion(new ChaCha20Key(genesis.terrainSeed), genesis, region);
}

/** The elevation of a region and the abundance of one of its deposits: what a being senses. */
export type SurfaceRegion = { readonly elevation: Int32Array; readonly deposit: Int32Array };

/**
 * The elevation and the deposit `k` of `prepared`'s terrain over `rect`, each equal to the field of
 * the same name that sampleRegion returns, computed by the same functions without the others: the
 * senses of beings read only these (ADR 0023). Throws EngineError("invalid_value") with every
 * problem sampleRegion reports, and at /deposit an index the genesis has no deposit for.
 */
export function sampleSurface(prepared: PreparedGenesis, rect: CellRect, k: number): SurfaceRegion {
  const issues = new IssueList();
  const genesis = readPreparedGenesis(prepared, issues);
  const region = readRegion(rect, issues);
  const deposit = genesis === undefined ? undefined : readDeposit(genesis, k, issues);
  if (genesis === undefined || region === undefined || deposit === undefined || issues.count > 0) {
    throw issues.toError("invalid_value");
  }
  const key = new ChaCha20Key(genesis.terrainSeed);
  const relief = { purpose: LATTICE_PURPOSES.elevation, ...genesis.terrain.relief };
  return {
    elevation: noiseRegion(key, relief, region),
    deposit: depositField(key, deposit, LATTICE_PURPOSES.deposits[k] as number, region),
  };
}

/** The deposit `k` of `genesis`, or undefined after reporting at /deposit that it has none. */
function readDeposit(genesis: Genesis, k: number, issues: IssueSink): Deposit | undefined {
  const index = Number.isSafeInteger(k) && !Object.is(k, -0) ? k : -1;
  const deposit = genesis.terrain.deposits[index];
  if (deposit !== undefined) return deposit;
  const count = genesis.terrain.deposits.length;
  const allowed =
    count === 0 ? "the genesis defines no deposits" : `it must be from 0 to ${count - 1}`;
  issues.report("/deposit", `the deposit index is not one of the genesis: ${allowed}`);
  return undefined;
}

/**
 * The chunk `key` of `prepared`'s terrain: the 32 × 32 region of its cells, with its key. Throws
 * EngineError("invalid_value") with every problem: at /prepared, a value prepareGenesis did not
 * make; at /key, what chunkKeyIssues finds, a malformed key or a coordinate outside the world.
 */
export function generateChunk(prepared: PreparedGenesis, key: ChunkKey): TerrainChunk {
  const issues = new IssueList();
  const genesis = readPreparedGenesis(prepared, issues);
  const coord = readWorldChunkKey(key, "/key", issues);
  if (genesis === undefined || coord === undefined || issues.count > 0) {
    throw issues.toError("invalid_value");
  }
  const rect = {
    x: chunkFirstCell(coord.x),
    y: chunkFirstCell(coord.y),
    width: CHUNK_CELLS,
    height: CHUNK_CELLS,
  };
  const region = terrainRegion(new ChaCha20Key(genesis.terrainSeed), genesis, rect);
  return { key: `${coord.x},${coord.y}`, ...region };
}

/** Writes u32 words, little-endian, to a byte buffer. */
class WordWriter {
  readonly bytes: Uint8Array;
  readonly #view: DataView;
  #at = 0;

  constructor(words: number) {
    this.bytes = new Uint8Array(4 * words);
    this.#view = new DataView(this.bytes.buffer);
  }

  /** One word: an int32 as its two's complement, or a u32. */
  word(value: number): void {
    this.#view.setUint32(this.#at, value >>> 0, true);
    this.#at += 4;
  }

  /** The UTF-8 bytes of a text: their count, then the bytes, zero-padded to a whole word. */
  text(bytes: Uint8Array): void {
    this.word(bytes.length);
    this.bytes.set(bytes, this.#at);
    this.#at += 4 * textWords(bytes.length);
  }

  /** Each value of `values` as one word. */
  words(values: Int32Array): void {
    for (let index = 0; index < values.length; index += 1) this.word(values[index] as number);
  }

  /** The bytes of `values`, 4 to a word, the first in the lowest byte. */
  packed(values: Uint8Array): void {
    this.bytes.set(values, this.#at);
    this.#at += values.length;
  }
}

/** How many words hold `length` bytes. */
function textWords(length: number): number {
  return floorDiv(length + 3, 4);
}

/** The tag that starts every terrain digest's words. */
const DIGEST_TAG = "terrain";

/** A chunk whose members terrainDigest validated. */
type ValidChunk = { readonly x: number; readonly y: number; readonly region: TerrainRegion };

/** A kind of chunk field: its typed array type, and the message for a value of another kind. */
type FieldKind<T extends Int32Array | Uint8Array> = {
  readonly type: abstract new (length: number) => T;
  readonly message: string;
};

const INT32_FIELD: FieldKind<Int32Array> = {
  type: Int32Array,
  message: `the field must be an Int32Array of ${CHUNK_AREA} cells`,
};
const UINT8_FIELD: FieldKind<Uint8Array> = {
  type: Uint8Array,
  message: `the field must be a Uint8Array of ${CHUNK_AREA} cells`,
};

/**
 * `value` if it is a typed array of `kind` with a chunk's cells; otherwise undefined, after an
 * issue at `path` unless readMember already reported it. ArrayBuffer.isView comes first: it reads
 * an internal slot, so a Proxy is refused without running a trap.
 */
function chunkField<T extends Int32Array | Uint8Array>(
  value: unknown,
  kind: FieldKind<T>,
  path: string,
  sink: IssueSink,
): T | undefined {
  if (value === UNREAD) return undefined;
  if (ArrayBuffer.isView(value) && value instanceof kind.type && value.length === CHUNK_AREA) {
    return value;
  }
  sink.report(path, kind.message);
  return undefined;
}

/** The deposit fields of a chunk, at most 8; undefined after an issue under /deposits. */
function readDeposits(value: unknown, sink: IssueSink): Int32Array[] | undefined {
  const most = LATTICE_PURPOSES.deposits.length;
  const notList = `the deposits must be an array of at most ${most} fields`;
  const elements = readElements(value, "/deposits", notList, sink);
  if (elements === undefined) return undefined;
  if (elements.length > most) {
    sink.report("/deposits", notList);
    return undefined;
  }
  const fields: Int32Array[] = [];
  elements.forEach((element, k) => {
    const field = chunkField(element, INT32_FIELD, `/deposits/${k}`, sink);
    if (field !== undefined) fields.push(field);
  });
  return fields.length === elements.length ? fields : undefined;
}

/** The fields of the host record `chunk`, each read once; undefined after every problem. */
function readFields(chunk: object, sink: IssueSink): TerrainRegion | undefined {
  const member = (name: string) => readMember(chunk, name, `/${name}`, sink);
  const elevation = chunkField(member("elevation"), INT32_FIELD, "/elevation", sink);
  const substrate = chunkField(member("substrate"), UINT8_FIELD, "/substrate", sink);
  const thermalBase = chunkField(member("thermalBase"), INT32_FIELD, "/thermalBase", sink);
  const deposits = readDeposits(member("deposits"), sink);
  if (elevation === undefined || substrate === undefined || thermalBase === undefined) {
    return undefined;
  }
  return deposits === undefined ? undefined : { elevation, substrate, thermalBase, deposits };
}

/** The members of the host value `chunk`, each read once; undefined after every problem. */
function readChunk(chunk: unknown, sink: IssueSink): ValidChunk | undefined {
  const shape = "the chunk must be a record { key, elevation, substrate, thermalBase, deposits }";
  if (!expectRecord(chunk, "", shape, sink)) return undefined;
  const key = readMember(chunk, "key", "/key", sink);
  const coord = key === UNREAD ? undefined : readWorldChunkKey(key, "/key", sink);
  const region = readFields(chunk, sink);
  return coord === undefined || region === undefined ? undefined : { ...coord, region };
}

/**
 * The digest of the permanent layer of `chunk`, a chunk from generateChunk: MurmurHash3 x86_128
 * with seed 0 over these little-endian u32 words, in this order:
 *
 * | Words | Content |
 * |---|---|
 * | 1, then 2 | the tag "terrain": its UTF-8 byte count, 7, then its bytes, zero-padded to a word |
 * | 1, then 3 | WORLDGEN_VERSION, "worldgen@1", the same way: 10, then its bytes |
 * | 2 | the chunk's x, then its y, as int32 |
 * | 1024 | elevation, cell y·32 + x at word y·32 + x, as int32 |
 * | 256 | substrate, 4 cells per word, cell 4w + i in byte i of word w |
 * | 1024 | thermalBase, as int32 |
 * | 1 | the number of deposits, k |
 * | 1024 × k | each deposit's field in the genesis's order, as int32 |
 *
 * The words hold neither the terrain seed nor an instant, so the digest identifies terrain without
 * revealing the seed, and never depends on time. It throws EngineError("invalid_value") with every
 * problem of `chunk`: a value that is not a record, a key that is not a chunk of the world, at
 * /key, and a field that is not a typed array of the right type with 1024 cells, or more than 8
 * deposits, at the field's path. Members are read once, through their own descriptors.
 */
export function terrainDigest(chunk: TerrainChunk): Digest {
  const issues = new IssueList();
  const valid = readChunk(chunk, issues);
  if (valid === undefined || issues.count > 0) throw issues.toError("invalid_value");
  const { x, y, region } = valid;
  const tag = utf8Encode(DIGEST_TAG);
  const version = utf8Encode(WORLDGEN_VERSION);
  const texts = 2 + textWords(tag.length) + textWords(version.length);
  const cells = (2 + region.deposits.length) * CHUNK_AREA + CHUNK_AREA / 4;
  // The texts, x and y, the count of deposits, and the cells.
  const writer = new WordWriter(texts + 3 + cells);
  writer.text(tag);
  writer.text(version);
  writer.word(x);
  writer.word(y);
  writer.words(region.elevation);
  writer.packed(region.substrate);
  writer.words(region.thermalBase);
  writer.word(region.deposits.length);
  for (const field of region.deposits) writer.words(field);
  return hexOf(murmur3x86_128(writer.bytes, 0));
}
