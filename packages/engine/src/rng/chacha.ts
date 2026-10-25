/**
 * The ChaCha20 block function of RFC 8439 §2.3, with its 20 rounds fixed (ADR 0021): a keyed
 * pseudorandom function from 4 input words to 16 output words, for terrain. It uses only 32-bit
 * addition, xor, and rotation, which ECMA-262 defines exactly, so every engine gives the same
 * words. That its outputs cannot be predicted without the key rests on the standard assumption
 * that ChaCha20 is a pseudorandom function with a 256-bit key; nothing proves it.
 *
 * The state is the RFC's 16 words: the constants, the 8 key words, and the 4 input words, which
 * RFC 8439 fills with the block counter (word 12) and the nonce (words 13 to 15). The block is the
 * state after the rounds plus the initial state, word by word modulo 2^32: the RFC's serialized
 * block read as 16 little-endian words. The rounds run on int32 words, as int.ts explains, and a
 * Uint32Array stores each output word as its u32.
 */
import { describeValue, EngineError, type Issue } from "../errors.ts";
import { rotl32 } from "../int.ts";
import { readWord } from "./words.ts";

/** The words of a key: 256 bits. */
const KEY_WORDS = 8;

/** The words of an input: state words 12 to 15. */
export const CHACHA20_INPUT_WORDS = 4;

/** The words of a block: 64 bytes. */
export const CHACHA20_BLOCK_WORDS = 16;

/** The first 4 state words: "expand 32-byte k" read as little-endian words (RFC 8439 §2.3). */
const CONSTANTS: readonly number[] = Object.freeze([
  0x61707865, 0x3320646e, 0x79622d32, 0x6b206574,
]);

/** 20 rounds: 10 column rounds, each followed by a diagonal round (RFC 8439 §2.3). */
const DOUBLE_ROUNDS = 10;

/**
 * The `count` words of the array `value` in a fresh array: its length and each element are read
 * once, by index, so neither a getter nor a custom iterator can show the block other words than
 * validation saw. Issues go to `/${name}` and `/${name}/i`.
 */
function readWords(value: unknown, name: string, count: number, issues: Issue[]): number[] {
  const path = `/${name}`;
  if (!Array.isArray(value)) {
    issues.push({ path, message: `the ${name} must be an array of ${count} words` });
    return [];
  }
  const words: readonly unknown[] = value;
  // A Proxy can report any length, one that is not a number included.
  const length: unknown = words.length;
  if (length !== count) {
    const message = `the ${name} must have ${count} words, not ${describeValue(length)}`;
    issues.push({ path, message });
    return [];
  }
  const copy: number[] = [];
  for (let index = 0; index < count; index += 1) copy.push(readWord(words, index, path, issues));
  return copy;
}

/**
 * The quarter round of RFC 8439 §2.1 on four words of `state`, read as a 4 x 4 matrix: a is in
 * row 0 at `column`, and b, c, and d are in rows 1 to 3 at column + skew, column + 2 * skew, and
 * column + 3 * skew, modulo 4. For column 1, skew 0 gives the column QUARTERROUND(1, 5, 9, 13) and
 * skew 1 the diagonal QUARTERROUND(1, 6, 11, 12).
 */
function quarterRound(state: Int32Array, column: number, skew: number): void {
  const ib = 4 + ((column + skew) & 3);
  const ic = 8 + ((column + 2 * skew) & 3);
  const id = 12 + ((column + 3 * skew) & 3);
  // Every index is below 16, the length of the state.
  let a = state[column] as number;
  let b = state[ib] as number;
  let c = state[ic] as number;
  let d = state[id] as number;
  a = (a + b) | 0;
  d = rotl32(d ^ a, 16);
  c = (c + d) | 0;
  b = rotl32(b ^ c, 12);
  a = (a + b) | 0;
  d = rotl32(d ^ a, 8);
  c = (c + d) | 0;
  b = rotl32(b ^ c, 7);
  state[column] = a;
  state[ib] = b;
  state[ic] = c;
  state[id] = d;
}

/**
 * A column round, QUARTERROUND(0, 4, 8, 12) to (3, 7, 11, 15), then a diagonal round,
 * (0, 5, 10, 15), (1, 6, 11, 12), (2, 7, 8, 13), and (3, 4, 9, 14).
 */
function doubleRound(state: Int32Array): void {
  for (let column = 0; column < 4; column += 1) quarterRound(state, column, 0);
  for (let column = 0; column < 4; column += 1) quarterRound(state, column, 1);
}

/**
 * A key, validated and copied once, for blocks in hot loops. Each key has working words of its
 * own, which every call overwrites, so keys share no state.
 */
export class ChaCha20Key {
  /** The initial state: constants and key in words 0 to 11, the block's input in 12 to 15. */
  readonly #initial = new Int32Array(CHACHA20_BLOCK_WORDS);
  /** The state during the rounds. */
  readonly #state = new Int32Array(CHACHA20_BLOCK_WORDS);

  /**
   * Reads the 8 words of `key` once each, by index, into a copy. Throws
   * EngineError("invalid_value") with every problem, at `/key` and `/key/i`.
   */
  constructor(key: readonly number[]) {
    const issues: Issue[] = [];
    const words = readWords(key, "key", KEY_WORDS, issues);
    if (issues.length > 0) throw new EngineError("invalid_value", issues);
    this.#initial.set(CONSTANTS);
    this.#initial.set(words, CONSTANTS.length);
  }

  /**
   * Writes the block for `input` to words 0 to 15 of `output`, without validating or allocating.
   * The caller guarantees that `input` has at least 4 words and `output` at least 16: with fewer,
   * missing input words read as 0 and output words past the end are dropped, without an error.
   * The input is read before the output is written, so the two may share memory.
   */
  blockInto(input: Uint32Array, output: Uint32Array): void {
    const initial = this.#initial;
    const state = this.#state;
    for (let index = 0; index < CHACHA20_INPUT_WORDS; index += 1) {
      // An Int32Array stores a u32 as the int32 with the same bits.
      initial[12 + index] = input[index] as number;
    }
    state.set(initial);
    for (let round = 0; round < DOUBLE_ROUNDS; round += 1) doubleRound(state);
    for (let index = 0; index < CHACHA20_BLOCK_WORDS; index += 1) {
      // The sum of two int32 words, which the Uint32Array stores modulo 2^32.
      output[index] = (state[index] as number) + (initial[index] as number);
    }
  }
}

/**
 * The ChaCha20 block of `key`, 8 u32 words, for `input`, 4 u32 words that become state words 12
 * to 15: 16 u32 words in a fresh array. Each word is read once, by index. Throws
 * EngineError("invalid_value") with every problem, at `/key`, `/key/i`, `/input`, and `/input/i`.
 */
export function chacha20Block(key: readonly number[], input: readonly number[]): number[] {
  const issues: Issue[] = [];
  const keyWords = readWords(key, "key", KEY_WORDS, issues);
  const inputWords = readWords(input, "input", CHACHA20_INPUT_WORDS, issues);
  if (issues.length > 0) throw new EngineError("invalid_value", issues);
  const output = new Uint32Array(CHACHA20_BLOCK_WORDS);
  new ChaCha20Key(keyWords).blockInto(Uint32Array.from(inputWords), output);
  return Array.from(output);
}
